import { db, uid, requestPersist } from './db.js';
import { $, $$, h, toast, sheet, modal, confirmBox, promptBox, progress, fmtSize, fmtDate } from './ui.js';
import { openPdf, renderPageImage, isPdf } from './pdfcore.js';
import { imagesToPdf, exportPdf } from './pdfedit.js';
import { Viewer } from './viewer.js';
import { Annotator, COLORS, bbox } from './annot.js';
import { ocrPage, pageHasText } from './ocr.js';
import { chooseSignature } from './sign.js';
import { openOrganizer, initOrganizerUI } from './organizer.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const viewer = new Viewer($('#viewerBody'), $('#pages'));
const annot = new Annotator(viewer);

const S = {
  doc: null,     // 開いている文書のメタ情報
  bytes: null,   // PDF本体
  pdf: null,     // pdf.js の文書
  ocr: {},       // { pageIndex: {words, lines, text} }
  sort: 'updated',
};

// =====================================================================
// ホーム
// =====================================================================
async function showHome() {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#home').classList.add('active');
  await renderList();
}

async function renderList() {
  const docs = await db.all('docs');
  const q = $('#homeFilter').value.trim().toLowerCase();
  let list = docs.filter(d => !q || d.name.toLowerCase().includes(q));
  list.sort(S.sort === 'name' ? (a, b) => a.name.localeCompare(b.name, 'ja') : (a, b) => b.updated - a.updated);
  const el = $('#fileList');
  el.innerHTML = '';
  $('#emptyState').classList.toggle('hidden', docs.length > 0);
  for (const d of list) {
    const card = h('div', { class: 'file-card' },
      h('div', { class: 'thumb', style: { backgroundImage: d.thumb ? `url(${d.thumb})` : '' } }),
      h('div', { class: 'meta' },
        h('div', { class: 'name' }, d.name),
        h('div', { class: 'sub' }, `${d.pages}ページ・${fmtSize(d.size)}`),
        h('div', { class: 'sub' }, fmtDate(d.updated))),
      h('button', { class: 'more', 'aria-label': 'メニュー', onclick: (e) => { e.stopPropagation(); fileMenu(d); } }, '⋯'));
    card.addEventListener('click', () => openDoc(d.id));
    el.append(card);
  }
}

async function fileMenu(d) {
  const v = await sheet(d.name, [
    { icon: '✏️', label: '名前を変更', value: 'rename' },
    { icon: '⧉', label: '複製', value: 'dup' },
    { icon: '⤴︎', label: '共有・保存', desc: '注釈を含めたPDFを書き出します', value: 'share' },
    { icon: '🗑', label: '削除', value: 'delete', danger: true },
  ]);
  if (v === 'rename') {
    const name = await promptBox('名前を変更', d.name);
    if (name && name.trim()) { d.name = name.trim(); await db.put('docs', d); renderList(); }
  } else if (v === 'dup') {
    const f = await db.get('files', d.id);
    const a = await db.get('annots', d.id);
    const o = await db.get('ocr', d.id);
    const id = uid();
    await db.put('files', { id, bytes: f.bytes });
    if (a) await db.put('annots', { id, pages: a.pages });
    if (o) await db.put('ocr', { id, pages: o.pages });
    await db.put('docs', { ...d, id, name: d.name + ' のコピー', created: Date.now(), updated: Date.now() });
    renderList();
  } else if (v === 'share') {
    await shareDoc(d, true);
  } else if (v === 'delete') {
    if (await confirmBox('削除', `「${d.name}」を削除しますか？元に戻せません。`, '削除')) {
      await Promise.all(['docs', 'files', 'annots', 'ocr'].map(s => db.del(s, d.id)));
      renderList();
    }
  }
}

async function addDocument(bytes, name) {
  if (!isPdf(bytes)) throw new Error('PDFファイルではありません');
  const pdf = await openPdf(bytes);
  let thumb = null;
  try { thumb = await renderPageImage(pdf, 1, 260); } catch (_) {}
  const id = uid();
  const now = Date.now();
  const doc = { id, name: name.replace(/\.pdf$/i, ''), size: bytes.byteLength, pages: pdf.numPages, thumb, created: now, updated: now };
  await db.put('files', { id, bytes });
  await db.put('docs', doc);
  pdf.destroy();
  return doc;
}

async function importFiles(files, asImages, baseName) {
  if (!files.length) return;
  progress.show('読み込み中…');
  let last = null;
  try {
    if (asImages) {
      const bytes = await imagesToPdf(files);
      last = await addDocument(bytes, baseName || ('スキャン ' + fmtDate(Date.now()).replace(/[/:]/g, '-')));
    } else {
      let k = 0;
      for (const f of files) {
        progress.set(k++ / files.length, `読み込み中… ${f.name}`);
        try { last = await addDocument(await f.arrayBuffer(), f.name); }
        catch (e) { toast(`${f.name}: ${e.message}`, 3500); }
      }
    }
  } catch (e) {
    console.error(e); toast('読み込めませんでした: ' + e.message, 3500);
  } finally { progress.hide(); }
  await renderList();
  if (last && files.length === 1 || asImages && last) openDoc(last.id);
}

function bindHome() {
  $('#btnAdd').onclick = async () => {
    const v = await sheet('追加', [
      { icon: '📄', label: 'PDFを開く', desc: '「ファイル」アプリやiCloud Driveから', value: 'pdf' },
      { icon: '📷', label: '書類をスキャン', desc: 'カメラで撮影してPDFにします', value: 'scan' },
      { icon: '🖼', label: '写真からPDFを作成', desc: '複数枚を1つのPDFにまとめます', value: 'img' },
    ]);
    if (v === 'pdf') $('#filePdf').click();
    if (v === 'scan') $('#fileScan').click();
    if (v === 'img') $('#fileImages').click();
  };
  $('#filePdf').onchange = (e) => { importFiles([...e.target.files], false); e.target.value = ''; };
  $('#fileImages').onchange = (e) => { importFiles([...e.target.files], true); e.target.value = ''; };
  // スキャン：続けて撮るか確認しながら複数ページにする
  const scanned = [];
  $('#fileScan').onchange = async (e) => {
    scanned.push(...e.target.files);
    e.target.value = '';
    const v = await modal('スキャン', h('p', {}, `${scanned.length}枚撮影しました。`), [
      { label: '破棄', value: 'discard' },
      { label: 'もう1枚撮る', value: 'more' },
      { label: 'PDFにする', value: 'done', primary: true },
    ]);
    if (v === 'more') { $('#fileScan').click(); return; }
    const files = scanned.splice(0);
    if (v === 'done') importFiles(files, true);
  };
  $('#homeFilter').oninput = () => renderList();
  $('#btnSort').onclick = async () => {
    const v = await sheet('並べ替え', [
      { icon: '🕒', label: '更新日順', value: 'updated' },
      { icon: 'あ', label: '名前順', value: 'name' },
    ]);
    if (v) { S.sort = v; db.kvSet('sort', v); renderList(); }
  };
}

// =====================================================================
// ビューア
// =====================================================================
async function openDoc(id) {
  progress.show('開いています…');
  try {
    const doc = await db.get('docs', id);
    const file = await db.get('files', id);
    const a = await db.get('annots', id);
    const o = await db.get('ocr', id);
    S.doc = doc; S.bytes = file.bytes; S.ocr = (o && o.pages) || {};
    S.searchIndex = null;
    S.pdf = await openPdf(S.bytes);
    $$('.screen').forEach(s => s.classList.remove('active'));
    $('#viewer').classList.add('active');
    $('#docTitle').textContent = doc.name;
    closeSearch();
    setAnnotMode(false);
    await viewer.load(S.pdf, { ocr: S.ocr });
    annot.load((a && a.pages) || {});
    annot.attach();
    updateIndicator(0);
    doc.opened = Date.now();
    db.put('docs', doc);
  } catch (e) {
    console.error(e);
    toast('開けませんでした: ' + e.message, 3500);
    showHome();
  } finally { progress.hide(); }
}

function updateIndicator(i) {
  const ind = $('#pageIndicator');
  ind.textContent = `${i + 1} / ${viewer.pages.length}`;
  ind.style.opacity = 1;
  clearTimeout(updateIndicator.t);
  updateIndicator.t = setTimeout(() => { ind.style.opacity = 0.35; }, 1500);
}
viewer.onPageChange = updateIndicator;
viewer.onPageRendered = (i) => { annot._applyMode(); drawSearchHits(i); };
viewer.onPinchStart = () => hideMenus();

let saveTimer = null;
annot.onChange = (data) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveAnnots(data), 400);
};
async function saveAnnots(data) {
  if (!S.doc) return;
  await db.put('annots', { id: S.doc.id, pages: data });
  S.doc.updated = Date.now();
  await db.put('docs', S.doc);
}
annot.onTextRequest = (init) => promptBox('テキストを入力', init, { multiline: true, placeholder: '改行もできます' });
annot.onToolChanged = (t) => refreshToolUI();

async function closeViewer() {
  clearTimeout(saveTimer);
  if (S.doc) await saveAnnots(annot.data);
  hideMenus();
  viewer.destroy();
  S.doc = null; S.bytes = null; S.pdf = null;
  showHome();
}

// ---------- 注釈モード ----------
function setAnnotMode(on) {
  $('#annotBar').classList.toggle('hidden', !on);
  $('#mainBar').classList.toggle('hidden', on);
  $('#mAnnot').classList.toggle('on', on);
  annot.setTool(on ? (annot.lastTool || 'marker') : null);
  refreshToolUI();
}

function refreshToolUI() {
  $$('#annotBar .tool').forEach(b => b.classList.toggle('on', b.dataset.tool === annot.tool));
  const row = $('#colorRow');
  row.innerHTML = '';
  const showColor = annot.tool && annot.tool !== 'eraser' && annot.tool !== 'select';
  row.classList.toggle('hidden', !showColor);
  $('#widthSel').classList.toggle('hidden', !showColor);
  $('.pencil-toggle').classList.toggle('hidden', !(annot.tool === 'pen' || annot.tool === 'marker'));
  if (showColor) {
    for (const c of COLORS) {
      row.append(h('button', { class: 'swatch' + (c === annot.currentColor ? ' on' : ''), style: { background: c }, onclick: () => { annot.currentColor = c; refreshToolUI(); } }));
    }
  }
  $('#widthSel').value = String(annot.widthLevel);
  $('#widthSel').options[0].text = annot.tool === 'text' ? '小' : '細';
  $('#widthSel').options[2].text = annot.tool === 'text' ? '大' : '太';
}

function bindAnnotBar() {
  $$('#annotBar .tool').forEach(b => b.onclick = () => {
    annot.setTool(b.dataset.tool);
    annot.lastTool = b.dataset.tool;
    refreshToolUI();
  });
  $('#widthSel').onchange = (e) => { annot.widthLevel = +e.target.value; };
  $('#pencilOnly').onchange = (e) => { annot.pencilOnly = e.target.checked; annot._applyMode(); db.kvSet('pencilOnly', e.target.checked); };
  $('#btnUndo').onclick = () => annot.undo();
  $('#btnRedo').onclick = () => annot.redo();
  $('#annotDone').onclick = () => setAnnotMode(false);
}

// ---------- 選択中の注釈のメニュー ----------
annot.onSelect = (sel, hideOnly) => {
  const m = $('#annotMenu');
  if (!sel || hideOnly) { m.classList.add('hidden'); return; }
  const a = annot.find(sel.i, sel.id);
  if (!a) { m.classList.add('hidden'); return; }
  m.innerHTML = '';
  const btn = (label, fn, cls) => m.append(h('button', { class: cls || '', onclick: fn }, label));
  if (a.type === 'text') btn('編集', async () => {
    const t = await promptBox('テキストを編集', a.text, { multiline: true });
    if (t != null) annot.updateSelected(x => { x.text = t; });
  });
  if (a.type !== 'hl') { btn('大きく', () => annot.scaleSelected(1.2)); btn('小さく', () => annot.scaleSelected(1 / 1.2)); }
  btn('色', async () => {
    const c = await sheet('色', COLORS.map(c => ({ icon: h('span', { class: 'swatch', style: { background: c, display: 'inline-block' } }), label: c, value: c })));
    if (c) annot.updateSelected(x => { x.color = c; });
  });
  btn('削除', () => annot.deleteSelected(), 'danger');
  placeMenu(m, annot.selectedClientRect());
};

function placeMenu(m, r) {
  if (!r) return;
  m.classList.remove('hidden');
  const mw = m.offsetWidth, mh = m.offsetHeight;
  const vw = window.innerWidth;
  let top = r.top - mh - 10;
  const minTop = $('#viewerBody').getBoundingClientRect().top + 4;
  if (top < minTop) top = r.top + r.height + 10;
  let left = r.left + r.width / 2 - mw / 2;
  left = Math.max(8, Math.min(vw - mw - 8, left));
  m.style.top = top + 'px';
  m.style.left = left + 'px';
}

function hideMenus() {
  $('#selMenu').classList.add('hidden');
  $('#annotMenu').classList.add('hidden');
}
$('#viewerBody').addEventListener('scroll', () => {
  $('#annotMenu').classList.add('hidden');
  if (!document.getSelection().isCollapsed) $('#selMenu').classList.add('hidden');
}, { passive: true });

// ---------- 文字を選択 → ハイライト ----------
function selectionRects() {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const node = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
  if (!node || !node.closest('.textLayer, .ocrLayer')) return null;
  const byPage = {};
  const pageRects = viewer.pages.map(p => p.div.getBoundingClientRect());
  for (let k = 0; k < sel.rangeCount; k++) {
    for (const r of sel.getRangeAt(k).getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const i = pageRects.findIndex(pr => cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom);
      if (i < 0) continue;
      const p = viewer.pages[i], pr = pageRects[i];
      const kx = p.w / pr.width;
      if (r.height * kx > p.h * 0.3) continue; // 大きすぎる矩形（行末など）は除外
      (byPage[i] = byPage[i] || []).push([(r.left - pr.left) * kx, (r.top - pr.top) * kx, r.width * kx, r.height * kx]);
    }
  }
  for (const i of Object.keys(byPage)) byPage[i] = mergeRects(byPage[i]);
  return byPage;
}

function mergeRects(rects) {
  rects.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const out = [];
  for (const r of rects) {
    const last = out[out.length - 1];
    if (last) {
      const ov = Math.min(last[1] + last[3], r[1] + r[3]) - Math.max(last[1], r[1]);
      const sameLine = ov > Math.min(last[3], r[3]) * 0.5;
      const gap = r[0] - (last[0] + last[2]);
      if (sameLine && gap < Math.max(last[3], r[3]) * 0.8 && gap > -last[2]) {
        const x1 = Math.min(last[0], r[0]), y1 = Math.min(last[1], r[1]);
        const x2 = Math.max(last[0] + last[2], r[0] + r[2]), y2 = Math.max(last[1] + last[3], r[1] + r[3]);
        out[out.length - 1] = [x1, y1, x2 - x1, y2 - y1];
        continue;
      }
    }
    out.push([...r]);
  }
  return out.map(r => r.map(v => +v.toFixed(2)));
}

document.addEventListener('selectionchange', () => {
  clearTimeout(selectionRects.t);
  selectionRects.t = setTimeout(() => {
    const m = $('#selMenu');
    if (!$('#viewer').classList.contains('active') || annot.tool) { m.classList.add('hidden'); return; }
    const sel = document.getSelection();
    const byPage = selectionRects();
    if (!byPage || !Object.keys(byPage).length) { m.classList.add('hidden'); return; }
    const r = sel.getRangeAt(0).getBoundingClientRect();
    placeMenu(m, r);
  }, 250);
});

$('#selMenu').addEventListener('pointerdown', (e) => e.preventDefault()); // 選択が消えないように
$('#selMenu').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const act = b.dataset.sel;
  const sel = document.getSelection();
  if (act === 'copy') {
    const text = sel.toString();
    try { await navigator.clipboard.writeText(text); toast('コピーしました'); } catch (_) { toast('コピーできませんでした'); }
  } else {
    const byPage = selectionRects();
    if (byPage) annot.addFromSelection(act, byPage);
  }
  sel.removeAllRanges();
  $('#selMenu').classList.add('hidden');
});

// ---------- 検索 ----------
function openSearch() {
  $('#searchBar').classList.remove('hidden');
  $('#searchInput').focus();
}
function closeSearch() {
  $('#searchBar').classList.add('hidden');
  $('#searchInput').value = '';
  S.hits = []; S.hitIdx = -1;
  $('#searchCount').textContent = '';
  $$('#pages g.search').forEach(g => g.remove());
}

const norm = (s) => s.normalize('NFKC').toLowerCase();

async function buildSearchIndex() {
  if (S.searchIndex) return S.searchIndex;
  progress.show('検索の準備中…');
  const idx = [];
  try {
    for (let i = 0; i < S.pdf.numPages; i++) {
      progress.set(i / S.pdf.numPages);
      const page = await S.pdf.getPage(i + 1);
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      // 1文字ずつ、どこから来たかを覚えておく（空白は詰める）
      const chars = [];
      const pieces = [];
      tc.items.forEach((it) => {
        if (!it.str) return;
        const [a, b, , , e, f] = it.transform;
        const fh = Math.hypot(a, b) || it.height;
        pieces.push({ kind: 'pdf', it, vp, fh });
        const pk = pieces.length - 1;
        [...norm(it.str)].forEach((ch, k, arr) => { if (!/\s/.test(ch)) chars.push({ ch, pk, k, n: arr.length }); });
      });
      const o = S.ocr[i];
      if (o && o.lines) for (const ln of o.lines) {
        pieces.push({ kind: 'ocr', ln });
        const pk = pieces.length - 1;
        [...norm(ln.t)].forEach((ch, k, arr) => { if (!/\s/.test(ch)) chars.push({ ch, pk, k, n: arr.length }); });
      }
      idx.push({ text: chars.map(c => c.ch).join(''), chars, pieces });
    }
  } finally { progress.hide(); }
  S.searchIndex = idx;
  return idx;
}

function pieceRect(piece, k0, k1, n) {
  if (piece.kind === 'ocr') {
    const l = piece.ln;
    return [l.x + l.w * k0 / n, l.y, l.w * (k1 - k0) / n, l.h];
  }
  const { it, vp, fh } = piece;
  const [a, b, , , e, f] = it.transform;
  const ang = Math.atan2(b, a);
  const w = it.width;
  // 回転していない横書きを基本に、始点・終点を比率で出す
  const x0 = e + Math.cos(ang) * w * k0 / n, y0 = f + Math.sin(ang) * w * k0 / n;
  const x1 = e + Math.cos(ang) * w * k1 / n, y1 = f + Math.sin(ang) * w * k1 / n;
  const pts = [[x0, y0], [x1, y1], [x0 - Math.sin(ang) * -fh, y0 + Math.cos(ang) * fh], [x1 - Math.sin(ang) * -fh, y1 + Math.cos(ang) * fh]]
    .map(([x, y]) => vp.convertToViewportPoint(x, y));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const minX = Math.min(...xs), minY = Math.min(...ys);
  return [minX, minY, Math.max(...xs) - minX, Math.max(...ys) - minY];
}

async function runSearch() {
  const q = norm($('#searchInput').value).replace(/\s/g, '');
  $$('#pages g.search').forEach(g => g.remove());
  S.hits = []; S.hitIdx = -1;
  if (!q) { $('#searchCount').textContent = ''; return; }
  const idx = await buildSearchIndex();
  idx.forEach((pg, i) => {
    let from = 0, at;
    while ((at = pg.text.indexOf(q, from)) >= 0) {
      const cs = pg.chars.slice(at, at + q.length);
      // 同じ断片ごとにまとめて矩形にする
      const rects = [];
      let run = null;
      for (const c of cs) {
        if (run && run.pk === c.pk && c.k === run.k1) { run.k1 = c.k + 1; continue; }
        if (run) rects.push(pieceRect(pg.pieces[run.pk], run.k0, run.k1, run.n));
        run = { pk: c.pk, k0: c.k, k1: c.k + 1, n: c.n };
      }
      if (run) rects.push(pieceRect(pg.pieces[run.pk], run.k0, run.k1, run.n));
      S.hits.push({ i, rects });
      from = at + q.length;
    }
  });
  $('#searchCount').textContent = S.hits.length ? `${S.hits.length}件` : '0件';
  viewer.pages.forEach(p => drawSearchHits(p.i));
  if (S.hits.length) gotoHit(0);
}

function drawSearchHits(i) {
  const p = viewer.pages[i];
  if (!p) return;
  p.svg.querySelectorAll('g.search').forEach(g => g.remove());
  const hits = (S.hits || []).filter(x => x.i === i);
  if (!hits.length) return;
  const g = document.createElementNS(SVGNS, 'g');
  g.setAttribute('class', 'search');
  for (const hit of hits) for (const [x, y, w, hh] of hit.rects) {
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', hh);
    r.setAttribute('class', 'search-hit' + (S.hits[S.hitIdx] === hit ? ' current' : ''));
    g.append(r);
  }
  p.svg.prepend(g);
}

function gotoHit(k) {
  if (!S.hits.length) return;
  const prev = S.hits[S.hitIdx];
  S.hitIdx = (k + S.hits.length) % S.hits.length;
  const hit = S.hits[S.hitIdx];
  if (prev) drawSearchHits(prev.i);
  drawSearchHits(hit.i);
  viewer.scrollToPoint(hit.i, hit.rects[0] ? hit.rects[0][1] : 0);
  $('#searchCount').textContent = `${S.hitIdx + 1}/${S.hits.length}`;
}

// ---------- 共有・書き出し ----------
async function buildExport(doc, bytes, withAnnots) {
  if (!withAnnots) return bytes;
  const a = doc === S.doc ? annot.data : ((await db.get('annots', doc.id)) || {}).pages || {};
  const o = doc === S.doc ? S.ocr : ((await db.get('ocr', doc.id)) || {}).pages || {};
  const hasA = Object.values(a).some(l => l && l.length);
  const hasO = Object.values(o).some(x => x && x.words && x.words.length);
  if (!hasA && !hasO) return bytes;
  return exportPdf(bytes, a, o);
}

async function shareDoc(doc, fromHome = false) {
  const v = await sheet('共有・保存', [
    { icon: '📝', label: '注釈を含めて書き出す', desc: 'マーカーやサイン、OCRの文字を入れたPDF', value: 'annot' },
    { icon: '📄', label: '元のPDFを書き出す', desc: '注釈なし', value: 'orig' },
  ]);
  if (!v) return;
  progress.show('PDFを作成中…');
  try {
    const bytes = doc === S.doc ? S.bytes : (await db.get('files', doc.id)).bytes;
    const out = await buildExport(doc, bytes, v === 'annot');
    const file = new File([out], `${doc.name}.pdf`, { type: 'application/pdf' });
    progress.hide();
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: doc.name }); }
      catch (e) { if (e.name !== 'AbortError') downloadFile(file); }
    } else downloadFile(file);
  } catch (e) {
    console.error(e);
    progress.hide();
    toast('書き出せませんでした: ' + e.message, 3500);
  }
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- その他メニュー ----------
async function moreMenu() {
  const v = await sheet(S.doc.name, [
    { icon: '#', label: 'ページへ移動', value: 'goto' },
    { icon: '✏️', label: '名前を変更', value: 'rename' },
    { icon: '📝', label: '注釈を確定して保存', desc: '注釈をPDFに焼き込み、元のPDFを置き換えます', value: 'flatten' },
    { icon: '🧹', label: '注釈をすべて消す', value: 'clear', danger: true },
    { icon: 'ℹ️', label: '情報', value: 'info' },
  ]);
  if (v === 'goto') {
    const n = await promptBox(`ページ番号（1〜${viewer.pages.length}）`, String(viewer.current + 1));
    const k = parseInt(n, 10);
    if (k >= 1 && k <= viewer.pages.length) viewer.scrollToPage(k - 1);
  } else if (v === 'rename') {
    const name = await promptBox('名前を変更', S.doc.name);
    if (name && name.trim()) { S.doc.name = name.trim(); await db.put('docs', S.doc); $('#docTitle').textContent = S.doc.name; }
  } else if (v === 'flatten') {
    if (!await confirmBox('注釈を確定', '注釈とOCRの文字をPDFに焼き込みます。確定後は注釈を個別に動かしたり消したりできなくなります。', '確定する')) return;
    progress.show('保存中…');
    try {
      const out = await exportPdf(S.bytes, annot.data, S.ocr);
      await replaceBytes(out, {}, {}, null);
      toast('確定しました');
    } catch (e) { console.error(e); toast('保存できませんでした: ' + e.message); }
    finally { progress.hide(); }
  } else if (v === 'clear') {
    if (await confirmBox('注釈をすべて消す', 'この文書の注釈をすべて消します。', '消す')) {
      annot._snapshot();
      annot.data = {};
      annot.renderAll();
      annot._changed();
    }
  } else if (v === 'info') {
    const ocrN = Object.keys(S.ocr).length;
    const annN = Object.values(annot.data).reduce((s, l) => s + (l ? l.length : 0), 0);
    modal('情報', h('div', {},
      h('p', {}, `ページ数：${viewer.pages.length}`),
      h('p', {}, `サイズ：${fmtSize(S.bytes.byteLength)}`),
      h('p', {}, `注釈：${annN}件`),
      h('p', {}, `OCR済みページ：${ocrN}`),
      h('p', {}, `追加日：${fmtDate(S.doc.created)}`)), [{ label: '閉じる', value: true, primary: true }]);
  }
}

// PDF本体を入れ替えて開き直す（ページ整理・確定のあと）
async function replaceBytes(bytes, annots, ocr, pageCount) {
  const keepPage = viewer.current;
  S.bytes = bytes;
  S.ocr = ocr;
  S.searchIndex = null;
  await db.put('files', { id: S.doc.id, bytes });
  await db.put('annots', { id: S.doc.id, pages: annots });
  await db.put('ocr', { id: S.doc.id, pages: ocr });
  S.pdf = await openPdf(bytes);
  S.doc.size = bytes.byteLength;
  S.doc.pages = S.pdf.numPages;
  S.doc.updated = Date.now();
  try { S.doc.thumb = await renderPageImage(S.pdf, 1, 260); } catch (_) {}
  await db.put('docs', S.doc);
  await viewer.load(S.pdf, { ocr: S.ocr });
  annot.load(annots);
  annot.attach();
  viewer.scrollToPage(Math.min(keepPage, viewer.pages.length - 1), false);
}

// ---------- ページ整理 ----------
async function organize() {
  hideMenus();
  setAnnotMode(false);
  const res = await openOrganizer({
    bytes: S.bytes, pdf: S.pdf, annots: annot.data, ocr: S.ocr,
    onExtract: async (bytes, n) => {
      const d = await addDocument(bytes, `${S.doc.name}（抜粋）`);
      toast(`${n}ページを「${d.name}」として保存しました`, 3000);
    },
  });
  if (!res) return;
  progress.show('保存中…');
  try { await replaceBytes(res.bytes, res.annots, res.ocr, res.pageCount); toast('ページを保存しました'); }
  catch (e) { console.error(e); toast('保存できませんでした: ' + e.message); }
  finally { progress.hide(); }
}

// ---------- 署名 ----------
async function sign() {
  hideMenus();
  const sig = await chooseSignature();
  if (!sig) return;
  if (!$('#annotBar').classList.contains('hidden')) setAnnotMode(false);
  annot.placeSign(sig);
  toast('サインを置きたい場所をタップしてください', 3000);
}

// ---------- OCR ----------
async function ocrMenu() {
  hideMenus();
  const cur = viewer.current;
  const has = Object.keys(S.ocr).length > 0;
  const v = await sheet('OCR（文字の読み取り）', [
    { icon: '📄', label: `このページ（${cur + 1}ページ）を読み取る`, value: 'this' },
    { icon: '🔍', label: '文字のないページだけ読み取る', desc: 'スキャンしたページを自動で探します', value: 'empty' },
    { icon: '📚', label: 'すべてのページを読み取る', value: 'all' },
    has ? { icon: '📋', label: '読み取った文字を見る・コピー', value: 'show' } : null,
    has ? { icon: '🗑', label: 'OCR結果を消す', value: 'clear', danger: true } : null,
  ]);
  if (!v) return;
  if (v === 'show') return showOcrText();
  if (v === 'clear') {
    S.ocr = {};
    await db.put('ocr', { id: S.doc.id, pages: {} });
    viewer.ocr = S.ocr;
    viewer.pages.forEach(p => viewer.renderOcrLayer(p.i));
    S.searchIndex = null;
    toast('消しました');
    return;
  }
  let targets = [];
  if (v === 'this') targets = [cur];
  else targets = viewer.pages.map(p => p.i);
  progress.show('OCRの準備中…（初回は少し時間がかかります）', true);
  let done = 0, skipped = 0;
  try {
    if (v === 'empty') {
      const t2 = [];
      for (const i of targets) if (!(await pageHasText(S.pdf, i + 1))) t2.push(i);
      skipped = targets.length - t2.length;
      targets = t2;
      if (!targets.length) { progress.hide(); toast('文字のないページはありませんでした'); return; }
    }
    for (let k = 0; k < targets.length; k++) {
      if (progress.cancelled) break;
      const i = targets[k];
      const label = `${i + 1}ページを読み取り中…（${k + 1}/${targets.length}）`;
      progress.set(k / targets.length, label);
      const res = await ocrPage(S.pdf, i + 1, (m) => {
        if (m.status === 'recognizing text') progress.set((k + m.progress) / targets.length, label);
        else if (m.status && k === 0 && m.status.startsWith('loading')) progress.set(0, 'OCRエンジンを読み込み中…');
      });
      S.ocr[i] = res;
      await db.put('ocr', { id: S.doc.id, pages: S.ocr });
      viewer.ocr = S.ocr;
      viewer.renderOcrLayer(i);
      done++;
    }
    S.searchIndex = null;
    annot._applyMode();
    progress.hide();
    toast(`${done}ページ読み取りました` + (skipped ? `（文字のある${skipped}ページはスキップ）` : '') + '。検索・選択できます', 3500);
    if (v === 'this' && done) showOcrText(cur);
  } catch (e) {
    console.error(e);
    progress.hide();
    toast('OCRに失敗しました: ' + e.message, 4000);
  }
}

async function showOcrText(only) {
  const keys = only != null ? [only] : Object.keys(S.ocr).map(Number).sort((a, b) => a - b);
  const text = keys.filter(i => S.ocr[i]).map(i => `【${i + 1}ページ】\n${S.ocr[i].text}`).join('\n\n');
  const v = await modal('読み取った文字', h('div', { class: 'ocr-text' }, text || '（文字が見つかりませんでした）'), [
    { label: '閉じる', value: false },
    { label: 'すべてコピー', value: true, primary: true },
  ]);
  if (v) {
    try { await navigator.clipboard.writeText(text.replace(/【\d+ページ】\n/g, '')); toast('コピーしました'); }
    catch (_) { toast('コピーできませんでした'); }
  }
}

// ---------- ページ一覧 ----------
async function openThumbs() {
  hideMenus();
  const panel = $('#thumbPanel');
  const grid = $('#thumbGrid');
  grid.innerHTML = '';
  panel.classList.remove('hidden');
  const items = viewer.pages.map(p => {
    const img = h('img', { alt: '' });
    img.style.aspectRatio = `${p.w} / ${p.h}`;
    const el = h('div', { class: 'thumb' + (p.i === viewer.current ? ' current' : ''), onclick: () => { panel.classList.add('hidden'); viewer.scrollToPage(p.i, false); } }, img, String(p.i + 1));
    grid.append(el);
    return { img, i: p.i };
  });
  const cur = grid.children[viewer.current];
  if (cur) cur.scrollIntoView({ block: 'center' });
  const pdf = S.pdf;
  for (const it of items) {
    if (panel.classList.contains('hidden') || S.pdf !== pdf) break;
    try { it.img.src = await renderPageImage(pdf, it.i + 1, 180); } catch (_) {}
  }
}

// ---------- パソコン向け：キーボード・ドラッグ＆ドロップ・拡大縮小 ----------
viewer.onZoom = (z) => { $('#zoomVal').textContent = Math.round(z * 100) + '%'; };

function bindDesktop() {
  $('#zoomIn').onclick = () => viewer.setZoom(viewer.zoom * 1.2);
  $('#zoomOut').onclick = () => viewer.setZoom(viewer.zoom / 1.2);
  $('#zoomVal').onclick = () => viewer.setZoom(1);

  // ドラッグ＆ドロップで追加
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('#dropZone').classList.remove('hidden'); });
  document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  document.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; $('#dropZone').classList.add('hidden'); } });
  document.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0; $('#dropZone').classList.add('hidden');
    const files = [...e.dataTransfer.files];
    const pdfs = files.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const imgs = files.filter(f => f.type.startsWith('image/'));
    if (!pdfs.length && !imgs.length) { toast('PDFか画像をドロップしてください'); return; }
    if ($('#viewer').classList.contains('active')) await closeViewer();
    if (pdfs.length) await importFiles(pdfs, false);
    if (imgs.length) await importFiles(imgs, true);
  });

  // キーボードショートカット
  document.addEventListener('keydown', (e) => {
    const typing = e.target.closest('input, textarea, select');
    const mod = e.ctrlKey || e.metaKey;
    const inViewer = $('#viewer').classList.contains('active');
    if (e.key === 'Escape') {
      if (!$('#modal').classList.contains('hidden')) return;
      if (!$('#sheet').classList.contains('hidden')) { $('#sheetBackdrop').click(); return; }
      if (inViewer) {
        if (!$('#searchBar').classList.contains('hidden')) closeSearch();
        else if (annot.selected) annot.deselect();
        else if (!$('#thumbPanel').classList.contains('hidden')) $('#thumbPanel').classList.add('hidden');
        else if (annot.tool) setAnnotMode(false);
      }
      return;
    }
    if (!inViewer || typing || !$('#modal').classList.contains('hidden')) return;
    const k = e.key.toLowerCase();
    if (mod && k === 'z' && !e.shiftKey) { e.preventDefault(); annot.undo(); }
    else if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); annot.redo(); }
    else if (mod && k === 'f') { e.preventDefault(); openSearch(); }
    else if (mod && k === 's') { e.preventDefault(); shareDoc(S.doc); }
    else if (mod && (k === '=' || k === '+' || k === ';')) { e.preventDefault(); viewer.setZoom(viewer.zoom * 1.2); }
    else if (mod && k === '-') { e.preventDefault(); viewer.setZoom(viewer.zoom / 1.2); }
    else if (mod && k === '0') { e.preventDefault(); viewer.setZoom(1); }
    else if ((k === 'delete' || k === 'backspace') && annot.selected) { e.preventDefault(); annot.deleteSelected(); }
    else if (mod) return;
    else if (k === 'pagedown' || k === 'arrowright') { e.preventDefault(); viewer.scrollToPage(Math.min(viewer.current + 1, viewer.pages.length - 1)); }
    else if (k === 'pageup' || k === 'arrowleft') { e.preventDefault(); viewer.scrollToPage(Math.max(viewer.current - 1, 0)); }
    else if (k === 'home') { e.preventDefault(); viewer.scrollToPage(0); }
    else if (k === 'end') { e.preventDefault(); viewer.scrollToPage(viewer.pages.length - 1); }
    else {
      // 1文字キーでツール切り替え（注釈モード中）
      const map = { v: 'select', h: 'marker', p: 'pen', t: 'text', r: 'rect', o: 'ellipse', a: 'arrow', e: 'eraser' };
      if (map[k]) {
        if ($('#annotBar').classList.contains('hidden')) setAnnotMode(true);
        annot.setTool(map[k]); annot.lastTool = map[k]; refreshToolUI();
      }
    }
  });
}

function bindViewer() {
  $('#btnBack').onclick = closeViewer;
  $('#btnSearch').onclick = () => $('#searchBar').classList.contains('hidden') ? openSearch() : closeSearch();
  $('#searchClose').onclick = closeSearch;
  $('#searchInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#searchInput').blur(); runSearch(); } });
  $('#searchNext').onclick = () => gotoHit(S.hitIdx + 1);
  $('#searchPrev').onclick = () => gotoHit(S.hitIdx - 1);
  $('#btnShare').onclick = () => shareDoc(S.doc);
  $('#btnMore').onclick = moreMenu;
  $('#mAnnot').onclick = () => setAnnotMode($('#annotBar').classList.contains('hidden'));
  $('#mPages').onclick = organize;
  $('#mSign').onclick = sign;
  $('#mOcr').onclick = ocrMenu;
  $('#mThumbs').onclick = openThumbs;
  $$('[data-close]').forEach(b => b.onclick = () => $('#' + b.dataset.close).classList.add('hidden'));
}

// =====================================================================
async function init() {
  bindHome();
  bindViewer();
  bindAnnotBar();
  bindDesktop();
  initOrganizerUI();
  S.sort = await db.kvGet('sort', 'updated');
  annot.pencilOnly = await db.kvGet('pencilOnly', false);
  $('#pencilOnly').checked = annot.pencilOnly;
  requestPersist();
  await showHome();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW', e));
  }
}
init();

// デバッグ・テスト用
window.__app = { S, viewer, annot, openDoc, addDocument, exportPdf, renderList };
