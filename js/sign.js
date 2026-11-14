// 手書きサインの作成と保存
import { db, uid } from './db.js';
import { h, modal } from './ui.js';

const SVGNS = 'http://www.w3.org/2000/svg';

function previewSvg(sig) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', `0 0 100 ${100 * sig.ratio}`);
  s.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  for (const st of sig.strokes) {
    const p = document.createElementNS(SVGNS, 'polyline');
    p.setAttribute('points', st.map(([u, v]) => `${u * 100},${v * 100 * sig.ratio}`).join(' '));
    p.setAttribute('fill', 'none'); p.setAttribute('stroke', '#1a237e'); p.setAttribute('stroke-width', '1.6');
    p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
    s.append(p);
  }
  return s;
}

async function drawNew() {
  const canvas = h('canvas', { class: 'sign-pad' });
  const strokes = [];
  let cur = null;
  const body = h('div', {}, h('p', { class: 'muted small' }, '枠の中に指かApple Pencilでサインを書いてください。'), canvas,
    h('div', { class: 'field-row' }, h('button', { class: 'text-btn', onclick: () => { strokes.length = 0; redraw(); } }, '書き直す')));
  let ctx;
  const redraw = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = r.width * dpr; canvas.height = r.height * dpr;
    ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#1a237e';
    for (const st of strokes) { ctx.beginPath(); st.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.stroke(); }
  };
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => { canvas.setPointerCapture(e.pointerId); cur = [pos(e)]; strokes.push(cur); });
  canvas.addEventListener('pointermove', (e) => {
    if (!cur) return;
    const p = pos(e); const l = cur[cur.length - 1];
    cur.push(p);
    ctx.beginPath(); ctx.moveTo(l[0], l[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
  });
  const end = () => { cur = null; };
  canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
  setTimeout(redraw, 30);

  const ok = await modal('サインを作成', body, [
    { label: 'キャンセル', value: false },
    { label: '保存して使う', value: true, primary: true },
  ]);
  if (!ok || !strokes.length) return null;
  // 書いた範囲に合わせて正規化
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const st of strokes) for (const [x, y] of st) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
  const w = Math.max(1, x2 - x1), hh = Math.max(1, y2 - y1);
  const sig = {
    id: uid(),
    ratio: hh / w,
    strokes: strokes.map(st => st.map(([x, y]) => [+((x - x1) / w).toFixed(4), +((y - y1) / hh).toFixed(4)])),
  };
  const list = await db.kvGet('signatures', []);
  list.unshift(sig);
  await db.kvSet('signatures', list.slice(0, 5));
  return sig;
}

// 保存済みから選ぶ or 新しく書く
export async function chooseSignature() {
  const list = await db.kvGet('signatures', []);
  if (!list.length) return drawNew();
  let picked = null;
  const wrap = h('div', { class: 'sign-list' });
  const render = () => {
    wrap.innerHTML = '';
    for (const s of list) {
      const item = h('div', { class: 'sign-item' });
      const pv = previewSvg(s);
      pv.addEventListener('click', () => { picked = s; document.querySelector('#modalActions .primary').click(); });
      item.append(pv, h('button', { onclick: async () => {
        list.splice(list.indexOf(s), 1);
        await db.kvSet('signatures', list);
        render();
      } }, '削除'));
      wrap.append(item);
    }
  };
  render();
  const v = await modal('サインを選ぶ', h('div', {}, h('p', { class: 'muted small' }, 'サインをタップしてから、ページの置きたい場所をタップします。'), wrap), [
    { label: 'キャンセル', value: 'cancel' },
    { label: '新しく書く', value: 'new' },
    { label: '選ぶ', value: 'pick', primary: true },
  ]);
  if (v === 'new') return drawNew();
  if (v === 'pick') return picked || list[0];
  return null;
}
