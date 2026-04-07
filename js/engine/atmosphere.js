/**
 * atmosphere.js — Physically-based atmospheric light scattering engine
 *
 * Replaces empirical RGB heuristics with a genuine single-scattering model:
 *
 *   Rayleigh scattering  ∝ 1/λ⁴   → blue/violet in clean air
 *   Mie scattering       ≈ const   → wavelength-independent (aerosols / dust)
 *   Beer-Lambert law     T = exp(−τ·m)   → attenuation along the optical path
 *
 * Three sample wavelengths capture the visible spectrum with minimal overhead:
 *   450 nm → blue channel
 *   550 nm → green channel
 *   650 nm → red channel
 *
 * Four sky zones are modelled by mixing a Rayleigh-scatter component with a
 * direct-transmittance component in different proportions:
 *
 *   skyTop  : 90% scatter + 10% direct   → Rayleigh-dominant, deep blue
 *   skyMid  : 55% scatter + 45% direct   → warm transition
 *   horizon : 10% scatter + 90% direct   → transmittance-dominant, orange/red
 *   sun     : 100% direct (extra path)   → reddened disk
 *
 * References:
 *   Rayleigh optical depth coefficients — Bodhaine et al. (1999), simplified
 *   Beer-Lambert law — standard atmospheric optics
 */

// ── Wavelengths ───────────────────────────────────────────────────────────────

/** Sample wavelengths in micrometres: [blue, green, red] */
const WAVELENGTHS = [0.450, 0.550, 0.650];

// ── Scattering coefficients ───────────────────────────────────────────────────

/**
 * Rayleigh scattering optical depth per unit air mass at wavelength λ.
 * Coefficient 0.0087 is the reference value at λ=0.55 µm.
 * Scales as λ⁻⁴ — blue scatters ~4.4× more strongly than red.
 *
 * @param {number} lambda_um  Wavelength in micrometres
 * @returns {number} β_R(λ) — Rayleigh optical depth per air mass unit
 */
function rayleighBeta(lambda_um) {
  return 0.0087 * Math.pow(0.55 / lambda_um, 4);
}

/**
 * Mie scattering optical depth per unit air mass.
 * Mie scattering is approximately wavelength-independent for particles much
 * larger than visible light wavelengths (dust, aerosols, humidity droplets).
 * Turbidity is the primary driver; coefficient 0.05 is tuned so that
 * turbidity=1 roughly doubles total extinction at the horizon.
 *
 * @param {number} turbidity  Aerosol loading index 0–1 (from physicsLayer.js)
 * @returns {number} β_M — Mie optical depth per air mass unit
 */
function mieBeta(turbidity) {
  return 0.05 * turbidity;
}

// Normalization anchor: β_R at 450 nm (maximum Rayleigh coefficient)
const K_R_MAX = rayleighBeta(0.450); // ≈ 0.01942

// ── Air mass ──────────────────────────────────────────────────────────────────

/**
 * Compute relative air mass from solar elevation angle.
 *
 * Simple plane-parallel approximation:
 *   m = 1 / sin(elevation)  ≡  1 / cos(zenith angle)
 *
 * Per the user specification this is the accepted formula.  A minimum
 * elevation clamp of ~2° (sin ≈ 0.035) prevents the singularity at the
 * horizon and caps m at ≈ 28, which is representative of real astronomical
 * refraction limits.
 *
 * @param {number} sunAngle_rad  Solar elevation in radians (positive = above horizon)
 * @returns {number}  Dimensionless air mass m ≥ 1
 */
function computeAirmass(sunAngle_rad) {
  const sinEl = Math.sin(sunAngle_rad);
  // Clamp denominator: below ~2° elevation use m ≈ 28 (horizon approximation)
  return 1.0 / Math.max(sinEl, 0.035);
}

// ── Beer-Lambert transmittance ────────────────────────────────────────────────

/**
 * Beer-Lambert transmittance: fraction of solar irradiance surviving the path.
 *   T(λ, m) = exp( −(β_R(λ) + β_M) × m )
 *
 * At m=1 (overhead, clean air)  T ≈ 0.97  (almost unattenuated)
 * At m=28 (near-horizon, clean) T(450nm) ≈ 0.58, T(650nm) ≈ 0.75  → blue depleted
 * At m=28, turbidity=0.5        T(450nm) ≈ 0.27  (heavy haze, very red horizon)
 *
 * @param {number} lambda_um  Wavelength in µm
 * @param {number} airmass    Optical path length m
 * @param {number} turbidity  Mie loading 0–1
 * @returns {number} Transmittance in [0, 1]
 */
function transmittance(lambda_um, airmass, turbidity) {
  const tau = (rayleighBeta(lambda_um) + mieBeta(turbidity)) * airmass;
  return Math.exp(-tau);
}

// ── Zone intensity computation ────────────────────────────────────────────────

/**
 * Compute per-wavelength intensities for a single sky zone.
 *
 * Two additive components are mixed by (scatterFrac, directFrac):
 *
 * 1. Scatter component — Rayleigh-weighted transmittance:
 *      scatter_norm(λ) = (β_R(λ) / β_R_max) × T(λ)
 *    Represents light scattered *into* the view direction from the sun beam.
 *    The β_R normalisation makes blue = 1.0 at all conditions so that the
 *    hue relationship between wavelengths is preserved relative to the
 *    brightest scatter channel (blue at 450 nm).
 *
 * 2. Direct component — pure Beer-Lambert transmittance:
 *      direct(λ) = T(λ)
 *    Represents direct sun / forward-scattered light in the horizon glow.
 *    At high air mass blue is strongly attenuated → warm orange/red.
 *
 * At sunset (high airmass):
 *   - scatter: blue still dominant in ratio, but both components are dim
 *   - direct:  red > green >> blue  → orange glow dominates horizon
 *
 * @param {number}   airmass      Optical path length m
 * @param {number}   turbidity    Mie loading 0–1
 * @param {number}   scatterFrac  Weight for Rayleigh scatter (0–1)
 * @param {number}   directFrac   Weight for direct transmittance (0–1)
 * @returns {number[]} [I_blue, I_green, I_red]
 */
function zoneIntensities(airmass, turbidity, scatterFrac, directFrac) {
  return WAVELENGTHS.map(lambda => {
    const T = transmittance(lambda, airmass, turbidity);
    // Rayleigh scatter normalised to blue channel = 1.0
    const scatterNorm = (rayleighBeta(lambda) / K_R_MAX) * T;
    return scatterFrac * scatterNorm + directFrac * T;
  });
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/** Single-entry cache — avoids recomputing identical (angle, turbidity) pairs. */
let _cache = null;

// ── Primary export ────────────────────────────────────────────────────────────

/**
 * Compute physically-based sky radiance for four vertical zones.
 *
 * Results are returned as raw per-wavelength intensities in [0, ~1].
 * Pass each zone through color.js `spectrumToRGB()` to get 0–255 RGB values.
 *
 * @param {number} sunAngle_rad  Solar elevation in radians (negative = below horizon)
 * @param {number} turbidity     Aerosol loading 0–1 (from physicsLayer.computeScattering)
 * @returns {{
 *   skyTop:   number[],   // [I_blue, I_green, I_red] — zenith zone
 *   skyMid:   number[],   // transition zone
 *   horizon:  number[],   // near-horizon zone
 *   sun:      number[],   // sun disk (direct only, slightly more extinction)
 *   airmass:  number,     // computed air mass for reference / debug
 *   turbidity: number,
 *   wavelengths: number[] // λ values [0.45, 0.55, 0.65] µm for reference
 * }}
 */
export function computeAtmosphere(sunAngle_rad, turbidity) {
  // ── Cache lookup ──────────────────────────────────────────────────────────
  const cacheKey = `${sunAngle_rad.toFixed(3)}_${turbidity.toFixed(3)}`;
  if (_cache && _cache.key === cacheKey) return _cache.result;

  // ── Air mass ──────────────────────────────────────────────────────────────
  const m = computeAirmass(sunAngle_rad);

  // ── Zone colours ──────────────────────────────────────────────────────────
  // Mixing ratios (scatterFrac, directFrac):
  //   skyTop  → mostly Rayleigh scatter → stays blue even at sunset
  //   skyMid  → blended transition
  //   horizon → dominated by direct transmittance → reddened at sunset
  //   sun     → pure direct path, 2% extra extinction models limb darkening

  const result = {
    skyTop:    zoneIntensities(m,        turbidity, 0.90, 0.10),
    skyMid:    zoneIntensities(m,        turbidity, 0.55, 0.45),
    horizon:   zoneIntensities(m,        turbidity, 0.10, 0.90),
    sun:       zoneIntensities(m * 1.02, turbidity, 0.00, 1.00),
    airmass:   m,
    turbidity,
    wavelengths: WAVELENGTHS,
  };

  // ── Cache store ───────────────────────────────────────────────────────────
  _cache = { key: cacheKey, result };
  return result;
}

/**
 * Invalidate the internal cache.
 * Call this if turbidity changes between frames (optional — cache auto-updates).
 */
export function clearAtmosphereCache() {
  _cache = null;
}
