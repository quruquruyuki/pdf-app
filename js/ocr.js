// OCR（Tesseract.js・端末内で処理。日本語＋英語）
import { renderPageCanvas } from './pdfcore.js';

let workerP = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('OCRエンジンを読み込めませんでした'));
    document.head.append(s);
  });
}

async function getWorker(onProgress) {
  if (!workerP) {
    workerP = (async () => {
      const base = new URL('../vendor/tesseract/', import.meta.url).href;
      await loadScript(base + 'tesseract.min.js');
      const w = await window.Tesseract.createWorker(['jpn', 'eng'], 1, {
        workerPath: base + 'worker.min.js',
        corePath: base + 'core/',
        langPath: base + 'lang/',
        gzip: true,
        workerBlobURL: false,
        logger: (m) => { if (getWorker.cb) getWorker.cb(m); },
      });
      await w.setParameters({ preserve_interword_spaces: '1' });
      return w;
    })().catch(e => { workerP = null; throw e; });
  }
  getWorker.cb = onProgress;
  return workerP;
}

const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/;
// 日本語の文字の間に入る余計なスペースを消す
export function cleanJa(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
    .replace(/(\S) (?=\S)/g, (m, a, off, str) => {
      const b = str[off + 2];
      return (CJK.test(a) || CJK.test(b)) ? a : m;
    });
}

// pageNo: 1始まり。戻り値は表示座標（pt）
export async function ocrPage(pdfDoc, pageNo, onProgress) {
  const worker = await getWorker(onProgress);
  const page = await pdfDoc.getPage(pageNo);
  const vp1 = page.getViewport({ scale: 1 });
  // 長辺を約3600pxにして描く（A4で約300dpi。写真のPDFは細かい文字が多いので大きめに）
  const capped = Math.min(3600 / Math.max(vp1.width, vp1.height), 8);
  const { canvas } = await renderPageCanvas(pdfDoc, pageNo, capped);
  preprocess(canvas);
  try {
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const words = [], lines = [];
    const toBox = (b) => ({ x: b.x0 / capped, y: b.y0 / capped, w: (b.x1 - b.x0) / capped, h: (b.y1 - b.y0) / capped });
    const rawLines = [];
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) rawLines.push(line);
      }
    }
    // 文字の高さの中央値（図や写真の上にできる大きすぎる枠を除くため）
    const hs = rawLines.map(l => l.bbox.y1 - l.bbox.y0).sort((a, b) => a - b);
    const medH = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
    for (const line of rawLines) {
      const lh = line.bbox.y1 - line.bbox.y0;
      if (medH && lh > medH * 4 && line.confidence < 85) continue;
      // 単語ごとに判定して、ゴミを除いた単語だけで行を作り直す
      const ws = [];
      for (const wd of line.words || []) {
        const t = cleanJa(wd.text);
        if (!t || !VALID.test(t)) continue;
        const cjk = CJK.test(t);
        const min = cjk ? 55 : (t.length <= 3 ? 75 : 60);
        if (wd.confidence < min) continue;
        ws.push({ t, b: wd.bbox, c: wd.confidence });
      }
      if (!ws.length) continue;
      ws.sort((a, b) => a.b.x0 - b.b.x0);
      // 単語の間が大きく空いていたら別の行に分ける（地図や図のゴミとつながらないように）
      let seg = [ws[0]];
      const segs = [seg];
      for (let k = 1; k < ws.length; k++) {
        const gap = ws[k].b.x0 - ws[k - 1].b.x1;
        if (gap > lh * 2) { seg = [ws[k]]; segs.push(seg); } else seg.push(ws[k]);
      }
      for (const sg of segs) {
        const t = cleanJa(sg.map(w => w.t).join(' '));
        const conf = sg.reduce((a, w) => a + w.c, 0) / sg.length;
        if (!isMeaningful(t, conf)) continue;
        const bb = { x0: Math.min(...sg.map(w => w.b.x0)), y0: Math.min(...sg.map(w => w.b.y0)), x1: Math.max(...sg.map(w => w.b.x1)), y1: Math.max(...sg.map(w => w.b.y1)) };
        lines.push({ t, c: Math.round(conf), ...round(toBox(bb)) });
        for (const w of sg) words.push({ t: w.t, ...round(toBox(w.b)) });
      }
    }
    const text = lines.map(l => l.t).join('\n');
    return { words, lines, text, at: Date.now() };
  } finally {
    canvas.width = canvas.height = 0;
  }
}

// 意味のある文字（漢字・かな・英数字）
const VALID = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaffA-Za-z0-9\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/;
const VALID_G = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaffA-Za-z0-9\uff10-\uff19\uff21-\uff3a\uff41-\uff5a]/g;

// 図・地図・写真の上で拾ったゴミ（記号だらけ・自信の低い行）を捨てる
function isMeaningful(t, conf) {
  if (!t) return false;
  const chars = t.replace(/\s/g, '');
  if (!chars.length) return false;
  const valid = (chars.match(VALID_G) || []).length;
  const ratio = valid / chars.length;
  if (conf < 50) return false;
  if (ratio < 0.6) return false;
  if (chars.length === 1 && conf < 93) return false;
  if (chars.length <= 2 && conf < 80) return false;
  return true;
}

// 白黒にして明るさの差を広げる（色付きの紙や影のある写真で効く）
function preprocess(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let o = 0; o < d.length; o += 4) {
    const y = (d[o] * 77 + d[o + 1] * 150 + d[o + 2] * 29) >> 8;
    d[o] = y;
    hist[y]++;
  }
  const n = d.length / 4;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > n * 0.01) break; }
  acc = 0;
  for (; hi > 0; hi--) { acc += hist[hi]; if (acc > n * 0.01) break; }
  const range = Math.max(1, hi - lo);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = (v - lo) * 255 / range;
  for (let o = 0; o < d.length; o += 4) { const v = lut[d[o]]; d[o] = d[o + 1] = d[o + 2] = v; }
  ctx.putImageData(img, 0, 0);
}

function round(b) {
  return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.w.toFixed(2), h: +b.h.toFixed(2) };
}

export async function pageHasText(pdfDoc, pageNo) {
  const page = await pdfDoc.getPage(pageNo);
  const tc = await page.getTextContent();
  const s = tc.items.map(i => i.str || '').join('').replace(/\s/g, '');
  return s.length > 15;
}
