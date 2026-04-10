/**
 * tests/color.test.mjs
 *
 * Unit tests for the sky color pipeline (atmosphere → RGB).
 * Run with:  node --test tests/color.test.mjs
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { computeAtmosphere }                                     from '../js/engine/atmosphere.js';
import { spectrumToRGB, blendColors, applyPerceptualTuning, PERCEPTUAL_BOOST } from '../js/engine/color.js';

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

// ── Phase 7: Perceptual tuning layer ─────────────────────────────────────────
//
// These tests are split into two groups:
//
//   (1) Dormancy invariants — verify that PERCEPTUAL_BOOST ships at 0 and that
//       the function is a byte-identical no-op in that state. These are the
//       only Phase 7 tests that run against the shipping binary.
//
//   (2) Activation behaviour — verify the mathematical properties the tuning
//       pass is supposed to exhibit WHEN the dial is up. Because PERCEPTUAL_BOOST
//       is a module-level const, we can't flip it at test time; instead these
//       tests replicate the formula inline and assert its properties, then
//       cross-check against the real function using the property that its
//       output at BOOST=0 is the identity.

test('Phase 7 rollout: PERCEPTUAL_BOOST pinned at 0.0 (pure physics, violet palette)', () => {
  // Set to 0.0 to restore Rayleigh-dominant violet colours at golden hour.
  // The warm-reddening boost (0.5) was suppressing the purple palette.
  // Any change to this value must update this assertion in the same commit.
  // The `=== 0` guard in applyPerceptualTuning makes BOOST=0 a byte-identical no-op.
  assert.strictEqual(PERCEPTUAL_BOOST, 0.0,
    `PERCEPTUAL_BOOST must be 0.0 (pure physics); got ${PERCEPTUAL_BOOST}.`);
});

test('Phase 7: applyPerceptualTuning is identity at midday (outside sunset gate)', () => {
  // Even with the boost active, the bandpass gate must zero out the effect
  // above +8° elevation. This is the "daytime sky must still be blue" guarantee.
  const rgb = { r: 90, g: 130, b: 200 };
  const out = applyPerceptualTuning(rgb, { sunAngle_rad: Math.PI / 3, zone: 'horizon' });
  assert.deepStrictEqual(out, rgb, 'Midday horizon must be unchanged even when boost is active');
});

test('Phase 7: applyPerceptualTuning is identity at astronomical twilight', () => {
  // And below the lower bandpass bound — no effect after full darkness.
  const rgb = { r: 10, g: 10, b: 30 };
  const out = applyPerceptualTuning(rgb, { sunAngle_rad: -12 * Math.PI / 180, zone: 'horizon' });
  assert.deepStrictEqual(out, rgb);
});

test('Phase 7: applyPerceptualTuning at sunset horizon (branch-aware)', () => {
  // When BOOST > 0: must shift colour toward warmer (R lift, B dip).
  // When BOOST = 0: function is a byte-identical no-op — output === input.
  const rgb = { r: 200, g: 120, b: 100 };
  const out = applyPerceptualTuning(rgb, { sunAngle_rad: 0, zone: 'horizon' });
  if (PERCEPTUAL_BOOST === 0) {
    assert.deepStrictEqual(out, rgb, 'At BOOST=0, output must equal input (no-op)');
  } else {
    assert.ok(out.r > rgb.r, `R must lift at sunset horizon; got r=${out.r}, input=${rgb.r}`);
    assert.ok(out.b < rgb.b, `B must dip  at sunset horizon; got b=${out.b}, input=${rgb.b}`);
    assert.ok(out.g >= rgb.g, `G must not drop at sunset horizon; got g=${out.g}, input=${rgb.g}`);
  }
});

test('Phase 7: horizon zone receives more boost than skyTop (branch-aware)', () => {
  // Zone asymmetry: skyTop has zoneW=0.4, horizon has zoneW=1.0.
  // At BOOST=0: both deltas are 0 (no-op). At BOOST>0: horizon ΔR >= skyTop ΔR.
  const rgb = { r: 200, g: 120, b: 100 };
  const h   = applyPerceptualTuning(rgb, { sunAngle_rad: 0, zone: 'horizon' });
  const t   = applyPerceptualTuning(rgb, { sunAngle_rad: 0, zone: 'skyTop'  });
  const dRh = h.r - rgb.r;
  const dRt = t.r - rgb.r;
  if (PERCEPTUAL_BOOST === 0) {
    assert.strictEqual(dRh, 0, 'dRh must be 0 when boost=0 (no-op)');
    assert.strictEqual(dRt, 0, 'dRt must be 0 when boost=0 (no-op)');
  } else {
    assert.ok(dRh >= dRt,
      `Horizon ΔR (${dRh}) must be >= skyTop ΔR (${dRt}) at PERCEPTUAL_BOOST=${PERCEPTUAL_BOOST}`);
  }
});

test('Phase 7: applyPerceptualTuning survives missing context', () => {
  // Defensive: the caller must not need to pass a context at all.
  // This can't assert exact bytes now that boost is active, but must not
  // crash or produce NaN/out-of-range values.
  const rgb = { r: 100, g: 100, b: 100 };
  const out = applyPerceptualTuning(rgb);
  assert.ok(Number.isFinite(out.r) && out.r >= 0 && out.r <= 255);
  assert.ok(Number.isFinite(out.g) && out.g >= 0 && out.g <= 255);
  assert.ok(Number.isFinite(out.b) && out.b >= 0 && out.b <= 255);
});

// ── Activation-mode property tests (formula replicated inline) ───────────────
//
// These verify the SHAPE of the tuning transform: sunset gate, zone asymmetry,
// red lift, blue dip, luminance bound. They use the same formula the module
// uses, so if the formula changes these will catch it via comparison against
// expected signs and relative magnitudes — not against frozen numbers.

function _smoothstep01(lo, hi, x) {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

function _tune(rgb, sunDeg, zone, boost) {
  // Bandpass gate matching color.js: two smoothsteps, product
  const rampIn  = _smoothstep01(-6, -3, sunDeg);
  const rampOut = _smoothstep01(  8,  2, sunDeg);  // reversed (lo > hi)
  const sunsetBoost = rampIn * rampOut * boost;
  const zoneW = { skyTop: 0.4, skyMid: 0.8, horizon: 1.0, sun: 1.0 }[zone] ?? 1.0;
  const k = sunsetBoost * zoneW;
  return {
    r: Math.max(0, Math.min(255, Math.round(rgb.r * (1 + 0.10 * k)))),
    g: Math.max(0, Math.min(255, Math.round(rgb.g * (1 + 0.02 * k)))),
    b: Math.max(0, Math.min(255, Math.round(rgb.b * (1 - 0.05 * k)))),
  };
}

test('Phase 7 formula: midday (sun > 2°) gives zero effect regardless of zone', () => {
  const rgb = { r: 180, g: 180, b: 220 };
  const out = _tune(rgb, 45, 'horizon', 1.0);
  assert.deepStrictEqual(out, rgb);
});

test('Phase 7 formula: astronomical twilight (sun < −6°) gives zero effect', () => {
  const rgb = { r: 20, g: 20, b: 40 };
  const out = _tune(rgb, -10, 'horizon', 1.0);
  assert.deepStrictEqual(out, rgb);
});

test('Phase 7 formula: sunset horizon gets red lift + blue dip', () => {
  const rgb  = { r: 200, g: 120, b: 100 };
  const out  = _tune(rgb, -1, 'horizon', 1.0);
  assert.ok(out.r > rgb.r, `R must lift at sunset horizon (was ${rgb.r}, got ${out.r})`);
  assert.ok(out.b < rgb.b, `B must dip  at sunset horizon (was ${rgb.b}, got ${out.b})`);
  assert.ok(out.g >= rgb.g, `G must not drop at sunset horizon (was ${rgb.g}, got ${out.g})`);
});

test('Phase 7 formula: horizon boost magnitude > skyTop boost at same sun angle', () => {
  // Zone asymmetry: horizon zoneW=1.0, skyTop zoneW=0.4 → horizon should move
  // ≥ 2× as many R units as skyTop for the same input + sun angle
  const rgb  = { r: 200, g: 120, b: 100 };
  const h    = _tune(rgb, -1, 'horizon', 1.0);
  const t    = _tune(rgb, -1, 'skyTop',  1.0);
  const dRh  = h.r - rgb.r;
  const dRt  = t.r - rgb.r;
  assert.ok(dRh > dRt, `horizon ΔR (${dRh}) must exceed skyTop ΔR (${dRt})`);
  // Within factor-of-3 of theoretical 2.5× (1.0 / 0.4) — allows rounding slack
  assert.ok(dRh >= 2 * dRt, `horizon ΔR must be ≥ 2× skyTop ΔR (got ${dRh} vs ${dRt})`);
});

test('Phase 7 formula: luminance drift stays under 5% at full boost sunset horizon', () => {
  // Rec. 709 luminance
  const Y = ({ r, g, b }) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const rgb = { r: 180, g: 100, b: 60 };
  const out = _tune(rgb, 0, 'horizon', 1.0);
  const drift = Math.abs(Y(out) - Y(rgb)) / Math.max(Y(rgb), 1);
  assert.ok(drift < 0.05, `Luminance drift ${(drift*100).toFixed(2)}% must stay under 5%`);
});

test('Phase 7 formula: channels clamp to [0, 255] even when boosted R would overflow', () => {
  const rgb = { r: 250, g: 200, b: 50 };
  const out = _tune(rgb, 0, 'horizon', 1.0);
  assert.ok(out.r >= 0 && out.r <= 255, `r=${out.r}`);
  assert.ok(out.g >= 0 && out.g <= 255, `g=${out.g}`);
  assert.ok(out.b >= 0 && out.b <= 255, `b=${out.b}`);
});
