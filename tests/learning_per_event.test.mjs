// tests/learning_per_event.test.mjs
// Per-event EMA isolation: rating sunrise must not move sunset/dusk state.

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
  processLearningEntry, getLearningAdjustments, clearLearningData, migrateLearningV1toV2,
} = await import('../js/engine/learningEngine.js');

const _calibEntry = (date, eventType, rating, predicted = 5) => {
  const userRatings = { sunrise: null, sunset: null, dusk: null };
  userRatings[eventType] = { value: rating, confidence: 1, ts: Date.now() };
  const actual = { sunrise: null, sunset: null, dusk: null };
  actual[eventType] = {
    clouds: 40, humidity: 60, visibility: 20, dust: 25,
  };
  const predictedObj = { sunrise: null, sunset: null, dusk: null };
  predictedObj[eventType] = predicted;
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

test('feeding 3 sunrise ratings increments sunrise.sampleSize, not sunset', () => {
  for (let d = 1; d <= 3; d++) {
    processLearningEntry(_calibEntry(`2026-04-0${d}`, 'sunrise', 8, 6), 'coast', 'sunrise');
  }
  const sr = getLearningAdjustments(32, 34.7, 4, 'sunrise');
  const ss = getLearningAdjustments(32, 34.7, 4, 'sunset');
  const du = getLearningAdjustments(32, 34.7, 4, 'dusk');
  assert.equal(sr.sampleSize, 3);
  assert.equal(ss.sampleSize, 0);
  assert.equal(du.sampleSize, 0);
});

test('shared input scales only update on sunset entries', () => {
  // 3 sunrise ratings — shouldn't move shared cloudScale (still 1.0)
  for (let d = 1; d <= 3; d++) {
    processLearningEntry(_calibEntry(`2026-04-0${d}`, 'sunrise', 8, 6), 'coast', 'sunrise');
  }
  const sr = getLearningAdjustments(32, 34.7, 4, 'sunrise');
  assert.equal(sr.inputScales.cloudScale, 1.0,
    'sunrise feed must not move shared cloudScale (sunset-only update)');
});

test('migrate v1 learning state → all 3 events seeded equally', () => {
  const v1 = {
    version: 1,
    state: {
      cloudInputScale: 1.5,
      humidityInputScale: 0.8,
      dustInputScale: 1.0,
      visibilityInputScale: 1.2,
      CloudModelBias: 0.3,
      DustModelBias: -0.1,
      cloudDramaW: 0.5,
      sampleSize: 12,
    },
    entries: [],
  };
  const out = migrateLearningV1toV2(v1);
  assert.equal(out.schemaVersion, 2);
  assert.equal(out.shared.cloudInputScale, 1.5);
  assert.equal(out.perEvent.sunrise.CloudModelBias, 0.3);
  assert.equal(out.perEvent.sunset.CloudModelBias, 0.3);
  assert.equal(out.perEvent.dusk.CloudModelBias, 0.3);
  assert.equal(out.perEvent.sunrise.cloudDramaW, 0.5);
});

test('inactive event returns default bell peaks', () => {
  // No entries at all
  const adj = getLearningAdjustments(32, 34.7, 4, 'dusk');
  assert.equal(adj.active, false);
  assert.equal(adj.bellPeaks.humidityOptimum, 60);
  assert.equal(adj.bellPeaks.dustOptimum, 25);
});
