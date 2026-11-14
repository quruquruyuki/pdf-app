// ページ整理（並べ替え・回転・削除・複製・挿入・抽出）
import { $, h, toast, progress, sheet } from './ui.js';
import { openPdf, renderPageImage, isPdf } from './pdfcore.js';
import { buildFromPlan, imagesToPdf } from './pdfedit.js';
import { rotateAnnot } from './annot.js';

let state = null;

export function openOrganizer(ctx) {
  // ctx: { bytes, pdf, annots, ocr, onDone(result), onExtract(bytes), onCancel() }
  return new Promise(async (resolve) => {
    state = { ctx, items: [], sources: { main: ctx.bytes }, extraCount: 0, resolve };
    for (let i = 0; i < ctx.pdf.numPages; i++) {
      const pg = await ctx.pdf.getPage(i + 1);
      const vp = pg.getViewport({ scale: 1 });
      state.items.push({ key: 'm' + i, src: 'main', index: i, rotate: 0, w: vp.width, h: vp.height, thumb: null, pdf: ctx.pdf, selected: false });
    }
    show();
  });
}

function show() {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('#organizer').classList.add('active');
  render();
  loadThumbs();
}

function close(result) {
  const r = state.resolve;
  for (const pdf of Object.values(state.extraPdfs || {})) try { pdf.destroy(); } catch (_) {}
  state = null;
  $('#organizer').classList.remove('active');
  $('#viewer').classList.add('active');
  r(result);
}

async function loadThumbs() {
  const st = state;
  for (const it of st.items) {
    if (st !== state) return;
    if (it.thumb || it.kind === 'blank') continue;
    try {
      it.thumb = await renderPageImage(it.pdf, it.index + 1, 220);
      const img = document.querySelector(`.org-item[data-key="${it.key}"] img`);
      if (img) img.src = it.thumb;
    } catch (e) { console.warn(e); }
  }
}

function render() {
  const grid = $('#orgGrid');
  grid.innerHTML = '';
  state.items.forEach((it, k) => {
    const img = h('img', { src: it.thumb || 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', draggable: 'false' });
    const rot = it.rotate % 360;
    const sideways = rot === 90 || rot === 270;
    img.style.transform = `rotate(${rot}deg)` + (sideways ? ` scale(${Math.min(1, it.w / it.h, it.h / it.w) + 0.0})` : '');
    if (it.kind === 'blank') img.style.aspectRatio = `${it.w} / ${it.h}`;
    const el = h('div', { class: 'org-item' + (it.selected ? ' selected' : ''), 'data-key': it.key },
      h('div', { class: 'imgwrap' }, img), h('span', {}, String(k + 1)));
    bindItem(el, it);
    grid.append(el);
  });
  updateButtons();
}

function updateButtons() {
  const n = state.items.filter(i => i.selected).length;
  for (const id of ['orgRotL', 'orgRotR', 'orgDelete', 'orgDup', 'orgExtract']) $('#' + id).disabled = !n;
  $('.org-hint').textContent = n ? `${n}ページ選択中` : 'タップで選択、長押しして並べ替え';
}

function bindItem(el, it) {
  let timer = null, start = null, dragging = false, ghost = null;
  el.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY };
    // 指が他のページの上に移っても、このページにイベントが届くようにする
    try { el.setPointerCapture(e.pointerId); } catch (_) {}
    timer = setTimeout(() => {
      dragging = true;
      el.classList.add('dragging');
      $('#orgGrid').classList.add('dragging-active');
      ghost = el.querySelector('img').cloneNode();
      ghost.className = 'org-ghost';
      document.body.append(ghost);
      moveGhost(e.clientX, e.clientY);
      if (navigator.vibrate) navigator.vibrate(10);
    }, 380);
  });
  const moveGhost = (x, y) => { if (ghost) { ghost.style.left = x + 'px'; ghost.style.top = y + 'px'; } };
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    if (!dragging) {
      if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) { clearTimeout(timer); start = null; }
      return;
    }
    moveGhost(e.clientX, e.clientY);
    document.querySelectorAll('.org-drop-before, .org-drop-after').forEach(x => x.classList.remove('org-drop-before', 'org-drop-after'));
    const t = targetAt(e.clientX, e.clientY);
    if (t && t !== el) t.classList.add(isAfter(t, e.clientX) ? 'org-drop-after' : 'org-drop-before');
  });
  el.addEventListener('touchstart', () => {}, { passive: true });
  // 長押しドラッグ中はスクロールさせない
  el.addEventListener('touchmove', (e) => { if (dragging) e.preventDefault(); }, { passive: false });
  el.addEventListener('pointerup', (e) => {
    clearTimeout(timer);
    if (dragging) {
      const t = targetAt(e.clientX, e.clientY);
      const after = t ? isAfter(t, e.clientX) : false;
      finishDrag();
      if (t && t !== el) {
        const from = state.items.indexOf(it);
        state.items.splice(from, 1);
        const to = state.items.findIndex(x => x.key === t.dataset.key) + (after ? 1 : 0);
        state.items.splice(to, 0, it);
        render();
      }
    } else if (start) {
      it.selected = !it.selected;
      el.classList.toggle('selected', it.selected);
      updateButtons();
    }
    start = null;
  });
  el.addEventListener('pointercancel', () => { clearTimeout(timer); finishDrag(); start = null; });
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  function finishDrag() {
    dragging = false;
    el.classList.remove('dragging');
    $('#orgGrid').classList.remove('dragging-active');
    if (ghost) ghost.remove();
    ghost = null;
    document.querySelectorAll('.org-drop-before, .org-drop-after').forEach(x => x.classList.remove('org-drop-before', 'org-drop-after'));
  }
}

// ページの右半分に落としたら、そのページの後ろに入れる
function isAfter(t, x) {
  const r = t.getBoundingClientRect();
  return x > r.left + r.width / 2;
}

function targetAt(x, y) {
  const g = document.querySelector('.org-ghost');
  if (g) g.style.display = 'none';
  const el = document.elementFromPoint(x, y);
  if (g) g.style.display = '';
  return el && el.closest('.org-item');
}

const selected = () => state.items.filter(i => i.selected);

function rotate(d) {
  for (const it of selected()) it.rotate = ((it.rotate + d) % 360 + 360) % 360;
  render();
}
function del() {
  const s = selected();
  if (s.length === state.items.length) { toast('すべてのページは削除できません'); return; }
  state.items = state.items.filter(i => !i.selected);
  render();
}
function dup() {
  const out = [];
  for (const it of state.items) {
    out.push(it);
    if (it.selected) out.push({ ...it, key: it.key + '_' + Math.random().toString(36).slice(2, 6), selected: false, dupOf: it.key });
  }
  state.items = out;
  render();
}

async function insert() {
  const where = await sheet('ページを挿入', [
    { icon: '📄', label: 'PDFや画像から挿入', value: 'file' },
    { icon: '⬜', label: '白紙のページを挿入', value: 'blank' },
  ]);
  if (!where) return;
  const s = selected();
  const pos = s.length ? state.items.indexOf(s[s.length - 1]) + 1 : state.items.length;
  if (where === 'blank') {
    const ref = state.items[Math.max(0, pos - 1)];
    state.items.splice(pos, 0, { key: 'b' + Date.now(), kind: 'blank', w: ref ? ref.w : 595.28, h: ref ? ref.h : 841.89, rotate: 0, thumb: blankThumb(), selected: false });
    render();
    return;
  }
  const input = $('#fileInsert');
  input.value = '';
  input.onchange = async () => {
    const files = [...input.files];
    if (!files.length) return;
    progress.show('読み込み中…');
    try {
      const pdfs = files.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
      const imgs = files.filter(f => !pdfs.includes(f));
      const chunks = [];
      for (const f of pdfs) chunks.push(await f.arrayBuffer());
      if (imgs.length) chunks.push(await imagesToPdf(imgs));
      const added = [];
      for (const bytes of chunks) {
        if (!isPdf(bytes)) continue;
        const key = 'x' + (++state.extraCount);
        state.sources[key] = bytes;
        const pdf = await openPdf(bytes);
        (state.extraPdfs = state.extraPdfs || {})[key] = pdf;
        for (let i = 0; i < pdf.numPages; i++) {
          const vp = (await pdf.getPage(i + 1)).getViewport({ scale: 1 });
          added.push({ key: key + '_' + i, src: key, index: i, rotate: 0, w: vp.width, h: vp.height, pdf, thumb: null, selected: false });
        }
      }
      state.items.splice(pos, 0, ...added);
      render();
      loadThumbs();
      toast(`${added.length}ページ挿入しました`);
    } catch (e) {
      console.error(e); toast('読み込めませんでした: ' + e.message);
    } finally { progress.hide(); }
  };
  input.click();
}

function blankThumb() {
  const c = document.createElement('canvas');
  c.width = 60; c.height = 85;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 60, 85);
  return c.toDataURL();
}

function planFor(items) {
  return items.map(it => it.kind === 'blank'
    ? { kind: 'blank', w: it.w, h: it.h }
    : { kind: 'page', src: it.src, index: it.index, rotate: it.rotate });
}

async function extract() {
  const s = selected();
  if (!s.length) return;
  progress.show('新しいPDFを作成中…');
  try {
    const bytes = await buildFromPlan(planFor(s), state.sources);
    await state.ctx.onExtract(bytes, s.length);
  } catch (e) { console.error(e); toast('作成できませんでした'); }
  finally { progress.hide(); }
}

async function done() {
  const items = state.items;
  progress.show('ページを保存中…');
  try {
    const bytes = await buildFromPlan(planFor(items), state.sources);
    // 注釈とOCR結果を新しいページ順に付け替える
    const annots = {}, ocr = {};
    items.forEach((it, k) => {
      if (it.src !== 'main') return;
      const old = state.ctx.annots[it.index];
      if (old && old.length) annots[k] = old.map(a => rotateAnnot(JSON.parse(JSON.stringify({ ...a, id: a.id + (it.dupOf ? 'd' + k : '') })), it.rotate, it.w, it.h));
      if (!it.rotate && state.ctx.ocr[it.index]) ocr[k] = state.ctx.ocr[it.index];
    });
    progress.hide();
    close({ bytes, annots, ocr, pageCount: items.length });
  } catch (e) {
    console.error(e);
    progress.hide();
    toast('保存できませんでした: ' + e.message);
  }
}

export function initOrganizerUI() {
  $('#orgCancel').onclick = () => close(null);
  $('#orgDone').onclick = done;
  $('#orgRotL').onclick = () => rotate(-90);
  $('#orgRotR').onclick = () => rotate(90);
  $('#orgDelete').onclick = del;
  $('#orgDup').onclick = dup;
  $('#orgInsert').onclick = insert;
  $('#orgExtract').onclick = extract;
}
