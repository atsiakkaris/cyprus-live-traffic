// Two caches, deliberately separate: the shell is a handful of small files we
// always want, tiles are an unbounded stream we have to keep a lid on. Sharing
// one cache (as this used to) meant tiles could never be trimmed without
// risking the shell, and there was no cap at all — panning the island at high
// zoom would accumulate hundreds of MB on the device and never give it back.
const SHELL_CACHE = 'cy-traffic-v2';
const TILE_CACHE = 'cy-tiles-v1';
const KEEP_CACHES = [SHELL_CACHE, TILE_CACHE];

const SHELL = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ~1200 tiles is roughly 20-30MB — enough to keep a normal session's worth of
// panning instant offline, small enough to never be the reason a phone runs
// short on space. The Cache API exposes no timestamps or hit counts, but
// cache.keys() returns insertion order, so oldest-inserted-first is the best
// available approximation of least-useful.
const MAX_TILES = 1200;

// keys() over a large cache isn't free, so don't run it on every single tile —
// check periodically and then trim all the way back to the cap in one batch.
// A service worker restart resets this counter, which just means the next
// check comes later than it might have; the trim is self-correcting whenever
// it does run.
const TRIM_CHECK_EVERY = 50;
let putsSinceCheck = 0;

async function cacheTile(request, response) {
  const cache = await caches.open(TILE_CACHE);
  await cache.put(request, response);
  if (++putsSinceCheck < TRIM_CHECK_EVERY) return;
  putsSinceCheck = 0;
  const keys = await cache.keys();
  const excess = keys.length - MAX_TILES;
  if (excess > 0) {
    await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
  }
}

// One-off migration for installs from before the split: those have tiles piled
// up inside the shell cache, where nothing will ever trim them. Drop anything
// there that isn't shell (latest.json stays — it's the offline data fallback).
async function purgeStrayShellEntries() {
  const cache = await caches.open(SHELL_CACHE);
  const shellUrls = SHELL.map((path) => new URL(path, self.registration.scope).href);
  const keys = await cache.keys();
  await Promise.all(
    keys
      .filter((key) => !shellUrls.includes(key.url) && !key.url.includes('latest.json'))
      .map((key) => cache.delete(key))
  );
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => !KEEP_CACHES.includes(k)).map((k) => caches.delete(k)))
      ),
      purgeStrayShellEntries(),
    ])
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = event.request.url;

  // Live data: always try the network first (it's the whole point), fall
  // back to the last cached snapshot only when actually offline.
  if (url.includes('latest.json')) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell (our own files): network-first, so a reopen/reload always
  // gets the current code — this is what used to serve stale versions for
  // a cycle or two after every deploy. Falls back to cache only when
  // actually offline. The shell is one small HTML file, so the network
  // round-trip costs nothing worth trading freshness for.
  if (url.startsWith(self.location.origin)) {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Map tiles (cross-origin, from CartoDB): cache-first — heavy, static, and
  // worth caching aggressively, but bounded now (see cacheTile above).
  event.respondWith(
    caches.open(TILE_CACHE).then((cache) =>
      cache.match(event.request).then((cached) => {
        const network = fetch(event.request)
          .then((res) => {
            if (res.ok) event.waitUntil(cacheTile(event.request, res.clone()));
            return res;
          })
          .catch(() => cached);
        return cached || network;
      })
    )
  );
});
