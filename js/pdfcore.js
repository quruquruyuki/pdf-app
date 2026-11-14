// pdf.js の読み込みと共通処理
let pdfjsLib = null;

export async function pdfjs() {
  if (pdfjsLib) return pdfjsLib;
  pdfjsLib = await import('../vendor/pdfjs/pdf.min.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  return pdfjsLib;
}

export async function openPdf(bytes) {
  const lib = await pdfjs();
  // pdf.js は渡した ArrayBuffer を手放す（detach）ので、必ずコピーを渡す
  const data = new Uint8Array(bytes.byteLength);
  data.set(new Uint8Array(bytes));
  const task = lib.getDocument({
    data,
    cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
    isEvalSupported: false,
  });
  return task.promise;
}

// ページを画像（dataURL）にする。maxW: 横幅px
export async function renderPageImage(pdfDoc, pageNo, maxW = 300, type = 'image/jpeg', extraRotate = 0) {
  const page = await pdfDoc.getPage(pageNo);
  const vp1 = page.getViewport({ scale: 1, rotation: (page.rotate + extraRotate) % 360 });
  const scale = maxW / vp1.width;
  const vp = page.getViewport({ scale, rotation: (page.rotate + extraRotate) % 360 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const url = canvas.toDataURL(type, 0.8);
  canvas.width = canvas.height = 0;
  return url;
}

// ページをcanvasに描く（OCR用など）
export async function renderPageCanvas(pdfDoc, pageNo, scale) {
  const page = await pdfDoc.getPage(pageNo);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  return { canvas, viewport: vp, page };
}

// 表示座標（回転を含む、scale=1のpt）→ PDF座標 の変換関数を作る
// box: [x0, y0, w, h]（CropBox）, rot: ページの /Rotate
export function displayToPdfMapper(box, rot) {
  const [x0, y0, w, h] = box;
  const r = ((rot % 360) + 360) % 360;
  if (r === 90) return (dx, dy) => [x0 + dy, y0 + dx];
  if (r === 180) return (dx, dy) => [x0 + w - dx, y0 + dy];
  if (r === 270) return (dx, dy) => [x0 + w - dy, y0 + h - dx];
  return (dx, dy) => [x0 + dx, y0 + h - dy];
}

export function isPdf(bytes) {
  const b = new Uint8Array(bytes, 0, Math.min(1024, bytes.byteLength));
  for (let i = 0; i < b.length - 4; i++) {
    if (b[i] === 0x25 && b[i + 1] === 0x50 && b[i + 2] === 0x44 && b[i + 3] === 0x46) return true; // %PDF
  }
  return false;
}
