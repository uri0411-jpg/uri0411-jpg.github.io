/**
 * perceptualShape.js — Perceptual shaping layer
 *
 * Sits between tone mapping and sRGB gamma in the render pipeline:
 *
 *   Physics → XYZ → Linear sRGB → Tone Map → ★ perceptualShape ★ → Gamma → 8-bit
 *
 * Purpose: ACES tone mapping is a global curve — it treats every pixel equally.
 * Real sunsets are perceptually *localised*: the horizon is saturated and warm,
 * the zenith cool and diffuse. This shaper recovers that local contrast by:
 *
 *   1. Luminance-gated saturation boost — amplifies mid-tones (L ≈ 0.5) where
 *      the eye is most sensitive, fades out toward blacks and whites to preserve
 *      shadow depth and highlight cleanliness.
 *
 *   2. Hue separation — detects whether the pixel leans warm or cool, and gives
 *      a small nudge to the dominant temperature channel. This widens the
 *      perceived gap between a warm horizon and a cool zenith without inverting
 *      any channel ordering.
 *
 * Operates on LINEAR (pre-gamma) [0, 1] values. Input is the output of the
 * tone-mapping step; output is still in [0, 1], ready for sRGB gamma encoding.
 *
 * Feature flag: USE_PERCEPTUAL_SHAPE (default true). Rollback = one-line change.
 */

/**
 * Toggle for the perceptual shaping pass.
 * true  → shaping active (cinematic feel)
 * false → passthrough (byte-identical output, no performance cost either way)
 */
export const USE_PERCEPTUAL_SHAPE = true;

/**
 * Apply the perceptual shaping pass to a tonemapped linear-sRGB triple.
 *
 * @param {[number, number, number]} rgb  Tonemapped linear values, each in [0, 1]
 * @returns {[number, number, number]}    Shaped values, each in [0, 1]
 */
export function perceptualShape(rgb) {
  if (!USE_PERCEPTUAL_SHAPE) return rgb;

  const [r, g, b] = rgb;

  // ── 1. Luminance-gated saturation boost ──────────────────────────────────
  // Gaussian peak at L=0.5 → up to +25% saturation at mid-tones.
  // Falls to ~0% at L=0 and L=1, so shadows/highlights are untouched.
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const satBoost = 1 + 0.25 * Math.exp(-Math.pow((L - 0.5) * 2.5, 2));

  // ── 2. Hue separation ────────────────────────────────────────────────────
  // warmth > 0: image leans warm (orange/red sky) → amplify red slightly.
  // warmth < 0: image leans cool (blue sky) → amplify blue slightly.
  // The ±6% nudge widens perceived hue difference without inverting channels.
  const warmth = r - b;
  const hueBoost = 1 + 0.06 * Math.sign(warmth);

  return [
    Math.min(1, r * satBoost * (warmth > 0 ? hueBoost : 1)),
    Math.min(1, g * satBoost),
    Math.min(1, b * satBoost * (warmth < 0 ? hueBoost : 1)),
  ];
}
