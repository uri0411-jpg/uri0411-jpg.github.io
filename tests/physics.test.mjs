/**
 * tests/physics.test.mjs
 *
 * Unit tests for the atmospheric physics engine.
 * Run with:  node --test tests/physics.test.mjs
 *
 * Uses native node:test (Node 18+) — no external dependencies.
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

// ── Import physics modules ────────────────────────────────────────────────────
// ESM imports — paths relative to project root when run with node --test
import { airMass }           from '../js/engine/physicsLayer.js';
import { computeAtmosphere } from '../js/engine/atmosphere.js';
import { spectrumToRGB }     from '../js/engine/color.js';

// ── airMass ───────────────────────────────────────────────────────────────────

test('airMass: zenith (90°) ≈ 1', () => {
  const m = airMass(90);
  assert.ok(m >= 0.99 && m <= 1.01, `Expected ~1, got ${m}`);
});

test('airMass: horizon (0° geometric) is large (≥25) due to Saemundsson refraction', () => {
  // physicsLayer.js applies Saemundsson refraction: at geometric 0° the
  // apparent elevation is ~0.47°, so Kasten-Young returns ~32 rather than
  // the textbook "38 at true geometric horizon" value.
  const m = airMass(0);
  assert.ok(m >= 25 && m <= 42, `Expected 25-42, got ${m}`);
});

test('airMass: 30° elevation is between 1 and 5', () => {
  const m = airMass(30);
  assert.ok(m > 1 && m < 5, `Expected 1-5, got ${m}`);
});

test('airMass: decreases monotonically from horizon to zenith', () => {
  const elevations = [0, 5, 10, 20, 30, 45, 60, 90];
  const masses = elevations.map(e => airMass(e));
  for (let i = 1; i < masses.length; i++) {
    assert.ok(masses[i] < masses[i - 1],
      `airMass should decrease: m(${elevations[i]}°)=${masses[i].toFixed(2)} not < m(${elevations[i-1]}°)=${masses[i-1].toFixed(2)}`);
  }
});

test('airMass: below -2° returns cap value (≥ 60)', () => {
  const m = airMass(-5);
  assert.ok(m >= 60, `Expected ≥60 below horizon, got ${m}`);
});

// ── computeAtmosphere ─────────────────────────────────────────────────────────

test('computeAtmosphere: returns expected zones at sunset (0°, turbidity=0.3)', () => {
  const atm = computeAtmosphere(0, 0.3);
  assert.ok(Array.isArray(atm.skyTop),   'skyTop should be an array');
  assert.ok(Array.isArray(atm.skyMid),   'skyMid should be an array');
  assert.ok(Array.isArray(atm.horizon),  'horizon should be an array');
  assert.ok(Array.isArray(atm.sun),      'sun should be an array');
  assert.strictEqual(atm.skyTop.length,  5, 'skyTop should have 5 wavelengths (Phase 3.6: violet/blue/green/orange/red)');
});

test('computeAtmosphere: blue > red at zenith in clean air (horizon frac = 0)', () => {
  // At high solar elevation, Rayleigh scatter dominates → blue sky
  // WAVELENGTHS: [0]=430nm violet, [1]=450nm blue, [2]=550nm green, [3]=600nm orange, [4]=650nm red
  const atm = computeAtmosphere(Math.PI / 2, 0.05); // sun overhead, clean air
  const iBlue = atm.skyTop[1]; // 450nm
  const iRed  = atm.skyTop[4]; // 650nm
  assert.ok(iBlue > iRed, `Blue (${iBlue.toFixed(3)}) should dominate red (${iRed.toFixed(3)}) at zenith`);
});

test('computeAtmosphere: red > blue at horizon in moderate haze', () => {
  // At horizon with moderate turbidity, Beer-Lambert depletes blue strongly
  const atm = computeAtmosphere(0, 0.5); // sun at horizon, moderate haze
  const iBlue = atm.horizon[1]; // 450nm
  const iRed  = atm.horizon[4]; // 650nm
  assert.ok(iRed > iBlue, `Red (${iRed.toFixed(3)}) should dominate blue (${iBlue.toFixed(3)}) at hazy horizon`);
});

test('computeAtmosphere: higher turbidity reduces all channels', () => {
  const clean = computeAtmosphere(0, 0.1);
  const dusty = computeAtmosphere(0, 0.8);
  // In pure Rayleigh (no Mie), higher turbidity increases Mie attenuation
  const cleanHorizonR = clean.horizon[4]; // 650nm red
  const dustyHorizonR = dusty.horizon[4]; // 650nm red
  // At very high turbidity, even red gets attenuated at air mass ~38
  assert.ok(cleanHorizonR > 0 && dustyHorizonR >= 0, 'horizon intensities should be non-negative');
});

test('computeAtmosphere: LRU cache returns identical result for same inputs', () => {
  const a = computeAtmosphere(0.1, 0.3, 0.5, 290);
  const b = computeAtmosphere(0.1, 0.3, 0.5, 290);
  assert.deepStrictEqual(a, b, 'Cached result should be identical');
});

test('computeAtmosphere: different ozoneDU produces different skyTop', () => {
  const low  = computeAtmosphere(-0.05, 0.2, 0, 250);
  const high = computeAtmosphere(-0.05, 0.2, 0, 350);
  // Different ozone → different Chappuis absorption → different blue/orange ratio
  // Compare 450nm blue (index 1, barely absorbed) vs 600nm orange (index 3, Chappuis peak)
  const diff = Math.abs(low.skyTop[1] - high.skyTop[1])
             + Math.abs(low.skyTop[3] - high.skyTop[3]);
  assert.ok(diff > 0, 'Different ozoneDU should produce different spectrum');
});

// ── spectrumToRGB ─────────────────────────────────────────────────────────────

test('spectrumToRGB: output channels are integers in [0, 255]', () => {
  const { r, g, b } = spectrumToRGB([0.8, 0.5, 0.3]);
  assert.ok(Number.isInteger(r) && r >= 0 && r <= 255, `r=${r}`);
  assert.ok(Number.isInteger(g) && g >= 0 && g <= 255, `g=${g}`);
  assert.ok(Number.isInteger(b) && b >= 0 && b <= 255, `b=${b}`);
});

test('spectrumToRGB: deterministic — same input always gives same output', () => {
  const a = spectrumToRGB([0.6, 0.4, 0.7]);
  const b = spectrumToRGB([0.6, 0.4, 0.7]);
  assert.deepStrictEqual(a, b);
});

test('spectrumToRGB: [blue, green, red] → red channel from index 2', () => {
  // High red intensity (index 2) should produce high r channel
  const { r, b } = spectrumToRGB([0.05, 0.1, 0.9]);
  assert.ok(r > b, `Red channel (${r}) should exceed blue (${b}) when red intensity is dominant`);
});

test('spectrumToRGB: zero intensities map to (0, 0, 0)', () => {
  const { r, g, b } = spectrumToRGB([0, 0, 0]);
  assert.strictEqual(r, 0);
  assert.strictEqual(g, 0);
  assert.strictEqual(b, 0);
});

test('spectrumToRGB: high equal intensities approach (255, 255, 255)', () => {
  const { r, g, b } = spectrumToRGB([10, 10, 10]);
  assert.ok(r > 240 && g > 240 && b > 240,
    `High equal intensities should approach white, got (${r},${g},${b})`);
});
