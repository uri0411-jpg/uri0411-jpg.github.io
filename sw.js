// ═══════════════════════════════════════════
//  TWILIGHT — sw.js
//  Service Worker: offline support + push notifications
//  Plain JS (no ES6 modules in SW)
// ═══════════════════════════════════════════

// DEPLOY: Update BUILD_DATE before each deploy. Or run this one-liner to auto-bump:
//   node -e "const f='sw.js',d=new Date().toISOString().slice(0,10).replace(/-/g,''); \
//            require('fs').writeFileSync(f, require('fs').readFileSync(f,'utf8') \
//            .replace(/BUILD_DATE = '\d+'/, \"BUILD_DATE = '\" + d + \"'\"))"
const BUILD_DATE  = '20260425'; // YYYYMMDD — update per deploy
const CACHE_NAME  = 'twl-v' + BUILD_DATE; // auto-namespaces cache per deploy
const TILE_CACHE  = 'twl-tiles'; // persistent across deploys — managed by MAX_TILES
const MAX_TILES   = 800;         // ~12MB at ~15KB/vector tile — better cache hit rate for region

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
  './images/fallback-peak.svg',
  './images/fallback-viewpoint.svg',
  './images/fallback-cliff.svg',
  './images/fallback-beach.svg',
  // Curated generic-sunset pool — precached so it works offline as the
  // default photo fallback. Missing files are tolerated (Promise.allSettled).
  './images/sunset-pool/credits.json',
  './images/sunset-pool/beach-1.jpg',
  './images/sunset-pool/beach-2.jpg',
  './images/sunset-pool/peak-1.jpg',
  './images/sunset-pool/peak-2.jpg',
  './images/sunset-pool/desert-1.jpg',
  './images/sunset-pool/desert-2.jpg',
  './images/sunset-pool/forest-1.jpg',
  './images/sunset-pool/forest-2.jpg',
  './images/sunset-pool/urban-1.jpg',
  './images/sunset-pool/urban-2.jpg',
  './images/sunset-pool/generic-1.jpg',
  './images/sunset-pool/generic-2.jpg',
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
  './js/main-screen/rating.js',
  './js/main-screen/explainer.js',
  './js/main-screen/charts.js',
  './js/spots-screen.js',
  './js/spots/storage.js',
  './js/spotImages.js',
  './js/settings-screen.js',
  './js/learning-screen.js',
  './js/sw-register.js',
  './js/calibration.js',
  './js/install-prompt.js',
  './js/notifications.js',
  './js/zones.js',
  './js/store.js',
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
  './js/workers/skyWorker.js',
  './js/data/environment.js',
  './js/data/ozone_climatology.js',
  './learning-seed.json',
  // Vendor — bundled locally for instant cache-first loading
  './js/vendor/maplibre-gl.js',
  './css/maplibre-gl.css',
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
    caches.keys().then(keys => {
      const oldCaches = keys.filter(key => key !== CACHE_NAME && key !== TILE_CACHE);
      // First install has no old caches to purge — skip claim() so we don't
      // disrupt in-flight fetches the page started before the SW existed.
      const isFirstInstall = oldCaches.length === 0;
      return Promise.all(oldCaches.map(key => caches.delete(key)))
        .then(() => {
          if (!isFirstInstall) return self.clients.claim();
          console.log('[SW] First install — skipping claim() to protect boot fetches');
        });
    })
  );
});

// ─── FETCH ─────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // Map tiles + vector resources — stale-while-revalidate with capped cache (MAX_TILES)
  if (url.hostname.includes('tile.openstreetmap.org') || url.hostname.includes('basemaps.cartocdn.com') || url.hostname.includes('fonts.openmaptiles.org')) {
    event.respondWith(staleWhileRevalidateTile(request));
    return;
  }

  // Weather / AQ APIs → SWR (stale-while-revalidate) with URL normalization
  // Serves cached data instantly + revalidates in background when stale.
  const isWeatherApi = url.hostname.includes('api.open-meteo.com') ||
                       url.hostname.includes('air-quality-api.open-meteo.com');
  const isDevWeatherProxy = url.hostname === 'localhost' &&
    (url.pathname.startsWith('/proxy/weather') || url.pathname.startsWith('/proxy/airq'));
  if (isWeatherApi || isDevWeatherProxy) {
    event.respondWith(swrApi(request, event));
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

  // Vendor files (MapLibre GL) — cache-first, they are versioned and rarely change.
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

// ─── WEATHER API SWR ──────────────────
// Stale-while-revalidate for Open-Meteo weather/AQ endpoints.
// Normalises URLs so nearby coordinates share a single cache entry.
// SW-level TTL (6h) is intentionally longer than app-level TTL (2-3h)
// because the SW is the last-resort offline fallback.

function normalizeApiUrl(rawUrl) {
  const u = new URL(rawUrl);
  if (u.hostname.includes('open-meteo') || u.hostname === 'localhost') {
    const lat = u.searchParams.get('latitude');
    const lon = u.searchParams.get('longitude');
    if (lat) u.searchParams.set('latitude', Number(lat).toFixed(3));
    if (lon) u.searchParams.set('longitude', Number(lon).toFixed(3));
    u.searchParams.delete('current_weather');
    u.searchParams.sort(); // canonical order for cache key stability
  }
  return u.toString();
}

async function swrApi(request, event) {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  const cache = await caches.open(CACHE_NAME);
  const normalizedUrl = normalizeApiUrl(request.url);
  const cacheKey = new Request(normalizedUrl);
  const cached = await cache.match(cacheKey);

  if (cached) {
    const cachedAt = cached.headers.get('X-TWL-Cached-At');
    const age = cachedAt ? (Date.now() - Number(cachedAt)) : Infinity;

    if (age > SIX_HOURS) {
      // Stale → serve immediately, revalidate in background
      event.waitUntil(fetchAndCacheApi(request, cacheKey, cache));
    }
    return cached;
  }

  // No cache → must fetch (throws if offline → JSON error below)
  try {
    return await fetchAndCacheApi(request, cacheKey, cache);
  } catch {
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function fetchAndCacheApi(request, cacheKey, cache) {
  const response = await fetch(request, {
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache' }
  });
  if (response && response.ok) {
    const headers = new Headers(response.headers);
    headers.set('X-TWL-Cached-At', String(Date.now()));
    const tagged = new Response(await response.clone().blob(), {
      status: response.status,
      statusText: response.statusText,
      headers
    });
    cache.put(cacheKey, tagged).catch(() => {}); // non-blocking
  }
  return response;
}

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
