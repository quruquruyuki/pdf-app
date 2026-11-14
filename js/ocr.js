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
  // 約300dpi相当。ただしiPhoneのメモリを考えて長辺3200pxまで
  const scale = Math.min(300 / 72, 3200 / Math.max(vp1.width, vp1.height));
  const { canvas } = await renderPageCanvas(pdfDoc, pageNo, scale);
  try {
    const { data } = await worker.recognize(canvas, {}, { text: true, blocks: true });
    const words = [], lines = [];
    const toBox = (b) => ({ x: b.x0 / scale, y: b.y0 / scale, w: (b.x1 - b.x0) / scale, h: (b.y1 - b.y0) / scale });
    for (const block of data.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          const lt = cleanJa(line.text);
          if (!lt || line.confidence < 25) continue;
          lines.push({ t: lt, ...round(toBox(line.bbox)) });
          for (const wd of line.words || []) {
            const t = cleanJa(wd.text);
            if (!t || wd.confidence < 20) continue;
            words.push({ t, ...round(toBox(wd.bbox)) });
          }
        }
      }
    }
    const text = lines.map(l => l.t).join('\n');
    return { words, lines, text, at: Date.now() };
  } finally {
    canvas.width = canvas.height = 0;
  }
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
