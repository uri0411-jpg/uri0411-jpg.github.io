/**
 * skyCanvas.js — Physics-based canvas sky gradient renderer
 *
 * Computes a smooth 8-stop gradient from Rayleigh+Mie+Chappuis physics and
 * paints it ONLY on the sky/cloud pixels of the background photo, leaving
 * mountains, olive trees, and dark silhouettes completely untouched.
 *
 * Two-layer selectivity:
 *   1. `destination-in` clip against a pre-computed luminance + y-position
 *      mask of background.jpg (see skyMask.js). This is geometric and
 *      photometric filtering: only pixels that the photo deems "sky" at
 *      all receive any paint.
 *   2. `mix-blend-mode: hue` on the canvas element. Unlike `color`
 *      (which replaces H+S) or `soft-light` (which only modulates L),
 *      `hue` blend substitutes ONLY the backdrop's hue angle, keeping
 *      the photo's own saturation AND luminance intact. Result: the
 *      photo's vivid cloud texture and vibrancy are fully preserved;
 *      only the direction of its colour wheel rotates to match what
 *      the physics says the sky should look like right now.
 *
 *      This choice matters because the physics colour pipeline yields
 *      mostly desaturated colours (sat ≈ 0.1–0.2) at any given stop —
 *      what it *meaningfully* carries across time-of-day is the HUE
 *      angle (blue → cyan → gold → pink → violet), not saturation.
 *      `hue` blend extracts exactly that signal and ignores the rest.
 *
 * Architecture:
 *   • Injects <canvas id="sky-canvas"> into #sky-layers (sibling of .bg-sunset)
 *     so the blend mode's backdrop IS the photo.
 *   • z-index: 1, mix-blend-mode: hue — surgical hue-rotation of sky region only.
 *   • Re-renders on each live gradient update (called from startSkyGradient)
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

import { computeAtmosphere }                  from '../engine/atmosphere.js';
import { spectrumToRGB, applyPerceptualTuning } from '../engine/color.js';
import { LOCATION_CLIMATE }                    from '../config.js';
import { loadSkyMask, drawSkyMask, getSkyMaskSync } from './skyMask.js';

const CANVAS_ID = 'sky-canvas';

// ── Offscreen commit buffer (Contract 3) ────────────────────────────────────
let _offscreen = null;

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

// Alpha for each stop — calibrated for `mix-blend-mode: hue` + sky mask.
// `hue` replaces only the hue angle, so alpha acts as a linear mix between
// the photo's original hue and the physics-derived hue.  We use 1.0 almost
// everywhere to get the full physics signal where the mask permits.  A
// small softening at the very zenith prevents the rotation from feeling
// abrupt on overcast/cloud-free days.
const STOP_ALPHAS = [0.95, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00, 1.00];

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

/**
 * Boost the saturation of an RGB colour while preserving its hue angle
 * and perceptual lightness.
 *
 * `mix-blend-mode: hue` requires the source colour to have meaningful
 * saturation — if saturation is near zero, most browsers treat the
 * source as achromatic and leave the backdrop's hue untouched. The
 * physics pipeline returns mostly pale colours (s ≈ 0.08–0.18) whose
 * HUE ANGLE encodes the time-of-day signal (violet → pink → gold), but
 * whose low saturation is too weak for the blend to pick up.
 *
 * This helper converts RGB → HSL, clamps saturation up to at least
 * `targetS`, and converts back. It keeps L and H untouched, so the
 * perceptual lightness of the physics is preserved for any later
 * blend modes that do care about L (e.g., if we ever reintroduce a
 * luminance pass). The only property it alters is S.
 */
function boostSaturation({ r, g, b }, targetS = 0.70) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const L = (max + min) / 2;

  if (max === min) {
    // True grey — no hue to preserve; return as-is so blend does nothing.
    return { r, g, b };
  }

  const d = max - min;
  const S = L > 0.5 ? d / (2 - max - min) : d / (max + min);

  let H;
  if      (max === rn) H = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) H = (bn - rn) / d + 2;
  else                 H = (rn - gn) / d + 4;
  H /= 6;

  const newS = Math.max(S, targetS);

  // HSL → RGB
  const q = L < 0.5 ? L * (1 + newS) : L + newS - L * newS;
  const p = 2 * L - q;
  const hue2rgb = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  return {
    r: Math.round(hue2rgb(H + 1 / 3) * 255),
    g: Math.round(hue2rgb(H)         * 255),
    b: Math.round(hue2rgb(H - 1 / 3) * 255),
  };
}

// ── Primary export ────────────────────────────────────────────────────────────

/**
 * Render (or update) the physics-based sky canvas inside a container.
 *
 * WORKER-READY (v46): All physics helpers used here (computeAtmosphere,
 * spectrumToRGB, applyPerceptualTuning) are pure functions with no DOM
 * dependencies. The `ctx` parameter accepts both HTMLCanvasElement context
 * and OffscreenCanvasRenderingContext2D, making this function safe to run
 * inside a Web Worker when activated (see js/workers/skyWorker.js).
 *
 * @param {Element} container       The #sky-layers root (sibling of .bg-sunset)
 * @param {number}  sunAngle_rad    Current solar elevation in radians
 * @param {number}  turbidity       0–1 aerosol loading
 * @param {number}  [angstromExp=0] Ångström exponent from PM2.5/PM10
 * @param {number}  [beltOfVenus=0] 0–1 Belt-of-Venus visibility probability
 * @param {{low:number,mid:number,high:number}} [clouds]
 *                                  Fractional cloud cover per layer 0–1 (Phase 1).
 *                                  Optional — defaults to clear sky.
 * @param {number}  [mieGrowth=1]   κ-Köhler hygroscopic growth factor (Phase 2).
 *                                  Scales Mie cross-section as g² (cross-section ∝ r²).
 */
export function renderSkyCanvas(container, sunAngle_rad, turbidity, angstromExp = 0, beltOfVenus = 0, clouds, mieGrowth = 1) {
  if (!container) return;

  // ── First Frame Freeze ────────────────────────────────────────────────────
  // Skip rendering entirely if the sky mask isn't ready yet. Without the mask
  // the gradient would paint across the ENTIRE viewport (including mountains,
  // trees) and clip on the next frame — causing a visible flash.
  //
  // The graded render barrier in initMainScreen pre-loads the mask before
  // startSkyGradient fires, so this guard is a safety net for the race
  // where the 300ms soft timeout expired before the mask was ready.
  // The next 30-second update() cycle will have the mask and render normally.
  if (!getSkyMaskSync()) {
    // Ensure mask load is in-flight (idempotent — loadSkyMask caches its promise)
    loadSkyMask().catch(err => console.warn('[skyCanvas] mask load failed', err));
    return;
  }

  // #sky-layers is position:fixed inset:0, so its size matches the viewport.
  const w = container.offsetWidth  || window.innerWidth;
  const h = container.offsetHeight || window.innerHeight;
  if (!w || !h) return; // skip frame if container has no layout yet

  // DPR: render at device-pixel resolution for sharp output on retina displays.
  // All drawing uses logical (CSS) coordinates; the DPR transform handles scaling.
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(w * dpr);  // physical width
  const ph = Math.round(h * dpr);  // physical height

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
      zIndex:        '1',
      mixBlendMode:  'hue',
      pointerEvents: 'none',
      display:       'block',
    });
    container.insertBefore(canvas, container.firstChild);
  }

  // Resize if needed (backing store = physical pixels)
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width  = pw;
    canvas.height = ph;
  }

  // ── Contract 3: Offscreen commit — draw to buffer, then atomic blit ─────
  if (!_offscreen || _offscreen.width !== pw || _offscreen.height !== ph) {
    _offscreen = document.createElement('canvas');
    _offscreen.width = pw;
    _offscreen.height = ph;
  }
  const off = _offscreen.getContext('2d');
  if (!off) { _offscreen = null; return; } // context lost — bail, re-create next tick
  off.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in logical coords
  off.clearRect(0, 0, w, h);

  // ── Sample atmosphere at 8 elevation offsets ──────────────────────────────
  const colors = STOP_OFFSETS_RAD.map((offset, i) => {
    const sampleAngle = sunAngle_rad + offset;
    const atm  = computeAtmosphere(sampleAngle, turbidity, angstromExp, LOCATION_CLIMATE.ozoneDU, clouds, mieGrowth);
    const zone = STOP_ZONES[i];
    const rgb  = applyPerceptualTuning(
      spectrumToRGB(atm[zone]),
      { sunAngle_rad, zone }
    );

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

  // ── Saturation boost ──────────────────────────────────────────────────────
  const elevDeg = sunAngle_rad * 180 / Math.PI;
  const boostT  = Math.max(0, Math.min(1, (12 - elevDeg) / 10));
  const targetS = 0.30 + 0.45 * boostT;

  // ── Horizon correction ────────────────────────────────────────────────────
  const horizonCorrection = Math.max(0, Math.min(1, -elevDeg / 4));
  const effectiveTargetS  = targetS * (1 - horizonCorrection * 0.35);

  // ── Night indigo anchor ───────────────────────────────────────────────────
  const NIGHT_INDIGO   = { r: 18, g: 10, b: 78 };
  const _nRaw          = Math.max(0, Math.min(1, (-elevDeg - 1) / 20));
  const nightAnchorStr = _nRaw * _nRaw * (3 - 2 * _nRaw);
  const anchoredColors = nightAnchorStr > 0
    ? colors.map(c => ({
        r: Math.round(c.r + (NIGHT_INDIGO.r - c.r) * nightAnchorStr),
        g: Math.round(c.g + (NIGHT_INDIGO.g - c.g) * nightAnchorStr),
        b: Math.round(c.b + (NIGHT_INDIGO.b - c.b) * nightAnchorStr),
      }))
    : colors;

  const saturated = anchoredColors.map(c => boostSaturation(c, effectiveTargetS));

  // ── Build vertical gradient on offscreen buffer ───────────────────────────
  const grad = off.createLinearGradient(0, 0, 0, h);
  STOP_POSITIONS.forEach((pos, i) => {
    grad.addColorStop(pos, rgba(saturated[i], STOP_ALPHAS[i]));
  });

  off.fillStyle = grad;
  off.fillRect(0, 0, w, h);

  // ── Clip to sky mask ──────────────────────────────────────────────────────
  off.globalCompositeOperation = 'destination-in';
  drawSkyMask(off, w, h);
  off.globalCompositeOperation = 'source-over';

  // ── COMMIT: atomic blit to visible canvas ─────────────────────────────────
  const ctx = canvas.getContext('2d');
  if (!ctx) return; // context lost (rare: long-backgrounded tab, low memory)
  ctx.setTransform(1, 0, 0, 1, 0, 0); // reset to physical coords for blit
  ctx.clearRect(0, 0, pw, ph);
  ctx.drawImage(_offscreen, 0, 0, pw, ph);
}

/**
 * Remove the sky canvas element from the container.
 */
export function removeSkyCanvas(container) {
  container?.querySelector(`#${CANVAS_ID}`)?.remove();
}
