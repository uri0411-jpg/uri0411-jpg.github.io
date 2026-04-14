// ═══════════════════════════════════════════
//  TWILIGHT — spotImages.js
//  Geographic-first image resolution for map spots.
//  Prefers COORDINATES over names so generic labels like "נקודת תצפית"
//  still resolve to the actual spot, not some random photo sharing the name.
//  Sources: OSM direct → Commons category → Commons geosearch 500m →
//           Commons text search → Wikidata P18 → Wikipedia summary →
//           Commons geosearch 2km → type-based local fallback.
// ═══════════════════════════════════════════

import { getCache, setCache } from './cache.js';

const CACHE_TTL_MIN = 60 * 24 * 7;   // 7 days
const FETCH_TIMEOUT  = 4000;          // per-source timeout (ms)
const THUMB_WIDTH    = 320;           // initial thumbnail width (px)

const LANDSCAPE_KEYWORDS = [
  'sunset', 'sunrise', 'landscape', 'panorama', 'panoramic', 'view', 'viewpoint',
  'scenery', 'scenic', 'skyline', 'horizon', 'golden hour', 'dusk', 'twilight', 'dawn',
  'שקיעה', 'זריחה', 'נוף', 'פנורמה', 'תצפית', 'אופק',
];

const NEGATIVE_KEYWORDS = [
  'map', 'diagram', 'logo', 'sign', 'plaque', 'icon', 'flag',
  'chart', 'aerial', 'satellite', 'svg', 'drawing', 'plan',
];

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
      (await tryDirectImageTag(spot))         ||
      (await tryCommonsCategory(spot))        ||
      (await tryCommonsGeosearch(spot, 500))  ||
      (await tryCommonsTextSearch(spot))      ||
      (await tryWikidataP18(spot))            ||
      (await tryWikipediaSummary(spot))       ||
      (await tryCommonsGeosearch(spot, 2000));
  } catch (e) {
    console.warn('[spotImages] lookup failed:', e);
  }

  setCache(key, result || { _miss: true }, CACHE_TTL_MIN);
  return result || tryTypeFallback(spot);
}

/** Cache key for a spot — coordinate-bound */
function spotCacheKey(spot) {
  return spot._osmId
    ? `spotimg_osm_${spot._osmId}`
    : `spotimg_geo_${spot.lat.toFixed(4)}_${spot.lon.toFixed(4)}`;
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
  const text = [
    page.title || '',
    ext.Categories?.value || '',
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

  // Landscape orientation bonus
  if (w > h) score += 2;

  return score;
}

/** Build imageinfo results into scored candidates */
function buildCandidates(pages) {
  return Object.values(pages)
    .filter(p => /\.(jpe?g|png)$/i.test(p.title || ''))
    .map(p => {
      const info = p.imageinfo?.[0];
      if (!info) return null;
      return {
        url: info.thumburl || info.url,
        pageUrl: info.descriptionurl,
        credit: info.extmetadata?.Artist?.value?.replace(/<[^>]*>/g, '').trim() || 'Wikimedia Commons',
        score: scoreCandidate(p),
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

// ─── Source 3: Wikimedia Commons geosearch (geographic) ────────
async function tryCommonsGeosearch(spot, radiusM) {
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

  const candidates = buildCandidates(pages);
  const best = candidates[0];
  if (!best) return null;
  return { url: best.url, credit: best.credit, pageUrl: best.pageUrl, sourceLabel: 'ויקישיתוף' };
}

// ─── Source 4: Wikimedia Commons text search (topic-aware) ─────
async function tryCommonsTextSearch(spot) {
  const name = spot._nameEn || spot.name;
  if (!name) return null;

  const query = `"${name}" sunset OR sunrise OR landscape OR שקיעה OR נוף`;
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.searchParams.set('action', 'query');
  u.searchParams.set('list', 'search');
  u.searchParams.set('srnamespace', '6');
  u.searchParams.set('srsearch', query);
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

// ─── Source 5: Wikidata P18 image claim ─────────────────────────
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

// ─── Source 6: Wikipedia REST summary ───────────────────────────
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

// ─── Source 7 (fallback): type-based local image ────────────────
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
