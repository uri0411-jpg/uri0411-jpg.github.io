// ═══════════════════════════════════════════
//  TWILIGHT — api.js
//  External API: Open-Meteo (weather + air quality + ensemble),
//                Nominatim, Overpass
// ═══════════════════════════════════════════

import { OPEN_METEO_URL, OPEN_METEO_AQ_URL, NOMINATIM_URL, OVERPASS_URL, OVERPASS_FALLBACK_URL, CACHE_TTL, getWeatherTTL } from './config.js';
import { setCache, getCache, getStaleCache, swr, fetchWithDedup } from './cache.js';
import { distKm } from './utils.js';
import { getZoneForCoord } from './zones.js';

const FETCH_TIMEOUT_MS = 12000;
const FETCH_TIMEOUT_SECONDARY_MS = 8000;

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`fetch timeout after ${timeoutMs}ms: ${url}`)),
    timeoutMs
  );
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, options = {}, { maxAttempts = 3, baseMs = 1500, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchWithTimeout(url, options, timeoutMs);
      if (res.ok) return res;
      if ((res.status === 429 || res.status === 503) && attempt < maxAttempts - 1) {
        const ra = parseInt(res.headers.get('Retry-After'), 10);
        const wait = (isNaN(ra) ? baseMs * Math.pow(2, attempt) : ra * 1000) + Math.random() * 500;
        console.warn(`[api] ${res.status} on ${url} — retry ${attempt + 1}/${maxAttempts - 1} in ${Math.round(wait)}ms`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      lastErr = new Error(`HTTP ${res.status}`);
      lastErr.status = res.status;
      throw lastErr;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1 && !err.status) {
        await new Promise(r => setTimeout(r, baseMs * Math.pow(2, attempt) + Math.random() * 500));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ─────────────────────────────────────────
//  HOURLY PARAMS shared across models
// ─────────────────────────────────────────
const HOURLY_PARAMS = [
  'cloudcover', 'cloudcover_low', 'cloudcover_mid', 'cloudcover_high',
  'relativehumidity_2m', 'visibility',
  'windspeed_10m', 'winddirection_10m', 'windgusts_10m',
  'temperature_2m', 'surface_pressure',
  'precipitation_probability', 'precipitation',
  'dewpoint_2m', 'uv_index', 'apparent_temperature',
  'temperature_850hPa'  // A3: temperature inversion detection
].join(',');

const DAILY_PARAMS = [
  'sunrise', 'sunset',
  'temperature_2m_max', 'temperature_2m_min',
  'weathercode', 'precipitation_probability_max',
  'precipitation_sum', 'windspeed_10m_max', 'windgusts_10m_max'
].join(',');

// ─────────────────────────────────────────
//  Fetch single model forecast
// ─────────────────────────────────────────
async function fetchModel(lat, lon, model = null) {
  const params = new URLSearchParams({
    latitude: lat, longitude: lon,
    timezone: 'Asia/Jerusalem', forecast_days: 7,
    hourly: HOURLY_PARAMS, daily: DAILY_PARAMS
  });
  if (model) params.set('models', model);

  const url = `${OPEN_METEO_URL}?${params}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`Open-Meteo ${model || 'best_match'} error ${res.status}`);
  return res.json();
}

// ─────────────────────────────────────────
//  Average hourly arrays across models
// ─────────────────────────────────────────
function averageHourlyArrays(datasets, key) {
  const primary = datasets[0]?.hourly?.[key];
  if (!primary) return undefined;

  return primary.map((_, i) => {
    let sum = 0, count = 0;
    for (const ds of datasets) {
      const val = ds.hourly?.[key]?.[i];
      if (val != null && !isNaN(val)) { sum += val; count++; }
    }
    return count > 0 ? sum / count : primary[i] ?? 0;
  });
}

/**
 * Fast weather fetch — primary model only (best_match), zone-aware SWR.
 *
 * Always returns a Promise (never mixed sync/async).
 * - Warm boot (fresh cache): resolves instantly, 0 API calls.
 * - Stale boot: resolves instantly with stale data; background revalidation
 *   notifies subscribers via cache pub/sub when fresh data arrives.
 * - Cold boot (no cache): awaits network fetch.
 * - Force (manual refresh): always bypasses cache.
 *
 * @param {number}  lat
 * @param {number}  lon
 * @param {boolean} force  Bypass cache (manual refresh)
 * @returns {Promise<Object>}  Weather data (always a Promise)
 */
export async function fetchWeekFast(lat, lon, force = false) {
  const zone = getZoneForCoord(lat, lon);
  const key  = `weather_zone_${zone.zoneId}`;
  const ttl  = getWeatherTTL();

  if (force) {
    try {
      return await fetchWithDedup(key, async () => {
        const data = await fetchModel(zone.repLat, zone.repLon);
        data._modelCount = 1;
        setCache(key, data, ttl);
        return data;
      });
    } catch (err) {
      // Stale fallback — zone key first, legacy coord key second
      const stale = getStaleCache(key);
      if (stale) {
        console.warn('[api] fetchWeekFast: force fetch failed, using stale zone cache');
        stale._isStale = true;
        return stale;
      }
      const legacyKey = `weather_${lat.toFixed(3)}_${lon.toFixed(3)}`;
      const legacy = getStaleCache(legacyKey);
      if (legacy) {
        console.warn('[api] fetchWeekFast: force fetch failed, using legacy stale cache');
        legacy._isStale = true;
        return legacy;
      }
      throw err;
    }
  }

  const result = swr(key, async () => {
    const data = await fetchModel(zone.repLat, zone.repLon);
    data._modelCount = 1;
    return data;
  }, ttl);

  if (result.data) {
    // Cache hit (fresh or stale) — always return as Promise.
    // If stale, background revalidation is in-flight and will notify subscribers.
    if (result.isStale) {
      result.data._isStale = true;
      console.log(`[api] fetchWeekFast: serving stale zone ${zone.zoneId}, revalidating in background`);
    }
    return Promise.resolve(result.data);
  }

  // No cache — must await
  try {
    return await result.revalidatePromise;
  } catch (err) {
    // Network failed and no cache at all — check old per-coord key as last resort
    const legacyKey = `weather_${lat.toFixed(3)}_${lon.toFixed(3)}`;
    const stale = getStaleCache(legacyKey);
    if (stale) {
      console.warn('[api] fetchWeekFast: zone fetch failed, using legacy stale cache');
      stale._isStale = true;
      return stale;
    }
    throw err;
  }
}

/**
 * Background ensemble refinement — fetches ECMWF + GFS, averages with primary,
 * updates cache, and returns the refined data.
 * Zone-aware: uses zone representative coordinates for API calls.
 * Returns null if primary came from cache (wasFreshFetch=false) or both secondaries failed.
 *
 * @param {number}  lat            User's latitude (for zone lookup)
 * @param {number}  lon            User's longitude (for zone lookup)
 * @param {Object}  primaryData    Primary model data
 * @param {boolean} wasFreshFetch  True if primary was actually fetched (not from cache)
 */
export async function fetchWeekEnsemble(lat, lon, primaryData, wasFreshFetch = true) {
  if (!primaryData?.hourly) return null;
  if (!wasFreshFetch) return null; // Primary came from cache — no point re-averaging

  const zone = getZoneForCoord(lat, lon);
  const key  = `ensemble_zone_${zone.zoneId}`;

  return fetchWithDedup(key, async () => {
    const [ecmwfResult, gfsResult] = await Promise.allSettled([
      fetchModel(zone.repLat, zone.repLon, 'ecmwf_ifs025'),
      fetchModel(zone.repLat, zone.repLon, 'gfs_seamless')
    ]);

    const ecmwfData = ecmwfResult.status === 'fulfilled' ? ecmwfResult.value : primaryData;
    const gfsData   = gfsResult.status   === 'fulfilled' ? gfsResult.value   : primaryData;
    const datasets  = [primaryData, ecmwfData, gfsData];
    const realCount = new Set(datasets).size;

    if (realCount <= 1) {
      console.log('[api] Ensemble: no secondary models available, skipping refinement');
      return null;
    }

    // Deep-clone primary to avoid mutating the already-rendered data
    const refined = JSON.parse(JSON.stringify(primaryData));
    const hourlyKeys = Object.keys(refined.hourly).filter(k => k !== 'time');
    for (const hk of hourlyKeys) {
      refined.hourly[hk] = averageHourlyArrays(datasets, hk);
    }
    refined._modelCount = realCount;

    console.log(`[api] Ensemble: ${realCount} unique model(s) → averaging 3 slots (zone: ${zone.zoneId})`);
    const cacheKey = `weather_zone_${zone.zoneId}`;
    setCache(cacheKey, refined, getWeatherTTL());
    return refined;
  });
}

/**
 * Full ensemble fetch — backward-compatible wrapper.
 * Used by handleRefresh / handleSetLocation where we want complete data.
 */
export async function fetchWeek(lat, lon, force = false) {
  const primary = await fetchWeekFast(lat, lon, force);
  if (primary._isStale) return primary; // offline — skip ensemble
  const refined = await fetchWeekEnsemble(lat, lon, primary, true);
  return refined || primary;
}

/**
 * Fetch air quality data (dust, PM2.5, PM10, aerosol optical depth)
 * Zone-aware SWR — always returns a Promise.
 */
export async function fetchAirQuality(lat, lon, force = false) {
  const zone = getZoneForCoord(lat, lon);
  const key  = `airq_zone_${zone.zoneId}`;
  const ttl  = CACHE_TTL.airq; // 120min — was incorrectly using getWeatherTTL() (180min)

  if (force) {
    return fetchWithDedup(key, async () => {
      const data = await _fetchAirQualityRaw(zone.repLat, zone.repLon);
      if (data) setCache(key, data, ttl);
      return data;
    });
  }

  const result = swr(key, async () => {
    return _fetchAirQualityRaw(zone.repLat, zone.repLon);
  }, ttl);

  if (result.data) return Promise.resolve(result.data);

  try {
    return await result.revalidatePromise;
  } catch {
    return null; // non-critical
  }
}

/** Raw AQ fetch — no caching logic, just the API call */
async function _fetchAirQualityRaw(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat, longitude: lon,
    timezone: 'Asia/Jerusalem',
    forecast_days: 5,
    hourly: 'dust,pm2_5,pm10,aerosol_optical_depth,ozone'
  });

  try {
    const res = await fetchWithRetry(`${OPEN_METEO_AQ_URL}?${params}`, {}, { maxAttempts: 2, timeoutMs: FETCH_TIMEOUT_SECONDARY_MS });
    if (!res.ok) throw new Error(`AQ API error ${res.status}`);
    return await res.json();
  } catch (e) {
    console.warn('[api] Air quality fetch failed:', e.message);
    return null;
  }
}

// Hebrew name overrides for settlements that Nominatim returns in English/Arabic
const _HEBREW_NAME_OVERRIDES = {
  'Efrat': 'אפרת', 'Beitar Illit': 'ביתר עילית', 'Kiryat Arba': 'קרית ארבע',
  "Giv'at Ze'ev": 'גבעת זאב', 'Givat Zeev': 'גבעת זאב',
  "Beit El": 'בית אל', 'Eli': 'עלי', 'Shilo': 'שילה', 'Ofra': 'עופרה',
  'Kedumim': 'קדומים', 'Elkana': 'אלקנה', 'Immanuel': 'עמנואל',
  'Karnei Shomron': 'קרני שומרון', 'Barkan': 'ברקן',
  "Beit Aryeh": 'בית אריה', 'Adam': 'גבע בנימין', 'Tekoa': 'תקוע',
  'Hashmonaim': 'חשמונאים', "Ma'ale Adumim": 'מעלה אדומים',
  'Ariel': 'אריאל', 'Gush Etzion': 'גוש עציון',
};

/**
 * Reverse-geocode lat/lon to Hebrew city name via Nominatim
 */
export async function fetchCityName(lat, lon) {
  const cacheKey = `city_${lat.toFixed(3)}_${lon.toFixed(3)}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const params = new URLSearchParams({
    lat, lon, format: 'json', 'accept-language': 'he'
  });

  try {
    const res = await fetchWithTimeout(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': 'TWILIGHT-PWA/1.0', 'Accept-Language': 'he' }
    });
    if (!res.ok) return 'מיקום לא ידוע';
    const data = await res.json();
    let city = data.address?.city || data.address?.town
      || data.address?.village || data.address?.hamlet
      || data.address?.suburb || data.address?.county
      || data.address?.state || 'ישראל';
    city = _HEBREW_NAME_OVERRIDES[city] || city;
    setCache(cacheKey, city, CACHE_TTL.sun);
    return city;
  } catch { return 'מיקום לא ידוע'; }
}

/**
 * POST to Overpass with automatic fallback
 */
async function fetchOverpassWithFallback(query) {
  const body = `data=${encodeURIComponent(query)}`;
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  // Primary attempt — 25s to match Overpass server-side timeout
  try {
    const res = await fetchWithTimeout(OVERPASS_URL, { method: 'POST', headers, body }, 25000);
    if (res.ok) return res;
    throw new Error(`Overpass primary error ${res.status}`);
  } catch (err) {
    console.warn('[api] Overpass primary failed, trying fallback:', err.message);
  }
  // Fallback server — 25s
  try {
    const res2 = await fetchWithTimeout(OVERPASS_FALLBACK_URL, { method: 'POST', headers, body }, 25000);
    if (res2.ok) return res2;
    throw new Error(`Overpass fallback error ${res2.status}`);
  } catch (err2) {
    console.warn('[api] Overpass fallback also failed, retrying primary once:', err2.message);
  }
  // One more retry on primary (Overpass often succeeds on 2nd try)
  const res3 = await fetchWithTimeout(OVERPASS_URL, { method: 'POST', headers, body }, 25000);
  if (!res3.ok) throw new Error(`Overpass retry error ${res3.status}`);
  return res3;
}

/**
 * Fetch viewpoints/peaks/cliffs/beaches within radiusKm
 * v3: capped at 50km, limit 30 results
 */
export async function fetchSpots(lat, lon, radiusKm = 25) {
  const cappedRadius = Math.min(radiusKm, 50);
  const radiusM = cappedRadius * 1000;
  const cacheKey = `spots_${lat.toFixed(3)}_${lon.toFixed(3)}_${cappedRadius}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const query = `
    [out:json][timeout:25];
    (
      node["natural"="peak"](around:${radiusM},${lat},${lon});
      node["tourism"="viewpoint"](around:${radiusM},${lat},${lon});
      node["natural"="cliff"](around:${radiusM},${lat},${lon});
      node["natural"="beach"](around:${radiusM},${lat},${lon});
      way["natural"="peak"](around:${radiusM},${lat},${lon});
      way["tourism"="viewpoint"](around:${radiusM},${lat},${lon});
      way["natural"="cliff"](around:${radiusM},${lat},${lon});
      way["natural"="beach"](around:${radiusM},${lat},${lon});
    );
    out center;
  `;

  const res  = await fetchOverpassWithFallback(query);
  const data = await res.json();

  const typeMap = {
    peak: 'פסגה', viewpoint: 'נקודת תצפית', cliff: 'מצוק', beach: 'חוף'
  };

  const spots = (data.elements || [])
    .filter(el => el.lat || el.center?.lat)
    .map(el => {
      const slat = el.lat ?? el.center.lat;
      const slon = el.lon ?? el.center.lon;
      const name = el.tags?.name || el.tags?.['name:he'] || el.tags?.['name:en'] || 'נקודת תצפית';
      const natural = el.tags?.natural;
      const tourism = el.tags?.tourism;
      const type = typeMap[natural] || typeMap[tourism] || 'נקודת תצפית';
      const dist = distKm(lat, lon, slat, slon);
      return {
        name, type, lat: slat, lon: slon,
        dist: Math.round(dist * 10) / 10,
        elevation: el.tags?.ele ? Number(el.tags.ele) : null,
        // Image-resolution hints (coordinate-bound); consumed by js/spotImages.js
        _osmId:     el.id ?? null,
        _osmType:   el.type ?? null,
        _wikidata:  el.tags?.wikidata || null,
        _wikipedia: el.tags?.wikipedia || null,
        _nameEn:    el.tags?.['name:en'] || null,
        _commons:   el.tags?.wikimedia_commons || null,
        _imageUrl:  el.tags?.image || null,
      };
    })
    .filter(s => s.dist <= cappedRadius)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 100);

  setCache(cacheKey, spots, CACHE_TTL.spots);
  return spots;
}

/**
 * A2: Fetch cloud cover for the western horizon (~50km west)
 * Zone-aware SWR — uses zone representative point shifted 0.5° west.
 */
export async function fetchWesternHorizon(lat, lon, force = false) {
  const zone = getZoneForCoord(lat, lon);
  const key  = `west_zone_${zone.zoneId}`;
  const ttl  = getWeatherTTL();

  const fetcher = async () => {
    const lonWest = Math.max(-180, zone.repLon - 0.5);
    const params = new URLSearchParams({
      latitude: zone.repLat, longitude: lonWest,
      timezone: 'Asia/Jerusalem', forecast_days: 7,
      hourly: 'cloudcover_low,cloudcover'
    });
    try {
      const res = await fetchWithRetry(`${OPEN_METEO_URL}?${params}`, {}, { maxAttempts: 2, timeoutMs: FETCH_TIMEOUT_SECONDARY_MS });
      if (!res.ok) throw new Error(`Western horizon API error ${res.status}`);
      return await res.json();
    } catch (e) {
      console.warn('[api] Western horizon fetch failed:', e.message);
      return null;
    }
  };

  if (force) {
    return fetchWithDedup(key, async () => {
      const data = await fetcher();
      if (data) setCache(key, data, ttl);
      return data;
    });
  }

  const result = swr(key, fetcher, ttl);
  if (result.data) return Promise.resolve(result.data);

  try {
    return await result.revalidatePromise;
  } catch {
    return null; // non-critical
  }
}

// ✓ api.js v3 — complete
