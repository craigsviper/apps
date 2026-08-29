// RSW Field App — Service Worker v72.3
// Handles BOTH build modes:
//   - viteSingleFile: everything inlined in index.html (current build)
//   - Standard Vite: separate JS/CSS chunks
//
// Chrome PWA requirements met:
//   - Responds to fetch events ✓
//   - Caches content for offline ✓
//   - start_url is cached ✓

const CACHE_NAME = 'rsw-app-v73.142';

// Assets to pre-cache on install
// NOTE: '/' intentionally excluded — the app is a local file (index.html), not served from /
// Caching '/' would try to cache the sync server's root URL which is not the app
const PRECACHE_URLS = [
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-180.png',
  '/icons/icon-32.png',
  // Leaflet marker icons — served locally (no CDN), explicitly pre-cached so
  // map pins render correctly when offline / no network available
  '/leaflet/marker-icon.png',
  '/leaflet/marker-icon-2x.png',
  '/leaflet/marker-shadow.png',
  // Leaflet CSS + JS for print report maps (Reports.tsx uses window.open template)
  '/leaflet/leaflet.css',
  '/leaflet/leaflet-src.js',
];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache each URL individually so one failure doesn't block the rest
      await Promise.allSettled(
        PRECACHE_URLS.map(url =>
          fetch(url, { cache: 'no-store' })
            .then(r => { if (r.ok) return cache.put(url, r); })
            .catch(() => { /* ignore — will be cached on first visit */ })
        )
      );
    })
  );
  // Take control immediately — don't wait for old SW to idle
  self.skipWaiting();
});

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => {
            console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Strip the _cb cache-busting param added by forceAppRefresh so the SW
  // can still match cached assets after a forced refresh cycle.
  if (url.searchParams.has('_cb')) {
    url.searchParams.delete('_cb');
    // Re-issue the request without the param (cache lookup will now match)
    event.respondWith(
      caches.match(url.toString()).then(cached => cached || fetch(url.toString()))
    );
    return;
  }

  // Only handle GET requests from same origin
  if (req.method !== 'GET') return;

  // Don't intercept map tile servers or nominatim — let them pass through
  if (
    url.hostname.includes('tile.openstreetmap.org') ||
    url.hostname.includes('nominatim.openstreetmap.org') ||
    url.hostname.includes('arcgisonline.com') ||
    url.hostname.includes('unpkg.com') ||
    url.hostname.includes('cdnjs.cloudflare.com')
  ) {
    return; // Let browser handle map tiles natively
  }

  // ── Strategy: Cache-first for icons and static assets ────────────────────
  if (
    url.pathname.startsWith('/icons/') ||
    /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot)(\?.*)?$/.test(url.pathname)
  ) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(r => {
          if (r.ok) {
            caches.open(CACHE_NAME).then(c => c.put(req, r.clone()));
          }
          return r;
        });
      })
    );
    return;
  }

  // ── Strategy: Network-first for navigation (page loads / refresh) ─────────
  // Falls back to cached index.html so the app loads offline.
  // viteSingleFile puts ALL JS/CSS inline in index.html — so caching
  // index.html = caching the entire app.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(response => {
          if (response.ok) {
            // Update cache with fresh copy
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => {
              c.put(req, clone);
              // Also cache as '/' and '/index.html' for offline fallback
              c.put('/', response.clone());
              c.put('/index.html', response.clone());
            });
          }
          return response;
        })
        .catch(async () => {
          // Network failed — try cache fallback
          const cached =
            (await caches.match(req)) ||
            (await caches.match('/index.html')) ||
            (await caches.match('/'));
          // If we have a cached copy serve it (genuine offline)
          if (cached) return cached;
          // Cache is empty — likely just after a cache-clear + reload.
          // Do NOT serve the offline page; let the browser retry natively
          // so the server can respond with a fresh copy.
          // Returning undefined here causes the browser to handle the request.
          return fetch(req.url, { cache: 'no-store' }).catch(() =>
            new Response(
              '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>RSW Field App — Offline</title></head>' +
              '<body style="font-family:sans-serif;padding:40px;text-align:center;background:#0f172a;color:white">' +
              '<h1>🧹 RSW Field App</h1><p>You are offline. Open the app once while online to enable offline use.</p>' +
              '</body></html>',
              { headers: { 'Content-Type': 'text/html' } }
            )
          );
        })
    );
    return;
  }

  // ── Strategy: Stale-while-revalidate for JS/CSS (separate chunk builds) ───
  const isAppAsset = /\.(js|css|mjs)(\?.*)?$/.test(url.pathname);
  if (isAppAsset && url.origin === self.location.origin) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async cache => {
        const cached = await cache.match(req);
        const networkPromise = fetch(req).then(r => {
          if (r.ok) cache.put(req, r.clone());
          return r;
        }).catch(() => null);
        // Return cached immediately; update in background
        return cached ?? networkPromise;
      })
    );
    return;
  }

  // ── Default: network with cache fallback ──────────────────────────────────
  event.respondWith(
    fetch(req)
      .then(r => {
        if (r.ok) {
          caches.open(CACHE_NAME).then(c => c.put(req, r.clone()));
        }
        return r;
      })
      .catch(() => caches.match(req))
  );
});

// ── Message: force update ──────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
