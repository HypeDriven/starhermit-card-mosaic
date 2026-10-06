// sw.js — Card Mosaic service worker.
// Precaches the app shell on install; network-first for /api, cache-first for
// static assets. Registration lives in js/main.js.

// Bump on every shipped change to js/css/index.html: the fetch handler is
// cache-first, so a stale cache would otherwise pin returning players to the
// previous build forever.
const CACHE_VERSION = 'cardmosaic-v7';

const PRECACHE = [
  'index.html',
  'css/style.css',
  'js/main.js',
  'js/audio.js',
  'js/gfx.js',
  'js/gfx-strings.js',
  'js/content.js',
  'js/motifs.js',
  'js/platform.js',
  'js/platform-strings.js',
  'starhermit-sdk.js',
  'ui-scale.js',
  'js/render.js',
  'js/rng.js',
  'js/rules.js',
  'js/session.js',
  'js/storage.js',
  'js/themes.js',
  'js/ui.js',
  'vendor/three.module.js',
  'vendor/addons/environments/RoomEnvironment.js',
  'vendor/addons/math/SimplexNoise.js',
  'vendor/addons/postprocessing/EffectComposer.js',
  'vendor/addons/postprocessing/GTAOPass.js',
  'vendor/addons/postprocessing/MaskPass.js',
  'vendor/addons/postprocessing/OutputPass.js',
  'vendor/addons/postprocessing/Pass.js',
  'vendor/addons/postprocessing/RenderPass.js',
  'vendor/addons/postprocessing/SMAAPass.js',
  'vendor/addons/postprocessing/ShaderPass.js',
  'vendor/addons/postprocessing/UnrealBloomPass.js',
  'vendor/addons/shaders/CopyShader.js',
  'vendor/addons/shaders/FXAAShader.js',
  'vendor/addons/shaders/GTAOShader.js',
  'vendor/addons/shaders/LuminosityHighPassShader.js',
  'vendor/addons/shaders/OutputShader.js',
  'vendor/addons/shaders/PoissonDenoiseShader.js',
  'vendor/addons/shaders/SMAAShader.js',
  'starhermit.txt',
  'favicon.svg',
  'assets/key-art.webp',
  'assets/results-complete.webp',
  'assets/results-over.webp',
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
