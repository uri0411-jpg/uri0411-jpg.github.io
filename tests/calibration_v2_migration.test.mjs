// tests/calibration_v2_migration.test.mjs
// Verifies v1 → v2 entry migration preserves user data.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// localStorage polyfill (Node has none)
const _store = new Map();
globalThis.localStorage = {
  getItem(k) { return _store.get(k) ?? null; },
  setItem(k, v) { _store.set(k, String(v)); },
  removeItem(k) { _store.delete(k); },
  clear() { _store.clear(); },
};

const { migrateCalibrationV1toV2 } = await import('../js/calibration.js');

test('v1 entry with userRating → v2 userRatings.sunset.value', () => {
  const v1 = [{
    date: '2026-04-20',
    predicted: 7.5,
    userRating: 8,
    actual: { ssClouds: 30 },
    params: { clouds: 30 },
    locBucket: 'coast',
    lat: 32.08, lon: 34.78,
    ts: 1700000000000,
  }];
  const out = migrateCalibrationV1toV2(v1);
  assert.equal(out.length, 1);
  const e = out[0];
  assert.equal(e.schemaVersion, 2);
  assert.equal(e.predicted.sunset, 7.5);
  assert.equal(e.predicted.sunrise, null);
  assert.equal(e.predicted.dusk, null);
  assert.equal(e.userRatings.sunset.value, 8);
  assert.equal(e.userRatings.sunset.confidence, 1);
  assert.equal(e.userRatings.sunrise, null);
  assert.equal(e.userRatings.dusk, null);
  assert.equal(e.actual.sunset.ssClouds, 30);
  assert.equal(e.actual.sunrise, null);
});

test('v2 entry passes through unchanged', () => {
  const v2 = [{
    schemaVersion: 2,
    date: '2026-04-21',
    predicted: { sunrise: 6, sunset: 7, dusk: 8 },
    userRatings: {
      sunrise: { value: 5, confidence: 1, ts: 1 },
      sunset: null,
      dusk: { value: 9, confidence: 0, ts: 2 },
    },
    actual: { sunrise: null, sunset: null, dusk: null },
    params: {}, locBucket: 'coast', lat: 0, lon: 0, ts: 1,
  }];
  const out = migrateCalibrationV1toV2(v2);
  assert.equal(out[0].schemaVersion, 2);
  assert.equal(out[0].userRatings.dusk.value, 9);
  assert.equal(out[0].userRatings.dusk.confidence, 0);
});

test('v1 with userRating=null still migrates structure', () => {
  const v1 = [{ date: '2026-04-22', predicted: 5, userRating: null, actual: null }];
  const out = migrateCalibrationV1toV2(v1);
  assert.equal(out[0].schemaVersion, 2);
  assert.equal(out[0].userRatings.sunset, null);
  assert.equal(out[0].predicted.sunset, 5);
});

test('mixed array: v1 + v2 produces all v2', () => {
  const mixed = [
    { date: 'a', predicted: 5, userRating: 6 },
    { schemaVersion: 2, date: 'b', predicted: { sunrise: null, sunset: 7, dusk: null },
      userRatings: { sunrise: null, sunset: null, dusk: null }, actual: { sunrise: null, sunset: null, dusk: null } },
  ];
  const out = migrateCalibrationV1toV2(mixed);
  assert.ok(out.every(e => e.schemaVersion === 2));
  assert.equal(out[0].userRatings.sunset.value, 6);
  assert.equal(out[1].predicted.sunset, 7);
});
