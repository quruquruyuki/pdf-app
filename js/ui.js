export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

let toastTimer;
export function toast(msg, ms = 2200) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ボトムシート（アクションメニュー）
export function sheet(title, items) {
  return new Promise(resolve => {
    const bd = $('#sheetBackdrop'), sh = $('#sheet');
    $('#sheetTitle').textContent = title || '';
    $('#sheetTitle').classList.toggle('hidden', !title);
    const body = $('#sheetBody');
    body.innerHTML = '';
    const close = (v) => { bd.classList.add('hidden'); sh.classList.add('hidden'); bd.onclick = null; resolve(v); };
    for (const it of items) {
      if (!it) continue;
      body.append(h('button', { class: 'sheet-item' + (it.danger ? ' danger' : ''), onclick: () => close(it.value) },
        h('span', { class: 'ic' }, it.icon || ''),
        h('span', {}, it.label, it.desc ? h('span', { class: 'desc' }, it.desc) : null)));
    }
    bd.onclick = () => close(null);
    bd.classList.remove('hidden'); sh.classList.remove('hidden');
  });
}

// モーダル。actions: [{label, value, primary}] / body: Node
export function modal(title, body, actions) {
  return new Promise(resolve => {
    const m = $('#modal');
    $('#modalTitle').textContent = title;
    const b = $('#modalBody'); b.innerHTML = ''; if (body) b.append(body);
    const a = $('#modalActions'); a.innerHTML = '';
    const close = (v) => { m.classList.add('hidden'); resolve(v); };
    for (const act of actions) {
      a.append(h('button', { class: act.primary ? 'primary' : '', onclick: async () => {
        if (act.validate && !(await act.validate())) return;
        close(act.value);
      } }, act.label));
    }
    m.classList.remove('hidden');
    const f = b.querySelector('textarea, input');
    if (f) setTimeout(() => f.focus(), 50);
  });
}

export async function confirmBox(title, msg, okLabel = 'OK', danger = false) {
  const v = await modal(title, h('p', {}, msg), [
    { label: 'キャンセル', value: false },
    { label: okLabel, value: true, primary: true },
  ]);
  return v;
}

export async function promptBox(title, value = '', { multiline = false, placeholder = '' } = {}) {
  const input = multiline ? h('textarea', { placeholder }) : h('input', { type: 'text', placeholder });
  input.value = value;
  const ok = await modal(title, input, [
    { label: 'キャンセル', value: false },
    { label: 'OK', value: true, primary: true },
  ]);
  return ok ? input.value : null;
}

// 進行状況
let cancelFlag = false;
export const progress = {
  show(text, cancelable = false) {
    cancelFlag = false;
    $('#progressText').textContent = text;
    $('#progressBar').style.width = '0%';
    $('#progressCancel').classList.toggle('hidden', !cancelable);
    $('#progressCancel').onclick = () => { cancelFlag = true; $('#progressText').textContent = '中止しています…'; };
    $('#progress').classList.remove('hidden');
  },
  set(ratio, text) {
    $('#progressBar').style.width = Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
    if (text) $('#progressText').textContent = text;
  },
  get cancelled() { return cancelFlag; },
  hide() { $('#progress').classList.add('hidden'); },
};

export function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
export function fmtDate(t) {
  const d = new Date(t);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
