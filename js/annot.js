// 注釈（マーカー・ペン・テキスト・図形・署名）
import { uid } from './db.js';
import { arrowHead } from './pdfedit.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export const COLORS = ['#ffd400', '#ff6b6b', '#3fbf6f', '#3b82f6', '#a855f7', '#111111', '#ffffff'];
const WIDTHS = {
  pen: [0.8, 1.6, 3.2],
  marker: [8, 13, 20],
  shape: [1, 2, 3.5],
  text: [10, 14, 20],
};
const lvl = (w) => (w === 1 ? 0 : w === 4 ? 2 : 1);

function svg(tag, attrs = {}) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function smoothPath(pts) {
  if (!pts.length) return '';
  if (pts.length < 3) return 'M' + pts.map(p => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join(' L');
  let d = `M${pts[0][0].toFixed(2)} ${pts[0][1].toFixed(2)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += ` Q${pts[i][0].toFixed(2)} ${pts[i][1].toFixed(2)} ${mx.toFixed(2)} ${my.toFixed(2)}`;
  }
  const l = pts[pts.length - 1];
  d += ` L${l[0].toFixed(2)} ${l[1].toFixed(2)}`;
  return d;
}

let measureCtx = null;
function textBox(a) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `${a.size}px "Hiragino Sans", "Noto Sans JP", sans-serif`;
  const lines = String(a.text || '').split('\n');
  const w = Math.max(a.size, ...lines.map(l => measureCtx.measureText(l).width));
  const h = a.size * 1.3 * lines.length;
  return { w, h };
}

function rotPt(x, y, cx, cy, deg) {
  const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
}

export function bbox(a) {
  switch (a.type) {
    case 'ink': {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const [x, y] of a.points) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
      const p = a.width / 2;
      return { x: x1 - p, y: y1 - p, w: x2 - x1 + 2 * p, h: y2 - y1 + 2 * p };
    }
    case 'hl': {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const [x, y, w, h] of a.rects) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x + w); y2 = Math.max(y2, y + h); }
      return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
    }
    case 'rect': case 'ellipse': case 'sign':
      return { x: a.x, y: a.y, w: a.w, h: a.h };
    case 'arrow': {
      const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
      return { x: x - 6, y: y - 6, w: Math.abs(a.x2 - a.x1) + 12, h: Math.abs(a.y2 - a.y1) + 12 };
    }
    case 'edit': {
      const { w, h } = textBox(a);
      if (a.rot) return { x: a.x, y: a.y, w: a.w, h: a.h };
      return { x: Math.min(a.x, a.tx), y: Math.min(a.y, a.ty), w: Math.max(a.x + a.w, a.tx + w) - Math.min(a.x, a.tx), h: Math.max(a.y + a.h, a.ty + h) - Math.min(a.y, a.ty) };
    }
    case 'text': {
      const { w, h } = textBox(a);
      const r = a.rot || 0;
      if (!r) return { x: a.x, y: a.y, w, h };
      const pts = [[a.x, a.y], [a.x + w, a.y], [a.x + w, a.y + h], [a.x, a.y + h]].map(([x, y]) => rotPt(x, y, a.x, a.y, r));
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const l = dx * dx + dy * dy;
  let t = l ? ((px - x1) * dx + (py - y1) * dy) / l : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hits(a, x, y, tol) {
  if (a.type === 'ink') {
    const pts = a.points;
    for (let i = 0; i < pts.length - 1; i++) if (distToSeg(x, y, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) < tol + a.width / 2) return true;
    return pts.length === 1 && Math.hypot(x - pts[0][0], y - pts[0][1]) < tol + a.width;
  }
  if (a.type === 'arrow') return distToSeg(x, y, a.x1, a.y1, a.x2, a.y2) < tol + a.width;
  const b = bbox(a);
  return x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
}

export function translate(a, dx, dy) {
  switch (a.type) {
    case 'ink': a.points = a.points.map(([x, y]) => [x + dx, y + dy]); break;
    case 'hl': a.rects = a.rects.map(([x, y, w, h]) => [x + dx, y + dy, w, h]); break;
    case 'arrow': a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy; break;
    case 'edit': a.x += dx; a.y += dy; a.tx += dx; a.ty += dy; break;
    default: a.x += dx; a.y += dy;
  }
}

function scaleAnnot(a, f) {
  const b = bbox(a), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const S = (x, y) => [cx + (x - cx) * f, cy + (y - cy) * f];
  switch (a.type) {
    case 'ink': a.points = a.points.map(([x, y]) => S(x, y)); a.width *= f; break;
    case 'arrow': [a.x1, a.y1] = S(a.x1, a.y1); [a.x2, a.y2] = S(a.x2, a.y2); break;
    case 'text': [a.x, a.y] = S(a.x, a.y); a.size *= f; break;
    case 'hl': break;
    case 'edit': [a.x, a.y] = S(a.x, a.y); [a.tx, a.ty] = S(a.tx, a.ty); a.w *= f; a.h *= f; a.size *= f; break;
    default: [a.x, a.y] = S(a.x, a.y); a.w *= f; a.h *= f;
  }
}

// ページ整理で90°単位に回したときの座標変換（w,hは回転前の表示サイズ）
export function rotateAnnot(a, deg, w, h) {
  deg = ((deg % 360) + 360) % 360;
  if (!deg) return a;
  let W = w, H = h;
  const steps = deg / 90;
  for (let k = 0; k < steps; k++) {
    const f = (x, y) => [H - y, x]; // 時計回りに90°
    const rectT = (x, y, rw, rh) => { const [ax, ay] = f(x, y + rh); return [ax, ay, rh, rw]; };
    switch (a.type) {
      case 'ink': a.points = a.points.map(([x, y]) => f(x, y)); break;
      case 'hl': a.rects = a.rects.map(r => rectT(...r)); break;
      case 'arrow': [a.x1, a.y1] = f(a.x1, a.y1); [a.x2, a.y2] = f(a.x2, a.y2); break;
      case 'text': [a.x, a.y] = f(a.x, a.y); a.rot = ((a.rot || 0) + 90) % 360; break;
      case 'sign': {
        const abs = a.strokes.map(s => s.map(([u, v]) => f(a.x + u * a.w, a.y + v * a.h)));
        [a.x, a.y, a.w, a.h] = rectT(a.x, a.y, a.w, a.h);
        a.strokes = abs.map(s => s.map(([x, y]) => [(x - a.x) / a.w, (y - a.y) / a.h]));
        break;
      }
      case 'edit': [a.tx, a.ty] = f(a.tx, a.ty); [a.x, a.y, a.w, a.h] = rectT(a.x, a.y, a.w, a.h); a.rot = ((a.rot || 0) + 90) % 360; break;
      default: [a.x, a.y, a.w, a.h] = rectT(a.x, a.y, a.w, a.h);
    }
    [W, H] = [H, W];
  }
  return a;
}

export class Annotator {
  constructor(viewer) {
    this.v = viewer;
    this.data = {};       // { pageIndex: [annot] }
    this.tool = null;     // null = 閲覧
    this.color = { pen: '#111111', marker: '#ffd400', text: '#111111', shape: '#ff6b6b' };
    this.widthLevel = 2;
    this.pencilOnly = false;
    this.undoStack = [];
    this.redoStack = [];
    this.selected = null; // { i, id }
    this.onChange = null;
    this.onSelect = null;
    this.onTextRequest = null; // async (initial) => string|null
    this.pendingSign = null;
  }

  load(data) {
    this.data = data || {};
    this.undoStack = []; this.redoStack = [];
    this.selected = null;
  }

  attach() {
    for (const p of this.v.pages) this._bindPage(p);
    this.renderAll();
    this._applyMode();
  }

  get kind() {
    const t = this.tool;
    if (t === 'pen' || t === 'marker') return t;
    if (t === 'text') return 'text';
    return 'shape';
  }
  get currentColor() { return this.color[this.kind]; }
  set currentColor(c) { this.color[this.kind] = c; }
  get currentWidth() {
    const k = this.tool === 'pen' ? 'pen' : this.tool === 'marker' ? 'marker' : this.tool === 'text' ? 'text' : 'shape';
    return WIDTHS[k][lvl(this.widthLevel)];
  }

  setTool(t) {
    this.tool = t;
    this.deselect();
    this._applyMode();
  }

  _applyMode() {
    const drawing = this.tool && this.tool !== 'select';
    for (const p of this.v.pages) {
      p.svg.classList.toggle('drawing', !!drawing || !!this.pendingSign);
      p.svg.classList.toggle('pencil', !!drawing && this.pencilOnly && (this.tool === 'pen' || this.tool === 'marker'));
      p.svg.classList.toggle('selecting', this.tool === 'select');
      // タップだけで使うツールは、指でスクロールできるようにする
      p.svg.classList.toggle('tapmode', this.tool === 'edittext' || this.tool === 'text');
    }
    // 描いている間は文字選択を止める
    document.body.classList.toggle('annotating', !!this.tool);
    document.body.classList.toggle('edittext-mode', this.tool === 'edittext');
    for (const p of this.v.pages) {
      if (p.textLayer) p.textLayer.style.pointerEvents = this.tool ? 'none' : '';
      const o = p.div.querySelector('.ocrLayer');
      if (o) o.style.pointerEvents = this.tool ? 'none' : '';
    }
  }

  // ---------- 履歴 ----------
  _snapshot() {
    this.undoStack.push(JSON.stringify(this.data));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.data));
    this.data = JSON.parse(this.undoStack.pop());
    this.deselect(); this.renderAll(); this._changed();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.data));
    this.data = JSON.parse(this.redoStack.pop());
    this.deselect(); this.renderAll(); this._changed();
  }
  _changed() { this.onChange && this.onChange(this.data); }

  add(i, a) {
    this._snapshot();
    a.id = a.id || uid();
    (this.data[i] = this.data[i] || []).push(a);
    this.renderPage(i);
    this._changed();
    return a;
  }
  remove(i, id) {
    const list = this.data[i] || [];
    const k = list.findIndex(a => a.id === id);
    if (k < 0) return;
    this._snapshot();
    list.splice(k, 1);
    this.renderPage(i);
    this._changed();
  }
  find(i, id) { return (this.data[i] || []).find(a => a.id === id); }

  // ---------- 描画 ----------
  renderAll() { for (const p of this.v.pages) this.renderPage(p.i); }

  renderPage(i) {
    const p = this.v.pages[i];
    if (!p) return;
    const s = p.svg;
    [...s.querySelectorAll('g.annot, .sel-box, .live')].forEach(e => e.remove());
    for (const a of this.data[i] || []) s.append(this._el(a));
    if (this.selected && this.selected.i === i) this._drawSel();
  }

  _el(a) {
    const g = svg('g', { class: 'annot', 'data-id': a.id });
    switch (a.type) {
      case 'ink': {
        const path = svg('path', { d: smoothPath(a.points), fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
        if (a.mode === 'marker') { path.setAttribute('stroke-opacity', '0.4'); path.style.mixBlendMode = 'multiply'; }
        g.append(path);
        break;
      }
      case 'hl':
        for (const [x, y, w, h] of a.rects) {
          if (a.kind === 'highlight') {
            const r = svg('rect', { x, y, width: w, height: h, fill: a.color, 'fill-opacity': 0.4 });
            r.style.mixBlendMode = 'multiply';
            g.append(r);
          } else {
            const yy = a.kind === 'underline' ? y + h * 0.95 : y + h * 0.55;
            g.append(svg('line', { x1: x, y1: yy, x2: x + w, y2: yy, stroke: a.color, 'stroke-width': Math.max(0.8, h * 0.07) }));
          }
        }
        break;
      case 'rect':
        g.append(svg('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linejoin': 'round' }));
        break;
      case 'ellipse':
        g.append(svg('ellipse', { cx: a.x + a.w / 2, cy: a.y + a.h / 2, rx: a.w / 2, ry: a.h / 2, fill: 'none', stroke: a.color, 'stroke-width': a.width }));
        break;
      case 'arrow': {
        g.append(svg('line', { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round' }));
        const hd = arrowHead(a.x1, a.y1, a.x2, a.y2, a.width);
        g.append(svg('polyline', { points: hd.map(p => p.join(',')).join(' '), fill: 'none', stroke: a.color, 'stroke-width': a.width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        break;
      }
      case 'sign':
        for (const st of a.strokes) {
          const pts = st.map(([u, v]) => [a.x + u * a.w, a.y + v * a.h]);
          g.append(svg('path', { d: smoothPath(pts), fill: 'none', stroke: a.color, 'stroke-width': a.width || 1.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
        }
        break;
      case 'edit': {
        g.append(svg('rect', { x: a.x, y: a.y, width: a.w, height: a.h, fill: a.bg || '#ffffff' }));
        const t = svg('text', { x: a.tx, y: a.ty, fill: a.color, 'font-size': a.size, 'font-family': '"Hiragino Sans","Noto Sans JP",sans-serif' });
        if (a.rot) t.setAttribute('transform', `rotate(${a.rot} ${a.tx} ${a.ty})`);
        String(a.text || '').split('\n').forEach((line, k) => {
          const ts = svg('tspan', { x: a.tx, y: a.ty + a.size * 0.88 + k * a.size * 1.3 });
          ts.textContent = line || ' ';
          t.append(ts);
        });
        g.append(t);
        break;
      }
      case 'text': {
        const t = svg('text', { x: a.x, y: a.y, fill: a.color, 'font-size': a.size, 'font-family': '"Hiragino Sans","Noto Sans JP",sans-serif' });
        if (a.rot) t.setAttribute('transform', `rotate(${a.rot} ${a.x} ${a.y})`);
        String(a.text || '').split('\n').forEach((line, k) => {
          const ts = svg('tspan', { x: a.x, y: a.y + a.size * 0.88 + k * a.size * 1.3 });
          ts.textContent = line || ' ';
          t.append(ts);
        });
        g.append(t);
        break;
      }
    }
    const b = bbox(a);
    const pad = 4;
    g.append(svg('rect', { class: 'hit', x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, fill: 'transparent' }));
    return g;
  }

  // ---------- 入力 ----------
  _bindPage(p) {
    const el = p.svg;
    let cur = null;
    const tol = () => 8 / this.v.scale;

    // Apple Pencil だけで描く設定のとき、ペンのタッチだけスクロールを止める
    el.addEventListener('touchstart', (e) => {
      if (!el.classList.contains('pencil')) return;
      const t = e.touches[0];
      if (t && t.touchType === 'stylus') e.preventDefault();
    }, { passive: false });

    el.addEventListener('pointerdown', (e) => {
      if (e.isPrimary === false) { cur = null; this._clearLive(p); return; }
      const [x, y] = this.v.clientToPage(p.i, e.clientX, e.clientY);

      // 署名の配置
      if (this.pendingSign) {
        const sg = this.pendingSign; this.pendingSign = null;
        const w = 150, h = w * sg.ratio;
        const a = this.add(p.i, { type: 'sign', x: x - w / 2, y: y - h / 2, w, h, strokes: sg.strokes, color: sg.color || '#1a237e', width: 1.6 });
        this._applyMode();
        this.select(p.i, a.id);
        return;
      }

      if (this.tool === 'select') {
        const hit = this._hitTest(p.i, x, y, tol());
        if (hit) {
          this.select(p.i, hit.id);
          cur = { mode: 'move', x, y, moved: false, a: hit };
          el.setPointerCapture(e.pointerId);
          e.preventDefault();
        } else this.deselect();
        return;
      }
      if (!this.tool) return;
      if (this.pencilOnly && (this.tool === 'pen' || this.tool === 'marker') && e.pointerType !== 'pen' && e.pointerType !== 'mouse') return;
      e.preventDefault();
      el.setPointerCapture(e.pointerId);

      if (this.tool === 'eraser') {
        cur = { mode: 'erase', snap: false };
        this._erase(p.i, x, y, tol(), cur);
        return;
      }
      if (this.tool === 'text') {
        cur = { mode: 'text', x, y };
        return;
      }
      if (this.tool === 'edittext') {
        cur = { mode: 'edittext', x, y };
        return;
      }
      if (this.tool === 'pen' || this.tool === 'marker') {
        cur = { mode: 'ink', pts: [[x, y]], live: svg('path', { class: 'live', fill: 'none', stroke: this.currentColor, 'stroke-width': this.currentWidth, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }) };
        if (this.tool === 'marker') { cur.live.setAttribute('stroke-opacity', '0.4'); cur.live.style.mixBlendMode = 'multiply'; }
        el.append(cur.live);
        return;
      }
      cur = { mode: 'shape', x0: x, y0: y, x, y, live: null };
    });

    el.addEventListener('pointermove', (e) => {
      if (!cur) return;
      const [x, y] = this.v.clientToPage(p.i, e.clientX, e.clientY);
      if (cur.mode === 'move') {
        const dx = x - cur.x, dy = y - cur.y;
        if (!cur.moved && Math.hypot(dx, dy) < 2 / this.v.scale) return;
        if (!cur.moved) { this._snapshot(); cur.moved = true; this._hideMenus(); }
        translate(cur.a, dx, dy);
        cur.x = x; cur.y = y;
        this.renderPage(p.i);
        return;
      }
      if (cur.mode === 'erase') { this._erase(p.i, x, y, tol(), cur); return; }
      if (cur.mode === 'ink') {
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events) {
          const [cx, cy] = this.v.clientToPage(p.i, ev.clientX, ev.clientY);
          const last = cur.pts[cur.pts.length - 1];
          if (Math.hypot(cx - last[0], cy - last[1]) > 0.7 / this.v.scale) cur.pts.push([cx, cy]);
        }
        cur.live.setAttribute('d', smoothPath(cur.pts));
        return;
      }
      if (cur.mode === 'shape') {
        cur.x = x; cur.y = y;
        if (cur.live) cur.live.remove();
        const a = this._shapeFrom(cur);
        if (a) { cur.live = this._el(a); cur.live.classList.add('live'); el.append(cur.live); }
      }
    });

    const up = async (e) => {
      if (!cur) return;
      const c = cur; cur = null;
      if (c.mode === 'move') { if (c.moved) { this._changed(); this._drawSel(); this.onSelect && this.onSelect(this.selected); } return; }
      if (c.mode === 'erase') { if (c.snap) this._changed(); return; }
      if (c.mode === 'ink') {
        c.live.remove();
        if (e.type === 'pointercancel' && c.pts.length < 3) return;
        let pts = c.pts;
        if (this.tool === 'marker' && pts.length > 2) pts = straighten(pts);
        this.add(p.i, { type: 'ink', mode: this.tool, points: pts.map(([x, y]) => [+x.toFixed(2), +y.toFixed(2)]), color: this.currentColor, width: this.currentWidth });
        return;
      }
      if (c.mode === 'shape') {
        if (c.live) c.live.remove();
        const a = this._shapeFrom(c);
        if (a) this.add(p.i, a);
        return;
      }
      if (c.mode === 'edittext' && e.type !== 'pointercancel') {
        const hit = (this.data[p.i] || []).slice().reverse().find(a => a.type === 'edit' && hits(a, c.x, c.y, 2));
        this.onEditTextAt && this.onEditTextAt(p.i, c.x, c.y, hit || null);
        return;
      }
      if (c.mode === 'text' && e.type !== 'pointercancel') {
        const text = this.onTextRequest ? await this.onTextRequest('') : null;
        if (text && text.trim()) {
          const a = this.add(p.i, { type: 'text', x: c.x, y: c.y - this.currentWidth * 0.6, size: this.currentWidth, color: this.currentColor, text, rot: 0 });
          this.setTool('select');
          this.select(p.i, a.id);
          this.onToolChanged && this.onToolChanged('select');
        }
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  _clearLive(p) { p.svg.querySelectorAll('.live').forEach(e => e.remove()); }

  _shapeFrom(c) {
    const w = Math.abs(c.x - c.x0), h = Math.abs(c.y - c.y0);
    if (Math.hypot(w, h) < 4) return null;
    const color = this.color.shape, width = this.currentWidth;
    if (this.tool === 'arrow') return { type: 'arrow', x1: c.x0, y1: c.y0, x2: c.x, y2: c.y, color, width };
    return { type: this.tool, x: Math.min(c.x, c.x0), y: Math.min(c.y, c.y0), w, h, color, width };
  }

  _hitTest(i, x, y, tol) {
    const list = this.data[i] || [];
    for (let k = list.length - 1; k >= 0; k--) if (hits(list[k], x, y, tol)) return list[k];
    return null;
  }

  _erase(i, x, y, tol, cur) {
    const hit = this._hitTest(i, x, y, tol);
    if (!hit) return;
    if (!cur.snap) { this._snapshot(); cur.snap = true; }
    const list = this.data[i];
    list.splice(list.indexOf(hit), 1);
    this.renderPage(i);
  }

  // ---------- 選択 ----------
  select(i, id) {
    this.selected = { i, id };
    this.renderPage(i);
    this.onSelect && this.onSelect(this.selected);
  }
  deselect() {
    const s = this.selected;
    this.selected = null;
    if (s) this.renderPage(s.i);
    this.onSelect && this.onSelect(null);
  }
  _hideMenus() { this.onSelect && this.onSelect(null, true); }
  _drawSel() {
    const s = this.selected;
    const a = s && this.find(s.i, s.id);
    if (!a) return;
    const b = bbox(a);
    const pad = 4 / this.v.scale + 2;
    this.v.pages[s.i].svg.append(svg('rect', { class: 'sel-box', x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2 }));
  }
  selectedClientRect() {
    const s = this.selected;
    const a = s && this.find(s.i, s.id);
    if (!a) return null;
    const b = bbox(a);
    const r = this.v.pages[s.i].div.getBoundingClientRect();
    const k = r.width / this.v.pages[s.i].w;
    return { left: r.left + b.x * k, top: r.top + b.y * k, width: b.w * k, height: b.h * k };
  }
  deleteSelected() {
    const s = this.selected;
    if (!s) return;
    this.selected = null;
    this.remove(s.i, s.id);
    this.onSelect && this.onSelect(null);
  }
  updateSelected(fn) {
    const s = this.selected;
    const a = s && this.find(s.i, s.id);
    if (!a) return;
    this._snapshot();
    fn(a);
    this.renderPage(s.i);
    this._changed();
    this.onSelect && this.onSelect(this.selected);
  }
  scaleSelected(f) { this.updateSelected(a => scaleAnnot(a, f)); }

  // ---------- テキスト選択からハイライト ----------
  addFromSelection(kind, rectsByPage) {
    for (const [i, rects] of Object.entries(rectsByPage)) {
      if (!rects.length) continue;
      const color = kind === 'highlight' ? this.color.marker : (kind === 'underline' ? '#3b82f6' : '#ff3b30');
      this.add(+i, { type: 'hl', kind, rects, color });
    }
  }

  // 既存の注釈を置き換える（履歴付き）
  replace(i, id, next) {
    const list = this.data[i] || [];
    const k = list.findIndex(a => a.id === id);
    if (k < 0) return;
    this._snapshot();
    list[k] = { ...next, id };
    this.renderPage(i);
    this._changed();
  }

  placeSign(sig) {
    this.pendingSign = sig;
    this.tool = null;
    this._applyMode();
  }
}

// マーカーの線がほぼ水平ならまっすぐにする（文字の上に引きやすく）
function straighten(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 20) return pts;
  let maxDev = 0;
  for (const p of pts) maxDev = Math.max(maxDev, distToSeg(p[0], p[1], a[0], a[1], b[0], b[1]));
  if (maxDev < Math.max(3, len * 0.06)) return [a, b];
  return pts;
}
