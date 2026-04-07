/**
 * color.js — Spectrum-to-RGB conversion and colour blending utilities
 *
 * Converts the per-wavelength intensity arrays produced by atmosphere.js into
 * standard {r, g, b} objects suitable for CSS and canvas rendering.
 *
 * Wavelength order convention (matches atmosphere.js WAVELENGTHS array):
 *   intensities[0]  →  450 nm  →  blue  channel
 *   intensities[1]  →  550 nm  →  green channel
 *   intensities[2]  →  650 nm  →  red   channel
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Absolute brightness scale factor.
 *
 * The raw intensities from atmosphere.js are dimensionless values in roughly
 * [0, 1].  Multiplying by 255 maps the full physical range to the 8-bit RGB
 * space without per-zone renormalisation.  This preserves brightness
 * differences across zones (horizon > mid > zenith) rather than flattening
 * them to equal peak values.
 *
 * Overflow is clamped at 255 so hot pixels (direct sun, near-overhead midday)
 * saturate cleanly.
 */
const RGB_SCALE = 255;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Clamp v to integer in [0, 255]. */
function clamp8(v) {
  return Math.round(Math.max(0, Math.min(255, v)));
}

// ── Primary exports ───────────────────────────────────────────────────────────

/**
 * Convert a three-element intensity spectrum to an RGB colour object.
 *
 * @param {number[]} intensities  [I_blue, I_green, I_red] from computeAtmosphere
 * @returns {{ r: number, g: number, b: number }}  Each channel 0–255
 */
export function spectrumToRGB(intensities) {
  const [iBlue, iGreen, iRed] = intensities;
  return {
    r: clamp8(iRed   * RGB_SCALE),
    g: clamp8(iGreen * RGB_SCALE),
    b: clamp8(iBlue  * RGB_SCALE),
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
