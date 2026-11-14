// PDFの表示（連続スクロール・ピンチ拡大・テキストレイヤー）
import { pdfjs } from './pdfcore.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const MAX_CANVAS_PIXELS = 7_000_000; // iOSのcanvasメモリ上限対策

export class Viewer {
  constructor(body, pagesEl) {
    this.body = body;
    this.pagesEl = pagesEl;
    this.pages = [];
    this.zoom = 1;
    this.baseScale = 1;
    this.pdf = null;
    this.onPageChange = null;
    this.onPageRendered = null;
    this.current = 0;
    this.renderQueue = new Set();
    this.rendering = 0;
    this._bindPinch();
    this.body.addEventListener('scroll', () => this._onScroll(), { passive: true });
    window.addEventListener('resize', () => { if (this.pdf) this.relayout(true); });
  }

  get scale() { return this.baseScale * this.zoom; }

  async load(pdf, { ocr = {} } = {}) {
    this.destroy();
    this.pdf = pdf;
    this.ocr = ocr;
    const n = pdf.numPages;
    for (let i = 0; i < n; i++) {
      const page = await pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const div = document.createElement('div');
      div.className = 'page';
      div.dataset.index = i;
      div.innerHTML = '<div class="page-loading">' + (i + 1) + '</div>';
      const svg = document.createElementNS(SVGNS, 'svg');
      svg.setAttribute('class', 'annot-layer');
      svg.setAttribute('viewBox', `0 0 ${vp.width} ${vp.height}`);
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.dataset.index = i;
      div.append(svg);
      this.pagesEl.append(div);
      this.pages.push({ i, page, w: vp.width, h: vp.height, div, svg, canvas: null, renderedScale: 0, textLayer: null, task: null });
    }
    this.relayout(false);
    this._observe();
    this.scrollToPage(0, false);
  }

  destroy() {
    if (this.io) this.io.disconnect();
    for (const p of this.pages) { if (p.task) try { p.task.cancel(); } catch (_) {} this._release(p); }
    this.pages = [];
    this.pagesEl.innerHTML = '';
    this.pagesEl.style.width = '';
    if (this.pdf) { try { this.pdf.destroy(); } catch (_) {} }
    this.pdf = null;
    this.zoom = 1;
  }

  relayout(keepPosition) {
    const cw = this.body.clientWidth;
    const maxW = Math.max(...this.pages.map(p => p.w));
    // 横幅に合わせる（iPadの横向きでは広がりすぎないよう上限）
    const target = Math.min(cw - 24, 1100);
    this.baseScale = target / maxW;
    let anchor = null;
    if (keepPosition) anchor = this._anchor();
    const s = this.scale;
    for (const p of this.pages) {
      p.div.style.width = Math.round(p.w * s) + 'px';
      p.div.style.height = Math.round(p.h * s) + 'px';
      p.div.style.setProperty('--scale-factor', s);
    }
    this.pagesEl.style.width = Math.max(cw, Math.round(maxW * s) + 24) + 'px';
    if (anchor) this._restoreAnchor(anchor);
    this._scheduleVisible();
  }

  _anchor() {
    const p = this.pages[this.current];
    if (!p) return null;
    const top = this.body.scrollTop;
    const rel = (top - p.div.offsetTop) / p.div.offsetHeight;
    return { i: this.current, rel };
  }
  _restoreAnchor(a) {
    const p = this.pages[a.i];
    if (p) this.body.scrollTop = p.div.offsetTop + a.rel * p.div.offsetHeight;
  }

  setZoom(z, focal) {
    z = Math.max(0.5, Math.min(5, z));
    const old = this.zoom;
    if (Math.abs(z - old) < 0.001) return;
    const fx = focal ? focal.x : this.body.clientWidth / 2;
    const fy = focal ? focal.y : this.body.clientHeight / 2;
    const cx = this.body.scrollLeft + fx, cy = this.body.scrollTop + fy;
    this.zoom = z;
    this.relayout(false);
    const r = z / old;
    this.body.scrollLeft = cx * r - fx;
    this.body.scrollTop = cy * r - fy;
    this._scheduleVisible();
  }

  scrollToPage(i, smooth = true) {
    const p = this.pages[i];
    if (!p) return;
    this.body.scrollTo({ top: p.div.offsetTop - 8, behavior: smooth ? 'smooth' : 'auto' });
    this.current = i;
    this.onPageChange && this.onPageChange(i);
  }

  // ページ内の座標（pt）が見える位置へ
  scrollToPoint(i, y) {
    const p = this.pages[i];
    if (!p) return;
    const top = p.div.offsetTop + y * this.scale - this.body.clientHeight / 3;
    this.body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  _onScroll() {
    const mid = this.body.scrollTop + this.body.clientHeight * 0.35;
    let cur = 0;
    for (const p of this.pages) { if (p.div.offsetTop <= mid) cur = p.i; else break; }
    if (cur !== this.current) {
      this.current = cur;
      this.onPageChange && this.onPageChange(cur);
    }
    clearTimeout(this._st);
    this._st = setTimeout(() => this._scheduleVisible(), 120);
  }

  _observe() {
    this.io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        const p = this.pages[+e.target.dataset.index];
        p.visible = e.isIntersecting;
      }
      this._scheduleVisible();
    }, { root: this.body, rootMargin: '600px 0px' });
    for (const p of this.pages) this.io.observe(p.div);
  }

  _scheduleVisible() {
    const s = this.scale;
    for (const p of this.pages) {
      if (p.visible) {
        if (Math.abs(p.renderedScale - s) > 0.001) this.renderQueue.add(p.i);
      } else if (p.canvas && Math.abs(p.i - this.current) > 4) {
        this._release(p);
      }
    }
    this._pump();
  }

  async _pump() {
    while (this.rendering < 2 && this.renderQueue.size) {
      // 現在ページに近い順
      const list = [...this.renderQueue].sort((a, b) => Math.abs(a - this.current) - Math.abs(b - this.current));
      const i = list[0];
      this.renderQueue.delete(i);
      this.rendering++;
      this._render(this.pages[i]).catch(err => { if (err && err.name !== 'RenderingCancelledException') console.warn(err); })
        .finally(() => { this.rendering--; this._pump(); });
    }
  }

  async _render(p) {
    const s = this.scale;
    if (!p || Math.abs(p.renderedScale - s) < 0.001) return;
    let dpr = window.devicePixelRatio || 1;
    let px = p.w * s * dpr * p.h * s * dpr;
    if (px > MAX_CANVAS_PIXELS) dpr *= Math.sqrt(MAX_CANVAS_PIXELS / px);
    const vp = p.page.getViewport({ scale: s * dpr });
    const canvas = document.createElement('canvas');
    canvas.className = 'pdf';
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const ctx = canvas.getContext('2d');
    if (p.task) { try { p.task.cancel(); } catch (_) {} }
    const task = p.page.render({ canvasContext: ctx, viewport: vp });
    p.task = task;
    await task.promise;
    p.task = null;
    if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); }
    const loading = p.div.querySelector('.page-loading');
    if (loading) loading.remove();
    p.div.prepend(canvas);
    p.canvas = canvas;
    p.renderedScale = s;
    if (!p.textLayer) await this._renderText(p);
    this.onPageRendered && this.onPageRendered(p.i);
  }

  async _renderText(p) {
    const lib = await pdfjs();
    const div = document.createElement('div');
    div.className = 'textLayer';
    p.div.insertBefore(div, p.svg);
    p.textLayer = div;
    try {
      const tl = new lib.TextLayer({ textContentSource: p.page.streamTextContent(), container: div, viewport: p.page.getViewport({ scale: 1 }) });
      await tl.render();
      const end = document.createElement('div');
      end.className = 'endOfContent';
      div.append(end);
    } catch (e) { console.warn('textLayer', e); }
    this.renderOcrLayer(p.i);
  }

  // OCR結果を、選択できる透明テキストとして重ねる
  renderOcrLayer(i) {
    const p = this.pages[i];
    if (!p) return;
    let layer = p.div.querySelector('.ocrLayer');
    if (layer) layer.remove();
    const badge = p.div.querySelector('.ocr-badge');
    if (badge) badge.remove();
    const o = this.ocr && this.ocr[i];
    if (!o || !o.words || !o.words.length) return;
    layer = document.createElement('div');
    layer.className = 'ocrLayer';
    const ctx = document.createElement('canvas').getContext('2d');
    // 行ごとにまとめて、選択しやすくする
    for (const line of o.lines || []) {
      const span = document.createElement('span');
      span.textContent = line.t;
      span.style.left = (100 * line.x / p.w) + '%';
      span.style.top = (100 * line.y / p.h) + '%';
      const fs = line.h * 0.92;
      span.style.fontSize = `calc(var(--scale-factor) * ${fs.toFixed(2)}px)`;
      ctx.font = `${fs}px sans-serif`;
      const mw = ctx.measureText(line.t).width;
      if (mw > 0) span.style.transform = `scaleX(${(line.w / mw).toFixed(4)})`;
      layer.append(span);
    }
    p.div.insertBefore(layer, p.svg);
    const b = document.createElement('div');
    b.className = 'ocr-badge';
    b.textContent = 'OCR済';
    p.div.append(b);
  }

  _release(p) {
    if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
    p.renderedScale = 0;
  }

  // 画面座標 → ページ内pt
  clientToPage(i, cx, cy) {
    const p = this.pages[i];
    const r = p.div.getBoundingClientRect();
    return [(cx - r.left) / r.width * p.w, (cy - r.top) / r.height * p.h];
  }

  // ---------- ピンチ拡大 ----------
  _bindPinch() {
    let st = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
    this.body.addEventListener('touchstart', (e) => {
      if (e.touches.length === 2) {
        const r = this.body.getBoundingClientRect();
        const m = mid(e.touches);
        const fx = m.x - r.left, fy = m.y - r.top;
        st = { d0: dist(e.touches), fx, fy, cx: this.body.scrollLeft + fx, cy: this.body.scrollTop + fy, ratio: 1 };
        this.pagesEl.style.transformOrigin = `${st.cx}px ${st.cy}px`;
        this.onPinchStart && this.onPinchStart();
      }
    }, { passive: true });
    this.body.addEventListener('touchmove', (e) => {
      if (st && e.touches.length === 2) {
        e.preventDefault();
        let ratio = dist(e.touches) / st.d0;
        const z = Math.max(0.5, Math.min(5, this.zoom * ratio));
        ratio = z / this.zoom;
        st.ratio = ratio;
        this.pagesEl.style.transform = `scale(${ratio})`;
      }
    }, { passive: false });
    const end = (e) => {
      if (st && e.touches.length < 2) {
        const { ratio, fx, fy } = st;
        st = null;
        this.pagesEl.style.transform = '';
        this.setZoom(this.zoom * ratio, { x: fx, y: fy });
      }
    };
    this.body.addEventListener('touchend', end);
    this.body.addEventListener('touchcancel', end);
    // Safari の独自ジェスチャー（画面全体の拡大）を止める
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    // トラックパッド / Ctrl+ホイール
    this.body.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        const r = this.body.getBoundingClientRect();
        this.setZoom(this.zoom * Math.exp(-e.deltaY / 200), { x: e.clientX - r.left, y: e.clientY - r.top });
      }
    }, { passive: false });
  }
}
