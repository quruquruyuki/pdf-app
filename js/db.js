// IndexedDB: PDFは端末の中だけに保存する
const DB_NAME = 'pdf-note';
const DB_VER = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });   // メタ情報
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files', { keyPath: 'id' }); // PDF本体
      if (!db.objectStoreNames.contains('annots')) db.createObjectStore('annots', { keyPath: 'id' }); // 注釈
      if (!db.objectStoreNames.contains('ocr')) db.createObjectStore('ocr', { keyPath: 'id' });     // OCR結果
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', { keyPath: 'k' });        // 設定・署名
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r && 'onsuccess' in r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (store, key) => tx(store, 'readonly', s => s.get(key)),
  put: (store, val) => tx(store, 'readwrite', s => s.put(val)),
  del: (store, key) => tx(store, 'readwrite', s => s.delete(key)),
  all: (store) => tx(store, 'readonly', s => s.getAll()),
  async kvGet(k, def) { const r = await this.get('kv', k); return r ? r.v : def; },
  kvSet(k, v) { return this.put('kv', { k, v }); },
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 保存領域を消されにくくする（ホーム画面に追加したPWAでは特に有効）
export async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (_) {}
}
