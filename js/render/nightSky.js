/**
 * nightSky.js — Stars and moon canvas for night-time rendering
 *
 * Renders a <canvas id="night-canvas"> into #sky-layers using
 * mix-blend-mode: screen so stars/moon add light onto the darkened
 * background photo without washing it out.
 *
 * Stars are clipped to the sky mask (same mask as skyCanvas.js) so they
 * never appear on mountains, olive trees, or dark silhouettes.
 *
 * The moon phase is computed from the real lunar cycle (new moon reference:
 * Jan 6, 2000 18:14 UTC). Phase shape uses a soft radial gradient terminator
 * (destination-out) rather than a hard geometric clip.
 *
 * Called every 30 s from startLiveGradient in main-screen.js.
 * nightFactor (0–1) is the shared scalar: 0 at civil twilight (−6°),
 * 1 at deep night (−26°). All opacity/brightness values derive from it
 * so the entire night scene fades in/out coherently.
 */

import { getSkyMaskSync, drawSkyMask } from './skyMask.js';

const CANVAS_ID = 'night-canvas';

// ── Seeded star field ─────────────────────────────────────────────────────────
// Fixed positions (same stars every night — perceptual stability).
// XorShift32 PRNG with a fixed seed.
const STARS = (() => {
  let x = 12345;
  const rand = () => {
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xFFFFFFFF;
  };
  return Array.from({ length: 180 }, () => ({
    px:  rand(),           // 0–1 fractional position across width
    py:  rand() * 0.65,   // top 65 % of screen (sky zone)
    mag: rand(),           // 0=faint, 1=bright — determines opacity tier
    r:   0.5 + rand() * 1.5, // radius 0.5–2 px
  }));
})();

// ── Moon phase ────────────────────────────────────────────────────────────────

/**
 * Return moon age in days (0 = new moon, 14.77 ≈ full moon, 29.53 = next new moon).
 * Reference: Jan 6, 2000 18:14 UTC — verified astronomical new moon.
 */
function moonPhase(date) {
  const knownNewMoon = Date.UTC(2000, 0, 6, 18, 14);
  const daysSince    = (date.getTime() - knownNewMoon) / 86400000;
  return ((daysSince % 29.530588) + 29.530588) % 29.530588;
}

// ── Cached canvas dimensions ──────────────────────────────────────────────────
// Avoid a forced-layout read on every tick by caching w/h.
let _cw = 0, _ch = 0;

// ── Primary export ────────────────────────────────────────────────────────────

/**
 * Render (or update) the night-sky canvas.
 *
 * @param {Element} container   #sky-layers root element
 * @param {number}  nightFactor 0–1: 0 at civil twilight, 1 at deep night
 * @param {Date}    date        Current date (for moon phase)
 */
export function renderNightSky(container, nightFactor, date) {
  if (!container) return;

  const w = container.offsetWidth  || window.innerWidth;
  const h = container.offsetHeight || window.innerHeight;

  // Find or create canvas
  let canvas = container.querySelector(`#${CANVAS_ID}`);
  if (!canvas) {
    canvas = document.createElement('canvas');
    canvas.id = CANVAS_ID;
    Object.assign(canvas.style, {
      position:      'absolute',
      inset:         '0',
      width:         '100%',
      height:        '100%',
      zIndex:        '2',
      mixBlendMode:  'screen',
      pointerEvents: 'none',
      display:       'block',
    });
    container.appendChild(canvas);
    _cw = _ch = 0; // force resize on first render
  }

  // Resize only when viewport actually changes
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = _cw = w;
    canvas.height = _ch = h;
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  // ── Stars ─────────────────────────────────────────────────────────────────
  for (const star of STARS) {
    // Three magnitude tiers
    const baseOp = star.mag > 0.7 ? 0.9 : star.mag > 0.35 ? 0.7 : 0.5;
    // Quadratic "kick-in": 0.6 floor lets stars appear during civil twilight
    // before the sky is fully dark, matching real visual experience.
    ctx.globalAlpha = baseOp * nightFactor * (0.6 + 0.4 * nightFactor);
    ctx.fillStyle   = 'rgba(255,255,255,0.9)'; // slight sub-1 for screen blend punch
    ctx.beginPath();
    ctx.arc(star.px * w, star.py * h, star.r, 0, Math.PI * 2);
    ctx.fill();
  }

  // ── Moon ──────────────────────────────────────────────────────────────────
  const moonAge     = moonPhase(date);
  const phase       = moonAge / 29.530588;  // 0=new, 0.5=full, 1=new again

  // lunarBright: 0 at new moon, 1 at full moon, symmetric for waxing/waning.
  // Formula: 1 − |2·phase − 1|  gives 0→1→0 across the cycle.
  const lunarBright = 1 - Math.abs(2 * phase - 1);

  // Moon opacity: dim at new moon, bright at full moon, scaled by night depth.
  const finalMoonOp = Math.min(0.92, (0.1 + lunarBright * 0.85) * nightFactor);

  if (finalMoonOp > 0.02) {
    const moonR = 18;
    const moonX = w * 0.72;   // upper-right sky zone
    const moonY = h * 0.12;

    // Draw full moon disk with warm-white glow
    ctx.globalAlpha = finalMoonOp;
    ctx.fillStyle   = '#FFF8E6';
    ctx.shadowColor = 'rgba(255,245,210,0.6)';
    ctx.shadowBlur  = 14;
    ctx.beginPath();
    ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Soft terminator: radial gradient + destination-out cuts the shadow side
    // with a smooth edge rather than a hard geometric clip.
    if (lunarBright < 0.97) {
      // termX shifts left (waning) or right (waxing) based on phase angle
      const termX = moonX + Math.cos(phase * 2 * Math.PI) * moonR * 0.9;
      const grad  = ctx.createRadialGradient(termX, moonY, 0, termX, moonY, moonR * 1.4);
      grad.addColorStop(0,   'rgba(0,0,0,0.95)');
      grad.addColorStop(0.6, 'rgba(0,0,0,0.6)');
      grad.addColorStop(1,   'rgba(0,0,0,0)');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(moonX, moonY, moonR * 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ── Clip to sky mask ──────────────────────────────────────────────────────
  // Stars and moon must not appear on mountains, trees, or dark ground silhouettes.
  // destination-in keeps night canvas pixels only where the mask is non-zero.
  const mask = getSkyMaskSync?.();
  if (mask) {
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'destination-in';
    drawSkyMask(ctx, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
}

/**
 * Remove the night-sky canvas from the container.
 */
export function removeNightSky(container) {
  container?.querySelector(`#${CANVAS_ID}`)?.remove();
}
