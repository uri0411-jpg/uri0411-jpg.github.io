// ═══════════════════════════════════════════
//  TWILIGHT — sw.js
//  Service Worker: offline support + push notifications
//  Plain JS (no ES6 modules in SW)
// ═══════════════════════════════════════════

// 🔴 BUMP THIS ON EVERY DEPLOY (twl-v3, twl-v4, ...)
const CACHE_NAME  = 'twl-v28';  // bumped: Phase 3 physics — 5λ spectrum, Belt-of-Venus, ozone, goldenWindow fix
const TILE_CACHE  = 'twl-tiles'; // persistent across deploys — managed by MAX_TILES
const MAX_TILES   = 250;         // ~6MB at ~25KB/tile — enough for region + new spot

// Paths are relative — resolved against SW scope at install time
const STATIC_ASSETS = [
  './',
  './index.html',
  './css/app.css',
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
  './js/settings-screen.js',
  './js/sw-register.js',
  './js/calibration.js',
  './js/install-prompt.js',
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
  './js/render/skyGradient.js',
  './js/render/skyCanvas.js',
  './js/render/sunDisk.js',
  './js/render/crepuscularRays.js',
  './js/data/environment.js'
];

const API_PATTERNS = [
  'api.open-meteo.com',
  'air-quality-api.open-meteo.com',
  'archive-api.open-meteo.com',
  'nominatim.openstreetmap.org',
  'overpass-api.de',
  'overpass.kumi.systems',
  'unpkg.com/leaflet',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
];

// ─── INSTALL ───────────────────────────
self.addEventListener('install', event => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Caching static assets');
      return Promise.allSettled(
        STATIC_ASSETS.map(url => cache.add(url).catch(e => console.warn('[SW] Failed to cache:', url, e)))
      );
    }).then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE ──────────────────────────
self.addEventListener('activate', event => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME && key !== TILE_CACHE)
          .map(key => { console.log('[SW] Deleting old cache:', key); return caches.delete(key); })
      )
    ).then(() => self.clients.claim())
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
  if (isAPI) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
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
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
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

async function trimTileCache(cache) {
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) {
    const excess = keys.slice(0, keys.length - MAX_TILES);
    await Promise.all(excess.map(k => cache.delete(k)));
  }
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
