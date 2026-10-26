// sw.js — replaces the browser build's cache-first service worker: it takes
// over at once, clears the old caches, unregisters itself and reloads its
// pages onto the engine's loader (index.html). Kept at the old path so
// returning players' browsers fetch it.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  await self.clients.claim();
  for (const key of await caches.keys()) await caches.delete(key);
  await self.registration.unregister();
  for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
})()));
