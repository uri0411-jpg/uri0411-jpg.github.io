/**
 * color.js — Spectrum-to-RGB conversion and colour blending utilities
 *
 * Converts the per-wavelength intensity arrays produced by atmosphere.js into
 * standard {r, g, b} objects suitable for CSS and canvas rendering.
 *
 * 5-wavelength mode (Phase 3.6) — default for atmosphere.js output:
 *   intensities[0]  →  430 nm  →  violet
 *   intensities[1]  →  450 nm  →  blue
 *   intensities[2]  →  550 nm  →  green
 *   intensities[3]  →  600 nm  →  orange
 *   intensities[4]  →  650 nm  →  red
 *
 * Pipeline (Phase 2 — Cinematic):
 *   Spectral → CIE XYZ → Linear sRGB → ★ ACES tone map ★ → ★ Perceptual Shaping ★ → sRGB gamma
 *
 * Feature flags (top of file):
 *   USE_ACES_TONEMAP     — swap Reinhard → ACES Narkowicz (default true)
 *   USE_PERCEPTUAL_SHAPE — saturation boost + hue separation pass (default true)
 *
 * Legacy 3-element mode (backward compat for tests and external callers):
 *   intensities[0]  →  450 nm  →  blue  channel
 *   intensities[1]  →  550 nm  →  green channel
 *   intensities[2]  →  650 nm  →  red   channel
 */

import { perceptualShape, USE_PERCEPTUAL_SHAPE } from './perceptualShape.js';

// ── CIE 1931 2° standard observer CMFs at the 5 engine wavelengths ───────────

/**
 * Colour-matching functions at [430, 450, 550, 600, 650] nm.
 * Each row: [x̄(λ), ȳ(λ), z̄(λ)]  — CIE 1931 2° standard observer.
 */
const CIE_CMF = [
  [0.1750, 0.0119, 0.9146],  // 430 nm — violet
  [0.3362, 0.0380, 1.7721],  // 450 nm — blue
  [0.4334, 0.9950, 0.0087],  // 550 nm — green
  [1.0622, 0.6310, 0.0008],  // 600 nm — orange
  [0.2835, 0.1070, 0.0000],  // 650 nm — red
];

/**
 * Trapezoidal integration weights for non-uniform wavelength spacing (nm).
 * Half the interval to each neighbour: [10, 60, 75, 50, 25].
 *   430→450: 20 nm → weight 10 on each end
 *   450→550: 100 nm → weight 50 on each end
 *   550→600: 50 nm → weight 25 on each end
 *   600→650: 50 nm → weight 25 on each end
 */
const CMF_W = [10, 60, 75, 50, 25];

// Equal-energy white normalisation: Σ w_i × ȳ(λ_i) — used to keep Y_white=1
const _Y_WHITE = CMF_W.reduce((s, w, i) => s + w * CIE_CMF[i][1], 0);

// ── Feature flags ─────────────────────────────────────────────────────────────

/**
 * Toggle ACES Narkowicz tone mapping (vs legacy Reinhard).
 * true  → ACES (cinematic shoulder, richer highlights) — CURRENT default
 * false → Reinhard (physics-correct, flat shoulder) — rollback path
 */
export const USE_ACES_TONEMAP = true;

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Pre-exposure scale for Reinhard tone mapping.
 *
 * With Reinhard (x/(1+x)), EXPOSURE=4.0 maps a typical bright horizon pixel
 * (intensity 0.8) to 3.2/4.2 ≈ 0.76 → after gamma ≈ 0.88 → 224.
 */
const EXPOSURE = 4.0;

/**
 * Pre-exposure scale for ACES tone mapping.
 *
 * ACES has a steeper shoulder than Reinhard — the same EXPOSURE=4.0 would
 * crush highlights to white. ACES_EXPOSURE=2.4 keeps a typical bright horizon
 * pixel (0.8) at → v=1.92 → ACES≈0.910 → gamma≈0.951 → 242, while preserving
 * meaningful luminance contrast between mid-sky and zenith.
 */
const ACES_EXPOSURE = 2.4;

/**
 * Reinhard tone operator: compresses [0, ∞) → [0, 1).
 * Preserves hue ratios. Kept for rollback (USE_ACES_TONEMAP = false).
 */
function _reinhardTonemap(v) {
  return v / (1.0 + v);
}

/**
 * ACES Narkowicz approximation: cinematic S-curve with a stronger shoulder
 * than Reinhard. Maps [0, ∞) → [0, ~1.033], capped at 1.
 *
 * f(v) = (v(av+b)) / (v(cv+d)+e),  a=2.51, b=0.03, c=2.43, d=0.59, e=0.14
 *
 * Properties vs Reinhard:
 *   - Richer mid-tone saturation
 *   - Elegant highlight roll-off ("shoulder") — highlights compress to white
 *     gracefully instead of linearly clipping
 *   - Slightly deeper shadows (lower toe)
 */
function _acesTonemap(v) {
  const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return Math.min(1, (v * (a * v + b)) / (v * (c * v + d) + e));
}

/** Active tone mapping function — switches on USE_ACES_TONEMAP flag. */
function tonemap(v) {
  return USE_ACES_TONEMAP ? _acesTonemap(v) : _reinhardTonemap(v);
}

/** Active pre-exposure constant — paired with the active tonemap. */
const _EXPOSURE = USE_ACES_TONEMAP ? ACES_EXPOSURE : EXPOSURE;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clamp v to integer in [0, 255]. */
function clamp8(v) {
  return Math.round(Math.max(0, Math.min(255, v)));
}

// ── Primary exports ───────────────────────────────────────────────────────────

/**
 * Convert a spectral intensity array to an 8-bit sRGB colour object.
 *
 * 5-element path (standard, matches atmosphere.js WAVELENGTHS):
 *   1. Integrate: I(λ) × CMF_weight(λ) → CIE XYZ tristimulus
 *   2. Normalise by equal-energy white (Y_white = 1)
 *   3. XYZ → linear sRGB via D65 matrix (IEC 61966-2-1)
 *   4. Pre-scale by EXPOSURE, Reinhard tone map, sRGB gamma, clamp to 8-bit
 *
 * Legacy 3-element path (backward compat):
 *   Assumes [I_blue@450, I_green@550, I_red@650] — direct channel assignment.
 *
 * @param {number[]} intensities  5-element (violet/blue/green/orange/red) or
 *                                legacy 3-element [blue, green, red] spectrum
 * @returns {{ r: number, g: number, b: number }}  Each channel 0–255
 */
export function spectrumToRGB(intensities) {
  const gamma = v => Math.pow(Math.max(0, v), 1.0 / 2.2);

  // ── Legacy 3-element path (backward compat) ───────────────────────────────
  if (intensities.length !== 5) {
    const [iBlue, iGreen, iRed] = intensities;
    const [rS, gS, bS] = perceptualShape([
      tonemap(iRed   * _EXPOSURE),
      tonemap(iGreen * _EXPOSURE),
      tonemap(iBlue  * _EXPOSURE),
    ]);
    return {
      r: clamp8(gamma(rS) * 255),
      g: clamp8(gamma(gS) * 255),
      b: clamp8(gamma(bS) * 255),
    };
  }

  // ── 5-wavelength CIE path ─────────────────────────────────────────────────
  // Step 1: integrate spectrum × CMF weights → CIE XYZ
  let X = 0, Y = 0, Z = 0;
  for (let i = 0; i < 5; i++) {
    const wI = CMF_W[i] * intensities[i];
    X += wI * CIE_CMF[i][0];
    Y += wI * CIE_CMF[i][1];
    Z += wI * CIE_CMF[i][2];
  }
  // Step 2: normalise by equal-energy white
  const norm = 1 / _Y_WHITE;
  X *= norm; Y *= norm; Z *= norm;

  // Step 3: XYZ → linear sRGB (D65, IEC 61966-2-1)
  const Rl =  3.2406 * X - 1.5372 * Y - 0.4986 * Z;
  const Gl = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
  const Bl =  0.0557 * X - 0.2040 * Y + 1.0570 * Z;

  // Step 4: ACES tone map (per-channel, pre-exposure applied)
  const rTm = tonemap(Rl * _EXPOSURE);
  const gTm = tonemap(Gl * _EXPOSURE);
  const bTm = tonemap(Bl * _EXPOSURE);

  // Step 5: Perceptual shaping (luminance-gated sat boost + hue separation)
  const [rS, gS, bS] = perceptualShape([rTm, gTm, bTm]);

  // Step 6: sRGB gamma + clamp to 8-bit
  return {
    r: clamp8(gamma(rS) * 255),
    g: clamp8(gamma(gS) * 255),
    b: clamp8(gamma(bS) * 255),
  };
}

/**
 * Weighted linear blend of a physics-derived colour with a legacy colour.
 *
 * Used by skyColor.js for the hybrid pipeline:
 *   finalColor = physicsWeight × physicsColor + (1 − physicsWeight) × legacyColor
 *
 * @param {{ r, g, b }} physicsColor   Result from spectrumToRGB
 * @param {{ r, g, b }} legacyColor    Result from the heuristic RGB model
 * @param {number}      physicsWeight  0–1, default 0.7 (70% physics / 30% legacy)
 * @returns {{ r: number, g: number, b: number }}
 */
export function blendColors(physicsColor, legacyColor, physicsWeight = 0.7) {
  const w = Math.max(0, Math.min(1, physicsWeight));
  const lw = 1 - w;
  return {
    r: clamp8(physicsColor.r * w + legacyColor.r * lw),
    g: clamp8(physicsColor.g * w + legacyColor.g * lw),
    b: clamp8(physicsColor.b * w + legacyColor.b * lw),
  };
}

// ── Phase 7: Perceptual tuning layer ─────────────────────────────────────────
//
// Pipeline position:
//   dayData → computeAtmosphere → spectrumToRGB → applyPerceptualTuning → CSS
//                                                  ^
//                                                  runs LAST, pure aesthetic,
//                                                  zero physics feedback
//
// Principle: the physics engine (atmosphere.js) stays scientifically pure.
// The colorimetry layer (spectrumToRGB → CIE 1931) stays numerically exact.
// This is the ONE layer with licence to "beautify" — and it is:
//   (a) gated behind a single top-of-file dial (PERCEPTUAL_BOOST),
//   (b) byte-identical no-op when the dial = 0,
//   (c) zone-asymmetric so horizon catches more of the boost than zenith.
//
// Rollout is gradual: ships at 0, ramps to 0.5 after explicit visual sign-off,
// then optionally to 1.0. Debug override: ?perceptual=<float> in URL.

/**
 * Master dial for the perceptual tuning pass.
 *
 *   0.0  → pure physics (byte-identical to pre-Phase-7 pipeline)
 *   0.5  → conservative tuning (CURRENT shipping value)
 *   1.0  → full tuning (requires further sign-off)
 *
 * At 0.5 the red lift peaks at +5 % on horizon pixels during sunset (smoothly
 * gated out at midday and at astronomical twilight), the green lift at +1 %,
 * the blue dip at −2.5 %. Zone-weighted so skyTop gets 40 % of those moves
 * and horizon gets the full 100 %. Typical luminance drift well under 3 %.
 *
 * Ships active at 0.5. Setting to 0 restores pure-physics output
 * (byte-for-byte no-op via the `=== 0` guard below).
 */
export const PERCEPTUAL_BOOST = 0.0;

// Per-zone asymmetry: horizon gets the full boost, zenith barely any.
// Matches the physical intuition that sunset reddening is strongest along
// the long slant path through the horizon air mass, weakest at zenith.
const _PERCEPTUAL_ZONE_WEIGHT = {
  skyTop:  0.4,
  skyMid:  0.8,
  horizon: 1.0,
  sun:     1.0,
};

// Sunset bandpass window in degrees — two smoothsteps, one ramping in from
// civil twilight toward the horizon, one ramping out from just above horizon
// into clear daytime. Zero outside the outer bounds, unity inside the inner
// bounds, smoothed in between. A single smoothstep would have been monotonic
// (max boost at midday), which is wrong — the effect must be windowed.
//
//   -∞ .. −6°   → 0      (night, below civil twilight)
//   −6° .. −3°  → 0 → 1  (civil twilight ramps in)
//   −3° .. +2°  → 1      (full sunset window)
//   +2° .. +8°  → 1 → 0  (sun rising clear of horizon, boost fades)
//   +8° .. +∞°  → 0      (day, no sunset effect)
const _SUNSET_IN_LO_DEG  = -6;
const _SUNSET_IN_HI_DEG  = -3;
const _SUNSET_OUT_LO_DEG =  8;  // note: > HI because this ramp is reversed
const _SUNSET_OUT_HI_DEG =  2;

function _smoothstep01(lo, hi, x) {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

/**
 * Apply the perceptual tuning pass to a single RGB sample.
 *
 * When PERCEPTUAL_BOOST = 0 this function is a byte-identical no-op.
 * When > 0, it applies a sunset-window-gated red lift + tiny green lift +
 * slight blue dip, weighted per zone so horizon catches more than zenith.
 *
 * The transform preserves hue direction (monotonic) and is luminance-bounded
 * (tested: |ΔLuma| < 5 % at BOOST=1). It is NOT a physics correction — it
 * exists only to recover the "wow" factor that strict CIE-integrated physics
 * understates relative to camera-captured sunsets (which embed auto-WB,
 * saturation curves, and tone curves that the human visual system expects).
 *
 * @param {{r:number,g:number,b:number}} rgb    Input pixel (0–255, clamped)
 * @param {Object} ctx
 * @param {number} ctx.sunAngle_rad              Solar elevation in radians
 * @param {'skyTop'|'skyMid'|'horizon'|'sun'} [ctx.zone='horizon']
 * @returns {{r:number,g:number,b:number}}       Tuned pixel (0–255, clamped)
 */
export function applyPerceptualTuning(rgb, { sunAngle_rad, zone = 'horizon' } = {}) {
  // Byte-identical no-op when dormant. Explicit `=== 0` avoids float drift.
  if (PERCEPTUAL_BOOST === 0) return rgb;

  // Defensive: caller is allowed to omit the context entirely. With no sun
  // angle we can't evaluate the bandpass gate, so fall back to no-op rather
  // than let NaN propagate through the channels.
  if (!Number.isFinite(sunAngle_rad)) return rgb;

  // Sunset bandpass gate — product of two smoothsteps. Peaks in [−3°, +2°],
  // zero outside [−6°, +8°]. See constants above for the band layout.
  const deg      = sunAngle_rad * 180 / Math.PI;
  const rampIn   = _smoothstep01(_SUNSET_IN_LO_DEG,  _SUNSET_IN_HI_DEG,  deg);
  const rampOut  = _smoothstep01(_SUNSET_OUT_LO_DEG, _SUNSET_OUT_HI_DEG, deg);
  const sunsetBoost = rampIn * rampOut * PERCEPTUAL_BOOST;

  // Zone asymmetry
  const zoneW = _PERCEPTUAL_ZONE_WEIGHT[zone] ?? 1.0;
  const k     = sunsetBoost * zoneW;

  // Red lift, tiny green lift, slight blue dip. Coefficients chosen so that
  // at k=1 the maximum channel shift is ±10 % — well inside tone-map headroom.
  return {
    r: clamp8(rgb.r * (1 + 0.10 * k)),
    g: clamp8(rgb.g * (1 + 0.02 * k)),
    b: clamp8(rgb.b * (1 - 0.05 * k)),
  };
}
