/**
 * skyColor.js — Sky colour pipeline (physics + hybrid fallback)
 *
 * Primary path (default):
 *   computeSkyColor() → atmosphere.js (Rayleigh/Mie, wavelength-based)
 *                     → color.js (spectrum → RGB)
 *                     → blended 70% physics + 30% legacy
 *
 * Legacy path (fallback, still used for the 30% blend):
 *   computeSkyColorLegacy() — original empirical RGB offsets, preserved verbatim
 *
 * Configuration:
 *   PHYSICS_WEIGHT    default 0.7  (70 % physics, 30 % legacy)
 *   hybridMode        default true  — set false for 100 % physics
 *   setHybridMode(b)  programmatic toggle (e.g. for A/B testing)
 *
 * Backward-compatible interface:
 *   computeSkyColor({ solarElevation, airMass, turbidity,
 *                     mieIntensity, rayleighSpread, humidity })
 *   → { skyTop, skyMid, horizon, sun }  — same return shape as before
 *
 * Physics references:
 *   Rayleigh scattering ∝ 1/λ⁴  → see atmosphere.js
 *   Beer-Lambert attenuation     → see atmosphere.js
 *   Twilight purple shift        → legacy heuristic retained in legacy path
 */

import { computeAtmosphere }      from './atmosphere.js';
import { spectrumToRGB, blendColors } from './color.js';

// ── Hybrid mode configuration ─────────────────────────────────────────────────

/**
 * Fraction of the final colour that comes from the physics engine.
 * The remaining (1 − PHYSICS_WEIGHT) comes from the legacy heuristic path.
 * Range [0, 1].  Default: 0.7 (70 % physics / 30 % legacy).
 */
export const PHYSICS_WEIGHT = 0.7;

/** When false, skip the legacy computation and use 100 % physics output. */
export let hybridMode = false;

/**
 * Enable or disable hybrid blending at runtime.
 * @param {boolean} enabled  true = 70/30 blend, false = pure physics
 */
export function setHybridMode(enabled) {
  hybridMode = !!enabled;
}

// ── Shared internal helpers ───────────────────────────────────────────────────

function clamp(v, min = 0, max = 255) {
  return Math.max(min, Math.min(max, v));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep(lo, hi, x) {
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

// Constants shared by both paths
const AIR_MASS_MAX = 38;   // Kasten-Young air mass at horizon (h=0°)
const K_RAYLEIGH   = 0.05; // molecular extinction optical depth baseline
const K_MIE        = 0.45; // aerosol scaling — matches physicsLayer.js tauExt formula
const TWILIGHT_DEG = 6;    // civil twilight depth in degrees

/**
 * Warmth factor: ∝ 1/sin(elevation), normalised 0→1 as sun approaches horizon.
 * Capped at 1 so that sub-horizon elevations stay at maximum warmth.
 */
function _warmthNorm(solarElevation) {
  const sinEl = Math.max(Math.sin(solarElevation * Math.PI / 180), 0.01);
  return Math.min(1 / sinEl / AIR_MASS_MAX, 1);
}

/**
 * Beer-Lambert transmittance: fraction of direct solar radiation surviving the path.
 * Uses same tauExt formula as physicsLayer.js for consistency.
 */
function _beerLambert(airMass, turbidity) {
  const tauExt = K_RAYLEIGH + K_MIE * turbidity;
  return Math.exp(-tauExt * airMass);
}

/**
 * Civil twilight factor: 0 at elevation=0°, 1 at elevation=−6°.
 * Drives the purple/magenta Belt-of-Venus shift.
 */
function _twilightFactor(solarElevation) {
  return Math.max(0, Math.min(1, -solarElevation / TWILIGHT_DEG));
}

// ── Legacy colour path (preserved verbatim) ───────────────────────────────────

/**
 * Original empirical sky colour model.
 * Retained as the 30 % component of the hybrid blend and as a safety
 * fallback.  Do NOT edit this function — it is the reference implementation.
 *
 * @param {Object} p
 * @param {number} p.solarElevation   Solar elevation in degrees
 * @param {number} p.airMass          Kasten-Young air mass
 * @param {number} p.turbidity        0–1 composite aerosol index
 * @param {number} p.mieIntensity     0–1 Mie forward-scatter strength
 * @param {number} p.rayleighSpread   0–1 clean-air gradient quality
 * @param {number} p.humidity         0–100 relative humidity
 * @returns {{ skyTop, skyMid, horizon, sun }}
 */
function computeSkyColorLegacy({ solarElevation, airMass, turbidity, mieIntensity, rayleighSpread, humidity }) {
  const warmthN   = _warmthNorm(solarElevation);
  const twilightF = _twilightFactor(solarElevation);
  const intensity = _beerLambert(airMass, turbidity);

  // skyTop: Rayleigh-dominated, deep blue → violet/purple in twilight
  const mieDark = mieIntensity * 10;
  const skyTop = {
    r: clamp(8  + warmthN * 20 * rayleighSpread + 40 * twilightF - mieDark),
    g: clamp(5  + warmthN * 8  * rayleighSpread + 5  * twilightF - mieDark * 0.6),
    b: clamp(55 + rayleighSpread * 30 - turbidity * 20 + 35 * twilightF - mieDark * 0.3, 20),
  };

  // skyMid: Rayleigh + Mie blend — warm pink/amber transition
  const mieFrac = smoothstep(0.3, 0.7, mieIntensity);
  const rR = 35 + warmthN * 50 * rayleighSpread;
  const gR = 8  + warmthN * 18 * rayleighSpread;
  const bR = 40 + warmthN * 25 * rayleighSpread;
  const rM = 80 * mieIntensity * warmthN;
  const gM = 28 * mieIntensity * warmthN;
  const bM = 2  * mieIntensity * warmthN;
  const skyMid = {
    r: clamp(lerp(rR, rR + rM, mieFrac) + 15 * twilightF * rayleighSpread),
    g: clamp(lerp(gR, gR + gM, mieFrac)),
    b: clamp(lerp(bR, bR - bM, mieFrac) + 20 * twilightF * rayleighSpread),
  };

  // horizon: Mie-dominated, earth shadow fades colour as sun dips
  const earthShadow = Math.max(0, -solarElevation / 3);
  const shadowFade  = 1 - earthShadow * 0.7;
  const humHaze     = (humidity / 100) * 0.15;
  const horizon = {
    r: clamp(
      (120 + warmthN * 80 * rayleighSpread + 120 * mieIntensity * warmthN
        - 80 * mieIntensity * warmthN * humHaze * 0.2) * shadowFade
      + 30 * twilightF * (1 - mieIntensity * 0.5)
    ),
    g: clamp(
      (40 + warmthN * 30 * rayleighSpread + 38 * mieIntensity * warmthN) * shadowFade
      + 8 * twilightF
    ),
    b: clamp(
      (30 + warmthN * 20 * rayleighSpread - 4 * mieIntensity * warmthN
        + 20 * humHaze * warmthN) * shadowFade
      + 45 * twilightF * (1 - mieIntensity * 0.3)
    ),
  };

  // sun: direct Beer-Lambert transmission, reddened at low angles
  const humFactor = clamp(humidity / 100, 0, 1);
  const sun = {
    r: clamp(255 * (0.85 + 0.15 * intensity)),
    g: clamp(lerp(255 * intensity * (1 - warmthN * 0.7 * turbidity), 220, humFactor * mieIntensity * 0.5)),
    b: clamp(lerp(255 * intensity * (1 - warmthN * 0.9), 180, humFactor * mieIntensity * 0.5)),
  };

  return { skyTop, skyMid, horizon, sun };
}

// ── Physics colour path ───────────────────────────────────────────────────────

/**
 * Convert atmosphere.js output to a four-zone {r,g,b} colour set.
 * @param {number} sunAngle_rad    Solar elevation in radians
 * @param {number} turbidity       0–1 from physicsLayer
 * @param {number} [angstromExp]   Ångström exponent from PM2.5/PM10
 * @param {number} [ozoneDU]       Stratospheric ozone column in Dobson Units
 * @returns {{ skyTop, skyMid, horizon, sun }}
 */
function computeSkyColorPhysics(sunAngle_rad, turbidity, angstromExp = 0, ozoneDU = 300) {
  const atm = computeAtmosphere(sunAngle_rad, turbidity, angstromExp, ozoneDU);
  return {
    skyTop:  spectrumToRGB(atm.skyTop),
    skyMid:  spectrumToRGB(atm.skyMid),
    horizon: spectrumToRGB(atm.horizon),
    sun:     spectrumToRGB(atm.sun),
  };
}

// ── Primary export ────────────────────────────────────────────────────────────

/**
 * Compute physics-based sky colours for four vertical zones.
 *
 * Default mode: 70 % physics (Rayleigh/Mie wavelength model) blended with
 * 30 % legacy (empirical heuristic) for a gradual transition.
 * Set hybridMode = false or call setHybridMode(false) for 100 % physics.
 *
 * Interface is backward-compatible with the previous implementation —
 * callers in score.js do not need to change.
 *
 * @param {Object} params
 * @param {number} params.solarElevation   Solar elevation in degrees (negative = below horizon)
 * @param {number} params.airMass          Kasten-Young air mass (from physicsContributions.airMass)
 * @param {number} params.turbidity        0–1 composite aerosol index
 * @param {number} params.mieIntensity     0–1 Mie forward-scatter strength
 * @param {number} params.rayleighSpread   0–1 clean-air gradient quality
 * @param {number} params.humidity         0–100 relative humidity
 * @param {number} [params.ozoneDU=300]    Stratospheric ozone column (Dobson Units).
 *                                         Pass LOCATION_CLIMATE.ozoneDU for location accuracy.
 *
 * @returns {{
 *   skyTop:  {r:number, g:number, b:number},
 *   skyMid:  {r:number, g:number, b:number},
 *   horizon: {r:number, g:number, b:number},
 *   sun:     {r:number, g:number, b:number}
 * }}
 */
export function computeSkyColor({ solarElevation, airMass, turbidity, mieIntensity, rayleighSpread, humidity, angstromExp = 0, ozoneDU = 300 }) {
  // Convert degrees → radians for atmosphere.js
  const sunAngle_rad = solarElevation * (Math.PI / 180);

  const physics = computeSkyColorPhysics(sunAngle_rad, turbidity, angstromExp, ozoneDU);

  if (!hybridMode) return physics;

  // Hybrid: blend physics with legacy to preserve civil-twilight purple shift
  // and other heuristic touches while the physics model is primary
  const legacy = computeSkyColorLegacy({ solarElevation, airMass, turbidity, mieIntensity, rayleighSpread, humidity });

  return {
    skyTop:  blendColors(physics.skyTop,  legacy.skyTop,  PHYSICS_WEIGHT),
    skyMid:  blendColors(physics.skyMid,  legacy.skyMid,  PHYSICS_WEIGHT),
    horizon: blendColors(physics.horizon, legacy.horizon, PHYSICS_WEIGHT),
    sun:     blendColors(physics.sun,     legacy.sun,     PHYSICS_WEIGHT),
  };
}

// ── Sun appearance model (unchanged) ─────────────────────────────────────────

/**
 * Compute physical appearance parameters for the sun disk.
 * Useful for canvas rendering or CSS glow (future phase).
 *
 * @param {Object} params
 * @param {number} params.solarElevation  degrees
 * @param {number} params.turbidity       0–1
 * @param {number} params.mieIntensity    0–1
 * @param {number} params.humidity        0–100
 * @param {number} params.airMass         Kasten-Young air mass
 *
 * @returns {{ color:{r,g,b}, size:number, blur:number, intensity:number }}
 */
export function computeSunAppearance({ solarElevation, turbidity, mieIntensity, humidity, airMass }) {
  const warmthN   = _warmthNorm(solarElevation);
  const intensity = _beerLambert(airMass, turbidity);
  const { sun }   = computeSkyColor({
    solarElevation, airMass, turbidity, mieIntensity,
    rayleighSpread: clamp(1 - turbidity, 0, 1),
    humidity,
  });

  // Atmospheric refraction enlarges the apparent sun near the horizon
  const size = 1 + 0.6 * warmthN * (1 - turbidity * 0.3);

  // Mie halo blurs the disk
  const blur = 4 + mieIntensity * 24 + humidity * 0.05;

  return {
    color: sun,
    size:      clamp(size, 0, 2),
    blur:      clamp(blur, 0, 30),
    intensity: Math.max(intensity, 0.05), // always slightly visible
  };
}

// ── Score bias (unchanged) ────────────────────────────────────────────────────

/**
 * Enhance sky colours slightly based on dramaLevel (from score.js).
 * Only boosts channels that are already dominant (>80) — preserves hue,
 * increases saturation/contrast by at most 20 %.
 *
 * @param {{ skyTop, skyMid, horizon, sun }} skyColors
 * @param {number} dramaLevel  0–100 from dayData.dramaLevel
 * @returns {{ skyTop, skyMid, horizon, sun }}
 */
export function applyScoreBias(skyColors, dramaLevel) {
  const boost = 1 + Math.max(0, Math.min(1, dramaLevel / 100)) * 0.20;

  const enhance = (v) => v > 80 ? clamp(Math.round(v * boost)) : v;

  const biasZone = ({ r, g, b }) => ({
    r: enhance(r),
    g: enhance(g),
    b: enhance(b),
  });

  return {
    skyTop:  biasZone(skyColors.skyTop),
    skyMid:  biasZone(skyColors.skyMid),
    horizon: biasZone(skyColors.horizon),
    sun:     biasZone(skyColors.sun),
  };
}
