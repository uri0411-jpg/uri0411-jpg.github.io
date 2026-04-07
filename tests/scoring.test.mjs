/**
 * tests/scoring.test.mjs
 *
 * Unit tests for the scoring and physics-layer modules.
 * Run with:  node --test tests/scoring.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { computeScattering } from '../js/engine/physicsLayer.js';
import { computeScore }      from '../js/engine/scoreEngine.js';

// ── computeScattering ─────────────────────────────────────────────────────────

test('computeScattering: returns turbidity in [0,1]', () => {
  const r = computeScattering({ dust: 25, humidity: 60, visibility: 15, aqi: null, solarElevation: 3 });
  assert.ok(r.turbidity >= 0 && r.turbidity <= 1, `turbidity=${r.turbidity}`);
});

test('computeScattering: heavy dust raises turbidity above clean-air baseline', () => {
  const clean = computeScattering({ dust: 0,   humidity: 40, visibility: 25, aqi: null, solarElevation: 5 });
  const dusty = computeScattering({ dust: 150, humidity: 40, visibility: 5,  aqi: null, solarElevation: 5 });
  assert.ok(dusty.turbidity > clean.turbidity,
    `Heavy dust turbidity (${dusty.turbidity}) should exceed clean (${clean.turbidity})`);
});

test('computeScattering: mieIntensity increases with turbidity', () => {
  const low  = computeScattering({ dust: 5,   humidity: 30, visibility: 30, aqi: null, solarElevation: 5 });
  const high = computeScattering({ dust: 100, humidity: 70, visibility: 5,  aqi: null, solarElevation: 5 });
  assert.ok(high.mieIntensity >= low.mieIntensity,
    `mieIntensity should rise with turbidity (${low.mieIntensity} → ${high.mieIntensity})`);
});

test('computeScattering: returns expected keys', () => {
  const r = computeScattering({ dust: 20, humidity: 55, visibility: 12, aqi: null, solarElevation: 2 });
  for (const key of ['turbidity', 'mieIntensity', 'rayleighSpread', 'atmosphericClarity', 'contributions']) {
    assert.ok(key in r, `Missing key: ${key}`);
  }
});

// ── computeScore (scoreEngine) ────────────────────────────────────────────────

test('computeScore: returns score in [0, 100]', () => {
  const r = computeScore({ clouds: 0.3, humidity: 55, visibility: 15, solarElevation: 3 });
  assert.ok(r.score >= 0 && r.score <= 100, `score=${r.score}`);
});

test('computeScore: clear sky scores higher than fully overcast', () => {
  const clear     = computeScore({ clouds: 0.05, humidity: 50, visibility: 25, solarElevation: 3 });
  const overcast  = computeScore({ clouds: 1.00, cloudHeightCategory: 'low',
                                   horizonClearance: 0, humidity: 80, visibility: 5, solarElevation: 3 });
  assert.ok(clear.score > overcast.score,
    `Clear (${clear.score}) should beat overcast (${overcast.score})`);
});

test('computeScore: heavy stratus (low cloud, no gap) scores low', () => {
  const r = computeScore({
    clouds: 0.95,
    cloudHeightCategory: 'low',
    horizonClearance: 0,
    humidity: 85,
    visibility: 4,
    solarElevation: 3,
  });
  assert.ok(r.score < 40, `Heavy stratus should score < 40, got ${r.score}`);
});

test('computeScore: high cirrus with gaps scores above median', () => {
  const r = computeScore({
    clouds: 0.80,
    cloudHeightCategory: 'high',
    horizonClearance: 0.7,
    humidity: 50,
    visibility: 20,
    solarElevation: 3,
  });
  assert.ok(r.score > 40, `High cirrus with gaps should score > 40, got ${r.score}`);
});

test('computeScore: returns model label string', () => {
  const r = computeScore({ clouds: 0.85, solarElevation: 5 });
  assert.ok(typeof r.model === 'string' && r.model.length > 0, `model="${r.model}"`);
});

test('computeScore: clouds fraction 0-1 — value > 1 does not crash', () => {
  // Guard: if a caller accidentally passes % instead of fraction, score should
  // still return a finite number (robustness test)
  assert.doesNotThrow(() => {
    const r = computeScore({ clouds: 75, solarElevation: 5 }); // 75% passed as fraction
    assert.ok(isFinite(r.score));
  });
});

test('computeScore: crepuscularRays probability is in [0, 1]', () => {
  const r = computeScore({ clouds: 0.42, turbidity: 0.38, solarElevation: 12 });
  assert.ok(r.crepuscularRays >= 0 && r.crepuscularRays <= 1,
    `crepuscularRays=${r.crepuscularRays}`);
});

test('computeScore: blend weights sum to ~1.0', () => {
  const r = computeScore({ clouds: 0.5, solarElevation: 5 });
  const sum = r.blendWeights.cloud + r.blendWeights.dust + r.blendWeights.clearSky;
  assert.ok(Math.abs(sum - 1.0) < 0.001, `Blend weights sum=${sum}`);
});
