// ═══════════════════════════════════════════
//  TWILIGHT — calibration.js (v2 schema)
//  Self-calibrating scoring: auto ground-truth + user ratings
//  v2 multi-event: stores predicted/userRatings/actual per {sunrise, sunset, dusk}.
//  Migrates v1 entries (single sunset) on first load.
// ═══════════════════════════════════════════

import {
  CALIBRATION_KEY, CALIBRATION_MIN_DAYS, OPEN_METEO_HIST_URL, SEASONAL_BASELINE,
  CALIBRATION_SCHEMA_VERSION, EVENT_TYPES,
} from './config.js';

const MAX_ENTRIES = 90; // keep last 90 days

// ─── Location bucket ───────────────────────
function getLocBucket(lat, lon) {
  if (!lat || !lon) return 'central';
  if (lon < 34.6) return 'coast';
  if (lon > 35.2) return 'east';
  if (lat > 33.0) return 'north';
  return 'central';
}

// ─── Bias cache (60 s TTL) ─────────────────
let _biasCache = null;
let _biasCacheKey = '';
let _biasCacheTime = 0;

// ─────────────────────────────────────────
//  v1 → v2 migration
//  v1 shape:
//    { date, predicted: number, userRating: 1-10|null, actual: {...}|null, params, ... }
//  v2 shape:
//    { schemaVersion: 2, date,
//      predicted: { sunrise, sunset, dusk },
//      userRatings: { sunrise: {value, confidence, ts}|null, sunset: ..., dusk: ... },
//      actual: { sunrise: {...}|null, sunset: {...}|null, dusk: {...}|null },
//      params, locBucket, lat, lon, ts }
// ─────────────────────────────────────────
function migrateEntry(entry) {
  if (entry?.schemaVersion >= 2) return entry;

  const oldPredicted = (typeof entry.predicted === 'number') ? entry.predicted : null;
  const oldRating    = (typeof entry.userRating === 'number') ? entry.userRating : null;
  const oldActual    = entry.actual ?? null;

  return {
    schemaVersion: 2,
    date:      entry.date,
    locBucket: entry.locBucket ?? 'central',
    lat:       entry.lat ?? null,
    lon:       entry.lon ?? null,
    ts:        entry.ts ?? Date.now(),
    params:    entry.params ?? {},
    predicted: {
      sunrise: null,
      sunset:  oldPredicted,
      dusk:    null,
    },
    userRatings: {
      sunrise: null,
      sunset:  oldRating != null ? { value: oldRating, confidence: 1, ts: entry.ts ?? Date.now() } : null,
      dusk:    null,
    },
    actual: {
      sunrise: null,
      sunset:  oldActual,
      dusk:    null,
    },
  };
}

function migrateAll(entries) {
  if (!Array.isArray(entries)) return [];
  let mutated = false;
  const out = entries.map(e => {
    if (e?.schemaVersion >= 2) return e;
    mutated = true;
    return migrateEntry(e);
  });
  return { entries: out, migrated: mutated };
}

// ─────────────────────────────────────────
//  Load / save calibration data
// ─────────────────────────────────────────
function loadCalibration() {
  try {
    const raw = localStorage.getItem(CALIBRATION_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const { entries, migrated } = migrateAll(parsed);
    if (migrated) {
      try { localStorage.setItem(CALIBRATION_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES))); } catch { /* quota — non-fatal */ }
    }
    return entries;
  } catch { return []; }
}

function saveCalibration(entries) {
  try {
    const trimmed = entries.slice(-MAX_ENTRIES);
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(trimmed));
  } catch (e) {
    console.warn('[calibration] save failed:', e);
  }
}

// Exposed for tests + boot-time migration verification
export function migrateCalibrationV1toV2(rawEntries) {
  return migrateAll(rawEntries).entries;
}

// ─────────────────────────────────────────
//  Record today's predicted scores (per event)
//  predictedScores = { sunrise, sunset, dusk } (any may be null)
//  Backwards-compat: if a number is passed, treat as sunset only.
// ─────────────────────────────────────────
export function recordPrediction(date, predictedScores, params, lat, lon) {
  const entries = loadCalibration();
  if (entries.find(e => e.date === date)) return;

  const predicted = (typeof predictedScores === 'number')
    ? { sunrise: null, sunset: predictedScores, dusk: null }
    : {
        sunrise: predictedScores?.sunrise ?? null,
        sunset:  predictedScores?.sunset  ?? null,
        dusk:    predictedScores?.dusk    ?? null,
      };

  entries.push({
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    date,
    predicted,
    locBucket: getLocBucket(lat, lon),
    lat, lon,
    params: {
      clouds:     params._cloudRaw,
      cloudsLow:  params._cloudLowRaw,
      cloudsMid:  params._cloudMidRaw,
      cloudsHigh: params._cloudHighRaw,
      humidity:   params._humidityRaw,
      visibility: params._visibilityRaw,
      wind:       params._windRaw,
      dust:       params._dustRaw,
      pm10:       params._pm10Raw,
      rainMm:     params._rainMmRaw,
    },
    actual: { sunrise: null, sunset: null, dusk: null },
    userRatings: { sunrise: null, sunset: null, dusk: null },
    ts: Date.now()
  });
  _biasCache = null;
  saveCalibration(entries);
}

// ─────────────────────────────────────────
//  Record user rating (1-10) for a specific event
// ─────────────────────────────────────────
export async function recordUserRating(date, eventType, rating, confidence = 1) {
  if (!EVENT_TYPES.includes(eventType)) {
    console.warn('[calibration] invalid eventType:', eventType);
    return false;
  }
  const entries = loadCalibration();
  const entry = entries.find(e => e.date === date);
  if (!entry) return false;

  const value = Math.max(1, Math.min(10, Math.round(rating)));
  entry.userRatings = entry.userRatings ?? { sunrise: null, sunset: null, dusk: null };
  entry.userRatings[eventType] = {
    value,
    confidence: confidence ? 1 : 0,
    ts: Date.now(),
  };
  saveCalibration(entries);

  // Trigger learning update if actual data for this event is available
  const actualForEvent = entry.actual?.[eventType];
  if (actualForEvent) {
    try {
      const { processLearningEntry } = await import('./engine/learningEngine.js');
      processLearningEntry(entry, entry.locBucket, eventType);
    } catch { /* learning is non-critical */ }
  }
  return true;
}

// ─────────────────────────────────────────
//  Fetch actual conditions from Open-Meteo Historical
//  for a specific event (sunrise/sunset/dusk). Hour passed in.
// ─────────────────────────────────────────
export async function fetchActualForDate(date, lat, lon, eventHour, eventType = 'sunset') {
  if (!EVENT_TYPES.includes(eventType)) return;
  const entries = loadCalibration();
  const entry = entries.find(e => e.date === date);
  if (!entry) return;
  if (entry.actual?.[eventType] != null) return; // already filled

  try {
    const params = new URLSearchParams({
      latitude: lat, longitude: lon,
      start_date: date, end_date: date,
      timezone: 'Asia/Jerusalem',
      hourly: 'cloudcover,visibility,relativehumidity_2m,precipitation'
    });

    const res = await fetch(`${OPEN_METEO_HIST_URL}?${params}`);
    if (!res.ok) return;
    const data = await res.json();

    const h = data.hourly;
    if (!h?.time) return;
    const targetHour = String(eventHour).padStart(2, '0');
    const idx = h.time.findIndex(t => t.includes(`T${targetHour}:`));
    if (idx < 0) return;

    const actualForEvent = {
      clouds:     h.cloudcover?.[idx] ?? null,
      visibility: h.visibility?.[idx] ? h.visibility[idx] / 1000 : null,
      humidity:   h.relativehumidity_2m?.[idx] ?? null,
      rain:       h.precipitation?.[idx] ?? 0,
      dust:       null,
      pm10:       null,
    };

    // Best-effort dust/pm10 from AQ archive
    try {
      const aqParams = new URLSearchParams({
        latitude: lat, longitude: lon,
        start_date: date, end_date: date,
        timezone: 'Asia/Jerusalem',
        hourly: 'dust,pm10'
      });
      const aqRes = await fetch(`https://air-quality-api.open-meteo.com/v1/archive?${aqParams}`);
      if (aqRes.ok) {
        const aqData = await aqRes.json();
        const aqH = aqData.hourly;
        if (aqH?.time) {
          const aqIdx = aqH.time.findIndex(t => t.includes(`T${targetHour}:`));
          if (aqIdx >= 0) {
            actualForEvent.dust = aqH.dust?.[aqIdx] ?? null;
            actualForEvent.pm10 = aqH.pm10?.[aqIdx] ?? null;
          }
        }
      }
    } catch { /* optional — non-fatal */ }

    entry.actual = entry.actual ?? { sunrise: null, sunset: null, dusk: null };
    entry.actual[eventType] = actualForEvent;
    saveCalibration(entries);
    console.log(`[calibration] Actual ${eventType} data recorded for ${date}`);
  } catch (e) {
    console.warn('[calibration] fetchActual failed:', e.message);
  }
}

// ─────────────────────────────────────────
//  Calculate bias correction (sunset bucket only — backward-compat)
// ─────────────────────────────────────────
export function getBiasCorrection(lat, lon) {
  const bucket = getLocBucket(lat, lon);
  const cacheKey = bucket;
  const now = Date.now();
  if (_biasCache && cacheKey === _biasCacheKey && (now - _biasCacheTime) < 60000) {
    return _biasCache;
  }

  const allEntries = loadCalibration();
  let entries = allEntries.filter(e => e.locBucket === bucket);
  if (entries.length < CALIBRATION_MIN_DAYS) entries = allEntries;

  const withActual = entries.filter(e => e.actual?.sunset != null);
  if (withActual.length < CALIBRATION_MIN_DAYS) {
    return { bias: 0, confidence: 0, sampleSize: withActual.length };
  }

  let cloudBiasSum = 0;
  let visBiasSum = 0;
  let count = 0;

  for (const e of withActual) {
    const a = e.actual.sunset;
    if (a.clouds != null && e.params?.clouds != null) {
      cloudBiasSum += (a.clouds - e.params.clouds);
      count++;
    }
    if (a.visibility != null && e.params?.visibility != null) {
      visBiasSum += (e.params.visibility - a.visibility);
    }
  }

  if (count === 0) return { bias: 0, confidence: 0, sampleSize: 0 };

  const avgCloudBias = cloudBiasSum / count;
  const avgVisBias   = visBiasSum / count;
  const scoreBias = (avgCloudBias / 20) + (avgVisBias / 15);

  const withRating = entries.filter(e => e.userRatings?.sunset?.value != null);
  let userBias = 0;
  if (withRating.length >= 5) {
    const avgPredicted = withRating.reduce((s, e) => s + (e.predicted?.sunset ?? 0), 0) / withRating.length;
    const avgRated     = withRating.reduce((s, e) => s + e.userRatings.sunset.value, 0) / withRating.length;
    userBias = avgPredicted - avgRated;
  }

  const finalBias = withRating.length >= 5
    ? scoreBias * 0.7 + userBias * 0.3
    : scoreBias;

  const clampedBias = Math.max(-0.8, Math.min(0.5, finalBias));
  const confidence = Math.min(1, withActual.length / 30);

  const result = {
    bias: Math.round(clampedBias * 10) / 10,
    confidence,
    sampleSize: withActual.length,
    userSamples: withRating.length
  };
  _biasCache = result;
  _biasCacheKey = cacheKey;
  _biasCacheTime = now;
  return result;
}

// ─────────────────────────────────────────
//  Dynamic seasonal baseline from calibration history (sunset only)
// ─────────────────────────────────────────
export function getDynamicSeasonalBaseline(month) {
  try {
    const entries = loadCalibration();
    const monthEntries = entries.filter(e => {
      if (!e.actual?.sunset || !e.date) return false;
      const m = new Date(e.date + 'T12:00:00').getMonth() + 1;
      return Math.abs(m - month) <= 1;
    });
    if (monthEntries.length < 7) return null;

    const avgClouds = monthEntries.reduce((s, e) => s + (e.actual.sunset.clouds ?? 50), 0) / monthEntries.length;
    const avgVis    = monthEntries.reduce((s, e) => s + (e.actual.sunset.visibility ?? 10), 0) / monthEntries.length;
    const avgHum    = monthEntries.reduce((s, e) => s + (e.actual.sunset.humidity ?? 50), 0) / monthEntries.length;

    const staticBase = SEASONAL_BASELINE[month] || SEASONAL_BASELINE[6];
    return {
      clouds:     Math.round(avgClouds * 0.6 + staticBase.clouds * 0.4),
      visibility: Math.round((avgVis  * 0.6 + staticBase.visibility * 0.4) * 10) / 10,
      humidity:   Math.round(avgHum   * 0.6 + staticBase.humidity * 0.4),
      wind:       staticBase.wind,
      dust:       staticBase.dust,
    };
  } catch { return null; }
}

// ─────────────────────────────────────────
//  Calibration stats (per-event aware)
// ─────────────────────────────────────────
export function getCalibrationStats() {
  const entries = loadCalibration();
  const paired  = entries
    .filter(e => e.actual?.sunset != null && e.predicted?.sunset != null)
    .slice(-20);
  let _statLat, _statLon;
  try {
    const saved = JSON.parse(localStorage.getItem('twl_location') || '{}');
    _statLat = saved.lat; _statLon = saved.lon;
  } catch { /* ignore */ }
  const { bias, confidence, sampleSize, userSamples } = getBiasCorrection(_statLat, _statLon);

  const recent = paired.slice(-7);
  const older  = paired.slice(-14, -7);
  let trend = 'neutral';
  const truthScore = (e) => e.userRatings?.sunset?.value ?? null;
  if (recent.length >= 3 && older.length >= 3) {
    const avgErr = (arr) => {
      const valid = arr.filter(e => truthScore(e) != null);
      if (!valid.length) return 0;
      return valid.reduce((s, e) => s + Math.abs((e.predicted?.sunset ?? 0) - truthScore(e)), 0) / valid.length;
    };
    const recentErr = avgErr(recent);
    const olderErr  = avgErr(older);
    if (recentErr < olderErr - 0.3)  trend = 'improving';
    else if (recentErr > olderErr + 0.3) trend = 'worsening';
  }

  // Per-event totals for UI display
  const byEvent = { sunrise: 0, sunset: 0, dusk: 0 };
  for (const e of entries) {
    for (const ev of EVENT_TYPES) {
      if (e.userRatings?.[ev]?.value != null) byEvent[ev]++;
    }
  }

  return {
    entries: paired.map(e => ({
      date:       e.date,
      predicted:  e.predicted?.sunset ?? null,
      actual:     e.userRatings?.sunset?.value ?? null,
      hasActual:  e.actual?.sunset != null,
    })),
    bias,
    confidence: Math.round(confidence * 100),
    sampleSize,
    userSamples,
    trend,
    perEventRatings: byEvent,
  };
}

// ─────────────────────────────────────────
//  Dates that need fetched actuals (any missing event)
// ─────────────────────────────────────────
export function getUnfilledDates() {
  const entries = loadCalibration();
  return entries
    .filter(e => {
      const age = Date.now() - (e.ts ?? 0);
      if (age <= 2 * 60 * 60 * 1000) return false;
      const a = e.actual ?? {};
      return EVENT_TYPES.some(ev => a[ev] == null);
    })
    .map(e => {
      const a = e.actual ?? {};
      return {
        date: e.date, lat: e.lat, lon: e.lon,
        missing: EVENT_TYPES.filter(ev => a[ev] == null),
      };
    });
}

// ─────────────────────────────────────────
//  Clear all calibration data
// ─────────────────────────────────────────
export function clearCalibration() {
  try {
    localStorage.removeItem(CALIBRATION_KEY);
    _biasCache = null;
  } catch (e) {
    console.warn('[calibration] clearCalibration failed:', e);
  }
}

// ─────────────────────────────────────────
//  Crowdsourced cLow penalty adjustment (sunset only)
// ─────────────────────────────────────────
export function getCloudPenaltyAdjustment(lat, lon) { // eslint-disable-line no-unused-vars
  try {
    const allEntries = loadCalibration();
    const relevant = allEntries.filter(e =>
      e.params?.clouds > 40
      && e.userRatings?.sunset?.value != null
      && e.predicted?.sunset != null
    );
    if (relevant.length < 5) return 1.0;

    const avgPred   = relevant.reduce((s, e) => s + e.predicted.sunset, 0) / relevant.length;
    const avgRated  = relevant.reduce((s, e) => s + e.userRatings.sunset.value, 0) / relevant.length;
    const cloudBias = avgPred - avgRated;
    const mult = 1.0 - cloudBias * 0.10;
    return Math.max(0.60, Math.min(1.40, Math.round(mult * 100) / 100));
  } catch { return 1.0; }
}

// ─────────────────────────────────────────
//  Has user already rated this event today?
// ─────────────────────────────────────────
export function hasRatedEvent(date, eventType) {
  if (!EVENT_TYPES.includes(eventType)) return false;
  const entries = loadCalibration();
  const entry = entries.find(e => e.date === date);
  return entry?.userRatings?.[eventType]?.value != null;
}

// Backward-compat alias — many callers still use this name
export function hasRatedToday(date) {
  return hasRatedEvent(date, 'sunset');
}

// ─────────────────────────────────────────
//  Trigger learning update for all rated events of a date
// ─────────────────────────────────────────
export async function processLearningForEntry(date) {
  const entries = loadCalibration();
  const entry   = entries.find(e => e.date === date);
  if (!entry?.actual) return;
  try {
    const { processLearningEntry } = await import('./engine/learningEngine.js');
    for (const ev of EVENT_TYPES) {
      if (entry.actual[ev] != null) processLearningEntry(entry, entry.locBucket, ev);
    }
  } catch (e) {
    console.warn('[calibration] learning update failed:', e);
  }
}

// ✓ calibration.js v2 — complete
