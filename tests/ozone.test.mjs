/**
 * tests/ozone.test.mjs
 *
 * Unit tests for the seasonal ozone climatology module and config profiles.
 * Run with:  node --test tests/ozone.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { getSeasonalOzone }                         from '../js/data/ozone_climatology.js';
import { CLIMATE_PROFILES, detectClimateProfile }   from '../js/config.js';

// ── getSeasonalOzone ──────────────────────────────────────────────────────────

test('getSeasonalOzone: Israel (32°N) spring peak > winter trough', () => {
  const apr = getSeasonalOzone(32, 4);   // April — spring maximum
  const jan = getSeasonalOzone(32, 1);   // January — winter low
  assert.ok(apr > jan, `Spring (${apr} DU) should exceed winter (${jan} DU) at 32°N`);
});

test('getSeasonalOzone: returns value in realistic DU range (240–500)', () => {
  for (const lat of [0, 15, 32, 45, 60]) {
    for (const month of [1, 4, 7, 10]) {
      const du = getSeasonalOzone(lat, month);
      assert.ok(du >= 240 && du <= 500, `ozone(${lat}°, month=${month})=${du} DU out of range`);
    }
  }
});

test('getSeasonalOzone: higher latitudes have higher peak ozone (spring)', () => {
  const eq  = getSeasonalOzone(0,  4);
  const mid = getSeasonalOzone(32, 4);
  const hig = getSeasonalOzone(55, 4);
  assert.ok(mid > eq,  `32°N (${mid}) should exceed equator (${eq}) in April`);
  assert.ok(hig > mid, `55°N (${hig}) should exceed 32°N (${mid}) in April`);
});

test('getSeasonalOzone: southern hemisphere mirrored to northern (symmetry)', () => {
  const north = getSeasonalOzone(32, 4);
  const south = getSeasonalOzone(-32, 4);
  assert.strictEqual(north, south, 'Southern hemisphere should mirror northern');
});

test('getSeasonalOzone: month clamped — month 0 treated as January', () => {
  const jan = getSeasonalOzone(32, 1);
  const m0  = getSeasonalOzone(32, 0);
  assert.strictEqual(jan, m0);
});

test('getSeasonalOzone: month clamped — month 13 treated as December', () => {
  const dec  = getSeasonalOzone(32, 12);
  const m13  = getSeasonalOzone(32, 13);
  assert.strictEqual(dec, m13);
});

// ── CLIMATE_PROFILES ─────────────────────────────────────────────────────────

test('CLIMATE_PROFILES: all expected profiles exist', () => {
  for (const key of ['mediterranean', 'desert', 'temperate', 'tropical']) {
    assert.ok(key in CLIMATE_PROFILES, `Missing profile: ${key}`);
  }
});

test('CLIMATE_PROFILES: all profiles have required fields', () => {
  const required = ['dustPeak', 'humidityPeak', 'seaSaltWindPeak', 'ozoneDU'];
  for (const [name, p] of Object.entries(CLIMATE_PROFILES)) {
    for (const field of required) {
      assert.ok(field in p, `Profile '${name}' missing field '${field}'`);
    }
  }
});

// ── detectClimateProfile ──────────────────────────────────────────────────────

test('detectClimateProfile: Israel (32°N) → mediterranean', () => {
  assert.strictEqual(detectClimateProfile(32), 'mediterranean');
});

test('detectClimateProfile: equatorial (5°N) → tropical', () => {
  assert.strictEqual(detectClimateProfile(5), 'tropical');
});

test('detectClimateProfile: London (51°N) → temperate', () => {
  assert.strictEqual(detectClimateProfile(51), 'temperate');
});

test('detectClimateProfile: southern hemisphere mirrored — Sydney (−34°) → mediterranean', () => {
  // Sydney is subtropical but 34°S mirrors 34°N (mediterranean band)
  assert.strictEqual(detectClimateProfile(-34), 'mediterranean');
});

test('detectClimateProfile: returned profile key exists in CLIMATE_PROFILES', () => {
  for (const lat of [-60, -34, 0, 15, 32, 45, 65]) {
    const key = detectClimateProfile(lat);
    assert.ok(key in CLIMATE_PROFILES, `Unrecognised profile key '${key}' for lat=${lat}`);
  }
});
