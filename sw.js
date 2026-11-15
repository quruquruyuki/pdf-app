// オフラインでも開けるようにするキャッシュ
const VERSION = 'v10';
const SHELL = `shell-${VERSION}`;
const LAZY = `lazy-${VERSION}`;

const SHELL_FILES = [
  './', 'index.html', 'css/app.css', 'manifest.webmanifest',
  'js/app.js', 'js/db.js', 'js/ui.js', 'js/pdfcore.js', 'js/pdfedit.js', 'js/viewer.js',
  'js/annot.js', 'js/ocr.js', 'js/fontsubset.js', 'js/fonts.js', 'js/scan.js', 'js/scanimg.js', 'js/sign.js', 'js/organizer.js',
  'vendor/pdf-lib.min.js', 'vendor/fontkit.umd.min.js',
  'vendor/pdfjs/pdf.min.mjs', 'vendor/pdfjs/pdf.worker.min.mjs',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== SHELL && k !== LAZY).map(k => caches.delete(k)),
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // アプリ本体：ネット優先（更新をすぐ反映）、だめならキャッシュ
  const isShell = /\.(html|css|js|mjs|webmanifest)$/.test(url.pathname) && !url.pathname.includes('/vendor/') || url.pathname.endsWith('/');
  if (isShell) {
    e.respondWith(fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(SHELL).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  // ライブラリ・OCRデータ・フォント：キャッシュ優先（使ったときに保存）
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then(hit => hit || fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(LAZY).then(c => c.put(e.request, copy)); }
    return res;
  })));
});
