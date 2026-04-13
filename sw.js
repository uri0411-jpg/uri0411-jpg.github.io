// ═══════════════════════════════════════════
//  TWILIGHT — sw.js
//  Service Worker: offline support + push notifications
//  Plain JS (no ES6 modules in SW)
// ═══════════════════════════════════════════

// DEPLOY: Update BUILD_DATE before each deploy. Or run this one-liner to auto-bump:
//   node -e "const f='sw.js',d=new Date().toISOString().slice(0,10).replace(/-/g,''); \
//            require('fs').writeFileSync(f, require('fs').readFileSync(f,'utf8') \
//            .replace(/BUILD_DATE = '\d+'/, \"BUILD_DATE = '\" + d + \"'\"))"
const BUILD_DATE  = '20260414'; // YYYYMMDD — update per deploy
const CACHE_NAME  = 'twl-v' + BUILD_DATE; // auto-namespaces cache per deploy
const TILE_CACHE  = 'twl-tiles'; // persistent across deploys — managed by MAX_TILES
const MAX_TILES   = 500;         // ~12MB at ~25KB/tile — better cache hit rate for region

// Paths are relative — resolved against SW scope at install time
const STATIC_ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './css/tokens.css',
  './manifest.json',
  './images/background.jpg',
  './images/sunrise.png',
  './images/sunset.png',
  './images/twilight.png',
  './images/icon-192.png',
  './images/icon-512.png',
  './js/app.js',
  './js/config.js',
  './js/utils.js',
  './js/cache.js',
  './js/api.js',
  './js/score.js',
  './js/location.js',
  './js/nav.js',
  './js/ui.js',
  './js/main-screen.js',
  './js/spots-screen.js',
  './js/spotImages.js',
  './js/settings-screen.js',
  './js/learning-screen.js',
  './js/sw-register.js',
  './js/calibration.js',
  './js/install-prompt.js',
  './js/notifications.js',
  './js/zones.js',
  './js/locationSearch.js',
  // Pulse 1-4 additions
  './js/debugPanel.js',
  './js/engine/physicsLayer.js',
  './js/engine/goldenWindow.js',
  './js/engine/decisionEngine.js',
  './js/engine/scoreEngine.js',
  './js/engine/learningEngine.js',
  './js/engine/skyColor.js',
  './js/engine/atmosphere.js',
  './js/engine/sun.js',
  './js/engine/color.js',
  './js/render/skyCanvas.js',
  './js/render/skyMask.js',
  './js/render/sunDisk.js',
  './js/render/crepuscularRays.js',
  './js/render/nightSky.js',
  './js/data/environment.js',
  './js/data/ozone_climatology.js',
  './learning-seed.json',
  // Vendor — bundled locally for instant cache-first loading
  './js/vendor/leaflet.js',
  './css/leaflet.css',
  './css/images/layers.png',
  './css/images/layers-2x.png',
  './css/images/marker-icon.png',
  './css/images/marker-icon-2x.png',
  './css/images/marker-shadow.png'
];

const API_PATTERNS = [
  'api.open-meteo.com',
  'air-quality-api.open-meteo.com',
  'archive-api.open-meteo.com',
  'nominatim.openstreetmap.org',
  'overpass-api.de',
  'overpass.kumi.systems',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// ─── INSTALL ───────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(
        STATIC_ASSETS.map(async url => {
          try {
            const res = await fetch(url, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
            if (res.ok) await cache.put(url, res);
          } catch {
            // Non-fatal: asset will be fetched and cached on first live request
          }
        })
      )
    ).then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE ──────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_NAME && key !== TILE_CACHE)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── FETCH ─────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Map tiles — stale-while-revalidate with capped cache (MAX_TILES)
  if (url.hostname.includes('tile.openstreetmap.org') || url.hostname.includes('basemaps.cartocdn.com')) {
    event.respondWith(staleWhileRevalidateTile(request));
    return;
  }

  const isAPI = API_PATTERNS.some(p => url.hostname.includes(p) || url.href.includes(p));
  // Dev proxy: same-origin /proxy/* paths forward to real APIs via server.js.
  // Treat them identically to direct API calls (networkFirst + JSON offline fallback).
  const isDevProxy = url.hostname === 'localhost' && url.pathname.startsWith('/proxy/');
  if (isAPI || isDevProxy) {
    event.respondWith(networkFirst(request));
    return;
  }

  // Vendor files (Leaflet) — cache-first, they are versioned and rarely change.
  const path = url.pathname;
  if (path.includes('/vendor/') || path.includes('/css/images/')) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // App code (JS/CSS/HTML) — always try network first so updates are instant.
  // Large stable assets (images, fonts, seed data) stay cache-first.
  const isAppCode = path.endsWith('.js') || path.endsWith('.css') || path.endsWith('.html') || path === '/';
  if (isAppCode) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request, { ignoreSearch: true });
  if (cached) return cached;

  try {
    const response = await fetch(request, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
    if (response && response.status === 200 && response.type !== 'opaque') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (request.headers.get('accept')?.includes('text/html')) {
      return caches.match('./index.html');
    }
    // FIX: include Content-Type header in 503 response
    return new Response('Offline', {
      status: 503,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

async function networkFirst(request) {
  // No artificial SW timeout — app's AbortController (25s in api.js) is the
  // single source of truth for request timeouts. Avoids racing two timeouts.
  // cache: 'no-store' + no-cache header bypass HTTP cache so we always hit origin.
  try {
    const response = await fetch(request, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request, { ignoreSearch: true });
    return cached || new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ─── MAP TILE CACHE ────────────────────
async function staleWhileRevalidateTile(request) {
  const cache  = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);

  // Kick off background revalidation regardless
  const networkPromise = fetch(request).then(async response => {
    if (response && response.status === 200 && response.type !== 'opaque') {
      await cache.put(request, response.clone());
      await trimTileCache(cache);
    }
    return response;
  }).catch(() => null);

  // Serve cached immediately; fall back to network if not cached
  return cached || await networkPromise
    || new Response('Tile unavailable', { status: 503, headers: { 'Content-Type': 'text/plain' } });
}

// In-memory counter avoids calling cache.keys() on every background tile fetch.
// Starts at -1 (unknown). First call measures actual size; subsequent calls
// increment. Reset to MAX_TILES after a trim; -1 again on SW restart.
let _tileCacheSize = -1;

async function trimTileCache(cache) {
  if (_tileCacheSize < 0) {
    // First call or post-restart: measure the actual tile cache size
    _tileCacheSize = (await cache.keys()).length;
  } else {
    _tileCacheSize++;
  }
  if (_tileCacheSize <= MAX_TILES) return; // fast path: nothing to trim

  // Only enumerate keys when we know we're over the limit
  const keys   = await cache.keys();
  const excess = keys.slice(0, keys.length - MAX_TILES);
  await Promise.all(excess.map(k => cache.delete(k)));
  _tileCacheSize = MAX_TILES;
}

// ─── PUSH NOTIFICATIONS ────────────────
self.addEventListener('push', event => {
  const data = event.data?.json() || {};
  const title = data.title || 'TWILIGHT · דמדומים';
  const options = {
    body:    data.body || 'תנאי שקיעה מעולים היום!',
    icon:    '/images/sunset.png',
    badge:   '/images/icon-192.svg',
    dir:     'rtl',
    lang:    'he',
    data:    { url: data.url || '/' },
    actions: [
      { action: 'open',    title: 'פתח אפליקציה' },
      { action: 'dismiss', title: 'סגור' }
    ]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'dismiss') return;
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      return clients.openWindow(url);
    })
  );
});

// ✎ fixed: CACHE_NAME — added deploy-bump reminder comment
// ✎ fixed: tile.openstreetmap.org — excluded from SW (opaque responses)
// ✎ fixed: 503 response — includes Content-Type: text/plain
// ✎ fixed: OVERPASS_FALLBACK_URL added to API_PATTERNS
// ✓ sw.js — complete
