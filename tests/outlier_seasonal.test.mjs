// tests/outlier_seasonal.test.mjs
// Verifies outlier rejection (alphaScale ½) + seasonal bias correction.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const _store = new Map();
globalThis.localStorage = {
  getItem(k) { return _store.get(k) ?? null; },
  setItem(k, v) { _store.set(k, String(v)); },
  removeItem(k) { _store.delete(k); },
  clear() { _store.clear(); },
};
globalThis.window = globalThis.window || {};

const {
  processLearningEntry, getLearningAdjustments, clearLearningData,
} = await import('../js/engine/learningEngine.js');
const { LEARNING_KEY } = await import('../js/config.js');

// Helper: build a calibration entry where reconstructed will be ~7 (clouds=40)
const calib = (date, eventType, rating, confidence = 1) => {
  const userRatings = { sunrise: null, sunset: null, dusk: null };
  userRatings[eventType] = { value: rating, confidence, ts: Date.now() };
  const actual = { sunrise: null, sunset: null, dusk: null };
  actual[eventType] = { clouds: 40, humidity: 60, visibility: 20, dust: 25 };
  const predictedObj = { sunrise: null, sunset: null, dusk: null };
  predictedObj[eventType] = 7;
  return {
    schemaVersion: 2,
    date,
    locBucket: 'coast',
    lat: 32, lon: 34.7,
    params: { clouds: 40, humidity: 60, visibility: 20, dust: 25, cloudsHigh: 10, cloudsMid: 20, cloudsLow: 10 },
    predicted: predictedObj,
    userRatings,
    actual,
    ts: Date.now(),
  };
};

beforeEach(() => { _store.clear(); clearLearningData(); _store.clear(); });

test('outlier (|rating - reconstructed| > 4) → alphaScale ≤ 0.5', () => {
  // reconstructed for these inputs lands ~5-7. Rate 1 → big δ → outlier.
  processLearningEntry(calib('2026-04-01', 'sunset', 1, 1), 'coast', 'sunset');
  const stored = JSON.parse(_store.get(LEARNING_KEY));
  const e = stored.entries.find(x => x.date === '2026-04-01');
  assert.ok(e, 'entry recorded');
  assert.ok(Math.abs(e.userRating - e.reconstructed) > 4,
    `expected δ > 4, got ${Math.abs(e.userRating - e.reconstructed)}`);
  assert.ok(e.alphaScale <= 0.5, `outlier alphaScale should be ≤ 0.5, got ${e.alphaScale}`);
});

test('low confidence (0) downweights alphaScale to ≤ 0.4', () => {
  // rating=6 (close to reconstructed) — not an outlier — but confidence=0
  processLearningEntry(calib('2026-04-01', 'sunset', 6, 0), 'coast', 'sunset');
  const stored = JSON.parse(_store.get(LEARNING_KEY));
  const e = stored.entries.find(x => x.date === '2026-04-01');
  assert.ok(e.alphaScale <= 0.4, `low-confidence alphaScale should be ≤ 0.4, got ${e.alphaScale}`);
});

test('full confidence + non-outlier → alphaScale = 1.0', () => {
  processLearningEntry(calib('2026-04-01', 'sunset', 6, 1), 'coast', 'sunset');
  const stored = JSON.parse(_store.get(LEARNING_KEY));
  const e = stored.entries.find(x => x.date === '2026-04-01');
  assert.equal(e.alphaScale, 1.0);
});

test('seasonal bias applied when ≥3 same-season entries', () => {
  // Need MIN_ACTIVE_SAMPLES (10) for state to be active.
  // Seed 12 January entries with rating=2 so formulaError trends positive.
  for (let i = 1; i <= 12; i++) {
    const dd = String(i).padStart(2,'0');
    processLearningEntry(calib(`2026-01-${dd}`, 'sunset', 2, 1), 'coast', 'sunset');
  }
  const winterAdj = getLearningAdjustments(32, 34.7, 1, 'sunset'); // January
  const summerAdj = getLearningAdjustments(32, 34.7, 7, 'sunset'); // July
  assert.ok(winterAdj.active, 'winter adjustment should be active');
  assert.notEqual(winterAdj.seasonalBias, summerAdj.seasonalBias,
    'seasonal bias should differ between winter (in-season) and summer (out-of-season)');
});
