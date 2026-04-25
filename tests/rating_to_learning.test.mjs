// tests/rating_to_learning.test.mjs
// Integration: calibration.recordUserRating ↔ learningEngine sample state.
// Validates per-event sample-count tracking, the MIN_ACTIVE_SAMPLES gate,
// and that clearUserRating winds back learning samples without off-by-one.

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

const { CALIBRATION_KEY }                                   = await import('../js/config.js');
const { recordUserRating, clearUserRating, getUserRating }  = await import('../js/calibration.js');
const { getLearningStats, clearLearningData, MIN_ACTIVE_SAMPLES } = await import('../js/engine/learningEngine.js');

// Build a v2 calibration entry with `actual` populated for all 3 events so
// recordUserRating triggers processLearningEntry on every call.
function _seedEntry(date) {
  const actualPayload = { clouds: 40, humidity: 60, visibility: 20, dust: 25, rain: 0 };
  return {
    schemaVersion: 2,
    date,
    locBucket: 'coast',
    lat: 32, lon: 34.7,
    ts: Date.now(),
    params: { clouds: 40, humidity: 60, visibility: 20, dust: 25, cloudsHigh: 10, cloudsMid: 20, cloudsLow: 10 },
    predicted: { sunrise: 6, sunset: 6, dusk: 6 },
    userRatings: { sunrise: null, sunset: null, dusk: null },
    actual: { sunrise: actualPayload, sunset: actualPayload, dusk: actualPayload },
  };
}

function _seedEntries(dates) {
  localStorage.setItem(CALIBRATION_KEY, JSON.stringify(dates.map(_seedEntry)));
}

const _datesN = (n) => Array.from({ length: n }, (_, i) => `2026-04-${String(i + 1).padStart(2, '0')}`);

beforeEach(() => { _store.clear(); clearLearningData(); _store.clear(); });

test('case 1: 10× sunrise ratings increment only sunrise sampleSize', async () => {
  const dates = _datesN(10);
  _seedEntries(dates);
  for (const d of dates) await recordUserRating(d, 'sunrise', 8, 1);

  const stats = getLearningStats();
  assert.equal(stats.samplesByEvent.sunrise, 10);
  assert.equal(stats.samplesByEvent.sunset, 0);
  assert.equal(stats.samplesByEvent.dusk, 0);
});

test('case 2: clearUserRating drops sample + decrements sampleSize', async () => {
  const dates = _datesN(10);
  _seedEntries(dates);
  for (const d of dates) await recordUserRating(d, 'sunrise', 8, 1);
  assert.equal(getLearningStats().samplesByEvent.sunrise, 10);

  const ok = await clearUserRating(dates[0], 'sunrise');
  assert.equal(ok, true,                                 'clearUserRating returns true when rating existed');
  assert.equal(getUserRating(dates[0], 'sunrise'), null, 'calibration rating is null after clear');
  assert.equal(getLearningStats().samplesByEvent.sunrise, 9,
               'learning sampleSize decremented (no off-by-one)');
});

test('case 3: a single rating stays below MIN_ACTIVE_SAMPLES gate', async () => {
  _seedEntries(['2026-04-01']);
  await recordUserRating('2026-04-01', 'sunrise', 8, 1);

  const stats = getLearningStats();
  assert.equal(stats.samplesByEvent.sunrise, 1, 'sample recorded');
  assert.ok(stats.samplesByEvent.sunrise < MIN_ACTIVE_SAMPLES,
            'a lone rating is gated out of bias activation');
});

test('case 4: clear then re-rate restores the counter (no off-by-one)', async () => {
  const dates = _datesN(8);
  _seedEntries(dates);
  for (const d of dates) await recordUserRating(d, 'sunrise', 8, 1);
  assert.equal(getLearningStats().samplesByEvent.sunrise, 8, 'baseline 8 ratings');

  await clearUserRating(dates[0], 'sunrise');
  assert.equal(getLearningStats().samplesByEvent.sunrise, 7, 'after clear: 7');

  await recordUserRating(dates[0], 'sunrise', 6, 1);
  assert.equal(getLearningStats().samplesByEvent.sunrise, 8, 'after re-rate: back to 8');
  assert.equal(getUserRating(dates[0], 'sunrise'), 6,        'new rating value sticks');
});

test('clearUserRating returns false when rating did not exist', async () => {
  _seedEntries(['2026-04-01']);
  const ok = await clearUserRating('2026-04-01', 'sunrise');
  assert.equal(ok, false);
});

test('clearUserRating ignores invalid eventType', async () => {
  _seedEntries(['2026-04-01']);
  const ok = await clearUserRating('2026-04-01', 'noon');
  assert.equal(ok, false);
});
