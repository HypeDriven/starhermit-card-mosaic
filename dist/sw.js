// sw.js — Card Mosaic service worker.
// Precaches the app shell on install; network-first for /api, cache-first for
// static assets. Registration lives in js/main.js.

const CACHE_VERSION = 'cardmosaic-v1';

const PRECACHE = [
  'index.html',
  'css/style.css',
  'js/main.js',
  'js/audio.js',
  'js/content.js',
  'js/motifs.js',
  'js/platform.js',
  'js/render.js',
  'js/rng.js',
  'js/rules.js',
  'js/session.js',
  'js/storage.js',
  'js/themes.js',
  'js/ui.js',
  'vendor/three.module.js',
  'starhermit.txt',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) =>
        // tolerate missing files during development: add individually
        Promise.allSettled(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' }))))
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // API: network-first, never served from cache
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req)).then((res) => res || Response.error())
    );
    return;
  }

  // static: cache-first, populate cache in the background
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    })
  );
});
