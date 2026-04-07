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
 * Conversion: weighted integration via CIE 1931 2° CMFs → XYZ → linear sRGB
 * (D65 reference, IEC 61966-2-1 matrix) → Reinhard tone map → sRGB gamma.
 *
 * Legacy 3-element mode (backward compat for tests and external callers):
 *   intensities[0]  →  450 nm  →  blue  channel
 *   intensities[1]  →  550 nm  →  green channel
 *   intensities[2]  →  650 nm  →  red   channel
 */

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

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Pre-exposure scale applied before tone mapping.
 *
 * Raw intensities from atmosphere.js are dimensionless values typically in
 * [0.05, 0.95].  Multiplying by EXPOSURE maps them into the region where
 * Reinhard tone mapping (x / (1+x)) produces perceptually meaningful colour
 * differences.  Without this pre-scale the tonemapped values would cluster
 * near zero and the sky would appear very dark.
 *
 * EXPOSURE = 4.0 means that an intensity of 0.8 (bright horizon in clear air)
 * maps to 3.2 before tonemapping → 3.2/4.2 ≈ 0.76 → after gamma ≈ 0.88 → 224.
 * An intensity of 0.2 (dark upper sky) → 0.8 → 0.44 → gamma ≈ 0.67 → 170.
 * This keeps colour distinctions visible across the full sky range.
 */
const EXPOSURE = 4.0;

/**
 * Reinhard tone operator: compresses [0, ∞) → [0, 1).
 * Preserves hue ratios — channels are scaled equally at each intensity level.
 */
function tonemap(v) {
  return v / (1.0 + v);
}

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
    return {
      r: clamp8(gamma(tonemap(iRed   * EXPOSURE)) * 255),
      g: clamp8(gamma(tonemap(iGreen * EXPOSURE)) * 255),
      b: clamp8(gamma(tonemap(iBlue  * EXPOSURE)) * 255),
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

  // Step 4: pre-exposure + Reinhard + sRGB gamma + clamp
  return {
    r: clamp8(gamma(tonemap(Rl * EXPOSURE)) * 255),
    g: clamp8(gamma(tonemap(Gl * EXPOSURE)) * 255),
    b: clamp8(gamma(tonemap(Bl * EXPOSURE)) * 255),
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
