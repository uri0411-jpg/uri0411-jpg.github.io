// ═══════════════════════════════════════════
//  TWILIGHT — spotImages.js
//  Geographic-first image resolution for map spots.
//  Prefers COORDINATES over names so generic labels like "נקודת תצפית"
//  still resolve to the actual spot, not some random photo sharing the name.
// ═══════════════════════════════════════════

import { getCache, setCache } from './cache.js';

const CACHE_TTL_MIN = 60 * 24 * 7;   // 7 days
const USER_AGENT = 'TwilightPWA/1.0 (sunset forecast; contact: github.com/twilight-pwa)';

const LANDSCAPE_KEYWORDS = [
  'sunset', 'sunrise', 'landscape', 'panorama', 'panoramic', 'view', 'viewpoint',
  'scenery', 'scenic', 'skyline', 'horizon', 'golden hour', 'dusk', 'twilight', 'dawn',
  'שקיעה', 'זריחה', 'נוף', 'פנורמה', 'תצפית', 'אופק',
];

/**
 * Resolve a photo for a spot. Returns { url, credit, sourceLabel, pageUrl }
 * or null if nothing found. Safe to call repeatedly — cached by coordinate.
 */
export async function fetchSpotImage(spot) {
  if (!spot || typeof spot.lat !== 'number' || typeof spot.lon !== 'number') return null;

  // Coordinate-bound key: two "נקודת תצפית" spots 200m apart get distinct entries.
  const key = spot._osmId
    ? `spotimg_osm_${spot._osmId}`
    : `spotimg_geo_${spot.lat.toFixed(4)}_${spot.lon.toFixed(4)}`;

  const cached = getCache(key);
  if (cached !== null) {
    // Miss sentinel — we already looked and found nothing.
    if (cached && cached._miss) return null;
    return cached;
  }

  let result = null;
  try {
    result =
      (await tryDirectImageTag(spot))      ||
      (await tryCommonsGeosearch(spot, 500)) ||
      (await tryWikidataP18(spot))         ||
      (await tryWikipediaSummary(spot))    ||
      (await tryCommonsGeosearch(spot, 2000));
  } catch (e) {
    console.warn('[spotImages] lookup failed:', e);
  }

  // Cache hits AND misses (misses as a sentinel so we don't hammer the APIs).
  setCache(key, result || { _miss: true }, CACHE_TTL_MIN);
  return result;
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
  if (!info) return 0;
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
  return score;
}

// ─── Source 2: Wikimedia Commons geosearch (geographic) ────────
async function tryCommonsGeosearch(spot, radiusM) {
  const u = new URL('https://commons.wikimedia.org/w/api.php');
  u.searchParams.set('action', 'query');
  u.searchParams.set('generator', 'geosearch');
  u.searchParams.set('ggsradius', String(radiusM));
  u.searchParams.set('ggscoord', `${spot.lat}|${spot.lon}`);
  u.searchParams.set('ggslimit', '10');
  u.searchParams.set('ggsnamespace', '6');     // File: namespace only
  u.searchParams.set('prop', 'imageinfo');
  u.searchParams.set('iiprop', 'url|extmetadata');
  u.searchParams.set('iiurlwidth', '640');
  u.searchParams.set('format', 'json');
  u.searchParams.set('origin', '*');

  const res = await fetch(u.toString());
  if (!res.ok) return null;
  const data = await res.json();
  const pages = data?.query?.pages;
  if (!pages) return null;

  const candidates = Object.values(pages)
    .filter(p => /\.(jpe?g|png)$/i.test(p.title || ''))
    .map(p => {
      const info = p.imageinfo?.[0];
      return info ? {
        url: info.thumburl || info.url,
        pageUrl: info.descriptionurl,
        credit: info.extmetadata?.Artist?.value?.replace(/<[^>]*>/g, '').trim() || 'Wikimedia Commons',
        score: scoreCandidate(p),
      } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return null;
  return { url: best.url, credit: best.credit, pageUrl: best.pageUrl, sourceLabel: 'ויקישיתוף' };
}

// ─── Source 3: Wikidata P18 image claim ─────────────────────────
async function tryWikidataP18(spot) {
  if (!spot._wikidata) return null;
  const qid = spot._wikidata;
  const u = `https://www.wikidata.org/wiki/Special:EntityData/${encodeURIComponent(qid)}.json`;
  const res = await fetch(u);
  if (!res.ok) return null;
  const data = await res.json();
  const entity = data?.entities?.[qid];
  const filename = entity?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
  if (!filename) return null;
  const encoded = encodeURIComponent(filename.replace(/ /g, '_'));
  return {
    url: `https://commons.wikimedia.org/w/thumb.php?f=${encoded}&w=640`,
    credit: 'Wikimedia Commons',
    sourceLabel: 'ויקיפדיה',
    pageUrl: `https://commons.wikimedia.org/wiki/File:${encoded}`,
  };
}

// ─── Source 4: Wikipedia REST summary ───────────────────────────
async function tryWikipediaSummary(spot) {
  if (!spot._wikipedia) return null;
  // Format is "lang:Title"
  const idx = spot._wikipedia.indexOf(':');
  if (idx < 0) return null;
  const lang = spot._wikipedia.slice(0, idx);
  const title = spot._wikipedia.slice(idx + 1);
  const u = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const res = await fetch(u);
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
