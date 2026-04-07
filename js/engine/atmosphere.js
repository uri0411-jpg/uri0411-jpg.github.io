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
 * direct-transmittance component in different proportions that vary with solar
 * elevation (see zoneMixRatios):
 *
 *   skyTop  : Rayleigh-dominant  → deep blue / violet
 *   skyMid  : blended transition → warm pink / amber
 *   horizon : transmittance-dominant → orange / red at sunset
 *   sun     : 100% direct (extra path) → reddened disk
 *
 * Air-mass model: Kasten-Young 1989 (imported from physicsLayer.js) with a
 * smooth exponential extension below the horizon to capture civil-twilight
 * purple/violet scatter (0° to −6°).
 *
 * Ozone: stratospheric Chappuis-band absorption (300 DU, Israel climatology)
 * selectively attenuates 500–700 nm, reinforcing the blue/violet twilight arch.
 *
 * References:
 *   Rayleigh optical depth coefficients — Bodhaine et al. (1999), simplified
 *   Beer-Lambert law — standard atmospheric optics
 *   Air mass — Kasten & Young (1989) via physicsLayer.js
 */

import { airMass as kastenyoungAirMass } from './physicsLayer.js';

// ── Wavelengths ───────────────────────────────────────────────────────────────

/**
 * Sample wavelengths in micrometres: [violet, blue, green, orange, red]
 *
 * Expanding from 3 to 5 wavelengths (Phase 3.6) adds:
 *   430 nm (violet) — Rayleigh-dominant, enhances Belt-of-Venus purple
 *   600 nm (orange) — Chappuis-band peak, discriminates orange from red glow
 *
 * Pass output arrays to color.js:spectrumToRGB() for XYZ→sRGB conversion.
 */
const WAVELENGTHS = [0.430, 0.450, 0.550, 0.600, 0.650];

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
 * Mie scattering optical depth per unit air mass at wavelength λ.
 *
 * The Ångström exponent (α) describes spectral dependence of aerosol extinction:
 *   β_M(λ) = 0.05 · turbidity · (0.55 / λ)^α
 *
 *   α ≈ 0   → wavelength-independent (coarse dust, sea salt)   → white/grey haze
 *   α ≈ 1.5 → strong wavelength dependence (fine smoke/urban)  → blue-tinted haze
 *
 * When angstromExp = 0 (default) the formula reduces to the previous
 * wavelength-independent value, preserving backward compatibility.
 *
 * @param {number} lambda_um    Wavelength in µm
 * @param {number} turbidity    Aerosol loading index 0–1 (from physicsLayer.js)
 * @param {number} [angstromExp=0]  Ångström exponent α (from PM2.5/PM10 ratio)
 * @returns {number} β_M(λ) — Mie optical depth per air mass unit
 */
function mieBeta(lambda_um, turbidity, angstromExp = 0) {
  return 0.05 * turbidity * Math.pow(0.55 / lambda_um, angstromExp);
}

// Normalization anchor: β_R at 450 nm (maximum Rayleigh coefficient)
const K_R_MAX = rayleighBeta(0.450); // ≈ 0.01942

// ── Air mass ──────────────────────────────────────────────────────────────────

/**
 * Compute relative air mass from solar elevation angle.
 *
 * Delegates to physicsLayer.js:airMass (Kasten-Young 1989) for elevations
 * at or above the horizon.  For sub-horizon elevations (civil twilight,
 * 0° to −6°) a smooth exponential continuation is applied so that scattered
 * light reaching the upper atmosphere is modelled:
 *
 *   m(0°)  ≈ 28   (Kasten-Young horizon value)
 *   m(−3°) ≈ 44
 *   m(−6°) ≈ 64   → enables purple-violet Belt-of-Venus colours
 *
 * @param {number} sunAngle_rad  Solar elevation in radians (negative = below horizon)
 * @returns {number}  Dimensionless air mass m ≥ 1
 */
function computeAirmass(sunAngle_rad) {
  const deg = sunAngle_rad * (180 / Math.PI);
  if (deg >= 0) {
    // Above horizon — Kasten-Young 1989 (same formula as physicsLayer.js)
    return kastenyoungAirMass(deg);
  }
  if (deg >= -6) {
    // Civil twilight — smooth exponential continuation from horizon value
    const horizonM = kastenyoungAirMass(0);
    return horizonM * Math.exp(-sunAngle_rad / (1.5 * Math.PI / 180));
  }
  // Astronomical / nautical twilight and below — sky effectively dark
  return 80;
}

// ── Ozone Chappuis absorption ─────────────────────────────────────────────────

/**
 * Stratospheric ozone (O₃) Chappuis band absorption transmittance.
 *
 * The Chappuis bands (500–700 nm, peak ~600 nm) absorb orange–red wavelengths.
 * This differential absorption relative to blue (450 nm, near-zero absorption)
 * is the primary physical cause of the blue-violet twilight arch and Belt-of-Venus
 * tint seen 5–10° above the anti-solar horizon after sunset.
 *
 * Parameterisation:
 *   σ(λ) = σ_max × exp( −½ ((λ − λ_peak) / w)² )   Gaussian fit to Chappuis peak
 *   T_O3  = exp( −σ(λ) × [O₃] )
 *
 *   σ_max  = 0.02  (relative, normalised units)
 *   λ_peak = 0.600 µm
 *   w      = 0.080 µm  (Gaussian width)
 *   [O₃]   = ozoneDU × 1e-3  (scaled column density)
 *
 * At a vertical column of 300 DU (Israel spring/summer climatology):
 *   T(450 nm) ≈ 0.999  →  blue essentially unaffected
 *   T(550 nm) ≈ 0.995  →  green mildly attenuated
 *   T(600 nm) ≈ 0.994  →  orange slightly reduced
 *
 * The effect is applied to every wavelength in every sky zone and compounds
 * with the Rayleigh + Mie Beer-Lambert attenuation, reinforcing the blue/violet
 * excess in the upper sky especially at high air mass (low solar elevation).
 *
 * @param {number} lambda_um      Wavelength in µm
 * @param {number} [ozoneDU=300]  Total ozone column in Dobson Units
 * @returns {number} Transmittance factor in (0, 1]
 */
function chappuisAbsorption(lambda_um, ozoneDU = 300) {
  const peak     = 0.600;
  const width    = 0.080;
  const sigmaMax = 0.02;
  const sigma = sigmaMax * Math.exp(-0.5 * Math.pow((lambda_um - peak) / width, 2));
  return Math.exp(-sigma * ozoneDU * 1e-3);
}

// ── Beer-Lambert transmittance ────────────────────────────────────────────────

/**
 * Combined atmospheric transmittance: Rayleigh + Mie (Beer-Lambert) × Chappuis (O₃).
 *   T(λ, m) = exp( −(β_R(λ) + β_M(λ)) × m ) × T_O3(λ)
 *
 * At m=1 (overhead, clean air)  T ≈ 0.97  (almost unattenuated)
 * At m=28 (near-horizon, clean) T(450nm) ≈ 0.58, T(650nm) ≈ 0.75  → blue depleted
 * At m=28, turbidity=0.5        T(450nm) ≈ 0.27  (heavy haze, very red horizon)
 *
 * The Chappuis term adds a wavelength-selective correction that slightly
 * enhances the blue channel relative to orange/red — a physically correct
 * contribution to the twilight blue arch.
 *
 * @param {number} lambda_um      Wavelength in µm
 * @param {number} airmass        Optical path length m
 * @param {number} turbidity      Mie loading 0–1
 * @param {number} [angstromExp]  Ångström exponent for spectral Mie (default 0)
 * @param {number} [ozoneDU]      Stratospheric ozone column in Dobson Units (default 300)
 * @returns {number} Transmittance in [0, 1]
 */
function transmittance(lambda_um, airmass, turbidity, angstromExp = 0, ozoneDU = 300) {
  const tau = (rayleighBeta(lambda_um) + mieBeta(lambda_um, turbidity, angstromExp)) * airmass;
  return Math.exp(-tau) * chappuisAbsorption(lambda_um, ozoneDU);
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
 * @param {number}   airmass        Optical path length m
 * @param {number}   turbidity      Mie loading 0–1
 * @param {number}   scatterFrac    Weight for Rayleigh scatter (0–1)
 * @param {number}   directFrac     Weight for direct transmittance (0–1)
 * @param {number}   [angstromExp]  Ångström exponent for spectral Mie (default 0)
 * @param {number}   [ozoneDU]      Stratospheric ozone column in Dobson Units (default 300)
 * @returns {number[]} [I_blue, I_green, I_red]
 */
function zoneIntensities(airmass, turbidity, scatterFrac, directFrac, angstromExp = 0, ozoneDU = 300) {
  return WAVELENGTHS.map(lambda => {
    const T = transmittance(lambda, airmass, turbidity, angstromExp, ozoneDU);
    // Rayleigh scatter normalised to blue channel = 1.0
    const scatterNorm = (rayleighBeta(lambda) / K_R_MAX) * T;
    const single = scatterFrac * scatterNorm + directFrac * T;
    // ── Multiple scattering correction (Phase 3.2) ────────────────────────────
    // Single-scattering models underestimate brightness at high aerosol optical
    // depth (AOD).  At τ_Mie ≈ 1 (heavy haze / dust), first-order multiple
    // scatter augments the single-scatter radiance by ~30%.
    //   I_total ≈ I_single × (1 + τ_Mie × 0.30)
    // Reference: two-stream approximation, e.g. Chandrasekhar (1960) §5.
    // Effect is negligible for clean air (turbidity < 0.2, τ_Mie < 0.05)
    // and significant for heavy dust (turbidity > 0.5, τ_Mie > 0.5).
    const tauMie = mieBeta(lambda, turbidity, angstromExp) * airmass;
    return single * (1 + tauMie * 0.30);
  });
}

// ── Elevation-dependent zone mixing ratios ────────────────────────────────────

/**
 * Compute scatter/direct mixing fractions for each sky zone as a function of
 * solar elevation.
 *
 * As the sun approaches the horizon (horizonFrac → 1) the direct-transmittance
 * component grows relative to Rayleigh scatter, producing the characteristic
 * warm orange/red horizon glow.  At high solar elevations scatter dominates
 * everywhere and the sky is uniformly blue.
 *
 * @param {number} sunAngle_rad  Solar elevation in radians
 * @returns {{ skyTop, skyMid, horizon }} each as { s: scatterFrac, d: directFrac }
 */
function zoneMixRatios(sunAngle_rad) {
  // 0 at zenith (sun overhead), 1 at horizon and below
  const horizonFrac = Math.max(0, 1 - sunAngle_rad / (Math.PI / 2));
  return {
    skyTop:  { s: 0.92 - 0.05 * horizonFrac, d: 0.08 + 0.05 * horizonFrac },
    skyMid:  { s: 0.55 - 0.20 * horizonFrac, d: 0.45 + 0.20 * horizonFrac },
    horizon: { s: 0.10 - 0.08 * horizonFrac, d: 0.90 + 0.08 * horizonFrac },
  };
}

// ── LRU Cache ─────────────────────────────────────────────────────────────────

/**
 * Least-recently-used cache for atmosphere computations.
 *
 * During the 30-second live-update loop the solar elevation changes by only
 * ~0.008°/s, meaning successive calls often share the same rounded key.
 * A single-entry cache is invalidated on every tiny parameter drift; an
 * 8-entry LRU retains the last several distinct (angle, turbidity, angstrom,
 * ozone) combinations — covering all 8 canvas stops plus the score pipeline
 * in a single render cycle without recomputing.
 */
const LRU_MAX = 8;
const _lruCache = new Map(); // insertion order = LRU order

function _cacheGet(key) {
  if (!_lruCache.has(key)) return null;
  // Re-insert to mark as most recently used
  const val = _lruCache.get(key);
  _lruCache.delete(key);
  _lruCache.set(key, val);
  return val;
}

function _cacheSet(key, value) {
  if (_lruCache.has(key)) _lruCache.delete(key);
  else if (_lruCache.size >= LRU_MAX) {
    // Evict oldest entry (first key in insertion order)
    _lruCache.delete(_lruCache.keys().next().value);
  }
  _lruCache.set(key, value);
}

// ── Primary export ────────────────────────────────────────────────────────────

/**
 * Compute physically-based sky radiance for four vertical zones.
 *
 * Results are returned as raw per-wavelength intensities in [0, ~1].
 * Pass each zone through color.js `spectrumToRGB()` to get 0–255 RGB values.
 *
 * Zone mixing ratios vary with solar elevation (see zoneMixRatios): near the
 * horizon the direct-transmittance component dominates, producing warm orange/
 * red; at high elevations Rayleigh scatter dominates, producing deep blue.
 *
 * @param {number} sunAngle_rad       Solar elevation in radians (negative = below horizon)
 * @param {number} turbidity          Aerosol loading 0–1 (from physicsLayer.computeScattering)
 * @param {number} [angstromExp=0]    Ångström exponent α from PM2.5/PM10 ratio.
 *                                    0 = pure dust (white haze), 1.5 = fine smoke (tinted haze).
 * @param {number} [ozoneDU=300]      Stratospheric ozone column in Dobson Units.
 *                                    Pass LOCATION_CLIMATE.ozoneDU for location-aware accuracy.
 * @returns {{
 *   skyTop:   number[],   // [I_blue, I_green, I_red] — zenith zone
 *   skyMid:   number[],   // transition zone
 *   horizon:  number[],   // near-horizon zone
 *   sun:      number[],   // sun disk (direct only, slightly more extinction)
 *   airmass:  number,     // computed air mass for reference / debug
 *   turbidity: number,
 *   wavelengths: number[] // λ values [0.43, 0.45, 0.55, 0.60, 0.65] µm for reference
 * }}
 */
export function computeAtmosphere(sunAngle_rad, turbidity, angstromExp = 0, ozoneDU = 300) {
  // ── Cache lookup ──────────────────────────────────────────────────────────
  const cacheKey = `${sunAngle_rad.toFixed(3)}_${turbidity.toFixed(3)}_${angstromExp.toFixed(2)}_${ozoneDU}`;
  const cached = _cacheGet(cacheKey);
  if (cached) return cached;

  // ── Air mass ──────────────────────────────────────────────────────────────
  const m = computeAirmass(sunAngle_rad);

  // ── Elevation-dependent mixing ratios ─────────────────────────────────────
  const mix = zoneMixRatios(sunAngle_rad);

  // ── Zone colours ──────────────────────────────────────────────────────────
  const result = {
    skyTop:    zoneIntensities(m,        turbidity, mix.skyTop.s,  mix.skyTop.d,  angstromExp, ozoneDU),
    skyMid:    zoneIntensities(m,        turbidity, mix.skyMid.s,  mix.skyMid.d,  angstromExp, ozoneDU),
    horizon:   zoneIntensities(m,        turbidity, mix.horizon.s, mix.horizon.d, angstromExp, ozoneDU),
    sun:       zoneIntensities(m * 1.02, turbidity, 0.00,          1.00,          angstromExp, ozoneDU),
    airmass:   m,
    turbidity,
    wavelengths: WAVELENGTHS,
  };

  // ── Cache store ───────────────────────────────────────────────────────────
  _cacheSet(cacheKey, result);
  return result;
}

/**
 * Invalidate the LRU cache.
 * Optional — the cache auto-evicts stale entries; call only when you want
 * to force a full recompute (e.g. after a turbidity step-change).
 */
export function clearAtmosphereCache() {
  _lruCache.clear();
}
