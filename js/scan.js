// カメラでスキャン（Adobe Scan風：書類の枠を自動で見つけて、ゆがみを直して、見やすく補正）
import { $, h, toast, modal, confirmBox, progress, fmtDate } from './ui.js';
import { detectQuad, defaultQuad, fullQuad, quadDiff, warp, rotateCanvas, applyFilter } from './scanimg.js';
import { db, uid } from './db.js';

let st = null; // 状態

const MAX_SRC = 4032; // 元写真の長辺の上限

export function openScanner() {
  return new Promise(async (resolve) => {
    st = {
      resolve, pages: [], cur: 0, retake: -1,
      auto: await db.kvGet('scanAuto', true),
      filter: await db.kvGet('scanFilter', 'auto'),
      stream: null, loopTimer: null, quad: null, stableSince: 0, lastShot: 0, needMove: false,
      queue: Promise.resolve(),
    };
    showCam();
  });
}

function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('#' + id).classList.add('active');
}

// =====================================================================
// カメラ
// =====================================================================
async function showCam() {
  show('scanCam');
  updateCamUI();
  await startCamera();
}

function updateCamUI() {
  $('#scanAuto').textContent = '自動撮影：' + (st.auto ? 'オン' : 'オフ');
  $('#scanAuto').classList.toggle('on', st.auto);
  const n = st.pages.length;
  $('#scanCount').textContent = st.retake >= 0 ? '撮り直し' : `${n}枚`;
  const last = st.pages[n - 1];
  $('#scanLastThumb').src = last && last.outUrl ? last.outUrl : '';
}

async function startCamera() {
  stopCamera();
  const video = $('#scanVideo');
  try {
    st.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } },
    });
    video.srcObject = st.stream;
    await video.play().catch(() => {});
    $('#scanMsg').textContent = '書類全体が入るように写してください';
    loop();
  } catch (e) {
    console.warn(e);
    $('#scanMsg').textContent = 'カメラを使えません。下の「写真から」か、シャッターでカメラアプリを使えます';
    st.stream = null;
  }
}

function stopCamera() {
  clearTimeout(st && st.loopTimer);
  if (st && st.stream) { st.stream.getTracks().forEach(t => t.stop()); st.stream = null; }
  const v = $('#scanVideo');
  if (v) v.srcObject = null;
}

// 映像の中で実際に見えている範囲（object-fit: contain）
function videoRect() {
  const v = $('#scanVideo');
  const r = v.getBoundingClientRect();
  const vw = v.videoWidth || 1, vh = v.videoHeight || 1;
  const s = Math.min(r.width / vw, r.height / vh);
  const w = vw * s, hh = vh * s;
  return { x: (r.width - w) / 2, y: (r.height - hh) / 2, w, h: hh };
}

const small = document.createElement('canvas');
function loop() {
  if (!st || !st.stream) return;
  const v = $('#scanVideo');
  if (v.readyState >= 2 && v.videoWidth) {
    const k = 220 / Math.max(v.videoWidth, v.videoHeight);
    small.width = Math.round(v.videoWidth * k);
    small.height = Math.round(v.videoHeight * k);
    const ctx = small.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, small.width, small.height);
    const now0 = performance.now();
    let q = detectQuad(ctx, small.width, small.height);
    // 一瞬見失っても枠がちらつかないよう、少しのあいだ前の枠を使う
    if (q) { st.lastSeen = now0; st.lastQ = q; }
    else if (st.lastQ && now0 - st.lastSeen < 450) q = st.lastQ;
    // なめらかに動かす
    if (q && st.quad) st.quad = st.quad.map((p, i) => [p[0] * 0.5 + q[i][0] * 0.5, p[1] * 0.5 + q[i][1] * 0.5]);
    else st.quad = q;
    const now = performance.now();
    if (q && st.prevQ && quadDiff(q, st.prevQ) < 0.025) { if (!st.stableSince) st.stableSince = now; }
    else st.stableSince = 0;
    // 撮ったあとは、書類を動かすまで次を撮らない
    if (st.needMove && q && st.shotQ && quadDiff(q, st.shotQ) > 0.08) st.needMove = false;
    if (!q) st.needMove = false;
    st.prevQ = q;
    drawOverlay(q ? st.quad : null, st.stableSince ? Math.min(1, (now - st.stableSince) / 1300) : 0);
    if (st.auto && q && st.stableSince && now - st.stableSince > 1300 && now - st.lastShot > 1500 && !st.needMove && !st.shooting) {
      capture();
    }
    $('#scanMsg').textContent = q
      ? (st.needMove ? '撮影しました。次の書類を写してください' : (st.auto ? 'そのまま動かさないでください…' : '書類が見つかりました。シャッターを押してください'))
      : '書類全体が入るように写してください';
  }
  st.loopTimer = setTimeout(loop, 110);
}

function drawOverlay(q, progressRatio) {
  const c = $('#scanOverlay');
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(r.width * dpr)) { c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, r.width, r.height);
  if (!q) return;
  const vr = videoRect();
  const pts = q.map(([x, y]) => [vr.x + x * vr.w, vr.y + y * vr.h]);
  ctx.beginPath();
  pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath();
  ctx.fillStyle = 'rgba(224,56,62,.18)';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = progressRatio >= 1 ? '#3fbf6f' : '#e0383e';
  ctx.stroke();
  for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); }
}

async function capture() {
  if (st.shooting) return;
  const v = $('#scanVideo');
  if (!st.stream || !v.videoWidth) { $('#scanNative').click(); return; }
  st.shooting = true;
  $('#scanShutter').classList.add('busy');
  try {
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    $('#scanStage').classList.remove('flash'); void $('#scanStage').offsetWidth; $('#scanStage').classList.add('flash');
    if (navigator.vibrate) navigator.vibrate(15);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
    const q = st.prevQ || null;
    addSource(blob, c.width, c.height, q);
    c.width = c.height = 0;
    st.lastShot = performance.now();
    st.needMove = true; st.shotQ = q; st.stableSince = 0;
  } finally {
    st.shooting = false;
    $('#scanShutter').classList.remove('busy');
  }
}

// 撮影・読み込みした写真をページに追加（撮り直しなら置き換え）
function addSource(blob, w, hgt, quad) {
  const pg = { id: uid(), src: blob, w, h: hgt, quad: quad || null, rot: 0, filter: st.filter, out: null, outUrl: '' };
  if (st.retake >= 0) {
    const old = st.pages[st.retake];
    if (old && old.outUrl) URL.revokeObjectURL(old.outUrl);
    st.pages[st.retake] = pg;
    st.cur = st.retake;
    st.retake = -1;
    process(pg).then(() => { updateCamUI(); });
    showReview();
    return;
  }
  st.pages.push(pg);
  st.cur = st.pages.length - 1;
  process(pg).then(updateCamUI);
  updateCamUI();
}

async function loadImageFile(file) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (_) {
    const url = URL.createObjectURL(file);
    bmp = new Image(); bmp.src = url; await bmp.decode(); URL.revokeObjectURL(url);
  }
  const s = Math.min(1, MAX_SRC / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  const k = 260 / Math.max(c.width, c.height);
  const sm = document.createElement('canvas');
  sm.width = Math.round(c.width * k); sm.height = Math.round(c.height * k);
  const sctx = sm.getContext('2d', { willReadFrequently: true });
  sctx.drawImage(c, 0, 0, sm.width, sm.height);
  const quad = detectQuad(sctx, sm.width, sm.height);
  const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  const out = { blob, w: c.width, h: c.height, quad };
  c.width = c.height = 0;
  return out;
}

async function addFiles(files) {
  if (!files.length) return;
  progress.show('読み込み中…');
  try {
    for (let k = 0; k < files.length; k++) {
      progress.set(k / files.length);
      const r = await loadImageFile(files[k]);
      addSource(r.blob, r.w, r.h, r.quad);
    }
  } catch (e) { console.error(e); toast('読み込めませんでした'); }
  finally { progress.hide(); }
}

// =====================================================================
// 1ページ分の処理（切り抜き → 回転 → 補正）
// =====================================================================
function process(pg) {
  st.queue = st.queue.then(() => doProcess(pg)).catch(e => console.error(e));
  return st.queue;
}

async function doProcess(pg) {
  pg.busy = true;
  if (st.pages[st.cur] === pg) setBusy(true);
  const bmp = await createImageBitmap(pg.src);
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  const q = (pg.quad || fullQuad()).map(([x, y]) => [x * (c.width - 1), y * (c.height - 1)]);
  let out = warp(c, q);
  c.width = c.height = 0;
  out = rotateCanvas(out, pg.rot);
  applyFilter(out, pg.filter);
  const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', 0.88));
  pg.outW = out.width; pg.outH = out.height;
  out.width = out.height = 0;
  if (pg.outUrl) URL.revokeObjectURL(pg.outUrl);
  pg.out = blob;
  pg.outUrl = URL.createObjectURL(blob);
  pg.busy = false;
  if (st && $('#scanReview').classList.contains('active')) renderReview();
}

function setBusy(on) { $('#revBusy').classList.toggle('hidden', !on); }

// =====================================================================
// 確認・補正
// =====================================================================
function showReview() {
  if (!st.pages.length) { showCam(); return; }
  stopCamera();
  show('scanReview');
  renderReview();
}

function renderReview() {
  const pg = st.pages[st.cur];
  if (!pg) return;
  $('#revTitle').textContent = `${st.cur + 1} / ${st.pages.length}`;
  $('#revImg').src = pg.outUrl || '';
  setBusy(!!pg.busy || !pg.outUrl);
  document.querySelectorAll('#revFilters button').forEach(b => b.classList.toggle('on', b.dataset.f === pg.filter));
  const th = $('#revThumbs');
  th.innerHTML = '';
  st.pages.forEach((p, k) => {
    th.append(h('button', { class: 'rt' + (k === st.cur ? ' on' : ''), onclick: () => { st.cur = k; renderReview(); } },
      h('img', { src: p.outUrl || '' }), h('b', {}, String(k + 1))));
  });
  th.append(h('button', { class: 'rt add', onclick: () => { st.retake = -1; showCam(); } }, '＋'));
  const on = th.querySelector('.on');
  if (on) on.scrollIntoView({ inline: 'center', block: 'nearest' });
  $('#revMoveL').disabled = st.cur === 0;
  $('#revMoveR').disabled = st.cur === st.pages.length - 1;
}

function move(d) {
  const k = st.cur, j = k + d;
  if (j < 0 || j >= st.pages.length) return;
  [st.pages[k], st.pages[j]] = [st.pages[j], st.pages[k]];
  st.cur = j;
  renderReview();
}

async function del() {
  if (!await confirmBox('削除', `${st.cur + 1}ページ目を削除しますか？`, '削除')) return;
  const [pg] = st.pages.splice(st.cur, 1);
  if (pg.outUrl) URL.revokeObjectURL(pg.outUrl);
  st.cur = Math.min(st.cur, st.pages.length - 1);
  if (!st.pages.length) { showCam(); return; }
  renderReview();
}

async function save() {
  if (st.pages.some(p => p.busy || !p.out)) { toast('処理が終わるまでお待ちください'); return; }
  const name = h('input', { type: 'text' });
  name.value = 'スキャン ' + fmtDate(Date.now()).replace(/[/:]/g, '-');
  const ocr = h('input', { type: 'checkbox' });
  ocr.checked = await db.kvGet('scanOcr', true);
  const ok = await modal('PDFを保存', h('div', {}, name,
    h('label', { class: 'field-row' }, ocr, '保存したあと文字を読み取る（OCR）'),
    h('p', { class: 'muted small' }, `${st.pages.length}ページのPDFを作ります。`)), [
    { label: 'キャンセル', value: false },
    { label: '保存', value: true, primary: true },
  ]);
  if (!ok) return;
  db.kvSet('scanOcr', ocr.checked);
  const pages = st.pages.map(p => ({ blob: p.out, w: p.outW, h: p.outH }));
  finish({ name: name.value.trim() || 'スキャン', pages, ocr: ocr.checked });
}

function finish(result) {
  stopCamera();
  for (const p of st.pages) if (p.outUrl) URL.revokeObjectURL(p.outUrl);
  const r = st.resolve;
  st = null;
  r(result);
}

async function closeScanner() {
  if (st.pages.length && !await confirmBox('スキャンをやめる', `撮影した${st.pages.length}ページは保存されません。やめますか？`, 'やめる')) return;
  finish(null);
}

// =====================================================================
// 切り抜き（四隅を動かす）
// =====================================================================
async function openCrop() {
  const pg = st.pages[st.cur];
  if (!pg) return;
  show('scanCrop');
  const bmp = await createImageBitmap(pg.src);
  const stage = $('#cropStage');
  const canvas = $('#cropCanvas');
  const sr = stage.getBoundingClientRect();
  const pad = 26;
  const s = Math.min((sr.width - pad * 2) / bmp.width, (sr.height - pad * 2) / bmp.height);
  const dw = bmp.width * s, dh = bmp.height * s;
  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = (dw + pad * 2) + 'px';
  canvas.style.height = (dh + pad * 2) + 'px';
  canvas.width = Math.round((dw + pad * 2) * dpr);
  canvas.height = Math.round((dh + pad * 2) * dpr);
  // 画像を小さくしておく（拡大鏡用にも使う）
  const img = document.createElement('canvas');
  img.width = Math.round(dw * dpr); img.height = Math.round(dh * dpr);
  img.getContext('2d').drawImage(bmp, 0, 0, img.width, img.height);
  if (bmp.close) bmp.close();
  let quad = (pg.quad || defaultQuad()).map(p => [...p]);
  const ctx = canvas.getContext('2d');
  const toPx = ([x, y]) => [pad + x * dw, pad + y * dh];
  const draw = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, dw + pad * 2, dh + pad * 2);
    ctx.drawImage(img, pad, pad, dw, dh);
    // 外側を暗く
    ctx.save();
    ctx.beginPath(); ctx.rect(pad, pad, dw, dh);
    const pts = quad.map(toPx);
    ctx.moveTo(pts[0][0], pts[0][1]); pts.slice(1).forEach(p => ctx.lineTo(p[0], p[1])); ctx.closePath();
    ctx.fillStyle = 'rgba(0,0,0,.45)'; ctx.fill('evenodd');
    ctx.restore();
    ctx.beginPath(); pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
    ctx.lineWidth = 2; ctx.strokeStyle = '#e0383e'; ctx.stroke();
    for (const [x, y] of pts) {
      ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.fill();
      ctx.lineWidth = 2.5; ctx.strokeStyle = '#e0383e'; ctx.stroke();
    }
  };
  draw();

  const loupe = $('#cropLoupe');
  const lctx = loupe.getContext('2d');
  const showLoupe = (k, cx, cy) => {
    const [px, py] = toPx(quad[k]);
    loupe.classList.remove('hidden');
    const cr = canvas.getBoundingClientRect();
    const sr2 = stage.getBoundingClientRect();
    // 指で隠れない位置（上）に出す
    let lx = cr.left - sr2.left + px - 60, ly = cr.top - sr2.top + py - 150;
    if (ly < 0) ly = cr.top - sr2.top + py + 40;
    loupe.style.left = lx + 'px'; loupe.style.top = ly + 'px';
    const z = 3;
    lctx.clearRect(0, 0, 120, 120);
    lctx.save();
    lctx.beginPath(); lctx.arc(60, 60, 60, 0, Math.PI * 2); lctx.clip();
    lctx.fillStyle = '#000'; lctx.fillRect(0, 0, 120, 120);
    const sx = (px - pad) * dpr, sy = (py - pad) * dpr;
    lctx.drawImage(img, sx - 60 * dpr / z, sy - 60 * dpr / z, 120 * dpr / z, 120 * dpr / z, 0, 0, 120, 120);
    lctx.restore();
    lctx.strokeStyle = '#e0383e'; lctx.lineWidth = 1.5;
    lctx.beginPath(); lctx.moveTo(60, 48); lctx.lineTo(60, 72); lctx.moveTo(48, 60); lctx.lineTo(72, 60); lctx.stroke();
  };

  let drag = null;
  canvas.onpointerdown = (e) => {
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    let best = -1, bd = 44;
    quad.forEach((p, k) => { const [px, py] = toPx(p); const d = Math.hypot(px - x, py - y); if (d < bd) { bd = d; best = k; } });
    if (best < 0) return;
    canvas.setPointerCapture(e.pointerId);
    const [px, py] = toPx(quad[best]);
    drag = { k: best, ox: px - x, oy: py - y };
    showLoupe(best);
  };
  canvas.onpointermove = (e) => {
    if (!drag) return;
    const r = canvas.getBoundingClientRect();
    const x = e.clientX - r.left + drag.ox, y = e.clientY - r.top + drag.oy;
    quad[drag.k] = [Math.min(1, Math.max(0, (x - pad) / dw)), Math.min(1, Math.max(0, (y - pad) / dh))];
    draw();
    showLoupe(drag.k);
  };
  canvas.onpointerup = canvas.onpointercancel = () => { drag = null; loupe.classList.add('hidden'); };

  $('#cropDetect').onclick = () => {
    const k = 260 / Math.max(img.width, img.height);
    const sm = document.createElement('canvas');
    sm.width = Math.round(img.width * k); sm.height = Math.round(img.height * k);
    const sctx = sm.getContext('2d', { willReadFrequently: true });
    sctx.drawImage(img, 0, 0, sm.width, sm.height);
    const q = detectQuad(sctx, sm.width, sm.height);
    if (q) { quad = q; draw(); } else toast('書類の枠を見つけられませんでした。四隅を手で合わせてください', 3000);
  };
  $('#cropFull').onclick = () => { quad = fullQuad(); draw(); };
  const close = () => { img.width = img.height = 0; canvas.onpointerdown = canvas.onpointermove = canvas.onpointerup = null; show('scanReview'); renderReview(); };
  $('#cropCancel').onclick = close;
  $('#cropOk').onclick = () => {
    pg.quad = quad;
    close();
    process(pg);
  };
}

// =====================================================================
export function initScannerUI() {
  $('#scanClose').onclick = closeScanner;
  $('#scanAuto').onclick = () => { st.auto = !st.auto; db.kvSet('scanAuto', st.auto); updateCamUI(); };
  $('#scanShutter').onclick = () => capture();
  $('#scanToReview').onclick = () => { if (st.pages.length) { st.retake = -1; showReview(); } };
  $('#scanFromPhotos').onclick = () => $('#scanFiles').click();
  $('#scanFiles').onchange = async (e) => { const f = [...e.target.files]; e.target.value = ''; await addFiles(f); if (st.pages.length) showReview(); };
  $('#scanNative').onchange = async (e) => { const f = [...e.target.files]; e.target.value = ''; await addFiles(f); updateCamUI(); };

  $('#revBack').onclick = () => { st.retake = -1; showCam(); };
  $('#revSave').onclick = save;
  document.querySelectorAll('#revFilters button').forEach(b => b.onclick = () => {
    const pg = st.pages[st.cur];
    if (!pg || pg.filter === b.dataset.f) return;
    pg.filter = b.dataset.f;
    st.filter = b.dataset.f;
    db.kvSet('scanFilter', b.dataset.f);
    renderReview();
    process(pg);
  });
  $('#revCrop').onclick = openCrop;
  $('#revRotate').onclick = () => { const pg = st.pages[st.cur]; pg.rot = (pg.rot + 1) % 4; process(pg); renderReview(); };
  $('#revRetake').onclick = () => { st.retake = st.cur; showCam(); };
  $('#revMoveL').onclick = () => move(-1);
  $('#revMoveR').onclick = () => move(1);
  $('#revDelete').onclick = del;
  document.addEventListener('visibilitychange', () => {
    if (!st) return;
    if (document.hidden) stopCamera();
    else if ($('#scanCam').classList.contains('active')) startCamera();
  });
}
