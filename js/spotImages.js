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

import { getCache, setCache, swr, subscribe } from './cache.js';

const CACHE_TTL_HIT_MIN  = 60 * 24 * 7;   // 7 days for hits
const CACHE_TTL_MISS_MIN = 30;            // 30 min for misses — short so pipeline improvements reach users fast
const FETCH_TIMEOUT      = 4000;          // per-source timeout (ms)
const FETCH_TIMEOUT_SLOW = 8000;          // for known-slow endpoints (Nominatim, Wikidata SPARQL)
const GLOBAL_BUDGET_MS   = 7000;          // total budget for all parallel sources (raised to fit slow Wikidata)
const THUMB_WIDTH        = 640;           // initial thumbnail width (px)

const LANDSCAPE_KEYWORDS = [
  'sunset', 'sunrise', 'landscape', 'panorama', 'panoramic', 'view', 'viewpoint',
  'scenery', 'scenic', 'skyline', 'horizon', 'golden hour', 'dusk', 'twilight', 'dawn',
  'nature', 'mountain', 'sea', 'clouds', 'outdoor', 'vista', 'overlook',
  'coast', 'hilltop', 'evening', 'sky',
  'שקיעה', 'זריחה', 'נוף', 'פנורמה', 'תצפית', 'אופק',
];

const NEGATIVE_KEYWORDS = [
  'map', 'diagram', 'logo', 'plaque', 'icon', 'flag',
  'chart', 'drawing',
  'screenshot', 'webcam', 'texture', 'pattern', 'coat of arms', 'emblem',
  'stamp', 'coin', 'portrait',
];
// Note: removed 'svg' (legitimate technical term in some descriptions),
// 'plan' (e.g. "plan to hike", "open plan"), 'sign' (very common word).

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
 * Resolve a photo for a spot. Returns:
 *   { url, credit, sourceLabel, pageUrl, score?, alternates?,
 *     _isStaticMap?, _isFallback?, _isGenericSunset?, _isAreaPhoto?, _poolKey? }
 * Cached by coordinate. Safe to call repeatedly.
 *
 * Pipeline:
 *   1. Cache hit (with rejected-URL filter applied) → return.
 *   2. Direct OSM image= tag → return.
 *   3. Cached miss → skip network, go straight to generic sunset.
 *   4. Parallel fan-out → top-3 candidates cached as alternates.
 *   5. Nothing real found → curated generic sunset (NOT static map).
 *
 * The static map is now an opt-in alternative (UI button), not the default.
 */
export async function fetchSpotImage(spot) {
  if (!spot || typeof spot.lat !== 'number' || typeof spot.lon !== 'number') return null;

  const key = spotCacheKey(spot);
  const rejected = getRejectedUrls(spot);

  // 2. Direct OSM image= tag — always instant, checked before cache so a
  //    user-tagged photo always takes priority even over a cached result.
  const direct = tryDirectImageTag(spot);
  if (direct && !rejected.has(direct.url)) {
    setCache(key, direct, CACHE_TTL_HIT_MIN);
    return direct;
  }

  // 1 + 4 combined via SWR:
  //   • Fresh cache hit   → return immediately, no network.
  //   • Stale cache hit   → return immediately AND revalidate in background;
  //                         notify() fires when fresh result is ready so the
  //                         UI can swap to a better photo without blocking.
  //   • No cache (miss)   → must await the network fetch.
  const { data: cached, revalidatePromise } = swr(
    key,
    () => _fetchFresh(spot, rejected),
    CACHE_TTL_HIT_MIN
  );

  if (cached && !cached._miss) {
    const next = pickFromCachedWithAlternates(cached, rejected);
    if (next) return next;
    // Every cached candidate rejected → let revalidatePromise bring fresh ones.
  }

  // Cached miss → skip network entirely, go straight to generic sunset.
  if (cached && cached._miss) return pickGenericSunset(spot);

  // No usable cached data: await the network fetch.
  if (revalidatePromise) {
    try {
      const fresh = await revalidatePromise;
      if (fresh && !fresh._miss) {
        return pickFromCachedWithAlternates(fresh, rejected) || pickGenericSunset(spot);
      }
    } catch (e) {
      console.warn('[spotImages] fetch failed:', e);
    }
  }

  return pickGenericSunset(spot);
}

/**
 * Pure network fetch for SWR: runs raceForBest, stores result, returns it.
 * Called by swr() as the fetcher; also called directly on cache-miss.
 */
async function _fetchFresh(spot, rejected = new Set()) {
  let bundle = null;
  try {
    bundle = await raceForBest(spot, GLOBAL_BUDGET_MS, rejected);
  } catch (e) {
    console.warn('[spotImages] fan-out failed:', e);
  }
  if (bundle && bundle.best) {
    return { ...bundle.best, alternates: bundle.alternates };
  }
  return { _miss: true };
}

/**
 * Subscribe to background-revalidation events for a spot's photo.
 * When swr() finds a fresher result in the background, the callback fires
 * with the new result so the UI can swap the photo without a full reload.
 * Returns an unsubscribe function — call it when the card is hidden/destroyed.
 */
export function subscribeSpotImage(spot, cb) {
  if (!spot) return () => {};
  const key = spotCacheKey(spot);
  return subscribe(key, (fresh) => {
    if (fresh && !fresh._miss) cb(fresh);
  });
}

/**
 * If the cached entry has alternates, return the first whose URL is not in
 * the rejected set. Returns null if every option has been rejected.
 */
function pickFromCachedWithAlternates(cached, rejected) {
  if (!rejected || rejected.size === 0) return cached;
  const candidates = [cached, ...(cached.alternates || [])];
  for (const c of candidates) {
    if (c && c.url && !rejected.has(c.url)) {
      // Re-attach the alternates list (minus the chosen one) for further cycling.
      const rest = candidates.filter(x => x !== c).map(x => ({ ...x, alternates: undefined }));
      return { ...c, alternates: rest };
    }
  }
  return null;
}

/**
 * Get the static map for a spot — exposed so the UI can show it on demand
 * (e.g., when the user clicks "🗺️ הצג מפה"). NOT used as automatic fallback.
 */
export function getStaticMapForSpot(spot) {
  if (!spot) return null;
  return tryStaticMap(spot);
}

// ─── Rejected URLs (per-spot blacklist) ──────────────────────
/** localStorage key for a spot's rejected-URL list */
function rejectedKey(spot) {
  return `twl_rejected_${spotCacheKey(spot)}`;
}

/** Return the set of URLs the user (or onerror) has marked as bad for this spot */
export function getRejectedUrls(spot) {
  try {
    const raw = localStorage.getItem(rejectedKey(spot));
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

/** Add a URL to the spot's rejected list. Caps at 30 entries (LRU). */
export function rejectSpotImageUrl(spot, url) {
  if (!spot || !url) return;
  try {
    const set = getRejectedUrls(spot);
    set.add(url);
    const arr = Array.from(set).slice(-30);
    localStorage.setItem(rejectedKey(spot), JSON.stringify(arr));
  } catch (_) { /* noop */ }
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

async function raceForBest(spot, budgetMs, rejected = new Set()) {
  // High-priority lane: trusted sources tied directly to this spot.
  // If one of these returns, it is almost certainly the right photo.
  // Wikipedia-by-name covers spots without OSM wikipedia/wikidata tags,
  // which is the common case for most Israeli viewpoints.
  const trusted = [
    tryWikidataP18(spot),
    tryCommonsCategory(spot),
    tryWikipediaSummary(spot),
    tryHebrewWikipediaByName(spot),
    tryEnglishWikipediaByName(spot),
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
      // Filter rejected URLs, dedupe by URL, sort by score, take top-3.
      const seen = new Set();
      const ranked = collected
        .filter(c => c && c.url && !rejected.has(c.url))
        .filter(c => { if (seen.has(c.url)) return false; seen.add(c.url); return true; })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
      if (!ranked.length) return resolve(null);
      const best = ranked[0];
      const alternates = ranked.slice(1, 3); // top-3 total (best + 2 alternates)
      resolve({ best, alternates });
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
        const best = collected
          .filter(c => !rejected.has(c.url))
          .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
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
  if (!lenient && (w < 150 || h < 100)) return -Infinity;
  if (lenient && (w < 80 || h < 60)) return -Infinity;

  const ext = info.extmetadata || {};
  const categories = (ext.Categories?.value || '').toLowerCase();
  const text = [
    page.title || '',
    categories,
    ext.ImageDescription?.value || '',
    ext.ObjectName?.value || '',
  ].join(' ').toLowerCase();

  let score = 0;

  // Sunset/sunrise keywords get a strong boost: a real twilight photo should
  // always beat a generic landscape for our use-case (a twilight forecast app).
  const SUNSET_KEYWORDS = ['sunset', 'sunrise', 'שקיעה', 'זריחה', 'golden hour', 'dusk', 'twilight', 'dawn'];
  for (const kw of LANDSCAPE_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) {
      score += SUNSET_KEYWORDS.includes(kw) ? 3 : 1;
    }
  }
  for (const kw of NEGATIVE_KEYWORDS) {
    if (text.includes(kw)) score -= 1;
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

  // Aspect ratio: cards are 16:9 — portrait images look terrible cropped.
  const ratio = w / h;
  if (ratio < 0.9) score -= 15;        // portrait → strongly penalize
  else if (ratio > 1.3) score += 2;
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
// Tries 4 radii. The last two are increasingly lenient — better a real
// photo from 30km away than a static map. We accept whatever Commons has.
async function tryCommonsGeosearchMulti(spot) {
  const radii = [500, 2000, 10000, 30000];
  for (const r of radii) {
    const lenient = r >= 10000;
    const superLenient = r >= 30000; // accept any real photo, no scoring filter
    const found = await commonsGeosearch(spot, r, { lenient, superLenient });
    if (found) {
      // Closer hits get higher implicit score
      const distBoost = r === 500 ? 6 : (r === 2000 ? 3 : (r === 10000 ? 1 : 0));
      found.score = (found.score ?? 0) + distBoost;
      // Mark wide-area hits so the UI can label them honestly
      if (r >= 10000) found._isAreaPhoto = true;
      return found;
    }
  }
  return null;
}

async function commonsGeosearch(spot, radiusM, { lenient = false, superLenient = false } = {}) {
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

  const candidates = buildCandidates(pages, { lenient: lenient || superLenient });
  let best = candidates[0];
  // Super-lenient: if scoring rejected everything, just take the first valid
  // jpg/png file in the result set. Better any real photo than a static map.
  if (!best && superLenient) {
    const fallback = Object.values(pages)
      .filter(p => /\.(jpe?g|png)$/i.test(p.title || ''))
      .map(p => {
        const info = p.imageinfo?.[0];
        if (!info) return null;
        return {
          url: info.thumburl || info.url,
          pageUrl: info.descriptionurl,
          credit: info.extmetadata?.Artist?.value?.replace(/<[^>]*>/g, '').trim() || 'Wikimedia Commons',
          score: -20,
        };
      })
      .filter(Boolean);
    best = fallback[0];
  }
  if (!best) return null;
  return { url: best.url, credit: best.credit, pageUrl: best.pageUrl, sourceLabel: 'ויקישיתוף', score: best.score };
}

// ─── Source: Commons text search (English) ─────────────────────
// Excludes are filtered in scoring; keeping them out of srsearch widens
// the result set considerably.
async function tryCommonsTextSearch(spot) {
  const enName = spot._nameEn || (spot.name && !/[\u0590-\u05FF]/.test(spot.name) ? spot.name : null);
  if (!enName) return null;
  return commonsSearch(
    `"${enName}" sunset OR sunrise OR landscape OR view OR panorama`
  );
}

// ─── Source: Commons text search (Hebrew) ──────────────────────
async function tryCommonsTextSearchHebrew(spot) {
  const heName = spot.name && /[\u0590-\u05FF]/.test(spot.name) ? spot.name : null;
  if (!heName) return null;
  return commonsSearch(
    `"${heName}" שקיעה OR זריחה OR נוף OR תצפית OR פנורמה`
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

// ─── Source: Wikipedia REST summary (from OSM tag) ─────────────
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

// ─── Source: Wikipedia summary by spot name (no OSM tag needed) ─
// Tries the article whose title matches spot.name (or _nameEn). Many Israeli
// viewpoints have Hebrew Wikipedia articles even without a wikipedia= tag.
async function tryWikipediaByName(spot, lang) {
  const isHebrew = lang === 'he';
  let candidate = null;
  if (isHebrew) {
    candidate = spot.name && /[\u0590-\u05FF]/.test(spot.name) ? spot.name : null;
  } else {
    candidate = spot._nameEn || (spot.name && !/[\u0590-\u05FF]/.test(spot.name) ? spot.name : null);
  }
  if (!candidate) return null;

  // Stage 1: try direct page summary
  const direct = await fetchWikipediaSummary(lang, candidate);
  if (direct) return direct;

  // Stage 2: opensearch — tolerant of spelling/word-order differences
  const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  u.searchParams.set('action', 'opensearch');
  u.searchParams.set('search', candidate);
  u.searchParams.set('limit', '1');
  u.searchParams.set('namespace', '0');
  u.searchParams.set('format', 'json');
  u.searchParams.set('origin', '*');
  try {
    const res = await fetchT(u.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const matchTitle = data?.[1]?.[0];
    if (!matchTitle || matchTitle === candidate) return null; // already tried
    return await fetchWikipediaSummary(lang, matchTitle);
  } catch {
    return null;
  }
}

async function fetchWikipediaSummary(lang, title) {
  try {
    const u = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
    const res = await fetchT(u);
    if (!res.ok) return null;
    const data = await res.json();
    const thumb = data?.thumbnail?.source || data?.originalimage?.source;
    if (!thumb) return null;
    // Prefer originalimage (full-res) over thumbnail when available — but we
    // upscale thumb to a reasonable size by replacing the size suffix.
    const upscaled = thumb.replace(/\/\d+px-/, `/${THUMB_WIDTH}px-`);
    return {
      url: upscaled,
      credit: 'Wikipedia',
      sourceLabel: 'ויקיפדיה',
      pageUrl: data?.content_urls?.desktop?.page || null,
      score: 16, // slightly lower than Wikidata-tagged P18 (20) but very high
    };
  } catch {
    return null;
  }
}

const tryHebrewWikipediaByName  = (spot) => tryWikipediaByName(spot, 'he');
const tryEnglishWikipediaByName = (spot) => tryWikipediaByName(spot, 'en');

// ─── Source: Regional category via Nominatim reverse-geocode ───
// Commons category convention: "Sunsets in {city}" exists for major Israeli
// cities (Tel Aviv, Jerusalem, Haifa, Eilat, etc.) but NOT for districts
// (HaMerkaz, HaDarom). Fall back to Israel-wide category, which has 3000+
// real photos — better than a static map.
const REGION_CACHE_TTL_MIN = 60 * 24 * 30; // 30 days

async function tryRegionalCategorySearch(spot) {
  const place = await getPlaceForSpot(spot);
  // Build query list. Even without a city we still try Israel-wide.
  const queries = [];
  if (place) {
    queries.push(`incategory:"Sunsets in ${place}"`);
    queries.push(`incategory:"Sunsets of ${place}"`);
    queries.push(`incategory:"Landscapes of ${place}"`);
    queries.push(`incategory:"Views of ${place}"`);
  }
  // Israel-wide baselines — last so they don't outrank city-specific hits.
  queries.push(`incategory:"Sunsets in Israel"`);
  queries.push(`incategory:"Landscapes of Israel"`);

  for (const q of queries) {
    const r = await commonsSearch(q);
    if (r) {
      // City-specific gets a stronger boost than Israel-wide
      const boost = q.includes(`"${place}"`) ? 5 : 2;
      r.score = (r.score ?? 0) + boost;
      if (!place || !q.includes(`"${place}"`)) r._isAreaPhoto = true;
      return r;
    }
  }
  return null;
}

async function getPlaceForSpot(spot) {
  const cacheKey = `place_${spot.lat.toFixed(2)}_${spot.lon.toFixed(2)}`;
  const cached = getCache(cacheKey);
  if (cached) return cached.place;

  try {
    // zoom=10 gives city/town resolution; lower zoom returns districts.
    const u = `https://nominatim.openstreetmap.org/reverse?lat=${spot.lat}&lon=${spot.lon}&format=json&zoom=10&accept-language=en`;
    const res = await fetchT(u, FETCH_TIMEOUT_SLOW);
    if (!res.ok) {
      setCache(cacheKey, { place: null }, REGION_CACHE_TTL_MIN);
      return null;
    }
    const data = await res.json();
    const a = data?.address || {};
    // Prefer city > town > village > municipality. Skip district-level
    // (state/region/county) since Commons has no categories for them.
    const place = a.city || a.town || a.village || a.municipality || null;
    setCache(cacheKey, { place }, REGION_CACHE_TTL_MIN);
    return place;
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

// ─── Curated generic-sunset pool ─────────────────────────────
// Local images at images/sunset-pool/. Selected deterministically per spot so
// the same spot always shows the same generic. Categories chosen by spot.type
// + coordinate heuristics (Israel-specific). Every category has 2 images so
// nearby spots don't collide on the same picture.

const SUNSET_POOL_CATEGORIES = ['beach', 'peak', 'desert', 'forest', 'urban', 'generic'];
const SUNSET_POOL_PATH = './images/sunset-pool/';
let _sunsetCreditsCache = null; // promise

async function loadSunsetCredits() {
  if (_sunsetCreditsCache) return _sunsetCreditsCache;
  _sunsetCreditsCache = fetch(`${SUNSET_POOL_PATH}credits.json`)
    .then(r => r.ok ? r.json() : {})
    .catch(() => ({}));
  return _sunsetCreditsCache;
}

/**
 * Map a spot to a sunset-pool category.
 * Type takes precedence; otherwise we use Israel-coordinate heuristics:
 *   lat < 31.0      → desert (Negev)
 *   lon < 34.95     → beach (Mediterranean coast)
 *   lat > 32.7      → forest (Galilee)
 *   else            → generic
 */
function categoryForSpot(spot) {
  const t = spot?.type;
  if (t === 'beach') return 'beach';
  if (t === 'peak')  return 'peak';
  if (t === 'cliff') return 'beach'; // cliffs are usually coastal in IL
  if (t === 'viewpoint') {
    // viewpoints fall through to geographic heuristics
  }
  const { lat, lon } = spot;
  if (typeof lat === 'number' && typeof lon === 'number') {
    if (lat < 31.0)  return 'desert';
    if (lon < 34.95) return 'beach';
    if (lat > 32.7)  return 'forest';
    // Heuristic: dense urban band (Tel Aviv/Jerusalem corridor)
    if (lat > 31.7 && lat < 32.2 && lon > 34.7 && lon < 35.3) return 'urban';
  }
  return 'generic';
}

/** Tiny deterministic hash → 0 or 1 (which of the two images per category). */
function poolIndex(spot) {
  const lat = spot?.lat ?? 0;
  const lon = spot?.lon ?? 0;
  // Multiply to spread fractional bits, sum, mod 2.
  const h = Math.abs(Math.floor(lat * 10000) + Math.floor(lon * 10000));
  return h % 2;
}

/**
 * Returns a curated generic-sunset descriptor for the spot.
 * Uses a primary (type+region match) and falls back through generic-1/2 to
 * the cartoon SVG. Deterministic — same spot always picks the same image.
 *
 * Returns: { url, credit, sourceLabel, pageUrl, _isGenericSunset, _poolKey, _poolFallbacks }
 *   _poolFallbacks is an array of alternate URLs the UI can try if the primary
 *   404s (e.g., that pool image hasn't been downloaded yet).
 */
export function pickGenericSunset(spot) {
  if (!spot) return getOfflineFallback(spot);
  const cat = categoryForSpot(spot);
  const idx = poolIndex(spot) + 1; // 1-based
  const primary = `${cat}-${idx}.jpg`;
  const sibling = `${cat}-${idx === 1 ? 2 : 1}.jpg`;
  // Fallback chain: primary → sibling in same cat → generic-1 → generic-2
  const chain = [primary, sibling, 'generic-1.jpg', 'generic-2.jpg']
    .filter((v, i, a) => a.indexOf(v) === i);

  const result = {
    url: SUNSET_POOL_PATH + chain[0],
    credit: 'תמונת אווירה',
    sourceLabel: 'תמונת אווירה',
    pageUrl: null,
    _isGenericSunset: true,
    _poolKey: chain[0].replace('.jpg', ''),
    _poolCategory: cat,
    _poolFallbacks: chain.slice(1).map(f => SUNSET_POOL_PATH + f),
  };

  // Asynchronously enrich with credits — UI can re-render when ready.
  loadSunsetCredits().then(credits => {
    const c = credits?.[chain[0]];
    if (c && c.author && c.author !== 'TODO') {
      result.credit = c.author + (c.license ? ` · ${c.license}` : '');
      result.pageUrl = c.source && c.source !== 'TODO' ? c.source : null;
    }
  }).catch(() => {});

  return result;
}
