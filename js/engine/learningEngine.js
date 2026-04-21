// ═══════════════════════════════════════════
//  TWILIGHT — learningEngine.js
//  Self-learning forecast calibration system
//
//  Tracks forecast vs. actual conditions and progressively adjusts:
//    1. Input scales   — corrects weather API forecast biases
//    2. Model biases   — per-regime (Cloud/Dust/ClearSky) offset
//    3. Drama weights  — cloud/dust/atmosphere component weights
//    4. Bell peaks     — humidity and dust sweet-spot values
//
//  Imports ONLY from ./scoreEngine.js and ../config.js (no cycles).
//  calibration.js calls this via dynamic import.
// ═══════════════════════════════════════════

import { computeScore }  from './scoreEngine.js';
import { LEARNING_KEY }  from '../config.js';

// ─── Constants ────────────────────────────────
const MAX_ENTRIES         = 90;
const MIN_ACTIVE_SAMPLES  = 10;   // below this: return defaults (no-op)
const MIN_BELL_SAMPLES    = 15;   // extra gate for bell peak learning
const ADJ_CACHE_TTL       = 1000; // ms — avoids re-reads for same calcDayData pass

// EMA smoothing factors (smaller = slower / more stable)
const α_INPUT  = 0.10; // forecast API input bias
const α_MODEL  = 0.08; // per-model score bias
const α_WEIGHT = 0.05; // drama component weights (needs many samples)
const α_BELL   = 0.03; // bell curve peaks (very slow structural change)

// Drama weight default values and bounds
const WEIGHT_DEFAULTS = { cloudDramaW: 0.30, dustDramaW: 0.27, atmosphereDramaW: 0.27 };
const WEIGHT_BOUNDS   = {
  cloudDramaW:       [0.21,  0.39 ],
  dustDramaW:        [0.189, 0.351],
  atmosphereDramaW:  [0.189, 0.351],
};
const WEIGHT_TARGET_SUM = 0.84; // 0.30+0.27+0.27 — must stay constant

// ─── Module-level adjustment cache ────────────
let _adjCache     = null;
let _adjCacheTime = 0;
// Session pin: when set, getLearningAdjustments returns this snapshot and
// ignores any localStorage mutations from async processLearningEntry. This
// prevents score drift between cold boot and refresh/setLocation within
// a single session. Set once from app.js loadAppData(); cleared by
// clearLearningData() and on full page reload (module re-evaluation).
let _pinnedAdj    = null;

// ─── Helpers ──────────────────────────────────
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

function getDefaultState() {
  return {
    // Input scale corrections (1.0 = no correction)
    cloudInputScale:     1.0,
    humidityInputScale:  1.0,
    dustInputScale:      1.0,
    visibilityInputScale:1.0,

    // Drama formula weights
    cloudDramaW:        0.30,
    dustDramaW:         0.27,
    atmosphereDramaW:   0.27,

    // Bell curve peaks
    humidityOptimum:    60,  // % — Rayleigh optimum for Israel
    dustOptimum:        25,  // µg/m³ — warm glow sweet-spot

    // Per-model additive biases (applied to 1-10 score)
    CloudModelBias:     0,
    DustModelBias:      0,
    ClearSkyModelBias:  0,

    sampleSize:  0,
    lastUpdated: 0,
  };
}

function loadLearning() {
  try {
    const raw = localStorage.getItem(LEARNING_KEY);
    if (!raw) return { version: 2, entries: [], state: getDefaultState() };
    const data = JSON.parse(raw);
    if (!data.state)   data.state   = getDefaultState();
    if (!data.entries) data.entries = [];
    // Fill any missing state fields (forward-compat)
    const def = getDefaultState();
    for (const k of Object.keys(def)) {
      if (data.state[k] == null) data.state[k] = def[k];
    }
    return data;
  } catch {
    return { version: 2, entries: [], state: getDefaultState() };
  }
}

function saveLearning(data) {
  try {
    data.entries = data.entries.slice(-MAX_ENTRIES);
    localStorage.setItem(LEARNING_KEY, JSON.stringify(data));
    _adjCache = null; // invalidate 1s cache
  } catch (e) {
    console.warn('[learning] save failed:', e);
  }
}

// ─── Build scoreEngine input from actual conditions ───────────────
function buildActualScoreInput(actual, forecastParams) {
  if (!actual) return null;

  const clouds = clamp((actual.clouds ?? 30) / 100, 0, 1);

  // Infer cloud height category from forecast layer breakdown (if stored)
  const cH = forecastParams?.cloudsHigh ?? 0;
  const cM = forecastParams?.cloudsMid  ?? 0;
  const cL = forecastParams?.cloudsLow  ?? 0;
  let cloudHeightCategory = 'mid';
  if (cH > cM && cH > cL)     cloudHeightCategory = 'high';
  else if (cL > cM && cL > cH) cloudHeightCategory = 'low';

  return {
    clouds,
    cloudHeightCategory,
    horizonClearance: clamp(1 - clouds * 1.2, 0, 1), // rough proxy
    dust:       actual.dust       ?? forecastParams?.dust       ?? 20,
    humidity:   actual.humidity   ?? forecastParams?.humidity   ?? 50,
    visibility: actual.visibility ?? forecastParams?.visibility ?? 15,
    aqi:        null,
    solarElevation: 3, // nominal sunset elevation
  };
}

// ─── EMA Phase 1: Forecast API input bias ────────────────────────
function updateInputScales(state, entry) {
  const r = entry.paramRatios;
  if (!r) return;

  if (r.cloudRatio != null && isFinite(r.cloudRatio)) {
    state.cloudInputScale = clamp(
      (1 - α_INPUT) * state.cloudInputScale + α_INPUT * clamp(r.cloudRatio, 0.2, 5.0),
      0.5, 2.0
    );
  }
  if (r.humidityRatio != null && isFinite(r.humidityRatio)) {
    state.humidityInputScale = clamp(
      (1 - α_INPUT) * state.humidityInputScale + α_INPUT * clamp(r.humidityRatio, 0.3, 3.0),
      0.5, 2.0
    );
  }
  if (r.dustRatio != null && isFinite(r.dustRatio)) {
    state.dustInputScale = clamp(
      (1 - α_INPUT) * state.dustInputScale + α_INPUT * clamp(r.dustRatio, 0.1, 10.0),
      0.5, 2.0
    );
  }
  if (r.visibilityRatio != null && isFinite(r.visibilityRatio)) {
    state.visibilityInputScale = clamp(
      (1 - α_INPUT) * state.visibilityInputScale + α_INPUT * clamp(r.visibilityRatio, 0.1, 5.0),
      0.5, 2.0
    );
  }
}

// ─── EMA Phase 2: Per-model bias ─────────────────────────────────
function updateModelBiases(state, entry) {
  if (entry.userRating == null || entry.reconstructed == null) return;

  // formulaError > 0 = formula over-scored → push bias negative to compensate
  const formulaError = entry.reconstructed - entry.userRating;
  const key = entry.dominantModel === 'CloudModel'  ? 'CloudModelBias'
            : entry.dominantModel === 'DustModel'   ? 'DustModelBias'
            :                                          'ClearSkyModelBias';

  state[key] = clamp(
    (1 - α_MODEL) * state[key] - α_MODEL * formulaError,
    -1.5, 1.5
  );
}

// ─── EMA Phase 3: Drama weight learning ──────────────────────────
function updateDramaWeights(state, entry) {
  if (entry.userRating == null || entry.reconstructed == null) return;
  if (state.sampleSize < MIN_ACTIVE_SAMPLES) return;

  const error = entry.reconstructed - entry.userRating;
  const cc    = entry.cloudScoreContrib  ?? 0.33;
  const dc    = entry.dustScoreContrib   ?? 0.33;
  const ac    = entry.atmosphereContrib  ?? 0.34;
  const total = cc + dc + ac + 0.001;

  // Gradient step: if cloud dominated AND formula over-scored → reduce cloudDramaW
  state.cloudDramaW      -= α_WEIGHT * error * (cc / total);
  state.dustDramaW       -= α_WEIGHT * error * (dc / total);
  state.atmosphereDramaW -= α_WEIGHT * error * (ac / total);

  // Re-normalise so weights sum stays at TARGET_SUM
  const mainSum = state.cloudDramaW + state.dustDramaW + state.atmosphereDramaW;
  if (Math.abs(mainSum - WEIGHT_TARGET_SUM) > 0.05 && mainSum > 0) {
    const scale = WEIGHT_TARGET_SUM / mainSum;
    state.cloudDramaW      *= scale;
    state.dustDramaW       *= scale;
    state.atmosphereDramaW *= scale;
  }

  // Clamp each weight to ±30% of defaults
  for (const [k, [lo, hi]] of Object.entries(WEIGHT_BOUNDS)) {
    state[k] = clamp(state[k], lo, hi);
  }
}

// ─── EMA Phase 4: Bell curve peak learning ───────────────────────
function updateBellPeaks(state, entry) {
  if (entry.userRating == null || entry.reconstructed == null) return;
  if (state.sampleSize < MIN_BELL_SAMPLES) return;

  const error = entry.reconstructed - entry.userRating;

  const h = entry.actualHumidity ?? 50;
  // humSign: if humidity > current peak AND we over-scored → peak is too low, push up
  const humSign = h > state.humidityOptimum ? 1 : -1;
  state.humidityOptimum = clamp(
    state.humidityOptimum + α_BELL * humSign * error,
    40, 75
  );

  const d = entry.actualDust ?? 20;
  const dustSign = d > state.dustOptimum ? 1 : -1;
  state.dustOptimum = clamp(
    state.dustOptimum + α_BELL * dustSign * error,
    10, 50
  );
}

// ─────────────────────────────────────────────────────────────────
//  processLearningEntry
//  Core EMA pipeline. Called from calibration.js via dynamic import
//  after fetchActualForDate fills entry.actual (and/or after user rates).
// ─────────────────────────────────────────────────────────────────
export function processLearningEntry(calibEntry, locBucket) {
  if (!calibEntry?.actual) return;

  const data  = loadLearning();
  const state = data.state;

  // Find existing learning entry or create a new one
  let lEntry = data.entries.find(e => e.date === calibEntry.date);
  const isNew = !lEntry;

  if (isNew) {
    lEntry = {
      date:              calibEntry.date,
      locBucket:         locBucket ?? calibEntry.locBucket ?? 'central',
      month:             new Date(calibEntry.date + 'T12:00:00').getMonth() + 1,
      predicted:         calibEntry.predicted,
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

  // Sync latest calibration state into learning entry
  lEntry.userRating = calibEntry.userRating;
  lEntry.predicted  = calibEntry.predicted;

  // ── Step 0: Reconstruct score from actual conditions ──────────────
  const scoreInput = buildActualScoreInput(calibEntry.actual, calibEntry.params);
  if (scoreInput) {
    try {
      const result = computeScore(scoreInput);
      lEntry.reconstructed  = Math.round(((result.score / 100) * 9 + 1) * 10) / 10;
      lEntry.dominantModel  = result.model;
      // Blend weights represent how much each model regime contributed
      lEntry.cloudScoreContrib = result.blendWeights?.cloud    ?? 0.33;
      lEntry.dustScoreContrib  = result.blendWeights?.dust     ?? 0.33;
      lEntry.atmosphereContrib = result.blendWeights?.clearSky ?? 0.34;
    } catch (e) {
      console.warn('[learning] reconstruct failed:', e);
    }
  }

  // ── Compute forecast input ratios (for Phase 1 learning) ─────────
  const p = calibEntry.params ?? {};
  const a = calibEntry.actual;
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

  // Error metrics (for stats UI and trend analysis)
  lEntry.forecastError = (lEntry.predicted != null && lEntry.reconstructed != null)
    ? Math.round((lEntry.predicted - lEntry.reconstructed) * 10) / 10
    : null;
  lEntry.formulaError = (lEntry.reconstructed != null && lEntry.userRating != null)
    ? Math.round((lEntry.reconstructed - lEntry.userRating) * 10) / 10
    : null;

  // Snapshot state before updates (for time-series display in settings)
  lEntry.stateSnapshot = {
    cloudDramaW:      state.cloudDramaW,
    dustDramaW:       state.dustDramaW,
    atmosphereDramaW: state.atmosphereDramaW,
    humidityOptimum:  state.humidityOptimum,
    dustOptimum:      state.dustOptimum,
  };

  // ── Run all four EMA phases ───────────────────────────────────────
  updateInputScales(state, lEntry);
  updateModelBiases(state, lEntry);
  updateDramaWeights(state, lEntry);
  updateBellPeaks(state, lEntry);

  state.sampleSize++;
  state.lastUpdated = Date.now();

  if (isNew) data.entries.push(lEntry);
  data.state = state;
  saveLearning(data);
}

// ─────────────────────────────────────────────────────────────────
//  _computeAdjustments — read current learning state from localStorage
//  and project it into the adjustment shape consumed by score.js.
//  Internal helper, not exported. Used by both getLearningAdjustments
//  (with TTL caching) and pinLearningSnapshot (forced fresh read).
// ─────────────────────────────────────────────────────────────────
function _computeAdjustments() {
  const { state, entries } = loadLearning();
  const active = state.sampleSize >= MIN_ACTIVE_SAMPLES;

  // Confidence split:
  //   activationLevel       — data volume (sampleSize ≥ 30 → 100%)
  //   calibrationConfidence — independently validated entries (paramRatios OR userRating)
  //   confidence            — blended display metric (0.7 × calibration + 0.3 × activation)
  const validatedSamples     = entries.filter(e =>
    e.userRating != null ||
    (e.paramRatios && Object.keys(e.paramRatios).length > 0)
  ).length;
  const activationLevel       = Math.min(1, state.sampleSize / 30);
  const calibrationConfidence = Math.min(1, validatedSamples / 15);
  const confidence            = calibrationConfidence * 0.7 + activationLevel * 0.3;

  return {
    inputScales: {
      cloudScale:      active ? state.cloudInputScale      : 1.0,
      humidityScale:   active ? state.humidityInputScale   : 1.0,
      dustScale:       active ? state.dustInputScale       : 1.0,
      visibilityScale: active ? state.visibilityInputScale : 1.0,
    },
    formulaWeights: {
      cloudDramaW:      active ? state.cloudDramaW      : WEIGHT_DEFAULTS.cloudDramaW,
      dustDramaW:       active ? state.dustDramaW       : WEIGHT_DEFAULTS.dustDramaW,
      atmosphereDramaW: active ? state.atmosphereDramaW : WEIGHT_DEFAULTS.atmosphereDramaW,
    },
    bellPeaks: {
      humidityOptimum: active ? state.humidityOptimum : 60,
      dustOptimum:     active ? state.dustOptimum     : 25,
    },
    modelBiases: {
      CloudModel:    active ? state.CloudModelBias    : 0,
      DustModel:     active ? state.DustModelBias     : 0,
      ClearSkyModel: active ? state.ClearSkyModelBias : 0,
    },
    confidence,
    activationLevel,
    calibrationConfidence,
    sampleSize:  state.sampleSize,
    active,
  };
}

// ─────────────────────────────────────────────────────────────────
//  getLearningAdjustments
//  Called by score.js to retrieve current learned corrections.
//  Returns defaults (no-op) when sampleSize < MIN_ACTIVE_SAMPLES.
//  Pin precedence: if pinLearningSnapshot() was called this session,
//  return the frozen snapshot — async processLearningEntry mutations
//  to localStorage do not leak into mid-session calcWeekData calls.
//  Otherwise: cached for ADJ_CACHE_TTL ms — called up to 3× per calcDayData().
// ─────────────────────────────────────────────────────────────────
export function getLearningAdjustments(lat, lon, month) { // eslint-disable-line no-unused-vars
  if (_pinnedAdj) return _pinnedAdj;

  const now = Date.now();
  if (_adjCache && (now - _adjCacheTime) < ADJ_CACHE_TTL) return _adjCache;

  _adjCache     = _computeAdjustments();
  _adjCacheTime = now;
  return _adjCache;
}

// ─────────────────────────────────────────────────────────────────
//  pinLearningSnapshot
//  Freeze the current learning adjustments for the rest of the session.
//  Subsequent getLearningAdjustments() calls return this snapshot until
//  unpinLearningSnapshot() or clearLearningData() is invoked, or until
//  the page is reloaded (module memory reset).
//
//  Called once from app.js loadAppData() AFTER autoSeedIfNeeded() and
//  BEFORE calcWeekData(). This ensures all calcWeekData calls within a
//  session — cold boot, refresh button, location search — see identical
//  learning state, eliminating score drift caused by the async
//  processLearningForEntry pipeline mutating cloudInputScale et al.
// ─────────────────────────────────────────────────────────────────
export function pinLearningSnapshot() {
  _pinnedAdj = _computeAdjustments();
  return _pinnedAdj;
}

export function unpinLearningSnapshot() {
  _pinnedAdj = null;
}

// ─────────────────────────────────────────────────────────────────
//  getLearningStats — for settings-screen.js UI
// ─────────────────────────────────────────────────────────────────
export function getLearningStats() {
  const { state, entries } = loadLearning();

  // Time series for accuracy chart (last 20 entries)
  const timeSeries = entries.slice(-20).map(e => ({
    date:          e.date,
    predicted:     e.predicted,
    reconstructed: e.reconstructed,
    userRating:    e.userRating,
    locBucket:     e.locBucket,
  }));

  // Forecast API bias: mean (actual/forecast - 1) per parameter
  const forecastBias = { cloudBias: null, humidityBias: null, dustBias: null, visibilityBias: null };
  const withRatios = entries.filter(e => e.paramRatios && Object.keys(e.paramRatios).length > 0);
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

  // Trend: compare absolute forecastError of last 7 vs prev 7
  const withErr = entries.filter(e => e.forecastError != null);
  const recent  = withErr.slice(-7);
  const older   = withErr.slice(-14, -7);
  let trend = 'stable';
  if (recent.length >= 3 && older.length >= 3) {
    const meanAbsErr = arr => arr.reduce((s, e) => s + Math.abs(e.forecastError), 0) / arr.length;
    const rErr = meanAbsErr(recent);
    const oErr = meanAbsErr(older);
    if (rErr < oErr - 0.3)      trend = 'improving';
    else if (rErr > oErr + 0.3) trend = 'worsening';
  }

  // Confidence split (mirrors getLearningAdjustments)
  const validatedSamples     = entries.filter(e =>
    e.userRating != null ||
    (e.paramRatios && Object.keys(e.paramRatios).length > 0)
  ).length;
  const activationLevel       = Math.min(1, state.sampleSize / 30);
  const calibrationConfidence = Math.min(1, validatedSamples / 15);

  // Forecast accuracy: weighted mean accuracy across available bias parameters
  // Higher weight on cloud (most impactful on sunset score)
  const BIAS_WEIGHTS = { cloudBias: 0.50, humidityBias: 0.30, visibilityBias: 0.15, dustBias: 0.05 };
  let weightedErr = 0, weightSum = 0;
  for (const [key, w] of Object.entries(BIAS_WEIGHTS)) {
    const b = forecastBias[key];
    if (b != null) { weightedErr += w * Math.min(1, Math.abs(b)); weightSum += w; }
  }
  const forecastAccuracy = weightSum > 0 ? Math.round((1 - weightedErr / weightSum) * 100) : null;

  // Per-location breakdown (coast/north/central/east)
  const byLocation = {};
  for (const e of entries) {
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
    // approximate accuracy: 1 - meanAbsErr / 9 (scale 1-10 → 0-1)
    accuracy: v.errCount > 0
      ? Math.max(0, Math.min(100, Math.round((1 - (v.errSum / v.errCount) / 4.5) * 100)))
      : null,
  })).sort((a, b) => b.samples - a.samples);

  // Biggest learning moments: top-5 entries by |forecastError|, with narrative hint
  const biggestLearningMoments = entries
    .filter(e => e.forecastError != null && Math.abs(e.forecastError) >= 1.5)
    .slice()
    .sort((a, b) => Math.abs(b.forecastError) - Math.abs(a.forecastError))
    .slice(0, 5)
    .map(e => ({
      date:         e.date,
      locBucket:    e.locBucket,
      predicted:    e.predicted,
      reconstructed: e.reconstructed,
      forecastError: e.forecastError,
      dominantModel: e.dominantModel,
    }));

  // Active influence: derived purely from forecastBias magnitudes.
  // If avg |bias| > 5%, the learning system is actively correcting today's forecast.
  const activeBiases = [forecastBias.cloudBias, forecastBias.humidityBias,
                        forecastBias.dustBias, forecastBias.visibilityBias]
    .filter(v => v != null);
  const maxBias = activeBiases.length
    ? Math.max(...activeBiases.map(v => Math.abs(v)))
    : 0;
  const activeInfluence = state.sampleSize >= MIN_ACTIVE_SAMPLES && maxBias >= 0.05;

  // Last-updated timestamp (ms epoch). Falls back to most-recent entry.ts.
  const lastUpdated = state.lastUpdated || entries.at(-1)?.ts || 0;

  return {
    sampleSize:           state.sampleSize,
    validatedSamples,
    activationLevel:       Math.round(activationLevel       * 100),
    calibrationConfidence: Math.round(calibrationConfidence * 100),
    confidence:            Math.round((calibrationConfidence * 0.7 + activationLevel * 0.3) * 100),
    forecastAccuracy,
    timeSeries,
    forecastBias,
    currentWeights: {
      cloudDramaW:      Math.round(state.cloudDramaW      * 1000) / 1000,
      dustDramaW:       Math.round(state.dustDramaW       * 1000) / 1000,
      atmosphereDramaW: Math.round(state.atmosphereDramaW * 1000) / 1000,
      humidityOptimum:  Math.round(state.humidityOptimum),
      dustOptimum:      Math.round(state.dustOptimum),
    },
    modelBiases: {
      CloudModel:    Math.round(state.CloudModelBias    * 10) / 10,
      DustModel:     Math.round(state.DustModelBias     * 10) / 10,
      ClearSkyModel: Math.round(state.ClearSkyModelBias * 10) / 10,
    },
    trend,
    lastUpdated,
    locationSummary,
    biggestLearningMoments,
    activeInfluence,
    active:       state.sampleSize >= MIN_ACTIVE_SAMPLES,
  };
}

// ─────────────────────────────────────────────────────────────────
//  clearLearningData — called from settings reset button
// ─────────────────────────────────────────────────────────────────
export function clearLearningData() {
  try {
    localStorage.removeItem(LEARNING_KEY);
    _adjCache  = null;
    _pinnedAdj = null; // also drop session pin so the cleared state takes effect immediately
  } catch (e) {
    console.warn('[learning] clear failed:', e);
  }
}

// ─────────────────────────────────────────────────────────────────
//  seedFromBacktest
//  Bulk-imports historical backtest entries (from scripts/backtest.js)
//  into the learning engine, cold-starting calibration with up to
//  365 days of archive data instead of waiting months.
//
//  Entries MUST be passed in chronological order (oldest first) so
//  the EMA converges correctly. The seed-export.js script sorts them.
// ─────────────────────────────────────────────────────────────────
export function seedFromBacktest(backtestEntries) {
  if (!Array.isArray(backtestEntries) || backtestEntries.length === 0) {
    return { added: 0, total: 0 };
  }

  const data  = loadLearning();
  const state = data.state;
  let added = 0;

  for (const e of backtestEntries) {
    if (!e.date || !e.reconstructed) continue;
    // Skip if this date already exists in learning data
    if (data.entries.find(x => x.date === e.date)) continue;

    const entry = {
      date:              e.date,
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
        cloudDramaW:      state.cloudDramaW,
        dustDramaW:       state.dustDramaW,
        atmosphereDramaW: state.atmosphereDramaW,
        humidityOptimum:  state.humidityOptimum,
        dustOptimum:      state.dustOptimum,
      },
      ts: e.ts ?? Date.now(),
    };

    // Run all four EMA phases (same pipeline as processLearningEntry)
    updateInputScales(state, entry);
    updateModelBiases(state, entry);
    updateDramaWeights(state, entry);
    updateBellPeaks(state, entry);

    state.sampleSize++;
    state.lastUpdated = Date.now();
    data.entries.push(entry);
    added++;
  }

  data.state = state;
  saveLearning(data);
  console.log(`[learning] seedFromBacktest: added ${added}, total ${data.entries.length}`);
  return { added, total: data.entries.length };
}

// ✓ learningEngine.js — complete
