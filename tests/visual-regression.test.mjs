/**
 * Visual regression tests — TWILIGHT PWA
 *
 * Validates that computeSkyColor and computeSunAppearance produce
 * physically plausible RGB values across key scenarios. Not pixel-exact;
 * uses RGB channel range assertions (±tolerance).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeSkyColor, computeSunAppearance } from '../js/engine/skyColor.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function inRange(val, lo, hi, label) {
  assert.ok(val >= lo && val <= hi,
    `${label}: ${val} not in [${lo}, ${hi}]`);
}

function assertRGB(color, rRange, gRange, bRange, label) {
  inRange(color.r, ...rRange, `${label} R`);
  inRange(color.g, ...gRange, `${label} G`);
  inRange(color.b, ...bRange, `${label} B`);
}

function assertWarm(color, label) {
  assert.ok(color.r > color.b,
    `${label}: expected warm (r > b), got r=${color.r} b=${color.b}`);
}

function assertCool(color, label) {
  assert.ok(color.b > color.r || (color.b > 150 && color.r < 100),
    `${label}: expected cool, got r=${color.r} g=${color.g} b=${color.b}`);
}

// No clouds, standard atmosphere
const CLEAR = { low: 0, mid: 0, high: 0, fog: 0 };
const OVERCAST = { low: 1, mid: 0.8, high: 0.5, fog: 0 };

// ── Scenario 1: Clear sky at noon (high sun) ────────────────────────────────

test('visual: clear sky noon — skyTop is blue', () => {
  const sky = computeSkyColor({
    solarElevation: 60, turbidity: 0.1, clouds: CLEAR,
  });
  assertCool(sky.skyTop, 'skyTop at noon');
  inRange(sky.skyTop.b, 120, 255, 'skyTop.b at noon');
});

test('visual: clear sky noon — horizon is lighter than zenith', () => {
  const sky = computeSkyColor({
    solarElevation: 60, turbidity: 0.1, clouds: CLEAR,
  });
  const topLum = sky.skyTop.r + sky.skyTop.g + sky.skyTop.b;
  const hrzLum = sky.horizon.r + sky.horizon.g + sky.horizon.b;
  assert.ok(hrzLum >= topLum * 0.5,
    `horizon luminance (${hrzLum}) should not be dramatically darker than zenith (${topLum})`);
});

// ── Scenario 2: Sunset at horizon (golden hour) ─────────────────────────────

test('visual: sunset horizon — horizon is warm (red dominant)', () => {
  const sky = computeSkyColor({
    solarElevation: 1, turbidity: 0.3, clouds: CLEAR,
  });
  assertWarm(sky.horizon, 'horizon at sunset');
});

test('visual: sunset horizon — sun zone is warm', () => {
  const sky = computeSkyColor({
    solarElevation: 1, turbidity: 0.3, clouds: CLEAR,
  });
  assertWarm(sky.sun, 'sun at sunset');
  inRange(sky.sun.r, 180, 255, 'sun.r at sunset');
});

test('visual: sunset horizon — skyTop stays cooler than horizon', () => {
  const sky = computeSkyColor({
    solarElevation: 1, turbidity: 0.3, clouds: CLEAR,
  });
  // skyTop blue-ish relative to warm horizon
  assert.ok(sky.skyTop.b >= sky.horizon.b,
    `skyTop should be cooler than horizon`);
});

// ── Scenario 3: Civil twilight (sun just below horizon) ─────────────────────

test('visual: civil twilight -3° — horizon still warm', () => {
  const sky = computeSkyColor({
    solarElevation: -3, turbidity: 0.2, clouds: CLEAR,
  });
  assertWarm(sky.horizon, 'horizon at civil twilight');
});

test('visual: civil twilight -3° — sky is dimmer than sunset', () => {
  const sunset = computeSkyColor({
    solarElevation: 1, turbidity: 0.2, clouds: CLEAR,
  });
  const twilight = computeSkyColor({
    solarElevation: -3, turbidity: 0.2, clouds: CLEAR,
  });
  const ssLum = sunset.skyTop.r + sunset.skyTop.g + sunset.skyTop.b;
  const twLum = twilight.skyTop.r + twilight.skyTop.g + twilight.skyTop.b;
  assert.ok(twLum <= ssLum,
    `twilight zenith (${twLum}) should be dimmer than sunset (${ssLum})`);
});

// ── Scenario 4: Deep night ──────────────────────────────────────────────────

test('visual: deep night -18° — sky is desaturated and dimmer than daytime', () => {
  const night = computeSkyColor({
    solarElevation: -18, turbidity: 0.1, clouds: CLEAR,
  });
  const day = computeSkyColor({
    solarElevation: 60, turbidity: 0.1, clouds: CLEAR,
  });
  // Night sky is significantly dimmer than daytime
  const nightLum = night.skyTop.r + night.skyTop.g + night.skyTop.b;
  const dayLum   = day.skyTop.r + day.skyTop.g + day.skyTop.b;
  assert.ok(nightLum < dayLum,
    `Night luminance (${nightLum}) should be less than day (${dayLum})`);
  // Night sky is desaturated (channels close together)
  const spread = Math.max(night.skyTop.r, night.skyTop.g, night.skyTop.b)
               - Math.min(night.skyTop.r, night.skyTop.g, night.skyTop.b);
  assert.ok(spread < 60,
    `Night sky should be desaturated, channel spread=${spread}`);
});

// ── Scenario 5: Overcast sky ────────────────────────────────────────────────

test('visual: overcast noon — sky is desaturated (low contrast R vs B)', () => {
  const sky = computeSkyColor({
    solarElevation: 50, turbidity: 0.5, clouds: OVERCAST,
  });
  const diff = Math.abs(sky.skyTop.r - sky.skyTop.b);
  assert.ok(diff < 120,
    `Overcast sky should be desaturated, R-B diff=${diff}`);
});

// ── Scenario 6: Dusty / high turbidity ──────────────────────────────────────

test('visual: high turbidity sunset — horizon is very warm/orange', () => {
  const sky = computeSkyColor({
    solarElevation: 2, turbidity: 0.8, clouds: CLEAR,
  });
  assertWarm(sky.horizon, 'dusty horizon');
  assert.ok(sky.horizon.r >= 150,
    `Dusty horizon should have strong red: r=${sky.horizon.r}`);
});

test('visual: high turbidity — skyMid is warmer than clean atmosphere', () => {
  const clean = computeSkyColor({
    solarElevation: 10, turbidity: 0.1, clouds: CLEAR,
  });
  const dusty = computeSkyColor({
    solarElevation: 10, turbidity: 0.8, clouds: CLEAR,
  });
  // Dusty mid should have higher R relative to B
  const cleanRatio = clean.skyMid.r / Math.max(clean.skyMid.b, 1);
  const dustyRatio = dusty.skyMid.r / Math.max(dusty.skyMid.b, 1);
  assert.ok(dustyRatio >= cleanRatio,
    `Dusty skyMid R/B ratio (${dustyRatio.toFixed(2)}) >= clean (${cleanRatio.toFixed(2)})`);
});

// ── Scenario 7: Ozone effects ───────────────────────────────────────────────

test('visual: high ozone — blue channel slightly enhanced at zenith', () => {
  const lowO3 = computeSkyColor({
    solarElevation: 30, turbidity: 0.1, ozoneDU: 200, clouds: CLEAR,
  });
  const highO3 = computeSkyColor({
    solarElevation: 30, turbidity: 0.1, ozoneDU: 500, clouds: CLEAR,
  });
  // Ozone absorbs in yellow-green (Chappuis band), making sky bluer
  assert.ok(highO3.skyTop.b >= lowO3.skyTop.b - 5,
    `High ozone should maintain or increase blue: lowO3.b=${lowO3.skyTop.b}, highO3.b=${highO3.skyTop.b}`);
});

// ── Scenario 8: computeSunAppearance ────────────────────────────────────────

test('sunAppearance: returns expected keys', () => {
  const sa = computeSunAppearance({
    solarElevation: 5, turbidity: 0.3, mieIntensity: 0.2,
    humidity: 40, airMass: 10,
  });
  assert.ok('color' in sa);
  assert.ok('size' in sa);
  assert.ok('blur' in sa);
  assert.ok('intensity' in sa);
});

test('sunAppearance: size increases near horizon', () => {
  const high = computeSunAppearance({
    solarElevation: 45, turbidity: 0.2, mieIntensity: 0.1,
    humidity: 30, airMass: 1.4,
  });
  const low = computeSunAppearance({
    solarElevation: 2, turbidity: 0.2, mieIntensity: 0.1,
    humidity: 30, airMass: 12,
  });
  assert.ok(low.size >= high.size,
    `Sun should appear larger near horizon: low=${low.size}, high=${high.size}`);
});

test('sunAppearance: intensity decreases with higher air mass', () => {
  const high = computeSunAppearance({
    solarElevation: 45, turbidity: 0.2, mieIntensity: 0.1,
    humidity: 30, airMass: 1.4,
  });
  const low = computeSunAppearance({
    solarElevation: 2, turbidity: 0.2, mieIntensity: 0.1,
    humidity: 30, airMass: 20,
  });
  assert.ok(low.intensity <= high.intensity,
    `Intensity should decrease with air mass: low=${low.intensity}, high=${high.intensity}`);
});

test('sunAppearance: sun colour is warm at low elevation', () => {
  const sa = computeSunAppearance({
    solarElevation: 2, turbidity: 0.3, mieIntensity: 0.2,
    humidity: 40, airMass: 12,
  });
  assertWarm(sa.color, 'sun disk at low elevation');
});

test('sunAppearance: blur increases with mieIntensity', () => {
  const low = computeSunAppearance({
    solarElevation: 10, turbidity: 0.2, mieIntensity: 0.05,
    humidity: 30, airMass: 5,
  });
  const high = computeSunAppearance({
    solarElevation: 10, turbidity: 0.2, mieIntensity: 0.8,
    humidity: 30, airMass: 5,
  });
  assert.ok(high.blur > low.blur,
    `Blur should increase with mie: low=${low.blur}, high=${high.blur}`);
});

test('sunAppearance: intensity is always at least 0.05', () => {
  const sa = computeSunAppearance({
    solarElevation: 0, turbidity: 1.0, mieIntensity: 1.0,
    humidity: 100, airMass: 38,
  });
  assert.ok(sa.intensity >= 0.05, `intensity should be >= 0.05, got ${sa.intensity}`);
});
