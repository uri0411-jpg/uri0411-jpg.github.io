// ═══════════════════════════════════════════
//  TWILIGHT — spotImages.js v4
//  Geographic-first image resolution for map spots.
//  Goal: ALWAYS show a real photo (or a real satellite map) of the location.
//  The cartoon SVG is now the ultimate offline fallback only.
//
//  Strategy:
//    1. Cache check (fresh hit returned instantly).
//    2. Direct OSM image= tag (instant, no network).
//    3. Parallel fan-out across many Wikimedia sources, with a global 6s budget.
//       The best-scoring candidate wins.
//    4. If nothing found → static OSM map of the coordinates with a sunset
//       direction overlay (rendered by the UI layer). This is a *real* image
//       of the place, not a generic illustration.
//    5. Cartoon SVG only when offline AND no cached anything.
// ═══════════════════════════════════════════

import { getCache, setCache } from './cache.js';

const CACHE_TTL_HIT_MIN  = 60 * 24 * 7;   // 7 days for hits
const CACHE_TTL_MISS_MIN = 60 * 6;        // 6 hours for misses (was 7d → user-felt latency on improvements)
const FETCH_TIMEOUT      = 4000;          // per-source timeout (ms)
const GLOBAL_BUDGET_MS   = 6000;          // total budget for all parallel sources
const THUMB_WIDTH        = 640;           // initial thumbnail width (px)

const LANDSCAPE_KEYWORDS = [
  'sunset', 'sunrise', 'landscape', 'panorama', 'panoramic', 'view', 'viewpoint',
  'scenery', 'scenic', 'skyline', 'horizon', 'golden hour', 'dusk', 'twilight', 'dawn',
  'nature', 'mountain', 'sea', 'clouds', 'outdoor', 'vista', 'overlook',
  'coast', 'hilltop', 'evening', 'sky',
  'שקיעה', 'זריחה', 'נוף', 'פנורמה', 'תצפית', 'אופק',
];

const NEGATIVE_KEYWORDS = [
  'map', 'diagram', 'logo', 'sign', 'plaque', 'icon', 'flag',
  'chart', 'svg', 'drawing', 'plan',
  'screenshot', 'webcam', 'texture', 'pattern', 'coat of arms', 'emblem',
  'stamp', 'coin', 'portrait',
];

const WARM_COLORS = ['orange', 'pink', 'purple', 'golden', 'red'];

// Type-based local fallback — ONLY used when offline + no cache
const TYPE_FALLBACKS = {
  peak:      './images/fallback-peak.svg',
  viewpoint: './images/fallback-viewpoint.svg',
  cliff:     './images/fallback-cliff.svg',
  beach:     './images/fallback-beach.svg',
};
const DEFAULT_FALLBACK = './images/fallback-viewpoint.svg';

// ─── Fetch with timeout ──────────────────────────────────────
function fetchT(url, ms = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// ─── Main entry point ────────────────────────────────────────
/**
 * Resolve a photo for a spot. Returns { url, credit, sourceLabel, pageUrl, _isStaticMap?, _isFallback? }
 * Cached by coordinate. Safe to call repeatedly.
 */
export async function fetchSpotImage(spot) {
  if (!spot || typeof spot.lat !== 'number' || typeof spot.lon !== 'number') return null;

  const key = spotCacheKey(spot);

  // 1. Cache hit (fresh photo) — return immediately.
  const cached = getCache(key);
  if (cached && !cached._miss) return cached;

  // 2. Direct OSM image= tag — instant, no network, very high confidence.
  const direct = tryDirectImageTag(spot);
  if (direct) {
    setCache(key, direct, CACHE_TTL_HIT_MIN);
    return direct;
  }

  // 3. Cached miss — go straight to static map (no network).
  if (cached && cached._miss) return tryStaticMap(spot);

  // 4. Parallel fan-out across all sources within global budget.
  let result = null;
  try {
    result = await raceForBest(spot, GLOBAL_BUDGET_MS);
  } catch (e) {
    console.warn('[spotImages] fan-out failed:', e);
  }

  if (result) {
    setCache(key, result, CACHE_TTL_HIT_MIN);
    return result;
  }

  // 5. Nothing real found — short-cache the miss and return a real static map.
  setCache(key, { _miss: true }, CACHE_TTL_MISS_MIN);
  return tryStaticMap(spot);
}

/** Cache key for a spot — v4 prefix to invalidate v3 misses from old strict pipeline */
function spotCacheKey(spot) {
  return spot._osmId
    ? `spotimg4_osm_${spot._osmId}`
    : `spotimg4_geo_${spot.lat.toFixed(4)}_${spot.lon.toFixed(4)}`;
}

/** Invalidate cached image for a spot so next fetch retries the chain */
export function invalidateSpotImage(spot) {
  if (!spot) return;
  const key = 'twl_' + spotCacheKey(spot);
  try { localStorage.removeItem(key); } catch (_) { /* noop */ }
}

// ─── Parallel race: collect candidates, pick the best ────────
/**
 * Run all sources in parallel. Each source returns either null or a candidate
 * with a `score` field. We accumulate as they resolve and pick the highest
 * scorer once either: all settle, the budget elapses, or we have a "good enough"
 * candidate (score >= EARLY_RETURN_SCORE) AND the high-priority lane has settled.
 */
const EARLY_RETURN_SCORE = 12; // featured/quality with strong landscape signal

async function raceForBest(spot, budgetMs) {
  // High-priority lane: trusted sources tied directly to this spot.
  // If one of these returns, it is almost certainly the right photo.
  const trusted = [
    tryWikidataP18(spot),
    tryCommonsCategory(spot),
    tryWikipediaSummary(spot),
  ];

  // Geographic lane: photos near these coordinates.
  const geographic = [
    tryWikidataSPARQLAround(spot, 5),
    tryCommonsGeosearchMulti(spot),
    tryCommonsTextSearchHebrew(spot),
    tryCommonsTextSearch(spot),
    tryRegionalCategorySearch(spot),
    tryCommonsSunsetCategory(spot),
    tryCommonsLandscapeCategory(spot),
  ];

  const all = [...trusted, ...geographic];
  const collected = [];
  let trustedSettled = 0;

  return new Promise((resolve) => {
    const budgetTimer = setTimeout(finalize, budgetMs);
    let resolved = false;

    function finalize() {
      if (resolved) return;
      resolved = true;
      clearTimeout(budgetTimer);
      // Pick best by score
      const best = collected
        .filter(c => c && c.url)
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
      resolve(best || null);
    }

    let pending = all.length;
    if (pending === 0) return finalize();

    trusted.forEach((p) => {
      Promise.resolve(p).then(handle).catch(() => handle(null)).finally(() => {
        trustedSettled++;
        maybeEarlyReturn();
      });
    });
    geographic.forEach((p) => {
      Promise.resolve(p).then(handle).catch(() => handle(null)).finally(maybeEarlyReturn);
    });

    function handle(c) {
      if (c && c.url) collected.push(c);
      pending--;
      if (pending <= 0) finalize();
    }
    function maybeEarlyReturn() {
      // Once trusted lane has fully settled, bail out if we already have a strong candidate
      if (trustedSettled >= trusted.length) {
        const best = collected.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
        if (best && (best.score ?? 0) >= EARLY_RETURN_SCORE) finalize();
      }
    }
  });
}

// ─── Source: direct OSM image= tag ─────────────────────────────
function tryDirectImageTag(spot) {
  if (!spot._imageUrl) return null;
  if (!/^https?:\/\//i.test(spot._imageUrl)) return null;
  return {
    url: spot._imageUrl,
    credit: 'OpenStreetMap contributors',
    sourceLabel: 'OSM',
    pageUrl: spot._imageUrl,
    score: 100, // user-tagged → trust
  };
}

// ─── Scoring helper ────────────────────────────────────────────
function scoreCandidate(page, { lenient = false } = {}) {
  const info = page.imageinfo?.[0];
  if (!info) return -Infinity;

  const w = info.width || 0;
  const h = info.height || 0;
  if (!lenient && (w < 200 || h < 150)) return -Infinity;
  if (lenient && (w < 100 || h < 75)) return -Infinity;

  const ext = info.extmetadata || {};
  const categories = (ext.Categories?.value || '').toLowerCase();
  const text = [
    page.title || '',
    categories,
    ext.ImageDescription?.value || '',
    ext.ObjectName?.value || '',
  ].join(' ').toLowerCase();

  let score = 0;

  for (const kw of LANDSCAPE_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) score += 1;
  }
  for (const kw of NEGATIVE_KEYWORDS) {
    if (text.includes(kw)) score -= 2;
  }

  if (categories.includes('featured picture')) score += 5;
  if (categories.includes('quality image'))    score += 3;

  let warmBonus = 0;
  for (const color of WARM_COLORS) {
    if (categories.includes(color)) { warmBonus += 2; if (warmBonus >= 4) break; }
  }
  score += warmBonus;

  const mp = (w * h) / 1_000_000;
  if (mp > 5) score += 2;
  else if (mp > 2) score += 1;

  const ratio = w / h;
  if (ratio > 1.3) score += 2;
  else if (ratio > 1.0) score += 1;

  if (lenient && score < 0) score = -10; // weak candidate, but real photo

  return score;
}

function buildCandidates(pages, opts = {}) {
  return Object.values(pages || {})
    .filter(p => /\.(jpe?g|png)$/i.test(p.title || ''))
    .map(p => {
      const info = p.imageinfo?.[0];
      if (!info) return null;
      const score = scoreCandidate(p, opts);
      if (score === -Infinity) return null;
      return {
        url: info.thumburl || info.url,
        pageUrl: info.descriptionurl,
        credit: info.extmetadata?.Artist?.value?.replace(/<[^>]*>/g, '').trim() || 'Wikimedia Commons',
        score,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

async function fetchImageInfo(titles) {
  if (!titles.length) return null;
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.searchParams.set('action', 'query');
  u.searchParams.set('titles', titles.slice(0, 10).join('|'));
  u.searchParams.set('prop', 'imageinfo');
  u.searchParams.set('iiprop', 'url|extmetadata|size');
  u.searchParams.set('iiurlwidth', String(THUMB_WIDTH));
  u.searchParams.set('format', 'json');
  u.searchParams.set('origin', '*');
  const res = await fetchT(u.toString());
  if (!res.ok) return null;
  const data = await res.json();
  return data?.query?.pages || null;
}

// ─── Shared Commons text-search helper ─────────────────────────
async function commonsSearch(srsearch, sourceLabel = 'ויקישיתוף') {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.searchParams.set('action', 'query');
  u.searchParams.set('list', 'search');
  u.searchParams.set('srnamespace', '6');
  u.searchParams.set('srsearch', srsearch);
  u.searchParams.set('srlimit', '10');
  u.searchParams.set('format', 'json');
  u.searchParams.set('origin', '*');

  const res = await fetchT(u.toString());
  if (!res.ok) return null;
  const data = await res.json();
  const results = data?.query?.search;
  if (!results?.length) return null;

  const titles = results.map(r => r.title).filter(t => /\.(jpe?g|png)$/i.test(t));
  const pages = await fetchImageInfo(titles);
  const candidates = buildCandidates(pages);
  const best = candidates[0];
  if (!best) return null;
  return { url: best.url, credit: best.credit, pageUrl: best.pageUrl, sourceLabel, score: best.score };
}

// ─── Source: Commons category from OSM _commons tag ────────────
async function tryCommonsCategory(spot) {
  if (!spot._commons) return null;
  const cat = spot._commons.startsWith('Category:') ? spot._commons : `Category:${spot._commons}`;
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.searchParams.set('action', 'query');
  u.searchParams.set('generator', 'categorymembers');
  u.searchParams.set('gcmtitle', cat);
  u.searchParams.set('gcmtype', 'file');
  u.searchParams.set('gcmlimit', '15');
  u.searchParams.set('prop', 'imageinfo');
  u.searchParams.set('iiprop', 'url|extmetadata|size');
  u.searchParams.set('iiurlwidth', String(THUMB_WIDTH));
  u.searchParams.set('format', 'json');
  u.searchParams.set('origin', '*');

  const res = await fetchT(u.toString());
  if (!res.ok) return null;
  const data = await res.json();
  const pages = data?.query?.pages;
  if (!pages) return null;

  const candidates = buildCandidates(pages);
  const best = candidates[0];
  if (!best) return null;
  // Boost: from explicit OSM tag → very likely correct
  return { url: best.url, credit: best.credit, pageUrl: best.pageUrl, sourceLabel: 'ויקישיתוף', score: best.score + 8 };
}

// ─── Source: Commons "Sunsets of Israel" category ──────────────
async function tryCommonsSunsetCategory(spot) {
  const name = spot._nameEn || spot.name;
  if (name) {
    const r = await commonsSearch(`incategory:"Sunsets of Israel" "${name}"`);
    if (r) { r.score += 5; return r; }
  }
  return null;
}

// ─── Source: Commons "Landscapes of Israel" category ───────────
async function tryCommonsLandscapeCategory(spot) {
  const name = spot._nameEn || spot.name;
  if (name) {
    const r = await commonsSearch(`incategory:"Landscapes of Israel" "${name}"`);
    if (r) { r.score += 3; return r; }
  }
  return null;
}

// ─── Source: Commons geosearch with expanding radii ────────────
async function tryCommonsGeosearchMulti(spot) {
  const radii = [500, 1500, 5000];
  for (const r of radii) {
    const found = await commonsGeosearch(spot, r, { lenient: r === 5000 });
    if (found) {
      // Closer hits get higher implicit score
      const distBoost = r === 500 ? 6 : (r === 1500 ? 3 : 0);
      found.score = (found.score ?? 0) + distBoost;
      return found;
    }
  }
  return null;
}

async function commonsGeosearch(spot, radiusM, { lenient = false } = {}) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.searchParams.set('action', 'query');
  u.searchParams.set('generator', 'geosearch');
  u.searchParams.set('ggsradius', String(radiusM));
  u.searchParams.set('ggscoord', `${spot.lat}|${spot.lon}`);
  u.searchParams.set('ggslimit', '15');
  u.searchParams.set('ggsnamespace', '6');
  u.searchParams.set('prop', 'imageinfo');
  u.searchParams.set('iiprop', 'url|extmetadata|size');
  u.searchParams.set('iiurlwidth', String(THUMB_WIDTH));
  u.searchParams.set('format', 'json');
  u.searchParams.set('origin', '*');

  const res = await fetchT(u.toString());
  if (!res.ok) return null;
  const data = await res.json();
  const pages = data?.query?.pages;
  if (!pages) return null;

  const candidates = buildCandidates(pages, { lenient });
  const best = candidates[0];
  if (!best) return null;
  return { url: best.url, credit: best.credit, pageUrl: best.pageUrl, sourceLabel: 'ויקישיתוף', score: best.score };
}

// ─── Source: Commons text search (English + sunset/landscape) ──
async function tryCommonsTextSearch(spot) {
  const name = spot._nameEn || spot.name;
  if (!name) return null;
  return commonsSearch(
    `"${name}" sunset OR sunrise OR landscape OR view -map -diagram -logo -sign`
  );
}

// ─── Source: Commons text search (Hebrew) ──────────────────────
async function tryCommonsTextSearchHebrew(spot) {
  const heName = spot.name && /[\u0590-\u05FF]/.test(spot.name) ? spot.name : null;
  if (!heName) return null;
  return commonsSearch(
    `"${heName}" שקיעה OR זריחה OR נוף OR תצפית`
  );
}

// ─── Source: Wikidata P18 image claim ──────────────────────────
async function tryWikidataP18(spot) {
  if (!spot._wikidata) return null;
  const qid = spot._wikidata;
  const u = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`;
  const res = await fetchT(u);
  if (!res.ok) return null;
  const data = await res.json();
  const entity = data?.entities?.[qid];
  const filename = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (!filename) return null;
  const encoded = encodeURIComponent(filename.replace(/ /g, '_'));
  return {
    url: `https://commons.wikimedia.org/w/thumb.php?f=${encoded}&w=${THUMB_WIDTH}`,
    credit: 'Wikimedia Commons',
    sourceLabel: 'ויקיפדיה',
    pageUrl: `https://commons.wikimedia.org/wiki/File:${encoded}`,
    score: 20, // Wikidata-curated → high confidence
  };
}

// ─── Source: Wikidata SPARQL nearby items with P18 ─────────────
async function tryWikidataSPARQLAround(spot, radiusKm = 5) {
  const sparql = `
    SELECT ?item ?image ?dist WHERE {
      SERVICE wikibase:around {
        ?item wdt:P625 ?loc .
        bd:serviceParam wikibase:center "Point(${spot.lon} ${spot.lat})"^^geo:wktLiteral .
        bd:serviceParam wikibase:radius "${radiusKm}" .
        bd:serviceParam wikibase:distance ?dist .
      }
      ?item wdt:P18 ?image .
    } ORDER BY ?dist LIMIT 5
  `;
  const u = `https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`;
  const res = await fetchT(u);
  if (!res.ok) return null;
  const data = await res.json();
  const bindings = data?.results?.bindings || [];
  if (!bindings.length) return null;
  const closest = bindings[0];
  const imageUrl = closest?.image?.value;
  if (!imageUrl) return null;
  // Convert "http://commons.wikimedia.org/wiki/Special:FilePath/Foo.jpg" → thumb
  const filenameMatch = imageUrl.match(/Special:FilePath\/(.+)$/);
  const filename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : null;
  if (!filename) return null;
  const encoded = encodeURIComponent(filename.replace(/ /g, '_'));
  const distKm = Number(closest?.dist?.value) || radiusKm;
  // Closer items get higher score
  const distBoost = distKm < 0.5 ? 12 : (distKm < 2 ? 7 : 3);
  return {
    url: `https://commons.wikimedia.org/w/thumb.php?f=${encoded}&w=${THUMB_WIDTH}`,
    credit: 'Wikimedia Commons',
    sourceLabel: 'ויקידאטה',
    pageUrl: `https://commons.wikimedia.org/wiki/File:${encoded}`,
    score: 8 + distBoost,
  };
}

// ─── Source: Wikipedia REST summary ────────────────────────────
async function tryWikipediaSummary(spot) {
  if (!spot._wikipedia) return null;
  const idx = spot._wikipedia.indexOf(':');
  if (idx < 0) return null;
  const lang = spot._wikipedia.slice(0, idx);
  const title = spot._wikipedia.slice(idx + 1);
  const u = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const res = await fetchT(u);
  if (!res.ok) return null;
  const data = await res.json();
  const thumb = data?.thumbnail?.source;
  if (!thumb) return null;
  return {
    url: thumb,
    credit: 'Wikipedia',
    sourceLabel: 'ויקיפדיה',
    pageUrl: data?.content_urls?.desktop?.page || null,
    score: 15,
  };
}

// ─── Source: Regional category via Nominatim reverse-geocode ───
const REGION_CACHE_TTL_MIN = 60 * 24 * 30; // 30 days

async function tryRegionalCategorySearch(spot) {
  const region = await getRegionForSpot(spot);
  if (!region) return null;
  // Try sunset-of-region first, then landscape
  const queries = [
    `incategory:"Sunsets of ${region}"`,
    `incategory:"Sunsets in ${region}"`,
    `incategory:"Landscapes of ${region}"`,
  ];
  for (const q of queries) {
    const r = await commonsSearch(q);
    if (r) {
      r.score += 4;
      return r;
    }
  }
  return null;
}

async function getRegionForSpot(spot) {
  const cacheKey = `region_${spot.lat.toFixed(2)}_${spot.lon.toFixed(2)}`;
  const cached = getCache(cacheKey);
  if (cached) return cached.region;

  try {
    const u = `https://nominatim.openstreetmap.org/reverse?lat=${spot.lat}&lon=${spot.lon}&format=json&zoom=8&accept-language=en`;
    const res = await fetchT(u);
    if (!res.ok) {
      setCache(cacheKey, { region: null }, REGION_CACHE_TTL_MIN);
      return null;
    }
    const data = await res.json();
    // Prefer state/region/county for category matching
    const a = data?.address || {};
    const region = a.state || a.region || a.county || a.city || null;
    setCache(cacheKey, { region }, REGION_CACHE_TTL_MIN);
    return region;
  } catch {
    return null;
  }
}

// ─── Last resort: real static map of the location ──────────────
/**
 * Returns a "static map" descriptor. The UI layer renders this specially:
 * a 3×2 grid of OSM tiles centered on the actual coordinates, with a
 * sunset-direction arrow overlaid. This is a real geographic depiction of the
 * spot, not a generic illustration. Tiles are fetched directly by `<img>` from
 * the OSM standard tile server (keyless, browser handles caching).
 */
const STATIC_MAP_ZOOM = 14;
const STATIC_MAP_TILES_X = 3;
const STATIC_MAP_TILES_Y = 3; // odd → marker always falls in central third (≈ 33%-67% of grid)

function tryStaticMap(spot) {
  const tileInfo = lonLatToTile(spot.lon, spot.lat, STATIC_MAP_ZOOM);
  // Use a single-tile representative URL for the `url` field (e.g. for previews/cache).
  // The UI layer reads `_tileGrid` to render the full mosaic.
  const repTileUrl = `https://tile.openstreetmap.org/${STATIC_MAP_ZOOM}/${tileInfo.xi}/${tileInfo.yi}.png`;
  return {
    url: repTileUrl,
    credit: '© OpenStreetMap contributors',
    sourceLabel: 'מפת לוויין',
    pageUrl: `https://www.openstreetmap.org/?mlat=${spot.lat}&mlon=${spot.lon}#map=15/${spot.lat}/${spot.lon}`,
    _isStaticMap: true,
    lat: spot.lat,
    lon: spot.lon,
    _tileGrid: buildTileGrid(spot.lat, spot.lon, STATIC_MAP_ZOOM, STATIC_MAP_TILES_X, STATIC_MAP_TILES_Y),
  };
}

/**
 * Build a tile grid descriptor centered on (lat, lon).
 * Returns { tiles: [{x, y, url, gridCol, gridRow}], cols, rows, markerX, markerY }
 * where markerX/markerY are 0..1 fractions of the rendered grid where the spot sits.
 */
function buildTileGrid(lat, lon, z, cols, rows) {
  const center = lonLatToTile(lon, lat, z);
  // Anchor: the center tile is at column floor(cols/2), row floor(rows/2)
  const anchorCol = Math.floor(cols / 2);
  const anchorRow = Math.floor(rows / 2);
  const tiles = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tx = center.xi + (c - anchorCol);
      const ty = center.yi + (r - anchorRow);
      tiles.push({
        x: tx, y: ty,
        url: `https://tile.openstreetmap.org/${z}/${tx}/${ty}.png`,
        gridCol: c, gridRow: r,
      });
    }
  }
  // Marker position within the grid (0..1)
  const markerX = (anchorCol + center.xf) / cols;
  const markerY = (anchorRow + center.yf) / rows;
  return { tiles, cols, rows, markerX, markerY };
}

function lonLatToTile(lon, lat, zoom) {
  const n = Math.pow(2, zoom);
  const x = (lon + 180) / 360 * n;
  const latRad = lat * Math.PI / 180;
  const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
  return { x, y, xi: Math.floor(x), yi: Math.floor(y), xf: x - Math.floor(x), yf: y - Math.floor(y) };
}

/** Ultimate offline fallback (cartoon SVG). Only used by UI when everything else fails. */
export function getOfflineFallback(spot) {
  const url = TYPE_FALLBACKS[spot?.type] || DEFAULT_FALLBACK;
  return {
    url,
    credit: '',
    sourceLabel: 'תמונה כללית',
    pageUrl: null,
    _isFallback: true,
  };
}
