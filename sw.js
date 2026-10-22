/*
 * Service worker: precaches the whole app so it opens and works offline.
 * Strategy: cache-first for this app's own files; nothing else is ever fetched.
 *
 * IMPORTANT: when you change ANY app file, bump VERSION below. Browsers then
 * download the new files and offer the update; without a bump, installed copies
 * keep serving the old cached files.
 */
const VERSION = '1.0.1';
const CACHE = 'pdf-scanner-v' + VERSION;
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'scanner.js',
  'pdf.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png'
];

self.addEventListener('install', (event) => {
  // Bypass the HTTP cache so we never precache stale copies. No skipWaiting here:
  // the page asks for it when the user accepts an update (avoids mixing versions mid-scan).
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((a) => new Request(a, { cache: 'reload' }))))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('pdf-scanner-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;     // never touch other origins
  event.respondWith(respond(req));
});

async function respond(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  if (req.mode === 'navigate') {
    const shell = (await cache.match('index.html')) || (await cache.match('./'));
    if (shell) return shell;
  }
  try {
    return await fetch(req);
  } catch (err) {
    return new Response('Offline', { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain' } });
  }
}
