/**
 * tests/color.test.mjs
 *
 * Unit tests for the sky color pipeline (atmosphere → RGB).
 * Run with:  node --test tests/color.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { computeAtmosphere }               from '../js/engine/atmosphere.js';
import { spectrumToRGB, blendColors }      from '../js/engine/color.js';

// ── Sunset color expectations ─────────────────────────────────────────────────

test('sunset horizon: red channel dominates at solar elevation 0°, turbidity 0.4', () => {
  const atm = computeAtmosphere(0, 0.4);
  const { r, g, b } = spectrumToRGB(atm.horizon);
  assert.ok(r > g && r > b,
    `Sunset horizon should be warm (r=${r}, g=${g}, b=${b})`);
});

test('clean midday sky: blue channel dominates at high elevation, low turbidity', () => {
  const atm = computeAtmosphere(Math.PI / 3, 0.05); // 60° elevation, very clean
  const { r, g, b } = spectrumToRGB(atm.skyTop);
  assert.ok(b > r, `Clean midday sky top should be blue-dominant (r=${r}, b=${b})`);
});

test('deep twilight: belt zone is blue-shifted relative to horizon', () => {
  // At −3° the anti-twilight arch (Belt of Venus) should show blue/purple
  // relative to the warm horizon — test that skyTop is cooler (more blue) than horizon
  const atm     = computeAtmosphere(-0.052, 0.2); // ~-3°
  const topRGB  = spectrumToRGB(atm.skyTop);
  const horizRGB= spectrumToRGB(atm.horizon);
  // Top should have lower r/b ratio than horizon (i.e. bluer)
  const topWarmth   = topRGB.r   / Math.max(topRGB.b,   1);
  const horizWarmth = horizRGB.r / Math.max(horizRGB.b, 1);
  assert.ok(topWarmth < horizWarmth,
    `Sky top should be cooler (bluer) than horizon at twilight. Top r/b=${topWarmth.toFixed(2)}, Horizon r/b=${horizWarmth.toFixed(2)}`);
});

// ── blendColors ───────────────────────────────────────────────────────────────

test('blendColors: weight=1 returns physics color unchanged', () => {
  const physics = { r: 200, g: 100, b: 50 };
  const legacy  = { r: 0,   g: 0,   b: 0  };
  const blend   = blendColors(physics, legacy, 1.0);
  assert.strictEqual(blend.r, 200);
  assert.strictEqual(blend.g, 100);
  assert.strictEqual(blend.b, 50);
});

test('blendColors: weight=0 returns legacy color unchanged', () => {
  const physics = { r: 0,   g: 0,   b: 0   };
  const legacy  = { r: 150, g: 80,  b: 200 };
  const blend   = blendColors(physics, legacy, 0.0);
  assert.strictEqual(blend.r, 150);
  assert.strictEqual(blend.g, 80);
  assert.strictEqual(blend.b, 200);
});

test('blendColors: weight=0.5 produces midpoint', () => {
  const physics = { r: 200, g: 100, b: 0   };
  const legacy  = { r: 100, g: 0,   b: 200 };
  const blend   = blendColors(physics, legacy, 0.5);
  assert.strictEqual(blend.r, 150); // (200*0.5 + 100*0.5) = 150
  assert.strictEqual(blend.g, 50);  // (100*0.5 + 0*0.5)   = 50
  assert.strictEqual(blend.b, 100); // (0*0.5 + 200*0.5)   = 100
});

test('blendColors: output channels stay in [0, 255]', () => {
  const blend = blendColors({ r: 300, g: -10, b: 255 }, { r: 0, g: 0, b: 0 }, 0.7);
  assert.ok(blend.r <= 255 && blend.r >= 0, `r=${blend.r}`);
  assert.ok(blend.g <= 255 && blend.g >= 0, `g=${blend.g}`);
  assert.ok(blend.b <= 255 && blend.b >= 0, `b=${blend.b}`);
});

// ── ozoneDU sensitivity ───────────────────────────────────────────────────────

test('higher ozoneDU slightly suppresses orange channel at twilight', () => {
  // Chappuis band peaks at 600nm (orange) — higher ozone should attenuate
  // the horizon orange slightly relative to blue at civil twilight
  const lo = computeAtmosphere(-0.03, 0.2, 0, 220);
  const hi = computeAtmosphere(-0.03, 0.2, 0, 380);
  const rgbLo = spectrumToRGB(lo.horizon);
  const rgbHi = spectrumToRGB(hi.horizon);
  // Higher ozone → more orange suppression → slightly lower r relative to b
  // (effect is subtle; just verify it goes in the right direction or is equal)
  const ratiLo = rgbLo.r / Math.max(rgbLo.b, 1);
  const ratiHi = rgbHi.r / Math.max(rgbHi.b, 1);
  assert.ok(ratiLo >= ratiHi,
    `Higher ozone should reduce warm/cool ratio at twilight horizon. Lo=${ratiLo.toFixed(3)}, Hi=${ratiHi.toFixed(3)}`);
});
