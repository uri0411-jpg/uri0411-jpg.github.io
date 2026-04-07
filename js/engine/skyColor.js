/**
 * skyColor.js — Physically-based sky color engine
 *
 * Computes sky colors from atmospheric scattering physics:
 *   - Rayleigh scattering → blue/violet tones (clean air)
 *   - Mie scattering     → orange/red tones (aerosols)
 *   - Beer-Lambert       → attenuation along air mass path
 *   - Twilight model     → purple/magenta shift when sun < 0°
 *
 * Score bias: drama level only adjusts saturation/contrast (±20% max),
 * never defines base hue.
 */

// ── Constants ──────────────────────────────────────────────────────────────
const AIR_MASS_MAX = 38;     // Kasten-Young air mass at horizon (h=0°)
const K_RAYLEIGH   = 0.05;   // molecular extinction optical depth baseline
const K_MIE        = 0.45;   // aerosol scaling — matches physicsLayer.js tauExt formula
const TWILIGHT_DEG = 6;      // civil twilight depth in degrees

// ── Internal helpers ───────────────────────────────────────────────────────

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

/**
 * Warmth factor: ∝ 1/sin(elevation), normalized 0→1 as sun approaches horizon.
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
 * Civil twilight factor: 0 at elevation=0°, 1 at elevation=-6°.
 * Drives the purple/magenta Belt-of-Venus shift.
 */
function _twilightFactor(solarElevation) {
  return Math.max(0, Math.min(1, -solarElevation / TWILIGHT_DEG));
}

// ── Primary export ─────────────────────────────────────────────────────────

/**
 * Compute physics-based sky colors for four vertical zones.
 *
 * @param {Object} params
 * @param {number} params.solarElevation   Solar elevation in degrees (negative = below horizon)
 * @param {number} params.airMass          Kasten-Young air mass (from physicsContributions.airMass)
 * @param {number} params.turbidity        0–1 composite aerosol index
 * @param {number} params.mieIntensity     0–1 Mie forward-scatter strength
 * @param {number} params.rayleighSpread   0–1 clean-air gradient quality
 * @param {number} params.humidity         0–100 relative humidity
 *
 * @returns {{
 *   skyTop:  {r:number, g:number, b:number},
 *   skyMid:  {r:number, g:number, b:number},
 *   horizon: {r:number, g:number, b:number},
 *   sun:     {r:number, g:number, b:number}
 * }}
 */
export function computeSkyColor({ solarElevation, airMass, turbidity, mieIntensity, rayleighSpread, humidity }) {
  const warmthN   = _warmthNorm(solarElevation);
  const twilightF = _twilightFactor(solarElevation);
  const intensity = _beerLambert(airMass, turbidity);

  // ── skyTop: Rayleigh-dominated, deep blue → violet/purple in twilight ──
  const mieDark = mieIntensity * 10;  // aerosol darkening of top sky
  const skyTop = {
    r: clamp(8  + warmthN * 20 * rayleighSpread + 40 * twilightF - mieDark),
    g: clamp(5  + warmthN * 8  * rayleighSpread + 5  * twilightF - mieDark * 0.6),
    b: clamp(55 + rayleighSpread * 30 - turbidity * 20 + 35 * twilightF - mieDark * 0.3, 20),
    // floor 20 on blue — dusty sky is always dark blue, never pure black
  };

  // ── skyMid: Rayleigh + Mie blend — warm pink/amber transition ──
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

  // ── horizon: Mie-dominated, earth shadow fades colour as sun dips ──
  const earthShadow = Math.max(0, -solarElevation / 3);  // 0→1 as sun goes -3°
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

  // ── sun: direct Beer-Lambert transmission, reddened at low angles ──
  const humFactor = clamp(humidity / 100, 0, 1);
  const sun = {
    r: clamp(255 * (0.85 + 0.15 * intensity)),  // slight attenuation even in red channel
    g: clamp(lerp(255 * intensity * (1 - warmthN * 0.7 * turbidity), 220, humFactor * mieIntensity * 0.5)),
    b: clamp(lerp(255 * intensity * (1 - warmthN * 0.9), 180, humFactor * mieIntensity * 0.5)),
  };

  return { skyTop, skyMid, horizon, sun };
}

// ── Sun appearance model ───────────────────────────────────────────────────

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
    size: clamp(size, 1, 0, 2),
    blur: clamp(blur, 0, 30),
    intensity: Math.max(intensity, 0.05),  // always slightly visible
  };
}

// ── Score bias ─────────────────────────────────────────────────────────────

/**
 * Enhance sky colors slightly based on dramaLevel (from score.js).
 * Only boosts channels that are already dominant (>80) — preserves hue,
 * increases saturation/contrast by at most 20%.
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
