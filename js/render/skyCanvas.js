/**
 * skyCanvas.js — Physics-based canvas sky gradient renderer
 *
 * Replaces the CSS 5-stop gradient with a smooth canvas gradient computed
 * at 8 effective solar elevation samples, eliminating CSS gradient banding
 * and providing a physically motivated colour distribution across sky zones.
 *
 * Architecture:
 *   • Injects <canvas id="sky-canvas"> as first child of .home-content
 *   • z-index: -1 inside the stacking context — above CSS background, below
 *     flex content, sun disk, and SVG rays
 *   • Re-renders on each live gradient update (called from startLiveGradient)
 *
 * The 8 stops are obtained by sampling computeAtmosphere() at the current solar
 * elevation ± small offsets, approximating the effective solar angle seen from
 * each altitude band in the sky:
 *
 *   Stop 0 (zenith)  → sun angle + 0.35 rad  (higher effective elevation → bluer)
 *   Stop 1           → sun angle + 0.20 rad
 *   Stop 2           → sun angle + 0.10 rad
 *   Stop 3           → sun angle + 0.03 rad
 *   Stop 4           → sun angle − 0.02 rad  (horizon band)
 *   Stop 5 (belt)    → sun angle − 0.06 rad  (Belt of Venus zone)
 *   Stop 6 (earth)   → sun angle − 0.12 rad  (earth shadow)
 *   Stop 7 (base)    → sun angle − 0.18 rad  (deep dark base)
 *
 * @module render/skyCanvas
 */

import { computeAtmosphere }   from '../engine/atmosphere.js';
import { spectrumToRGB }        from '../engine/color.js';
import { LOCATION_CLIMATE }     from '../config.js';

const CANVAS_ID = 'sky-canvas';

// Canvas-position fractions for each of the 8 gradient stops (top → bottom)
const STOP_POSITIONS = [0.00, 0.12, 0.25, 0.40, 0.58, 0.70, 0.83, 1.00];

// Angular offsets (radians) added to the current solar elevation for each stop.
// Positive = looking higher than sun, negative = looking below sun (into earth shadow).
//
// Adaptive spacing: stops 2-5 are tightly clustered around the horizon (±0.05 rad)
// where the Rayleigh → Mie colour transition is most rapid.  Outer stops are spread
// wider to capture the deep-blue zenith and dark earth-shadow base.
const STOP_OFFSETS_RAD = [0.35, 0.15, 0.06, 0.02, -0.01, -0.04, -0.09, -0.18];

// Which zone of atmosphere output each stop samples
const STOP_ZONES = ['skyTop', 'skyTop', 'skyMid', 'skyMid', 'horizon', 'horizon', 'horizon', 'horizon'];

// Alpha for each stop (top is lighter overlay, bottom is deep dark)
const STOP_ALPHAS = [0.70, 0.68, 0.62, 0.58, 0.55, 0.60, 0.70, 0.97];

// ── Belt of Venus colour (physics-based, Phase 3.4) ──────────────────────────

/**
 * Compute the Belt-of-Venus colour using Chappuis-weighted atmospheric backscatter.
 *
 * The Belt of Venus (anti-twilight arch) is backscattered twilight sky light
 * seen 3–10° above the anti-solar horizon.  Its characteristic pink-lavender
 * colour arises from:
 *   1. Rayleigh scatter (λ^{-4}) preferentially maintaining the violet/blue
 *      channels over orange/red at high air mass.
 *   2. Chappuis ozone absorption (peak 600 nm) suppressing the orange channel.
 *   3. Double optical path — sunlight crosses the full atmosphere twice
 *      (incoming → surface → observer), so the effective ozone column is 2×.
 *
 * Replaces the previous heuristic lerp toward (180, 60, 160).
 *
 * @param {number} sunAngle_rad  Solar elevation in radians (negative after sunset)
 * @param {number} turbidity     Aerosol loading (capped at 0.15 — belt is clear-sky)
 * @param {number} ozoneDU       Stratospheric ozone column in Dobson Units
 * @returns {{ r: number, g: number, b: number }}
 */
function _computeBeltColor(sunAngle_rad, turbidity, ozoneDU) {
  // Belt sits ~3° above the anti-solar horizon.  When sun is at −α the
  // anti-solar horizon is at +α, so belt centre ≈ |α| + 0.052 rad.
  const beltAngle = Math.abs(sunAngle_rad) + 0.052; // ≈ |α| + 3°

  // Belt is a clear-sky scattering effect — cap turbidity to isolate Rayleigh
  const cleanTurb = Math.min(turbidity, 0.15);

  // Double ozone path: sunlight transits the atmosphere twice for backscatter
  const atm = computeAtmosphere(beltAngle, cleanTurb, 0, ozoneDU * 2);

  // Blend Rayleigh-dominant skyTop (blue-violet) with warm horizon edge:
  //   70% skyTop  → sets the blue-violet base from λ^{-4} Rayleigh scatter
  //   30% horizon → adds pink warmth at the earth-shadow boundary
  // Together this produces the characteristic soft lavender-mauve of the belt.
  const st = spectrumToRGB(atm.skyTop);
  const hz = spectrumToRGB(atm.horizon);
  return {
    r: Math.round(st.r * 0.70 + hz.r * 0.30),
    g: Math.round(st.g * 0.70 + hz.g * 0.30),
    b: Math.round(st.b * 0.70 + hz.b * 0.30),
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rgba({ r, g, b }, a) {
  return `rgba(${r},${g},${b},${a.toFixed(2)})`;
}

// ── Primary export ────────────────────────────────────────────────────────────

/**
 * Render (or update) the physics-based sky canvas inside a container.
 *
 * @param {Element} container       The .home-content element (position: relative)
 * @param {number}  sunAngle_rad    Current solar elevation in radians
 * @param {number}  turbidity       0–1 aerosol loading
 * @param {number}  [angstromExp=0] Ångström exponent from PM2.5/PM10
 * @param {number}  [beltOfVenus=0] 0–1 Belt-of-Venus visibility probability
 */
export function renderSkyCanvas(container, sunAngle_rad, turbidity, angstromExp = 0, beltOfVenus = 0) {
  if (!container) return;

  const w = container.offsetWidth  || window.innerWidth;
  const h = container.offsetHeight || window.innerHeight;

  // ── Find or create canvas ─────────────────────────────────────────────────
  let canvas = container.querySelector(`#${CANVAS_ID}`);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = CANVAS_ID;
    Object.assign(canvas.style, {
      position:      'absolute',
      inset:         '0',
      width:         '100%',
      height:        '100%',
      zIndex:        '-1',
      pointerEvents: 'none',
      display:       'block',
    });
    container.insertBefore(canvas, container.firstChild);
  }

  // Resize if needed
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  // ── Sample atmosphere at 8 elevation offsets ──────────────────────────────
  const colors = STOP_OFFSETS_RAD.map((offset, i) => {
    const sampleAngle = sunAngle_rad + offset;
    const atm = computeAtmosphere(sampleAngle, turbidity, angstromExp, LOCATION_CLIMATE.ozoneDU);
    const zone = STOP_ZONES[i];
    const rgb  = spectrumToRGB(atm[zone]);

    // Belt of Venus zone (stop 5): blend toward physics-derived lavender-mauve
    if (i === 5 && beltOfVenus > 0) {
      const belt = _computeBeltColor(sunAngle_rad, turbidity, LOCATION_CLIMATE.ozoneDU);
      const bov  = beltOfVenus;
      return {
        r: Math.round(rgb.r * (1 - bov) + belt.r * bov),
        g: Math.round(rgb.g * (1 - bov) + belt.g * bov),
        b: Math.round(rgb.b * (1 - bov) + belt.b * bov),
      };
    }
    return rgb;
  });

  // ── Build vertical gradient ───────────────────────────────────────────────
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  STOP_POSITIONS.forEach((pos, i) => {
    grad.addColorStop(pos, rgba(colors[i], STOP_ALPHAS[i]));
  });

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
}

/**
 * Remove the sky canvas element from the container.
 */
export function removeSkyCanvas(container) {
  container?.querySelector(`#${CANVAS_ID}`)?.remove();
}
