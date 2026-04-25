// ═══════════════════════════════════════════
//  TWILIGHT — learningEngine.js v2 (per-event)
//  Self-learning forecast calibration with separate state per event
//  ({sunrise, sunset, dusk}) plus shared input scales.
//
//  Per-event learning rationale:
//    - sunrise: post-night boundary layer, higher dust, lower sun azimuth
//    - sunset:  classic warm-glow window
//    - dusk:    Earth shadow + Belt-of-Venus, high-cloud lit from below
//  Each event has its own bias regime → separate EMAs avoid cross-contamination.
//
//  Other v2 improvements:
//    - Outlier rejection: |rating - reconstructed| > 4 downweights the EMA step
//    - Confidence flag: confidence:0 ratings get 0.4× weight
//    - Seasonal correction at read time: same-season entries get a bonus weight
// ═══════════════════════════════════════════

import { computeScore }  from './scoreEngine.js';
import { LEARNING_KEY, LEARNING_SCHEMA_VERSION, EVENT_TYPES }  from '../config.js';

// ─── Constants ────────────────────────────────
const MAX_ENTRIES         = 90;
export const MIN_ACTIVE_SAMPLES  = 10;
const MIN_BELL_SAMPLES    = 15;
const ADJ_CACHE_TTL       = 1000;

// EMA smoothing factors (smaller = slower / more stable)
const α_INPUT  = 0.10;
const α_MODEL  = 0.08;
const α_WEIGHT = 0.05;
const α_BELL   = 0.03;

// Drama weight default values and bounds
const WEIGHT_DEFAULTS = { cloudDramaW: 0.30, dustDramaW: 0.27, atmosphereDramaW: 0.27 };
const WEIGHT_BOUNDS   = {
  cloudDramaW:       [0.21,  0.39 ],
  dustDramaW:        [0.189, 0.351],
  atmosphereDramaW:  [0.189, 0.351],
};
const WEIGHT_TARGET_SUM = 0.84;

// Outlier rejection thresholds
const OUTLIER_DELTA      = 4.0;  // |userRating - reconstructed| above this is suspicious
const OUTLIER_WEIGHT     = 0.5;  // multiply α by this for outliers (not full reject)
const LOW_CONFIDENCE_W   = 0.4;  // multiply α by this when confidence:0

// Seasonal weighting at read time
const SEASON_HALF_WIDTH  = 3;    // months — same-season window radius

// ─── Module-level adjustment cache ────────────
let _adjCache     = null;
let _adjCacheTime = 0;
let _adjCacheKey  = '';
let _pinnedAdj    = null;

// ─── Helpers ──────────────────────────────────
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function seasonalSimilarity(m1, m2) {
  if (m1 == null || m2 == null) return 1;
  const diff = Math.min(Math.abs(m1 - m2), 12 - Math.abs(m1 - m2));
  return Math.max(0, 1 - diff / 6);
}

function defaultEventState() {
  return {
    cloudDramaW:        0.30,
    dustDramaW:         0.27,
    atmosphereDramaW:   0.27,
    humidityOptimum:    60,
    dustOptimum:        25,
    CloudModelBias:     0,
    DustModelBias:      0,
    ClearSkyModelBias:  0,
    sampleSize:         0,
    lastUpdated:        0,
  };
}

function defaultSharedState() {
  return {
    cloudInputScale:      1.0,
    humidityInputScale:   1.0,
    dustInputScale:       1.0,
    visibilityInputScale: 1.0,
    sampleSize:           0,    // shared input-scale samples (≤ sum of perEvent)
    lastUpdated:          0,
  };
}

function defaultLearningData() {
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    perEvent: {
      sunrise: defaultEventState(),
      sunset:  defaultEventState(),
      dusk:    defaultEventState(),
    },
    shared: defaultSharedState(),
    entries: [],
  };
}

// ─────────────────────────────────────────────
//  v1 → v2 migration (single flat state → perEvent + shared)
//  v1 shape: { version: 2, state: {flat fields}, entries: [...] }
//  v2 shape: { schemaVersion: 2, perEvent:{...}, shared:{...}, entries: [...] }
// ─────────────────────────────────────────────
function migrateLearning(data) {
  if (!data || data.schemaVersion >= 2) return data;
  // The v1 'state' object has all fields flat.
  const old = data.state ?? {};
  const eventCommon = {
    cloudDramaW:       old.cloudDramaW       ?? 0.30,
    dustDramaW:        old.dustDramaW        ?? 0.27,
    atmosphereDramaW:  old.atmosphereDramaW  ?? 0.27,
    humidityOptimum:   old.humidityOptimum   ?? 60,
    dustOptimum:       old.dustOptimum       ?? 25,
    CloudModelBias:    old.CloudModelBias    ?? 0,
    DustModelBias:     old.DustModelBias     ?? 0,
    ClearSkyModelBias: old.ClearSkyModelBias ?? 0,
    sampleSize:        old.sampleSize        ?? 0,
    lastUpdated:       old.lastUpdated       ?? 0,
  };
  return {
    schemaVersion: LEARNING_SCHEMA_VERSION,
    perEvent: {
      sunrise: { ...eventCommon },
      sunset:  { ...eventCommon },
      dusk:    { ...eventCommon },
    },
    shared: {
      cloudInputScale:      old.cloudInputScale      ?? 1.0,
      humidityInputScale:   old.humidityInputScale   ?? 1.0,
      dustInputScale:       old.dustInputScale       ?? 1.0,
      visibilityInputScale: old.visibilityInputScale ?? 1.0,
      sampleSize:           old.sampleSize           ?? 0,
      lastUpdated:          old.lastUpdated          ?? 0,
    },
    entries: Array.isArray(data.entries) ? data.entries : [],
  };
}

function loadLearning() {
  try {
    const raw = localStorage.getItem(LEARNING_KEY);
    if (!raw) return defaultLearningData();
    let data = JSON.parse(raw);
    data = migrateLearning(data);
    // Forward-compat: ensure all required keys exist
    if (!data.perEvent) data.perEvent = defaultLearningData().perEvent;
    if (!data.shared)   data.shared   = defaultSharedState();
    if (!data.entries)  data.entries  = [];
    for (const ev of EVENT_TYPES) {
      if (!data.perEvent[ev]) data.perEvent[ev] = defaultEventState();
      const def = defaultEventState();
      for (const k of Object.keys(def)) {
        if (data.perEvent[ev][k] == null) data.perEvent[ev][k] = def[k];
      }
    }
    return data;
  } catch {
    return defaultLearningData();
  }
}

function saveLearning(data) {
  try {
    data.entries = data.entries.slice(-MAX_ENTRIES);
    localStorage.setItem(LEARNING_KEY, JSON.stringify(data));
    _adjCache = null;
  } catch (e) {
    console.warn('[learning] save failed:', e);
  }
}

// Exposed for tests
export function migrateLearningV1toV2(rawData) {
  return migrateLearning(rawData);
}

// ─── Build scoreEngine input from actual conditions ───────────────
function buildActualScoreInput(actual, forecastParams) {
  if (!actual) return null;
  const clouds = clamp((actual.clouds ?? 30) / 100, 0, 1);
  const cH = forecastParams?.cloudsHigh ?? 0;
  const cM = forecastParams?.cloudsMid  ?? 0;
  const cL = forecastParams?.cloudsLow  ?? 0;
  let cloudHeightCategory = 'mid';
  if (cH > cM && cH > cL)     cloudHeightCategory = 'high';
  else if (cL > cM && cL > cH) cloudHeightCategory = 'low';
  return {
    clouds,
    cloudHeightCategory,
    horizonClearance: clamp(1 - clouds * 1.2, 0, 1),
    dust:       actual.dust       ?? forecastParams?.dust       ?? 20,
    humidity:   actual.humidity   ?? forecastParams?.humidity   ?? 50,
    visibility: actual.visibility ?? forecastParams?.visibility ?? 15,
    aqi:        null,
    solarElevation: 3,
  };
}

// ─── EMA Phase 1: shared input scales ─────────────────────────────
function updateInputScales(shared, ratios) {
  if (!ratios) return;
  if (ratios.cloudRatio != null && isFinite(ratios.cloudRatio)) {
    shared.cloudInputScale = clamp(
      (1 - α_INPUT) * shared.cloudInputScale + α_INPUT * clamp(ratios.cloudRatio, 0.2, 5.0),
      0.5, 2.0
    );
  }
  if (ratios.humidityRatio != null && isFinite(ratios.humidityRatio)) {
    shared.humidityInputScale = clamp(
      (1 - α_INPUT) * shared.humidityInputScale + α_INPUT * clamp(ratios.humidityRatio, 0.3, 3.0),
      0.5, 2.0
    );
  }
  if (ratios.dustRatio != null && isFinite(ratios.dustRatio)) {
    shared.dustInputScale = clamp(
      (1 - α_INPUT) * shared.dustInputScale + α_INPUT * clamp(ratios.dustRatio, 0.1, 10.0),
      0.5, 2.0
    );
  }
  if (ratios.visibilityRatio != null && isFinite(ratios.visibilityRatio)) {
    shared.visibilityInputScale = clamp(
      (1 - α_INPUT) * shared.visibilityInputScale + α_INPUT * clamp(ratios.visibilityRatio, 0.1, 5.0),
      0.5, 2.0
    );
  }
}

// ─── EMA Phase 2: per-model bias (per event) ──────────────────────
function updateModelBiases(eventState, entry, alphaScale) {
  if (entry.userRating == null || entry.reconstructed == null) return;
  const formulaError = entry.reconstructed - entry.userRating;
  const key = entry.dominantModel === 'CloudModel'  ? 'CloudModelBias'
            : entry.dominantModel === 'DustModel'   ? 'DustModelBias'
            :                                          'ClearSkyModelBias';
  const α = α_MODEL * alphaScale;
  eventState[key] = clamp(
    (1 - α) * eventState[key] - α * formulaError,
    -1.5, 1.5
  );
}

// ─── EMA Phase 3: drama weights (per event) ───────────────────────
function updateDramaWeights(eventState, entry, alphaScale) {
  if (entry.userRating == null || entry.reconstructed == null) return;
  if (eventState.sampleSize < MIN_ACTIVE_SAMPLES) return;
  const error = entry.reconstructed - entry.userRating;
  const cc    = entry.cloudScoreContrib  ?? 0.33;
  const dc    = entry.dustScoreContrib   ?? 0.33;
  const ac    = entry.atmosphereContrib  ?? 0.34;
  const total = cc + dc + ac + 0.001;
  const α = α_WEIGHT * alphaScale;
  eventState.cloudDramaW      -= α * error * (cc / total);
  eventState.dustDramaW       -= α * error * (dc / total);
  eventState.atmosphereDramaW -= α * error * (ac / total);
  const mainSum = eventState.cloudDramaW + eventState.dustDramaW + eventState.atmosphereDramaW;
  if (Math.abs(mainSum - WEIGHT_TARGET_SUM) > 0.05 && mainSum > 0) {
    const scale = WEIGHT_TARGET_SUM / mainSum;
    eventState.cloudDramaW      *= scale;
    eventState.dustDramaW       *= scale;
    eventState.atmosphereDramaW *= scale;
  }
  for (const [k, [lo, hi]] of Object.entries(WEIGHT_BOUNDS)) {
    eventState[k] = clamp(eventState[k], lo, hi);
  }
}

// ─── EMA Phase 4: bell peaks (per event) ──────────────────────────
function updateBellPeaks(eventState, entry, alphaScale) {
  if (entry.userRating == null || entry.reconstructed == null) return;
  if (eventState.sampleSize < MIN_BELL_SAMPLES) return;
  const error = entry.reconstructed - entry.userRating;
  const α = α_BELL * alphaScale;
  const h = entry.actualHumidity ?? 50;
  const humSign = h > eventState.humidityOptimum ? 1 : -1;
  eventState.humidityOptimum = clamp(
    eventState.humidityOptimum + α * humSign * error,
    40, 75
  );
  const d = entry.actualDust ?? 20;
  const dustSign = d > eventState.dustOptimum ? 1 : -1;
  eventState.dustOptimum = clamp(
    eventState.dustOptimum + α * dustSign * error,
    10, 50
  );
}

// ─────────────────────────────────────────────────────────────────
//  processLearningEntry — process a single (date, eventType) rating.
//  Called from calibration.js after fetchActualForDate fills
//  entry.actual[eventType] and/or after the user submits a rating.
// ─────────────────────────────────────────────────────────────────
export function processLearningEntry(calibEntry, locBucket, eventType = 'sunset') {
  if (!EVENT_TYPES.includes(eventType)) return;
  const actualForEvent = calibEntry?.actual?.[eventType];
  if (!actualForEvent) return;

  const data        = loadLearning();
  const eventState  = data.perEvent[eventType];
  const sharedState = data.shared;

  // Find or create learning entry — keyed by (date, eventType)
  const entryKey = `${calibEntry.date}::${eventType}`;
  let lEntry = data.entries.find(e => (e.key ?? `${e.date}::${e.eventType ?? 'sunset'}`) === entryKey);
  const isNew = !lEntry;

  const predictedForEvent = (typeof calibEntry.predicted === 'number')
    ? (eventType === 'sunset' ? calibEntry.predicted : null)
    : (calibEntry.predicted?.[eventType] ?? null);
  const ratingForEvent = calibEntry.userRatings?.[eventType] ?? null;
  const ratingValue    = ratingForEvent?.value ?? null;
  const ratingConf     = ratingForEvent?.confidence ?? 1;

  if (isNew) {
    lEntry = {
      key:               entryKey,
      date:              calibEntry.date,
      eventType,
      locBucket:         locBucket ?? calibEntry.locBucket ?? 'central',
      month:             new Date(calibEntry.date + 'T12:00:00').getMonth() + 1,
      predicted:         predictedForEvent,
      reconstructed:     null,
      userRating:        null,
      paramRatios:       {},
      dominantModel:     'ClearSkyModel',
      cloudScoreContrib: 0.33,
      dustScoreContrib:  0.33,
      atmosphereContrib: 0.34,
      forecastError:     null,
      formulaError:      null,
      actualHumidity:    null,
      actualDust:        null,
      stateSnapshot:     {},
      ts:                Date.now(),
    };
  }

  lEntry.userRating = ratingValue;
  lEntry.predicted  = predictedForEvent;

  // ── Step 0: Reconstruct score from actual conditions ──────────────
  const scoreInput = buildActualScoreInput(actualForEvent, calibEntry.params);
  if (scoreInput) {
    try {
      const result = computeScore(scoreInput);
      lEntry.reconstructed     = Math.round(((result.score / 100) * 9 + 1) * 10) / 10;
      lEntry.dominantModel     = result.model;
      lEntry.cloudScoreContrib = result.blendWeights?.cloud    ?? 0.33;
      lEntry.dustScoreContrib  = result.blendWeights?.dust     ?? 0.33;
      lEntry.atmosphereContrib = result.blendWeights?.clearSky ?? 0.34;
    } catch (e) {
      console.warn('[learning] reconstruct failed:', e);
    }
  }

  // ── Compute forecast input ratios (Phase 1) ──────────────────────
  const p = calibEntry.params ?? {};
  const a = actualForEvent;
  const ratios = {};
  if ((p.clouds ?? 0) > 0 && a.clouds != null)
    ratios.cloudRatio     = a.clouds      / p.clouds;
  if ((p.humidity ?? 0) > 0 && a.humidity != null)
    ratios.humidityRatio  = a.humidity    / p.humidity;
  if ((p.dust ?? 0) > 2 && (a.dust ?? 0) > 0)
    ratios.dustRatio      = a.dust        / p.dust;
  if ((p.visibility ?? 0) > 0 && a.visibility != null)
    ratios.visibilityRatio = a.visibility / p.visibility;

  lEntry.paramRatios    = ratios;
  lEntry.actualHumidity = a.humidity ?? null;
  lEntry.actualDust     = a.dust     ?? null;

  lEntry.forecastError = (lEntry.predicted != null && lEntry.reconstructed != null)
    ? Math.round((lEntry.predicted - lEntry.reconstructed) * 10) / 10
    : null;
  lEntry.formulaError = (lEntry.reconstructed != null && lEntry.userRating != null)
    ? Math.round((lEntry.reconstructed - lEntry.userRating) * 10) / 10
    : null;

  lEntry.stateSnapshot = {
    cloudDramaW:      eventState.cloudDramaW,
    dustDramaW:       eventState.dustDramaW,
    atmosphereDramaW: eventState.atmosphereDramaW,
    humidityOptimum:  eventState.humidityOptimum,
    dustOptimum:      eventState.dustOptimum,
  };

  // ── Outlier + confidence weighting (alphaScale ∈ [0.2, 1.0]) ─────
  let alphaScale = 1.0;
  if (lEntry.userRating != null && lEntry.reconstructed != null) {
    const δ = Math.abs(lEntry.userRating - lEntry.reconstructed);
    if (δ > OUTLIER_DELTA) alphaScale *= OUTLIER_WEIGHT;
  }
  if (ratingConf === 0) alphaScale *= LOW_CONFIDENCE_W;
  alphaScale = clamp(alphaScale, 0.2, 1.0);
  lEntry.alphaScale = alphaScale;

  // ── Update shared input scales (only counted once per date) ──────
  // To prevent triple-counting from 3 events per date, we tie input-scale
  // updates to the sunset event only (sunset is the most reliable forecast).
  if (eventType === 'sunset' && Object.keys(ratios).length > 0) {
    updateInputScales(sharedState, ratios);
    sharedState.sampleSize++;
    sharedState.lastUpdated = Date.now();
  }

  // ── Run per-event EMA phases ─────────────────────────────────────
  updateModelBiases(eventState, lEntry, alphaScale);
  updateDramaWeights(eventState, lEntry, alphaScale);
  updateBellPeaks(eventState, lEntry, alphaScale);

  eventState.sampleSize++;
  eventState.lastUpdated = Date.now();

  if (isNew) data.entries.push(lEntry);
  saveLearning(data);
}

// ─────────────────────────────────────────────────────────────────
//  Compute adjustments for a specific event type.
//  Optionally applies a seasonal correction at read time:
//    - Pull recent same-event entries
//    - Compute mean formulaError weighted by seasonalSimilarity(month)
//    - Add a small same-season bias on top of the EMA bias
// ─────────────────────────────────────────────────────────────────
function _computeAdjustments(eventType = 'sunset', month = null) {
  const data        = loadLearning();
  const eventState  = data.perEvent[eventType] ?? defaultEventState();
  const shared      = data.shared;
  const eventEntries = data.entries.filter(e => (e.eventType ?? 'sunset') === eventType);

  const active = eventState.sampleSize >= MIN_ACTIVE_SAMPLES;

  // Confidence calculation
  const validatedSamples = eventEntries.filter(e =>
    e.userRating != null ||
    (e.paramRatios && Object.keys(e.paramRatios).length > 0)
  ).length;
  const activationLevel       = Math.min(1, eventState.sampleSize / 30);
  const calibrationConfidence = Math.min(1, validatedSamples / 15);
  const confidence            = calibrationConfidence * 0.7 + activationLevel * 0.3;

  // Seasonal correction: same-season entries with userRating, weighted by sim
  let seasonalBias = 0;
  if (active && month != null) {
    let wsum = 0, wErrSum = 0;
    for (const e of eventEntries) {
      if (e.formulaError == null) continue;
      const sim = seasonalSimilarity(month, e.month);
      if (sim < 0.34) continue; // outside ±SEASON_HALF_WIDTH months
      wsum   += sim;
      wErrSum += sim * e.formulaError;
    }
    if (wsum >= 3) {
      seasonalBias = clamp(-(wErrSum / wsum) * 0.3, -0.4, 0.4);
    }
  }

  return {
    inputScales: {
      cloudScale:      active ? shared.cloudInputScale      : 1.0,
      humidityScale:   active ? shared.humidityInputScale   : 1.0,
      dustScale:       active ? shared.dustInputScale       : 1.0,
      visibilityScale: active ? shared.visibilityInputScale : 1.0,
    },
    formulaWeights: {
      cloudDramaW:      active ? eventState.cloudDramaW      : WEIGHT_DEFAULTS.cloudDramaW,
      dustDramaW:       active ? eventState.dustDramaW       : WEIGHT_DEFAULTS.dustDramaW,
      atmosphereDramaW: active ? eventState.atmosphereDramaW : WEIGHT_DEFAULTS.atmosphereDramaW,
    },
    bellPeaks: {
      humidityOptimum: active ? eventState.humidityOptimum : 60,
      dustOptimum:     active ? eventState.dustOptimum     : 25,
    },
    modelBiases: {
      CloudModel:    (active ? eventState.CloudModelBias    : 0) + seasonalBias,
      DustModel:     (active ? eventState.DustModelBias     : 0) + seasonalBias,
      ClearSkyModel: (active ? eventState.ClearSkyModelBias : 0) + seasonalBias,
    },
    seasonalBias,
    confidence,
    activationLevel,
    calibrationConfidence,
    sampleSize:  eventState.sampleSize,
    eventType,
    active,
  };
}

// ─────────────────────────────────────────────────────────────────
//  getLearningAdjustments(lat, lon, month, eventType)
//  Pin precedence: if pinLearningSnapshot() was called, return that.
//  Otherwise cached for ADJ_CACHE_TTL ms keyed by (eventType, month).
// ─────────────────────────────────────────────────────────────────
export function getLearningAdjustments(lat, lon, month, eventType = 'sunset') { // eslint-disable-line no-unused-vars
  if (_pinnedAdj && _pinnedAdj[eventType]) return _pinnedAdj[eventType];

  const key = `${eventType}|${month ?? '?'}`;
  const now = Date.now();
  if (_adjCache && _adjCacheKey === key && (now - _adjCacheTime) < ADJ_CACHE_TTL) return _adjCache;

  _adjCache     = _computeAdjustments(eventType, month);
  _adjCacheKey  = key;
  _adjCacheTime = now;
  return _adjCache;
}

// ─────────────────────────────────────────────────────────────────
//  pinLearningSnapshot — freeze adjustments for the session
//  v2: pins all 3 events at once (caller might score sunrise/sunset/dusk
//  in the same calcDayData pass).
// ─────────────────────────────────────────────────────────────────
export function pinLearningSnapshot(month = null) {
  _pinnedAdj = {
    sunrise: _computeAdjustments('sunrise', month),
    sunset:  _computeAdjustments('sunset',  month),
    dusk:    _computeAdjustments('dusk',    month),
  };
  return _pinnedAdj;
}

export function unpinLearningSnapshot() {
  _pinnedAdj = null;
}

// ─────────────────────────────────────────────────────────────────
//  getLearningStats — aggregate per-event for settings UI
// ─────────────────────────────────────────────────────────────────
export function getLearningStats() {
  const data = loadLearning();
  const allEntries = data.entries;
  const totalSamples = EVENT_TYPES.reduce((s, ev) => s + (data.perEvent[ev]?.sampleSize ?? 0), 0);

  // Time series (last 20 entries — across all events, color-coded by event)
  const timeSeries = allEntries.slice(-60).map(e => ({
    date:          e.date,
    eventType:     e.eventType ?? 'sunset',
    predicted:     e.predicted,
    reconstructed: e.reconstructed,
    userRating:    e.userRating,
    locBucket:     e.locBucket,
  }));

  // Forecast-bias from shared input ratios
  const forecastBias = { cloudBias: null, humidityBias: null, dustBias: null, visibilityBias: null };
  const withRatios = allEntries.filter(e => e.paramRatios && Object.keys(e.paramRatios).length > 0);
  if (withRatios.length >= 3) {
    const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;
    const pick = key => withRatios.map(e => e.paramRatios[key]).filter(v => v != null);
    const cr = pick('cloudRatio');
    const hr = pick('humidityRatio');
    const dr = pick('dustRatio');
    const vr = pick('visibilityRatio');
    if (cr.length) forecastBias.cloudBias      = Math.round((avg(cr) - 1) * 100) / 100;
    if (hr.length) forecastBias.humidityBias   = Math.round((avg(hr) - 1) * 100) / 100;
    if (dr.length) forecastBias.dustBias       = Math.round((avg(dr) - 1) * 100) / 100;
    if (vr.length) forecastBias.visibilityBias = Math.round((avg(vr) - 1) * 100) / 100;
  }

  // Per-event RMSE (forecastError) — exposes which event the engine predicts best
  const rmsePerEvent = {};
  for (const ev of EVENT_TYPES) {
    const evEntries = allEntries.filter(e => (e.eventType ?? 'sunset') === ev && e.forecastError != null);
    if (evEntries.length === 0) { rmsePerEvent[ev] = null; continue; }
    const sumSq = evEntries.reduce((s, e) => s + e.forecastError * e.forecastError, 0);
    rmsePerEvent[ev] = Math.round(Math.sqrt(sumSq / evEntries.length) * 100) / 100;
  }

  // Trend: last 7 vs prev 7 mean abs forecast error (sunset only)
  const ssEntries = allEntries.filter(e => (e.eventType ?? 'sunset') === 'sunset' && e.forecastError != null);
  const recent = ssEntries.slice(-7);
  const older  = ssEntries.slice(-14, -7);
  let trend = 'stable';
  if (recent.length >= 3 && older.length >= 3) {
    const meanAbsErr = arr => arr.reduce((s, e) => s + Math.abs(e.forecastError), 0) / arr.length;
    const rErr = meanAbsErr(recent);
    const oErr = meanAbsErr(older);
    if (rErr < oErr - 0.3)      trend = 'improving';
    else if (rErr > oErr + 0.3) trend = 'worsening';
  }

  const validatedSamples = allEntries.filter(e =>
    e.userRating != null ||
    (e.paramRatios && Object.keys(e.paramRatios).length > 0)
  ).length;
  const activationLevel       = Math.min(1, totalSamples / 30);
  const calibrationConfidence = Math.min(1, validatedSamples / 15);

  // Forecast accuracy
  const BIAS_WEIGHTS = { cloudBias: 0.50, humidityBias: 0.30, visibilityBias: 0.15, dustBias: 0.05 };
  let weightedErr = 0, weightSum = 0;
  for (const [key, w] of Object.entries(BIAS_WEIGHTS)) {
    const b = forecastBias[key];
    if (b != null) { weightedErr += w * Math.min(1, Math.abs(b)); weightSum += w; }
  }
  const forecastAccuracy = weightSum > 0 ? Math.round((1 - weightedErr / weightSum) * 100) : null;

  // Per-location breakdown (sunset only)
  const byLocation = {};
  for (const e of allEntries) {
    if ((e.eventType ?? 'sunset') !== 'sunset') continue;
    const bucket = e.locBucket || 'central';
    if (!byLocation[bucket]) byLocation[bucket] = { samples: 0, errSum: 0, errCount: 0 };
    byLocation[bucket].samples++;
    if (e.forecastError != null) {
      byLocation[bucket].errSum += Math.abs(e.forecastError);
      byLocation[bucket].errCount++;
    }
  }
  const locationSummary = Object.entries(byLocation).map(([bucket, v]) => ({
    bucket,
    samples:  v.samples,
    meanAbsErr: v.errCount > 0 ? Math.round((v.errSum / v.errCount) * 10) / 10 : null,
    accuracy: v.errCount > 0
      ? Math.max(0, Math.min(100, Math.round((1 - (v.errSum / v.errCount) / 4.5) * 100)))
      : null,
  })).sort((a, b) => b.samples - a.samples);

  const biggestLearningMoments = allEntries
    .filter(e => e.forecastError != null && Math.abs(e.forecastError) >= 1.5)
    .slice()
    .sort((a, b) => Math.abs(b.forecastError) - Math.abs(a.forecastError))
    .slice(0, 5)
    .map(e => ({
      date:          e.date,
      eventType:     e.eventType ?? 'sunset',
      locBucket:     e.locBucket,
      predicted:     e.predicted,
      reconstructed: e.reconstructed,
      forecastError: e.forecastError,
      dominantModel: e.dominantModel,
    }));

  const activeBiases = [forecastBias.cloudBias, forecastBias.humidityBias,
                        forecastBias.dustBias, forecastBias.visibilityBias]
    .filter(v => v != null);
  const maxBias = activeBiases.length
    ? Math.max(...activeBiases.map(v => Math.abs(v)))
    : 0;
  const activeInfluence = totalSamples >= MIN_ACTIVE_SAMPLES && maxBias >= 0.05;

  const lastUpdated = Math.max(
    data.shared.lastUpdated || 0,
    ...EVENT_TYPES.map(ev => data.perEvent[ev]?.lastUpdated || 0),
    allEntries.at(-1)?.ts || 0,
  );

  // Per-event sample counts for display
  const samplesByEvent = {};
  for (const ev of EVENT_TYPES) samplesByEvent[ev] = data.perEvent[ev]?.sampleSize ?? 0;

  // Average current weights across events for legacy display
  const avgWeights = (key) => {
    const sum = EVENT_TYPES.reduce((s, ev) => s + (data.perEvent[ev]?.[key] ?? 0), 0);
    return sum / EVENT_TYPES.length;
  };

  return {
    sampleSize:           totalSamples,
    samplesByEvent,
    validatedSamples,
    activationLevel:       Math.round(activationLevel       * 100),
    calibrationConfidence: Math.round(calibrationConfidence * 100),
    confidence:            Math.round((calibrationConfidence * 0.7 + activationLevel * 0.3) * 100),
    forecastAccuracy,
    rmsePerEvent,
    timeSeries,
    forecastBias,
    currentWeights: {
      cloudDramaW:      Math.round(avgWeights('cloudDramaW')      * 1000) / 1000,
      dustDramaW:       Math.round(avgWeights('dustDramaW')       * 1000) / 1000,
      atmosphereDramaW: Math.round(avgWeights('atmosphereDramaW') * 1000) / 1000,
      humidityOptimum:  Math.round(avgWeights('humidityOptimum')),
      dustOptimum:      Math.round(avgWeights('dustOptimum')),
    },
    perEventState: data.perEvent,
    modelBiases: {
      CloudModel:    Math.round(avgWeights('CloudModelBias')    * 10) / 10,
      DustModel:     Math.round(avgWeights('DustModelBias')     * 10) / 10,
      ClearSkyModel: Math.round(avgWeights('ClearSkyModelBias') * 10) / 10,
    },
    trend,
    lastUpdated,
    locationSummary,
    biggestLearningMoments,
    activeInfluence,
    active:       totalSamples >= MIN_ACTIVE_SAMPLES,
  };
}

export function clearLearningData() {
  try {
    localStorage.removeItem(LEARNING_KEY);
    _adjCache  = null;
    _pinnedAdj = null;
  } catch (e) {
    console.warn('[learning] clear failed:', e);
  }
}

// ─────────────────────────────────────────────────────────────────
//  removeLearningSample — drop a single (date, eventType) sample.
//  Used by clearUserRating in calibration.js when the user retracts a
//  rating. Removes the per-event entry and decrements sampleSize.
//  EMA biases keep the old sample's residual contribution; future
//  ratings will gradually pull the bias back toward truth.
// ─────────────────────────────────────────────────────────────────
export function removeLearningSample(date, eventType) {
  if (!EVENT_TYPES.includes(eventType)) return false;
  const data = loadLearning();
  const key = `${date}::${eventType}`;
  const idx = data.entries.findIndex(e => (e.key ?? `${e.date}::${e.eventType ?? 'sunset'}`) === key);
  if (idx < 0) return false;
  data.entries.splice(idx, 1);

  const eventState = data.perEvent[eventType];
  if (eventState && eventState.sampleSize > 0) eventState.sampleSize--;

  saveLearning(data);
  _adjCache = null;
  return true;
}

// ─────────────────────────────────────────────────────────────────
//  seedFromBacktest — bulk-import historical backtest entries.
//  Backwards-compat: backtestEntries with no eventType default to 'sunset'.
// ─────────────────────────────────────────────────────────────────
export function seedFromBacktest(backtestEntries) {
  if (!Array.isArray(backtestEntries) || backtestEntries.length === 0) {
    return { added: 0, total: 0 };
  }
  const data = loadLearning();
  let added = 0;

  for (const e of backtestEntries) {
    if (!e.date || !e.reconstructed) continue;
    const eventType = EVENT_TYPES.includes(e.eventType) ? e.eventType : 'sunset';
    const key = `${e.date}::${eventType}`;
    if (data.entries.find(x => (x.key ?? `${x.date}::${x.eventType ?? 'sunset'}`) === key)) continue;

    const eventState = data.perEvent[eventType];

    const entry = {
      key,
      date:              e.date,
      eventType,
      locBucket:         e.locBucket         ?? 'central',
      month:             e.month             ?? (new Date(e.date + 'T12:00:00').getMonth() + 1),
      predicted:         e.predicted         ?? e.reconstructed,
      reconstructed:     e.reconstructed,
      userRating:        e.userRating        ?? null,
      paramRatios:       e.paramRatios       ?? {},
      dominantModel:     e.dominantModel     ?? 'ClearSkyModel',
      cloudScoreContrib: e.cloudScoreContrib ?? 0.33,
      dustScoreContrib:  e.dustScoreContrib  ?? 0.33,
      atmosphereContrib: e.atmosphereContrib ?? 0.34,
      forecastError:     e.forecastError     ?? 0,
      formulaError:      e.formulaError      ?? null,
      actualHumidity:    e.actualHumidity    ?? null,
      actualDust:        e.actualDust        ?? null,
      stateSnapshot: {
        cloudDramaW:      eventState.cloudDramaW,
        dustDramaW:       eventState.dustDramaW,
        atmosphereDramaW: eventState.atmosphereDramaW,
        humidityOptimum:  eventState.humidityOptimum,
        dustOptimum:      eventState.dustOptimum,
      },
      ts: e.ts ?? Date.now(),
    };

    if (eventType === 'sunset' && entry.paramRatios && Object.keys(entry.paramRatios).length > 0) {
      updateInputScales(data.shared, entry.paramRatios);
      data.shared.sampleSize++;
      data.shared.lastUpdated = Date.now();
    }
    updateModelBiases(eventState, entry, 1.0);
    updateDramaWeights(eventState, entry, 1.0);
    updateBellPeaks(eventState, entry, 1.0);

    eventState.sampleSize++;
    eventState.lastUpdated = Date.now();
    data.entries.push(entry);
    added++;
  }

  saveLearning(data);
  console.log(`[learning] seedFromBacktest: added ${added}, total ${data.entries.length}`);
  return { added, total: data.entries.length };
}

// ✓ learningEngine.js v2 — complete
