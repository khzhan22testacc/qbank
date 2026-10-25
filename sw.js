/* Service worker: makes the app work offline.
   Bump CACHE whenever you change index.html, app.js, styles.css or icons,
   so phones pick up the new version. questions.json updates on its own. */

const CACHE = 'qbank-v1';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];
const DATA_URL = new URL('./questions.json', self.registration.scope).href;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll([...SHELL, DATA_URL]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Question bank: try the network briefly for updates, fall back to the cached copy.
  if (url.href.split('?')[0] === DATA_URL) {
    event.respondWith(
      Promise.race([fetch(req), timeout(4000)])
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(DATA_URL, copy));
          }
          return res;
        })
        .catch(() => caches.match(DATA_URL))
        .then(res => res || Response.error())
    );
    return;
  }

  // Everything else: cache first, then network.
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()));
    })
  );
});
