// スキャン用の画像処理（書類の枠の検出・ゆがみ補正・見やすくする補正）

// ---------- 書類の枠を見つける ----------
// 小さく縮めた画像から書類の四角を探す。
// 1) 明るさのしきい値をいくつか変えて「紙らしいかたまり」の候補を作る
// 2) 候補ごとに四角を当てはめ、四辺にくっきりした境目があるか・四角らしいかで点数を付ける
// 3) 一番よい四角の各辺を、境目の線に合わせて微調整する
// 戻り値：[[x,y]×4]（左上・右上・右下・左下、0〜1の割合）または null
export function detectQuad(ctx, w, h) {
  const src = ctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  let g = new Float32Array(n);
  for (let i = 0, o = 0; i < n; i++, o += 4) g[i] = src[o] * 0.299 + src[o + 1] * 0.587 + src[o + 2] * 0.114;
  g = boxBlur(boxBlur(g, w, h, 1), w, h, 1);

  // 境目の強さ（ソーベル）
  const mag = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = g[i - w + 1] + 2 * g[i + 1] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - 1] - g[i + w - 1];
      const gy = g[i + w - 1] + 2 * g[i + w] + g[i + w + 1] - g[i - w - 1] - 2 * g[i - w] - g[i - w + 1];
      mag[i] = Math.hypot(gx, gy);
    }
  }
  const sorted = Float32Array.from(mag).sort();
  const magRef = Math.max(20, sorted[Math.floor(n * 0.97)]);

  // しきい値の候補（大津の値と、その前後）
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, g[i] | 0)]++;
  const otsu = otsuThreshold(hist, n);
  // 紙と、紙に近い明るさの背景（白っぽい布など）を分けられるよう、明るい側も細かく試す
  const cand = [otsu - 50, otsu - 25, otsu, otsu + 20, otsu + 45];
  for (let t = 150; t <= 230; t += 16) cand.push(t);
  const ths = [...new Set(cand.map(t => Math.max(20, Math.min(240, Math.round(t / 4) * 4))))].sort((a, b) => a - b);

  let best = null;
  const label = new Int32Array(n);
  const stack = new Int32Array(n);
  for (const th of ths) {
    label.fill(-1);
    let id = 0;
    for (let s0 = 0; s0 < n; s0++) {
      if (g[s0] <= th || label[s0] >= 0) continue;
      // かたまりを塗りつぶしながら、ふちの点を集める
      let sp = 0, area = 0;
      const edge = [];
      stack[sp++] = s0; label[s0] = id;
      while (sp) {
        const p = stack[--sp];
        area++;
        const x = p % w, y = (p / w) | 0;
        let border = x === 0 || y === 0 || x === w - 1 || y === h - 1;
        const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
        for (const q of nb) {
          if (q < 0) continue;
          if (g[q] > th) { if (label[q] < 0) { label[q] = id; stack[sp++] = q; } }
          else border = true;
        }
        if (border) edge.push(x, y);
      }
      id++;
      if (area < n * 0.06 || area > n * 0.96) continue;
      const quad = quadFromPoints(edge);
      if (!quad) continue;
      const qa = polyArea(quad) ;
      if (qa < n * 0.06 || !isConvex(quad)) continue;
      const fill = Math.min(1, area / qa);
      if (fill < 0.72) continue;
      const es = edgeScore(quad, mag, w, h, magRef);
      if (es < 0.18) continue;
      let border = 1;
      for (const [x, y] of quad) if (x < w * 0.015 || y < h * 0.015 || x > w * 0.985 || y > h * 0.985) border *= 0.8;
      const score = es * fill * fill * Math.pow(qa / n, 0.25) * border * angleScore(quad);
      if (!best || score > best.score) best = { quad, score, es };
    }
  }
  if (!best) return null;
  const refined = refineQuad(best.quad, mag, w, h);
  const q = refined || best.quad;
  return q.map(([x, y]) => [Math.min(1, Math.max(0, x / (w - 1))), Math.min(1, Math.max(0, y / (h - 1)))]);
}

function otsuThreshold(hist, n) {
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
  return th;
}

// ふちの点の凸包から、面積が最大に近い四角を選ぶ（傾いた書類にも強い）
function quadFromPoints(flat) {
  const pts = [];
  const step = Math.max(1, Math.floor(flat.length / 2 / 1500));
  for (let i = 0; i < flat.length; i += 2 * step) pts.push([flat[i], flat[i + 1]]);
  const hull = convexHull(pts);
  if (hull.length < 4) return null;
  // いちばん離れた2点（対角線）
  let a = 0, c = 0, dmax = -1;
  for (let i = 0; i < hull.length; i++) for (let j = i + 1; j < hull.length; j++) {
    const d = (hull[i][0] - hull[j][0]) ** 2 + (hull[i][1] - hull[j][1]) ** 2;
    if (d > dmax) { dmax = d; a = i; c = j; }
  }
  const A = hull[a], C = hull[c];
  const side = (P) => (C[0] - A[0]) * (P[1] - A[1]) - (C[1] - A[1]) * (P[0] - A[0]);
  let B = null, D = null, bmax = 0, dmin = 0;
  for (const P of hull) { const s = side(P); if (s > bmax) { bmax = s; B = P; } if (s < dmin) { dmin = s; D = P; } }
  if (!B || !D) return null;
  // 2本目の対角線で、もう一度いちばん面積が大きくなる点を探し直す
  const side2 = (P) => (D[0] - B[0]) * (P[1] - B[1]) - (D[1] - B[1]) * (P[0] - B[0]);
  let A2 = A, C2 = C, amax = 0, cmin = 0;
  for (const P of hull) { const s = side2(P); if (s > amax) { amax = s; C2 = P; } if (s < cmin) { cmin = s; A2 = P; } }
  return orderQuad([A2, B, C2, D]);
}

function convexHull(pts) {
  pts = pts.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
  for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

// 左上・右上・右下・左下の順に並べる
function orderQuad(q) {
  const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = q.slice().sort((p1, p2) => Math.atan2(p1[1] - cy, p1[0] - cx) - Math.atan2(p2[1] - cy, p2[0] - cx));
  // 角度順（右回り：左上から）に並んだので、x+yが最小の点を先頭に
  let k = 0, m = Infinity;
  sorted.forEach((p, i) => { if (p[0] + p[1] < m) { m = p[0] + p[1]; k = i; } });
  return [0, 1, 2, 3].map(i => sorted[(k + i) % 4]);
}

// 四辺にそって、境目がどれだけはっきりしているか（0〜1くらい）
function edgeScore(q, mag, w, h, ref) {
  const scores = [];
  for (let s = 0; s < 4; s++) {
    const [x1, y1] = q[s], [x2, y2] = q[(s + 1) % 4];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const nx = -(y2 - y1) / len, ny = (x2 - x1) / len;
    const vals = [];
    const N = 28;
    for (let k = 1; k < N; k++) {
      const t = k / N;
      let m = 0;
      for (let d = -2; d <= 2; d++) {
        const x = Math.round(x1 + (x2 - x1) * t + nx * d), y = Math.round(y1 + (y2 - y1) * t + ny * d);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        m = Math.max(m, mag[y * w + x]);
      }
      vals.push(Math.min(1, m / ref));
    }
    vals.sort((a, b) => a - b);
    // 辺の大部分で境目が見えているか（下から30%の値）
    scores.push(vals[Math.floor(vals.length * 0.3)]);
  }
  const mean = scores.reduce((a, b) => a + b, 0) / 4;
  return 0.5 * Math.min(...scores) + 0.5 * mean;
}

// 角が90°から大きく外れるものを少し減点（遠近で多少ゆがむのは許す）
function angleScore(q) {
  let sc = 1;
  for (let i = 0; i < 4; i++) {
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
    const ang = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
    if (ang < 45 || ang > 135) return 0;
    if (ang < 60 || ang > 120) sc *= 0.7;
  }
  return sc;
}

// 各辺を、近くの一番くっきりした境目に合わせて引き直し、交点を新しい角にする
function refineQuad(q, mag, w, h) {
  const diag = Math.hypot(w, h);
  const lines = [];
  for (let s = 0; s < 4; s++) {
    const [x1, y1] = q[s], [x2, y2] = q[(s + 1) % 4];
    const len = Math.hypot(x2 - x1, y2 - y1);
    const tx = (x2 - x1) / len, ty = (y2 - y1) / len, nx = -ty, ny = tx;
    const R = Math.max(3, Math.round(diag * 0.02));
    const pts = [];
    const N = 40;
    for (let k = 2; k < N - 1; k++) {
      const t = k / N;
      const bx = x1 + (x2 - x1) * t, by = y1 + (y2 - y1) * t;
      let bm = 0, bp = null;
      for (let d = -R; d <= R; d++) {
        const x = Math.round(bx + nx * d), y = Math.round(by + ny * d);
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        const m = mag[y * w + x];
        if (m > bm) { bm = m; bp = [x, y]; }
      }
      if (bp && bm > 15) pts.push(bp);
    }
    if (pts.length < 8) { lines.push(lineFrom([[x1, y1], [x2, y2]])); continue; }
    lines.push(fitLine(pts));
  }
  const out = [];
  for (let i = 0; i < 4; i++) {
    const p = intersect(lines[(i + 3) % 4], lines[i]);
    if (!p) return null;
    if (Math.hypot(p[0] - q[i][0], p[1] - q[i][1]) > diag * 0.06) return null;
    out.push(p);
  }
  return isConvex(out) ? out : null;
}

// 直線を「点(px,py)と向き(dx,dy)」で表す
function lineFrom([[x1, y1], [x2, y2]]) {
  const l = Math.hypot(x2 - x1, y2 - y1) || 1;
  return { px: x1, py: y1, dx: (x2 - x1) / l, dy: (y2 - y1) / l };
}
function fitLine(pts) {
  // 外れ値に強くするため、2回に分けて当てはめる
  let L = pcaLine(pts);
  const dist = (p) => Math.abs((p[0] - L.px) * L.dy - (p[1] - L.py) * L.dx);
  const ds = pts.map(dist).sort((a, b) => a - b);
  const lim = Math.max(1.5, ds[Math.floor(ds.length * 0.7)] * 1.5);
  const inl = pts.filter(p => dist(p) <= lim);
  if (inl.length >= 6) L = pcaLine(inl);
  return L;
}
function pcaLine(pts) {
  let mx = 0, my = 0;
  for (const [x, y] of pts) { mx += x; my += y; }
  mx /= pts.length; my /= pts.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { px: mx, py: my, dx: Math.cos(ang), dy: Math.sin(ang) };
}
function intersect(a, b) {
  const den = a.dx * b.dy - a.dy * b.dx;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.px - a.px) * b.dy - (b.py - a.py) * b.dx) / den;
  return [a.px + a.dx * t, a.py + a.dy * t];
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
