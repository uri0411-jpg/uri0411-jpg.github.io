// ═══════════════════════════════════════════
//  TWILIGHT — spotImages.js
//  Geographic-first image resolution for map spots.
//  Prefers COORDINATES over names so generic labels like "נקודת תצפית"
//  still resolve to the actual spot, not some random photo sharing the name.
//
//  Source chain (priority order):
//    1. OSM direct image= tag
//    2. Commons category (_commons OSM tag)
//    3. Commons "Sunsets of Israel" category search
//    4. Commons "Landscapes of Israel" category search (fallback)
//    5. Commons geosearch 500m
//    6. Commons text search (spot name + keywords)
//    7. Wikidata P18 image claim
//    8. Wikipedia REST summary
//    9. Commons geosearch 2km
//   10. Type-based local SVG fallback
// ═══════════════════════════════════════════

import { getCache, setCache } from './cache.js';

const CACHE_TTL_MIN = 60 * 24 * 7;   // 7 days
const FETCH_TIMEOUT  = 4000;          // per-source timeout (ms)
const THUMB_WIDTH    = 320;           // initial thumbnail width (px)

const LANDSCAPE_KEYWORDS = [
  'sunset', 'sunrise', 'landscape', 'panorama', 'panoramic', 'view', 'viewpoint',
  'scenery', 'scenic', 'skyline', 'horizon', 'golden hour', 'dusk', 'twilight', 'dawn',
  'nature', 'mountain', 'sea', 'clouds', 'outdoor', 'vista', 'overlook',
  'coast', 'hilltop', 'evening', 'sky',
  'שקיעה', 'זריחה', 'נוף', 'פנורמה', 'תצפית', 'אופק',
];

const NEGATIVE_KEYWORDS = [
  'map', 'diagram', 'logo', 'sign', 'plaque', 'icon', 'flag',
  'chart', 'aerial', 'satellite', 'svg', 'drawing', 'plan',
  'screenshot', 'webcam', 'texture', 'pattern', 'coat of arms', 'emblem',
  'stamp', 'coin', 'portrait',
];

const WARM_COLORS = ['orange', 'pink', 'purple', 'golden', 'red'];

// Type-based local fallback images (always available offline)
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
 * Resolve a photo for a spot. Returns { url, credit, sourceLabel, pageUrl }
 * or a type-based fallback. Safe to call repeatedly — cached by coordinate.
 */
export async function fetchSpotImage(spot) {
  if (!spot || typeof spot.lat !== 'number' || typeof spot.lon !== 'number') return null;

  const key = spotCacheKey(spot);

  const cached = getCache(key);
  if (cached !== null) {
    if (cached && cached._miss) return tryTypeFallback(spot);
    return cached;
  }

  let result = null;
  try {
    result =
      (await tryDirectImageTag(spot))           ||
      (await tryCommonsCategory(spot))          ||
      (await tryCommonsSunsetCategory(spot))    ||
      (await tryCommonsLandscapeCategory(spot)) ||
      (await tryCommonsGeosearch(spot, 500))    ||
      (await tryCommonsTextSearch(spot))        ||
      (await tryWikidataP18(spot))              ||
      (await tryWikipediaSummary(spot))         ||
      (await tryCommonsGeosearch(spot, 2000, { lenient: true }));
  } catch (e) {
    console.warn('[spotImages] lookup failed:', e);
  }

  setCache(key, result || { _miss: true }, CACHE_TTL_MIN);
  return result || tryTypeFallback(spot);
}

/** Cache key for a spot — v3 prefix to invalidate stale misses from strict filter era */
function spotCacheKey(spot) {
  return spot._osmId
    ? `spotimg3_osm_${spot._osmId}`
    : `spotimg3_geo_${spot.lat.toFixed(4)}_${spot.lon.toFixed(4)}`;
}

/** Invalidate cached image for a spot so next fetch retries the chain */
export function invalidateSpotImage(spot) {
  if (!spot) return;
  const key = 'twl_' + spotCacheKey(spot);
  try { localStorage.removeItem(key); } catch (_) { /* noop */ }
}

// ─── Source 1: direct OSM image= tag ────────────────────────────
async function tryDirectImageTag(spot) {
  if (!spot._imageUrl) return null;
  if (!/^https?:\/\//i.test(spot._imageUrl)) return null;
  return {
    url: spot._imageUrl,
    credit: 'OpenStreetMap contributors',
    sourceLabel: 'OSM',
    pageUrl: spot._imageUrl,
  };
}

// ─── Scoring helper: prefer landscape / sunset images ─────────
function scoreCandidate(page) {
  const info = page.imageinfo?.[0];
  if (!info) return -Infinity;

  // Skip tiny images (icons, thumbnails, logos)
  const w = info.width || 0;
  const h = info.height || 0;
  if (w < 200 || h < 150) return -Infinity;

  const ext = info.extmetadata || {};
  const categories = (ext.Categories?.value || '').toLowerCase();
  const text = [
    page.title || '',
    categories,
    ext.ImageDescription?.value || '',
    ext.ObjectName?.value || '',
  ].join(' ').toLowerCase();

  let score = 0;

  // Positive keyword matching
  for (const kw of LANDSCAPE_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) score += 1;
  }

  // Negative keyword matching (stronger penalty)
  for (const kw of NEGATIVE_KEYWORDS) {
    if (text.includes(kw)) score -= 2;
  }

  // Featured / Quality image bonuses
  if (categories.includes('featured picture')) score += 5;
  if (categories.includes('quality image'))    score += 3;

  // Warm sunset color bonus (capped at +4)
  let warmBonus = 0;
  for (const color of WARM_COLORS) {
    if (categories.includes(color)) { warmBonus += 2; if (warmBonus >= 4) break; }
  }
  score += warmBonus;

  // Resolution bonus
  const mp = (w * h) / 1_000_000;
  if (mp > 5) score += 2;
  else if (mp > 2) score += 1;

  // Aspect ratio: prefer landscape orientation
  const ratio = w / h;
  if (ratio > 1.3) score += 2;
  else if (ratio > 1.0) score += 1;

  return score;
}

/** Build imageinfo results into scored candidates.
 *  In lenient mode, skip the 200×150 minimum-size gate so we accept any valid
 *  jpg/png — better a small real photo than an SVG drawing. */
function buildCandidates(pages, { lenient = false } = {}) {
  return Object.values(pages)
    .filter(p => /\.(jpe?g|png)$/i.test(p.title || ''))
    .map(p => {
      const info = p.imageinfo?.[0];
      if (!info) return null;
      let score = scoreCandidate(p);
      if (lenient && score === -Infinity) {
        // Size-gated out — revive as a weak candidate for last-resort use.
        score = -10;
      }
      return {
        url: info.thumburl || info.url,
        pageUrl: info.descriptionurl,
        credit: info.extmetadata?.Artist?.value?.replace(/<[^>]*>/g, '').trim() || 'Wikimedia Commons',
        score,
      };
    })
    .filter(c => c && c.score > -Infinity)
    .sort((a, b) => b.score - a.score);
}

/** Fetch imageinfo for a list of page titles (File: namespace) */
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

// ─── Shared Commons search helper ─────────────────────────────
/** Search Commons files by srsearch query, score results, return best */
async function commonsSearch(srsearch) {
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
  if (!pages) return null;

  const candidates = buildCandidates(pages);
  const best = candidates[0];
  if (!best) return null;
  return { url: best.url, credit: best.credit, pageUrl: best.pageUrl, sourceLabel: 'ויקישיתוף' };
}

// ─── Source 2: Wikimedia Commons category (_commons tag) ──────
async function tryCommonsCategory(spot) {
  if (!spot._commons) return null;
  const cat = spot._commons.startsWith('Category:') ? spot._commons : `Category:${spot._commons}`;
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.searchParams.set('action', 'query');
  u.searchParams.set('list', 'categorymembers');
  u.searchParams.set('cmtitle', cat);
  u.searchParams.set('cmtype', 'file');
  u.searchParams.set('cmlimit', '10');
  u.searchParams.set('format', 'json');
  u.searchParams.set('origin', '*');

  const res = await fetchT(u.toString());
  if (!res.ok) return null;
  const data = await res.json();
  const members = data?.query?.categorymembers;
  if (!members?.length) return null;

  const titles = members.map(m => m.title).filter(t => /\.(jpe?g|png)$/i.test(t));
  const pages = await fetchImageInfo(titles);
  if (!pages) return null;

  const candidates = buildCandidates(pages);
  const best = candidates[0];
  if (!best) return null;
  return { url: best.url, credit: best.credit, pageUrl: best.pageUrl, sourceLabel: 'ויקישיתוף' };
}

// ─── Source 3: Wikimedia "Sunsets of Israel" category ─────────
async function tryCommonsSunsetCategory(spot) {
  const name = spot._nameEn || spot.name;
  // Try spot-specific sunset first, then general Israeli sunsets
  if (name) {
    const r = await commonsSearch(`incategory:"Sunsets of Israel" "${name}"`);
    if (r) return r;
  }
  return commonsSearch('incategory:"Sunsets of Israel" sunset');
}

// ─── Source 4: Wikimedia "Landscapes of Israel" category ──────
async function tryCommonsLandscapeCategory(spot) {
  const name = spot._nameEn || spot.name;
  if (name) {
    const r = await commonsSearch(`incategory:"Landscapes of Israel" "${name}"`);
    if (r) return r;
  }
  return commonsSearch('incategory:"Landscapes of Israel" landscape');
}

// ─── Source 5: Wikimedia Commons geosearch (geographic) ────────
async function tryCommonsGeosearch(spot, radiusM, { lenient = false } = {}) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.searchParams.set('action', 'query');
  u.searchParams.set('generator', 'geosearch');
  u.searchParams.set('ggsradius', String(radiusM));
  u.searchParams.set('ggscoord', `${spot.lat}|${spot.lon}`);
  u.searchParams.set('ggslimit', '10');
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
  return { url: best.url, credit: best.credit, pageUrl: best.pageUrl, sourceLabel: 'ויקישיתוף' };
}

// ─── Source 6: Wikimedia Commons text search (topic-aware) ─────
async function tryCommonsTextSearch(spot) {
  const name = spot._nameEn || spot.name;
  if (!name) return null;
  return commonsSearch(
    `"${name}" sunset OR sunrise OR landscape OR שקיעה OR נוף -map -diagram -logo -sign`
  );
}

// ─── Source 7: Wikidata P18 image claim ─────────────────────────
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
  };
}

// ─── Source 8: Wikipedia REST summary ───────────────────────────
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
  };
}

// ─── Source 10 (fallback): type-based local image ───────────────
function tryTypeFallback(spot) {
  const url = TYPE_FALLBACKS[spot.type] || DEFAULT_FALLBACK;
  return {
    url,
    credit: '',
    sourceLabel: 'תמונה כללית',
    pageUrl: null,
    _isFallback: true,
  };
}
