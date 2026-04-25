// tests/physics_per_event.test.mjs
// Per-event tuning in computeScattering: sunrise dust ×1.15, dusk Rayleigh ×1.10.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeScattering } from '../js/engine/physicsLayer.js';

const baseInput = {
  dust: 50,
  humidity: 60,
  visibility: 20,
  aqi: 80,
  solarElevation: 1,
};

test('default eventType=sunset matches explicit sunset', () => {
  const a = computeScattering({ ...baseInput });
  const b = computeScattering({ ...baseInput, eventType: 'sunset' });
  assert.equal(a.turbidity, b.turbidity);
  assert.equal(a.mieIntensity, b.mieIntensity);
  assert.equal(a.rayleighSpread, b.rayleighSpread);
});

test('sunrise increases dust contribution → higher turbidity', () => {
  const sunset  = computeScattering({ ...baseInput, eventType: 'sunset' });
  const sunrise = computeScattering({ ...baseInput, eventType: 'sunrise' });
  assert.ok(sunrise.turbidity > sunset.turbidity,
    `Expected sunrise turbidity > sunset, got ${sunrise.turbidity} vs ${sunset.turbidity}`);
  // Dust input goes from 50 → ~57.5 (×1.15), turbidity rises modestly
  const delta = sunrise.turbidity - sunset.turbidity;
  assert.ok(delta > 0.001 && delta < 0.05, `delta should be small but positive, got ${delta}`);
});

test('dusk boosts rayleighSpread vs sunset (same turbidity input)', () => {
  const sunset = computeScattering({ ...baseInput, eventType: 'sunset' });
  const dusk   = computeScattering({ ...baseInput, eventType: 'dusk' });
  assert.ok(dusk.rayleighSpread > sunset.rayleighSpread,
    `Expected dusk rayleigh > sunset, got ${dusk.rayleighSpread} vs ${sunset.rayleighSpread}`);
});

test('with no dust, sunrise=sunset (no per-event change)', () => {
  const sunset  = computeScattering({ ...baseInput, dust: null, eventType: 'sunset' });
  const sunrise = computeScattering({ ...baseInput, dust: null, eventType: 'sunrise' });
  assert.equal(sunrise.turbidity, sunset.turbidity);
});

test('rayleighSpread stays in [0,1]', () => {
  const dusk = computeScattering({ ...baseInput, dust: 0, humidity: 0, eventType: 'dusk' });
  assert.ok(dusk.rayleighSpread >= 0 && dusk.rayleighSpread <= 1);
});
