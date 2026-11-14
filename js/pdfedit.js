// pdf-lib を使った書き出し・ページ編集
import { displayToPdfMapper } from './pdfcore.js';
import { subsetFont } from './fontsubset.js';

const { PDFDocument, rgb, degrees, LineCapStyle, BlendMode, StandardFonts, pushGraphicsState, popGraphicsState, setCharacterSqueeze, setTextRenderingMode, TextRenderingMode } = window.PDFLib;

let fontBytesP = null;
function loadJpFont() {
  if (!fontBytesP) {
    fontBytesP = fetch(new URL('../vendor/fonts/NotoSansJP-Regular.ttf', import.meta.url)).then(r => {
      if (!r.ok) throw new Error('フォントを読み込めませんでした');
      return r.arrayBuffer();
    });
  }
  return fontBytesP;
}

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '#000000');
  return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
}

// ---------- 画像 → PDF（スキャン） ----------
async function imageToJpeg(file, maxSide = 2200) {
  const bmp = await loadBitmap(file);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), hgt = Math.round(bmp.height * s);
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, hgt);
  ctx.drawImage(bmp, 0, 0, w, hgt);
  if (bmp.close) bmp.close();
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
  c.width = c.height = 0;
  return { bytes: await blob.arrayBuffer(), w, h: hgt };
}

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (_) { /* fallthrough */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally { URL.revokeObjectURL(url); }
}

async function addImagePages(pdf, files) {
  for (const f of files) {
    const { bytes, w, h } = await imageToJpeg(f);
    const img = await pdf.embedJpg(bytes);
    // 横幅をA4（595pt）に合わせる
    const pw = 595.28, ph = pw * h / w;
    const page = pdf.addPage([pw, ph]);
    page.drawImage(img, { x: 0, y: 0, width: pw, height: ph });
  }
}

export async function imagesToPdf(files) {
  const pdf = await PDFDocument.create();
  await addImagePages(pdf, files);
  return (await pdf.save()).buffer;
}

// ---------- ページ整理 ----------
// plan: [{ kind:'page', src:'main'|key, index, rotate }, { kind:'blank', w, h }]
// sources: { main: bytes, [key]: bytes }
export async function buildFromPlan(plan, sources) {
  const out = await PDFDocument.create();
  const loaded = {};
  for (const [k, bytes] of Object.entries(sources)) {
    loaded[k] = await PDFDocument.load(bytes, { ignoreEncryption: true });
  }
  for (const item of plan) {
    if (item.kind === 'blank') {
      out.addPage([item.w || 595.28, item.h || 841.89]);
      continue;
    }
    const src = loaded[item.src];
    const [p] = await out.copyPages(src, [item.index]);
    const base = p.getRotation().angle || 0;
    p.setRotation(degrees(((base + (item.rotate || 0)) % 360 + 360) % 360));
    out.addPage(p);
  }
  return (await out.save()).buffer;
}

export async function pdfPageCount(bytes) {
  const d = await PDFDocument.load(bytes, { ignoreEncryption: true });
  return d.getPageCount();
}

// ---------- 注釈を焼き込んで書き出し ----------
// annots: { [pageIndex]: [annot] }  ocr: { [pageIndex]: { words:[{t,x,y,w,h}] } }
export async function exportPdf(bytes, annots, ocr, { includeOcr = true } = {}) {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
  const pages = pdf.getPages();

  // 使う文字を集めて、その文字だけのフォントを埋め込む
  let chars = '';
  pages.forEach((_, i) => {
    for (const a of annots[i] || []) if (a.type === 'text' || a.type === 'edit') chars += a.text || '';
    if (includeOcr && ocr[i]) for (const w of (ocr[i].lines || ocr[i].words || [])) chars += w.t || '';
  });
  let font = null;
  if (chars.trim()) {
    pdf.registerFontkit(window.fontkit);
    const sub = await subsetFont(await loadJpFont(), chars, new URL('../vendor/harfbuzz/harfbuzz-subset.wasm', import.meta.url).href);
    font = await pdf.embedFont(sub, { subset: false });
  }

  pages.forEach((page, i) => {
    const rot = page.getRotation().angle || 0;
    const cb = page.getCropBox();
    const map = displayToPdfMapper([cb.x, cb.y, cb.width, cb.height], rot);
    const list = annots[i] || [];
    for (const a of list) drawAnnot(page, a, map, rot, font);
    if (includeOcr && ocr[i]) drawOcr(page, ocr[i].lines || ocr[i].words || [], map, rot, font);
  });

  pdf.setModificationDate(new Date());
  return (await pdf.save()).buffer;
}

function pathFromPoints(pts, map, close = false) {
  // drawSvgPath はy軸を反転するので、PDF座標のyにマイナスを付けて渡す（原点0,0）
  let d = '';
  pts.forEach(([x, y], k) => {
    const [X, Y] = map(x, y);
    d += (k ? 'L' : 'M') + X.toFixed(2) + ' ' + (-Y).toFixed(2) + ' ';
  });
  if (close) d += 'Z';
  return d;
}

function ellipsePoints(x, y, w, h, n = 64) {
  const cx = x + w / 2, cy = y + h / 2, pts = [];
  for (let k = 0; k <= n; k++) {
    const t = (k / n) * Math.PI * 2;
    pts.push([cx + Math.cos(t) * w / 2, cy + Math.sin(t) * h / 2]);
  }
  return pts;
}

function rectPoints(x, y, w, h) {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
}

export function arrowHead(x1, y1, x2, y2, width) {
  const len = Math.max(8, width * 4.5);
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const a1 = ang + Math.PI * 0.85, a2 = ang - Math.PI * 0.85;
  return [[x2 + Math.cos(a1) * len, y2 + Math.sin(a1) * len], [x2, y2], [x2 + Math.cos(a2) * len, y2 + Math.sin(a2) * len]];
}

function rotVec(vx, vy, deg) {
  const r = deg * Math.PI / 180;
  return [vx * Math.cos(r) - vy * Math.sin(r), vx * Math.sin(r) + vy * Math.cos(r)];
}

function drawAnnot(page, a, map, rot, font) {
  const color = hexToRgb(a.color);
  const stroke = (pts, width, opts = {}) => {
    if (pts.length < 2) pts = [pts[0], [pts[0][0] + 0.01, pts[0][1] + 0.01]];
    page.drawSvgPath(pathFromPoints(pts, map, opts.close), {
      x: 0, y: 0,
      borderColor: color, borderWidth: width,
      borderOpacity: opts.opacity ?? 1,
      borderLineCap: LineCapStyle.Round,
      blendMode: opts.blend,
    });
  };
  const fill = (pts, opts = {}) => {
    page.drawSvgPath(pathFromPoints(pts, map, true), {
      x: 0, y: 0, color, opacity: opts.opacity ?? 1, blendMode: opts.blend,
    });
  };

  switch (a.type) {
    case 'ink':
      if (a.mode === 'marker') stroke(a.points, a.width, { opacity: 0.4, blend: BlendMode.Multiply });
      else stroke(a.points, a.width);
      break;
    case 'hl':
      for (const [x, y, w, h] of a.rects) {
        if (a.kind === 'highlight') fill(rectPoints(x, y, w, h), { opacity: 0.4, blend: BlendMode.Multiply });
        else if (a.kind === 'underline') stroke([[x, y + h * 0.95], [x + w, y + h * 0.95]], Math.max(0.8, h * 0.07));
        else stroke([[x, y + h * 0.55], [x + w, y + h * 0.55]], Math.max(0.8, h * 0.07));
      }
      break;
    case 'rect':
      stroke(rectPoints(a.x, a.y, a.w, a.h), a.width);
      break;
    case 'ellipse':
      stroke(ellipsePoints(a.x, a.y, a.w, a.h), a.width);
      break;
    case 'arrow':
      stroke([[a.x1, a.y1], [a.x2, a.y2]], a.width);
      stroke(arrowHead(a.x1, a.y1, a.x2, a.y2, a.width), a.width);
      break;
    case 'sign':
      for (const s of a.strokes) {
        const pts = s.map(([u, v]) => [a.x + u * a.w, a.y + v * a.h]);
        stroke(pts, a.width || 1.6);
      }
      break;
    case 'edit': {
      // 元の文字を背景色で隠して、新しい文字を書く
      page.drawSvgPath(pathFromPoints(rectPoints(a.x, a.y, a.w, a.h), map, true), { x: 0, y: 0, color: hexToRgb(a.bg || '#ffffff') });
      if (!font) break;
      const r = a.rot || 0;
      String(a.text || '').split('\n').forEach((line, k) => {
        if (!line) return;
        const [ox, oy] = rotVec(0, a.size * 0.88 + k * a.size * 1.3, r);
        const [X, Y] = map(a.tx + ox, a.ty + oy);
        page.drawText(line, { x: X, y: Y, size: a.size, font, color, rotate: degrees(rot - r) });
      });
      break;
    }
    case 'text': {
      if (!font) break;
      const lines = String(a.text || '').split('\n');
      const r = a.rot || 0;
      lines.forEach((line, k) => {
        if (!line) return;
        const [ox, oy] = rotVec(0, a.size * 0.88 + k * a.size * 1.3, r);
        const [X, Y] = map(a.x + ox, a.y + oy);
        page.drawText(line, { x: X, y: Y, size: a.size, font, color, rotate: degrees(rot - r) });
      });
      break;
    }
  }
}

// OCRの文字を「見えない文字」として行ごとに重ねる（検索・コピー用）
function drawOcr(page, lines, map, rot, font) {
  if (!font) return;
  for (const ln of lines) {
    const t = ln.t;
    if (!t || !t.trim()) continue;
    const size = ln.h * 0.85;
    if (!(size > 0.5)) continue;
    let squeeze = 100;
    try {
      const w = font.widthOfTextAtSize(t, size);
      if (w > 0) squeeze = Math.max(10, Math.min(400, ln.w / w * 100));
    } catch (_) {}
    const [X, Y] = map(ln.x, ln.y + ln.h * 0.85);
    try {
      page.pushOperators(pushGraphicsState(), setCharacterSqueeze(squeeze), setTextRenderingMode(TextRenderingMode.Invisible));
      page.drawText(t, { x: X, y: Y, size, font, rotate: degrees(rot) });
      page.pushOperators(popGraphicsState());
    } catch (e) { page.pushOperators(popGraphicsState()); }
  }
}

export { StandardFonts };
