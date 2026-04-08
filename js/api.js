// ═══════════════════════════════════════════
//  TWILIGHT — api.js
//  External API: Open-Meteo (weather + air quality + ensemble),
//                Nominatim, Overpass
// ═══════════════════════════════════════════

import { OPEN_METEO_URL, OPEN_METEO_AQ_URL, NOMINATIM_URL, OVERPASS_URL, OVERPASS_FALLBACK_URL, CACHE_TTL } from './config.js';
import { setCache, getCache, getStaleCache } from './cache.js';
import { distKm } from './utils.js';

const FETCH_TIMEOUT_MS = 40000;

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
  const res = await fetchWithTimeout(url);
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
 * Fetch 7-day weather forecast — ensemble of up to 3 models
 * Primary: best_match (auto), Secondary: ECMWF IFS, Tertiary: GFS
 * Falls back to primary-only if secondaries fail
 */
export async function fetchWeek(lat, lon, force = false) {
  const cacheKey = `weather_${lat.toFixed(3)}_${lon.toFixed(3)}`;
  const cached = getCache(cacheKey);
  if (cached && !force) return cached;

  // Fetch primary + secondaries in parallel — if primary (best_match) fails,
  // fall back to whichever secondary model responded, then to stale cache.
  const [primaryResult, ecmwfResult, gfsResult] = await Promise.allSettled([
    fetchModel(lat, lon),
    fetchModel(lat, lon, 'ecmwf_ifs025'),
    fetchModel(lat, lon, 'gfs_seamless')
  ]);

  let primary;
  if (primaryResult.status === 'fulfilled') {
    primary = primaryResult.value;
  } else {
    // best_match failed — try secondaries as primary
    const fallback = ecmwfResult.status === 'fulfilled' ? ecmwfResult.value
                   : gfsResult.status  === 'fulfilled' ? gfsResult.value
                   : null;
    if (fallback) {
      console.warn('[api] fetchWeek: best_match failed, using secondary model as primary:', primaryResult.reason?.message);
      primary = fallback;
    } else {
      // All models failed — try stale cache before crashing
      const stale = getStaleCache(cacheKey);
      if (stale) {
        console.warn('[api] fetchWeek: all models failed, using stale cache');
        stale._isStale = true; // signal to app.js to show offline banner
        return stale;
      }
      throw primaryResult.reason;
    }
  }

  // Always average across 3 fixed slots — fill missing secondaries with primary so
  // the ensemble denominator stays constant regardless of network availability.
  // This prevents score jumps when ECMWF or GFS are temporarily unavailable.
  const ecmwfData = ecmwfResult.status === 'fulfilled' && ecmwfResult.value !== primary ? ecmwfResult.value : primary;
  const gfsData   = gfsResult.status   === 'fulfilled' && gfsResult.value   !== primary ? gfsResult.value   : primary;
  const datasets  = [primary, ecmwfData, gfsData];
  const realCount = new Set(datasets).size; // 1–3 unique models

  console.log(`[api] Ensemble: ${realCount} unique model(s) → averaging 3 slots`);
  if (!primary?.hourly) return primary;
  const hourlyKeys = Object.keys(primary.hourly).filter(k => k !== 'time');
  for (const key of hourlyKeys) {
    primary.hourly[key] = averageHourlyArrays(datasets, key);
  }

  // Store model count for confidence display
  primary._modelCount = realCount;

  setCache(cacheKey, primary, CACHE_TTL.weather);
  return primary;
}

/**
 * Fetch air quality data (dust, PM2.5, PM10, aerosol optical depth)
 * Open-Meteo Air Quality API — free, no key
 */
export async function fetchAirQuality(lat, lon, force = false) {
  const cacheKey = `airq_${lat.toFixed(3)}_${lon.toFixed(3)}`;
  const cached = getCache(cacheKey);
  if (cached && !force) return cached;

  const params = new URLSearchParams({
    latitude: lat, longitude: lon,
    timezone: 'Asia/Jerusalem',
    forecast_days: 5,
    hourly: 'dust,pm2_5,pm10,aerosol_optical_depth,ozone'  // A1: ozone for photochemical smog detection
  });

  try {
    const res = await fetchWithTimeout(`${OPEN_METEO_AQ_URL}?${params}`);
    if (!res.ok) throw new Error(`AQ API error ${res.status}`);
    const data = await res.json();
    setCache(cacheKey, data, CACHE_TTL.airq);
    return data;
  } catch (e) {
    console.warn('[api] Air quality fetch failed:', e.message);
    return null;  // non-critical — scoring works without it
  }
}

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
    const city = data.address?.city || data.address?.town
      || data.address?.village || data.address?.suburb
      || data.address?.county || data.address?.state || 'ישראל';
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
        elevation: el.tags?.ele ? Number(el.tags.ele) : null
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
 * Used to detect low clouds blocking the sunset light path.
 * Same Open-Meteo API, no auth, fetched in parallel with fetchWeek.
 */
export async function fetchWesternHorizon(lat, lon, force = false) {
  const lonWest = Math.max(-180, lon - 0.5); // ~44km west at lat 32°
  const cacheKey = `west_${lat.toFixed(3)}_${lonWest.toFixed(3)}`;
  const cached = getCache(cacheKey);
  if (cached && !force) return cached;

  const params = new URLSearchParams({
    latitude: lat, longitude: lonWest,
    timezone: 'Asia/Jerusalem', forecast_days: 7,
    hourly: 'cloudcover_low,cloudcover'
  });

  try {
    const res = await fetchWithTimeout(`${OPEN_METEO_URL}?${params}`);
    if (!res.ok) throw new Error(`Western horizon API error ${res.status}`);
    const data = await res.json();
    setCache(cacheKey, data, CACHE_TTL.weather);
    return data;
  } catch (e) {
    console.warn('[api] Western horizon fetch failed:', e.message);
    return null; // non-critical — scoring works without it
  }
}

// ✓ api.js v3 — complete
