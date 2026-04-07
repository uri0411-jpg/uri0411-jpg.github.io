// ═══════════════════════════════════════════
//  archive-fetch.js
//  Fetches Open-Meteo archive weather + AQ data for a date range.
//  Uses 7-day batches with polite rate limiting.
//  No API key required (Open-Meteo is free).
// ═══════════════════════════════════════════

const ARCHIVE_URL      = 'https://archive-api.open-meteo.com/v1/archive';
const AQ_ARCHIVE_URL   = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const HIST_FORECAST_URL = 'https://historical-forecast-api.open-meteo.com/v1/forecast';
const RATE_DELAY_MS    = 150; // polite delay between batch requests

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Fetch weather + AQ archive for a single date range batch.
 * @param {number} lat
 * @param {number} lon
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD (max ~30 days per call)
 * @returns {Array<{date, sunsetHour, sunriseHour, actual: {...}, paramRatios: {...}}>}
 */
export async function fetchArchiveRange(lat, lon, startDate, endDate) {
  const weatherUrl = new URL(ARCHIVE_URL);
  weatherUrl.searchParams.set('latitude',   lat);
  weatherUrl.searchParams.set('longitude',  lon);
  weatherUrl.searchParams.set('start_date', startDate);
  weatherUrl.searchParams.set('end_date',   endDate);
  weatherUrl.searchParams.set('timezone',   'Asia/Jerusalem');
  weatherUrl.searchParams.set('hourly', [
    'cloudcover', 'cloudcover_low', 'cloudcover_mid', 'cloudcover_high',
    'visibility', 'relativehumidity_2m', 'precipitation',
    'windspeed_10m', 'winddirection_10m', 'temperature_2m',
  ].join(','));
  weatherUrl.searchParams.set('daily', 'sunrise,sunset');

  const aqUrl = new URL(AQ_ARCHIVE_URL);
  aqUrl.searchParams.set('latitude',   lat);
  aqUrl.searchParams.set('longitude',  lon);
  aqUrl.searchParams.set('start_date', startDate);
  aqUrl.searchParams.set('end_date',   endDate);
  aqUrl.searchParams.set('timezone',   'Asia/Jerusalem');
  aqUrl.searchParams.set('hourly', 'dust,pm10,pm2_5,aerosol_optical_depth');

  // Historical forecast: GFS model runs archived from 2021, providing
  // what the weather model predicted for each date (cloud/humidity/visibility).
  // Used to compute paramRatios = actual/forecast for Phase 1 EMA learning.
  const histFcUrl = new URL(HIST_FORECAST_URL);
  histFcUrl.searchParams.set('latitude',   lat);
  histFcUrl.searchParams.set('longitude',  lon);
  histFcUrl.searchParams.set('start_date', startDate);
  histFcUrl.searchParams.set('end_date',   endDate);
  histFcUrl.searchParams.set('timezone',   'Asia/Jerusalem');
  histFcUrl.searchParams.set('hourly', [
    'cloudcover', 'relativehumidity_2m', 'visibility',
  ].join(','));
  histFcUrl.searchParams.set('models', 'best_match');

  const [weatherRes, aqRes, histFcRes] = await Promise.all([
    fetch(weatherUrl.toString()),
    fetch(aqUrl.toString()).catch(() => null),
    fetch(histFcUrl.toString()).catch(() => null),
  ]);

  if (!weatherRes.ok) {
    throw new Error(`Archive fetch failed: ${weatherRes.status} ${await weatherRes.text().catch(() => '')}`);
  }

  const weather     = await weatherRes.json();
  const aq          = aqRes?.ok    ? await aqRes.json()    : null;
  const histForecast = histFcRes?.ok ? await histFcRes.json() : null;

  return parseArchiveResponse(weather, aq, histForecast);
}

function parseArchiveResponse(weather, aq, histForecast) {
  const daily    = weather.daily  ?? {};
  const hourly   = weather.hourly ?? {};
  const aqHourly = aq?.hourly     ?? null;
  const fcHourly = histForecast?.hourly ?? null;

  const dates    = daily.time    ?? [];
  const sunrises = daily.sunrise ?? [];
  const sunsets  = daily.sunset  ?? [];
  const hours    = hourly.time   ?? [];

  // Build a map for fast hour lookup
  const hourIndex = new Map(hours.map((t, i) => [t, i]));
  const aqHours   = aqHourly?.time ?? [];
  const aqIndex   = new Map(aqHours.map((t, i) => [t, i]));
  const fcHours   = fcHourly?.time ?? [];
  const fcIndex   = new Map(fcHours.map((t, i) => [t, i]));

  const results = [];

  for (let di = 0; di < dates.length; di++) {
    const date       = dates[di];
    const sunsetStr  = sunsets[di]  ?? null;
    const sunriseStr = sunrises[di] ?? null;

    const sunsetHour  = sunsetStr  ? parseInt(sunsetStr.split('T')[1].split(':')[0],  10) : 18;
    const sunriseHour = sunriseStr ? parseInt(sunriseStr.split('T')[1].split(':')[0], 10) : 6;

    // Average hourly values over -1h, 0h, +1h window around sunset
    const ssIdxs = [-1, 0, 1].map(d => {
      const h = sunsetHour + d;
      if (h < 0 || h > 23) return -1;
      const key = `${date}T${String(h).padStart(2, '0')}:00`;
      return hourIndex.get(key) ?? -1;
    }).filter(i => i >= 0);

    const avg = (arr, idxs) => {
      if (!arr) return null;
      const vals = idxs.map(i => arr[i]).filter(v => v != null && isFinite(v));
      return vals.length ? Math.round(vals.reduce((s, v) => s + v, 0) / vals.length) : null;
    };

    const clouds     = avg(hourly.cloudcover,          ssIdxs);
    const cloudsLow  = avg(hourly.cloudcover_low,      ssIdxs);
    const cloudsMid  = avg(hourly.cloudcover_mid,      ssIdxs);
    const cloudsHigh = avg(hourly.cloudcover_high,     ssIdxs);
    const humidity   = avg(hourly.relativehumidity_2m, ssIdxs);
    const rain       = avg(hourly.precipitation,       ssIdxs);

    // Visibility: archive returns metres → convert to km
    const visRaw     = avg(hourly.visibility, ssIdxs);
    const visibility = visRaw != null ? Math.round(visRaw / 1000 * 10) / 10 : null;

    // AQ data at same window
    let dust = null, pm10 = null, pm25 = null, aod = null;
    if (aqHourly) {
      const aqIdxs = ssIdxs.map(i => {
        const t = hours[i];
        return t ? (aqIndex.get(t) ?? -1) : -1;
      }).filter(i => i >= 0);

      dust = avg(aqHourly.dust,                 aqIdxs);
      pm10 = avg(aqHourly.pm10,                aqIdxs);
      pm25 = avg(aqHourly['pm2_5'],            aqIdxs);
      aod  = avg(aqHourly.aerosol_optical_depth, aqIdxs);
    }

    // Historical forecast values at same sunset window (for paramRatios)
    let fcClouds = null, fcHumidity = null, fcVisibility = null;
    if (fcHourly) {
      const fcIdxs = ssIdxs.map(i => {
        const t = hours[i];
        return t ? (fcIndex.get(t) ?? -1) : -1;
      }).filter(i => i >= 0);

      fcClouds     = avg(fcHourly.cloudcover,          fcIdxs);
      fcHumidity   = avg(fcHourly.relativehumidity_2m, fcIdxs);
      const fcVisRaw = avg(fcHourly.visibility, fcIdxs);
      fcVisibility = fcVisRaw != null ? Math.round(fcVisRaw / 1000 * 10) / 10 : null;
    }

    // paramRatios: actual / forecast (Phase 1 EMA input scale learning)
    const paramRatios = {};
    if (clouds != null && fcClouds != null && fcClouds > 2 && clouds > 2)
      paramRatios.cloudRatio     = Math.round((clouds     / fcClouds)     * 100) / 100;
    if (humidity != null && fcHumidity != null && fcHumidity > 5)
      paramRatios.humidityRatio  = Math.round((humidity   / fcHumidity)   * 100) / 100;
    if (visibility != null && fcVisibility != null && fcVisibility > 0)
      paramRatios.visibilityRatio = Math.round((visibility / fcVisibility) * 100) / 100;

    results.push({
      date,
      sunsetHour,
      sunriseHour,
      actual: {
        clouds,
        cloudsLow,
        cloudsMid,
        cloudsHigh,
        visibility,
        humidity,
        rain,
        dust,
        pm10,
        pm25,
        aod,
      },
      paramRatios,
    });
  }

  return results;
}

/**
 * Fetch a full date range in 7-day batches with rate limiting.
 * @param {number} lat
 * @param {number} lon
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 * @returns {Array} all day records
 */
export async function fetchArchiveBatched(lat, lon, startDate, endDate) {
  const results = [];
  let current   = new Date(startDate + 'T12:00:00Z');
  const end     = new Date(endDate   + 'T12:00:00Z');

  while (current <= end) {
    const batchStart = current.toISOString().slice(0, 10);
    const batchEnd   = new Date(
      Math.min(current.getTime() + 6 * 86400000, end.getTime())
    ).toISOString().slice(0, 10);

    const batch = await fetchArchiveRange(lat, lon, batchStart, batchEnd);
    results.push(...batch);

    current = new Date(current.getTime() + 7 * 86400000);
    if (current <= end) await sleep(RATE_DELAY_MS);
  }

  return results;
}
