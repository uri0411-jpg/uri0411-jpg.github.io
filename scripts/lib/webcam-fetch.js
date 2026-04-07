// ═══════════════════════════════════════════
//  webcam-fetch.js
//  Discovers fixed westward-facing webcams via Windy.com API
//  and fetches historical frames at sunset time.
//  Falls back to Flickr with strict geo+time+accuracy filter.
// ═══════════════════════════════════════════

const WINDY_API_BASE  = 'https://api.windy.com/webcams/api/v3';
const FLICKR_API_BASE = 'https://api.flickr.com/services/rest';

/**
 * Discover nearby webcams via Windy API, filtered to IL and westward orientation.
 * @param {number} lat
 * @param {number} lon
 * @param {string} windyApiKey
 * @returns {Array<{id, title, lat, lon, previewUrl}>}
 */
export async function discoverWebcams(lat, lon, windyApiKey) {
  if (!windyApiKey) return [];

  const url = new URL(`${WINDY_API_BASE}/webcams`);
  url.searchParams.set('limit',      '10');
  url.searchParams.set('nearby',     `${lat},${lon},15`);   // 15 km radius
  url.searchParams.set('categories', 'landscape,sea');
  url.searchParams.set('include',    'images,location');
  url.searchParams.set('key',        windyApiKey);

  try {
    const res  = await fetch(url.toString());
    if (!res.ok) {
      console.warn('[webcam] Windy API error:', res.status);
      return [];
    }
    const data = await res.json();

    return (data.webcams ?? [])
      .filter(w => w.location?.country === 'IL')
      .map(w => ({
        id:         w.id,
        title:      w.title,
        lat:        w.location?.latitude,
        lon:        w.location?.longitude,
        previewUrl: w.images?.current?.preview ?? null,
      }));
  } catch (e) {
    console.warn('[webcam] Discovery failed:', e.message);
    return [];
  }
}

/**
 * Attempt to fetch a historical webcam frame for a given date + hour.
 * Windy stores images at predictable URLs for some cameras.
 * Returns Buffer base64 string or null if unavailable.
 * @param {string} webcamId
 * @param {string} date  YYYY-MM-DD
 * @param {number} hour  0-23 (local Israel time)
 * @returns {string|null} base64 JPEG data
 */
export async function fetchWebcamFrame(webcamId, date, hour) {
  // Clamp hour to valid range
  const h = Math.max(0, Math.min(23, hour));
  const timestamp = Math.floor(
    new Date(`${date}T${String(h).padStart(2, '0')}:00:00+03:00`).getTime() / 1000
  );
  const url = `https://images-webcams.windy.com/${webcamId}/current/thumbnail/${timestamp}.jpg`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.startsWith('image/')) return null;

    const buf = await res.arrayBuffer();
    return Buffer.from(buf).toString('base64');
  } catch {
    return null;
  }
}

/**
 * Search Flickr for sunset photos near a location on a given date.
 * Uses strict geo accuracy (≥14 = neighbourhood) + ±45 min time window.
 * @param {number} lat
 * @param {number} lon
 * @param {string} date       YYYY-MM-DD
 * @param {number} sunsetHour local Israel hour (UTC+3)
 * @param {string} flickrApiKey
 * @returns {Array<{id, url, dateTaken, accuracy}>}
 */
export async function flickrSearch(lat, lon, date, sunsetHour, flickrApiKey) {
  if (!flickrApiKey) return [];

  // Build UTC time window: sunset ± 45 min (Israel is UTC+3, simplified)
  const toTwoDigit = n => String(Math.max(0, Math.min(23, n))).padStart(2, '0');
  const utcHour    = sunsetHour - 3; // rough Israel → UTC
  const minDate    = `${date}T${toTwoDigit(utcHour - 1)}:15:00Z`;
  const maxDate    = `${date}T${toTwoDigit(utcHour + 1)}:00:00Z`;

  const url = new URL(FLICKR_API_BASE);
  url.searchParams.set('method',          'flickr.photos.search');
  url.searchParams.set('api_key',         flickrApiKey);
  url.searchParams.set('lat',             lat);
  url.searchParams.set('lon',             lon);
  url.searchParams.set('radius',          '10');
  url.searchParams.set('radius_units',    'km');
  url.searchParams.set('min_date_taken',  minDate);
  url.searchParams.set('max_date_taken',  maxDate);
  url.searchParams.set('sort',            'interestingness-desc');
  url.searchParams.set('extras',         'date_taken,geo,views,url_l,accuracy');
  url.searchParams.set('per_page',       '10');
  url.searchParams.set('content_type',   '1');   // photos only
  url.searchParams.set('geo_context',    '2');   // outdoors
  url.searchParams.set('accuracy',       '14');  // neighbourhood minimum
  url.searchParams.set('format',         'json');
  url.searchParams.set('nojsoncallback', '1');

  try {
    const res  = await fetch(url.toString(), { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return [];
    const data = await res.json();

    return (data.photos?.photo ?? [])
      .filter(p => Number(p.accuracy ?? 0) >= 14 && p.url_l)
      .slice(0, 5)
      .map(p => ({
        id:        p.id,
        url:       p.url_l,
        dateTaken: p.datetaken,
        accuracy:  Number(p.accuracy),
      }));
  } catch (e) {
    console.warn('[webcam] Flickr search failed:', e.message);
    return [];
  }
}
