// スキャン用の画像処理（書類の枠の検出・ゆがみ補正・見やすくする補正）

// ---------- 書類の枠を見つける ----------
// 小さく縮めた画像から、紙（まわりより明るい大きな四角）を探す。
// 戻り値：[[x,y]×4]（左上・右上・右下・左下、0〜1の割合）または null
export function detectQuad(ctx, w, h) {
  const src = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  let g = new Float32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) g[i] = src[o] * 0.299 + src[o + 1] * 0.587 + src[o + 2] * 0.114;
  g = boxBlur(boxBlur(g, w, h, 2), w, h, 2);

  // 大津の方法で「明るい／暗い」を分ける
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[g[i] | 0]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, best = 0, th = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = n - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; th = t; }
  }
  // 明暗の差が小さいときは見つからない扱い
  let mLo = 0, cLo = 0, mHi = 0, cHi = 0;
  for (let t = 0; t < 256; t++) { if (t <= th) { mLo += t * hist[t]; cLo += hist[t]; } else { mHi += t * hist[t]; cHi += hist[t]; } }
  if (!cLo || !cHi || (mHi / cHi - mLo / cLo) < 25) return null;

  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = g[i] > th ? 1 : 0;

  // いちばん大きい明るいかたまり（中央に近いものを優先）
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let bestArea = 0, bestId = -1, id = 0;
  const cx = w / 2, cy = h / 2;
  let bestScore = 0;
  for (let s = 0; s < n; s++) {
    if (!mask[s] || label[s] >= 0) continue;
    let sp = 0, area = 0, sx = 0, sy = 0;
    stack[sp++] = s; label[s] = id;
    while (sp) {
      const p = stack[--sp];
      area++;
      const x = p % w, y = (p / w) | 0;
      sx += x; sy += y;
      if (x > 0 && mask[p - 1] && label[p - 1] < 0) { label[p - 1] = id; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && label[p + 1] < 0) { label[p + 1] = id; stack[sp++] = p + 1; }
      if (y > 0 && mask[p - w] && label[p - w] < 0) { label[p - w] = id; stack[sp++] = p - w; }
      if (y < h - 1 && mask[p + w] && label[p + w] < 0) { label[p + w] = id; stack[sp++] = p + w; }
    }
    const d = Math.hypot(sx / area - cx, sy / area - cy) / Math.hypot(cx, cy);
    const score = area * (1.2 - d);
    if (score > bestScore) { bestScore = score; bestArea = area; bestId = id; }
    id++;
  }
  if (bestId < 0 || bestArea < n * 0.12 || bestArea > n * 0.97) return null;

  // 四隅：x+y と x−y が最大・最小になる点
  let tl = null, tr = null, br = null, bl = null;
  let vtl = Infinity, vtr = -Infinity, vbr = -Infinity, vbl = Infinity;
  for (let p = 0; p < n; p++) {
    if (label[p] !== bestId) continue;
    const x = p % w, y = (p / w) | 0;
    const a = x + y, b = x - y;
    if (a < vtl) { vtl = a; tl = [x, y]; }
    if (a > vbr) { vbr = a; br = [x, y]; }
    if (b > vtr) { vtr = b; tr = [x, y]; }
    if (b < vbl) { vbl = b; bl = [x, y]; }
  }
  const q = [tl, tr, br, bl].map(([x, y]) => [x / (w - 1), y / (h - 1)]);
  // 四角としておかしい（小さすぎる・ねじれている）ものは捨てる
  if (polyArea(q) < 0.1 || !isConvex(q)) return null;
  // 紙の面積と四角の面積が大きく違う＝四角ではない
  if (bestArea / n / polyArea(q) < 0.75) return null;
  return q;
}

function boxBlur(a, w, h, r) {
  const out = new Float32Array(a.length), tmp = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += a[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / (2 * r + 1);
      s += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

export function polyArea(q) {
  let s = 0;
  for (let i = 0; i < q.length; i++) { const [x1, y1] = q[i], [x2, y2] = q[(i + 1) % q.length]; s += x1 * y2 - x2 * y1; }
  return Math.abs(s) / 2;
}
export function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i], [bx, by] = q[(i + 1) % 4], [cx, cy] = q[(i + 2) % 4];
    const z = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(z) < 1e-9) return false;
    if (!sign) sign = Math.sign(z); else if (Math.sign(z) !== sign) return false;
  }
  return true;
}

export const defaultQuad = () => [[0.04, 0.04], [0.96, 0.04], [0.96, 0.96], [0.04, 0.96]];
export const fullQuad = () => [[0, 0], [1, 0], [1, 1], [0, 1]];

export function quadDiff(a, b) {
  if (!a || !b) return 1;
  let m = 0;
  for (let i = 0; i < 4; i++) m = Math.max(m, Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]));
  return m;
}

// ---------- ゆがみ補正 ----------
// 出力の長方形 → 元画像の四角 へのホモグラフィ
function homography(dst, src) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dst[i], [u, v] = src[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // ガウスの消去法
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

// srcCanvas の四角（ピクセル座標）を、まっすぐな長方形に引き伸ばす
export function warp(srcCanvas, quadPx, maxSide = 3508) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const [tl, tr, br, bl] = quadPx;
  let W = Math.max(d(tl, tr), d(bl, br)), H = Math.max(d(tl, bl), d(tr, br));
  const s = Math.min(1, maxSide / Math.max(W, H));
  W = Math.max(1, Math.round(W * s)); H = Math.max(1, Math.round(H * s));
  const hm = homography([[0, 0], [W, 0], [W, H], [0, H]], quadPx);
  const sw = srcCanvas.width, sh = srcCanvas.height;
  const sd = srcCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = W; out.height = H;
  const octx = out.getContext('2d');
  const img = octx.createImageData(W, H);
  const od = img.data;
  const [a, b, c, dd, e, f, g, hh] = hm;
  let o = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++, o += 4) {
      const z = g * x + hh * y + 1;
      let u = (a * x + b * y + c) / z, v = (dd * x + e * y + f) / z;
      if (u < 0) u = 0; else if (u > sw - 1.001) u = sw - 1.001;
      if (v < 0) v = 0; else if (v > sh - 1.001) v = sh - 1.001;
      const x0 = u | 0, y0 = v | 0, fx = u - x0, fy = v - y0;
      const p00 = (y0 * sw + x0) * 4, p10 = p00 + 4, p01 = p00 + sw * 4, p11 = p01 + 4;
      for (let k = 0; k < 3; k++) {
        const top = sd[p00 + k] + (sd[p10 + k] - sd[p00 + k]) * fx;
        const bot = sd[p01 + k] + (sd[p11 + k] - sd[p01 + k]) * fx;
        od[o + k] = top + (bot - top) * fy;
      }
      od[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

export function rotateCanvas(c, quarter) {
  quarter = ((quarter % 4) + 4) % 4;
  if (!quarter) return c;
  const out = document.createElement('canvas');
  const side = quarter % 2 === 1;
  out.width = side ? c.height : c.width;
  out.height = side ? c.width : c.height;
  const x = out.getContext('2d');
  x.translate(out.width / 2, out.height / 2);
  x.rotate(quarter * Math.PI / 2);
  x.drawImage(c, -c.width / 2, -c.height / 2);
  c.width = c.height = 0;
  return out;
}

// ---------- 見やすくする補正 ----------
// mode: 'auto'（影を消して紙を白く）/ 'color'（色そのまま少し明るく）/ 'gray' / 'bw'（白黒）/ 'none'
export function applyFilter(canvas, mode) {
  if (mode === 'none') return canvas;
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const n = W * H;

  if (mode === 'color') {
    stretch(d, 0.005);
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  // 紙の明るさ（背景）を、小さく縮めたマップで推定する
  const bs = Math.max(8, Math.round(Math.max(W, H) / 48));
  const bw = Math.ceil(W / bs), bh = Math.ceil(H / bs);
  const bg = new Float32Array(bw * bh * 3);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      // ブロックの中で明るい方の色（上位10%くらい）を紙の色とみなす
      const lums = [];
      for (let y = by * bs; y < Math.min(H, (by + 1) * bs); y += 2) {
        for (let x = bx * bs; x < Math.min(W, (bx + 1) * bs); x += 2) {
          const o = (y * W + x) * 4;
          lums.push([d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114, o]);
        }
      }
      lums.sort((p, q) => q[0] - p[0]);
      const top = lums.slice(0, Math.max(1, Math.round(lums.length * 0.1)));
      let r = 0, gg = 0, b = 0;
      for (const [, o] of top) { r += d[o]; gg += d[o + 1]; b += d[o + 2]; }
      const k = (by * bw + bx) * 3;
      bg[k] = r / top.length; bg[k + 1] = gg / top.length; bg[k + 2] = b / top.length;
    }
  }
  // 背景マップをなめらかにする
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) ch[i] = bg[i * 3 + c];
    const sm = boxBlur(boxBlur(ch, bw, bh, 1), bw, bh, 1);
    for (let i = 0; i < bw * bh; i++) bg[i * 3 + c] = Math.max(sm[i], 40);
  }
  const sample = (x, y, c) => {
    const fx = Math.min(bw - 1.001, Math.max(0, x / bs - 0.5)), fy = Math.min(bh - 1.001, Math.max(0, y / bs - 0.5));
    const x0 = fx | 0, y0 = fy | 0, ax = fx - x0, ay = fy - y0;
    const i00 = (y0 * bw + x0) * 3 + c, i10 = i00 + 3, i01 = i00 + bw * 3, i11 = i01 + 3;
    return (bg[i00] * (1 - ax) + bg[i10] * ax) * (1 - ay) + (bg[i01] * (1 - ax) + bg[i11] * ax) * ay;
  };
  // 割り算で影を消す → 黒を締める
  const lo = 0.25, hi = 0.92; // 0〜1の明るさで、この範囲を広げる
  for (let y = 0, o = 0; y < H; y++) {
    for (let x = 0; x < W; x++, o += 4) {
      for (let c = 0; c < 3; c++) {
        let v = d[o + c] / sample(x, y, c);
        v = (v - lo) / (hi - lo);
        d[o + c] = v <= 0 ? 0 : v >= 1 ? 255 : 255 * Math.pow(v, 1.15);
      }
    }
  }
  if (mode === 'gray' || mode === 'bw') {
    for (let o = 0; o < n * 4; o += 4) {
      let v = d[o] * 0.299 + d[o + 1] * 0.587 + d[o + 2] * 0.114;
      if (mode === 'bw') v = v > 165 ? 255 : (v < 110 ? 0 : (v - 110) * 255 / 55);
      d[o] = d[o + 1] = d[o + 2] = v;
    }
  } else {
    // 自動：色が薄いところ（紙）は少しだけ彩度を落として白をきれいに
    for (let o = 0; o < n * 4; o += 4) {
      const l = (d[o] + d[o + 1] + d[o + 2]) / 3;
      if (l > 200) {
        const t = (l - 200) / 55;
        for (let c = 0; c < 3; c++) d[o + c] = d[o + c] + (l - d[o + c]) * t * 0.6;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function stretch(d, cut) {
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let o = 0; o < d.length; o += 4) { hist[0][d[o]]++; hist[1][d[o + 1]]++; hist[2][d[o + 2]]++; }
  const n = d.length / 4;
  const luts = hist.map(hh => {
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += hh[lo]; if (acc > n * cut) break; }
    acc = 0;
    for (; hi > 0; hi--) { acc += hh[hi]; if (acc > n * cut) break; }
    const lut = new Uint8ClampedArray(256), r = Math.max(1, hi - lo);
    for (let v = 0; v < 256; v++) lut[v] = (v - lo) * 255 / r;
    return lut;
  });
  for (let o = 0; o < d.length; o += 4) { d[o] = luts[0][d[o]]; d[o + 1] = luts[1][d[o + 1]]; d[o + 2] = luts[2][d[o + 2]]; }
}
