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
 * Called every 30 s from startSkyGradient in js/main-screen/sky-renderer.js.
 * nightFactor (0–1) is the shared scalar: 0 at civil twilight (−6°),
 * 1 at deep night (−26°). All opacity/brightness values derive from it
 * so the entire night scene fades in/out coherently.
 */

import { getSkyMaskSync, drawSkyMask, loadSkyMask } from './skyMask.js';

const CANVAS_ID = 'night-canvas';

// ── Pre-rendered star field ───────────────────────────────────────────────────
// Stars are painted once to an offscreen canvas at nightFactor=1.
// Each live tick composites the whole field via a single drawImage + globalAlpha.
// Invalidated only when the viewport dimensions change.
let _starCanvas = null, _starW = 0, _starH = 0, _starDPR = 1;

// ── Pending render — mask race-condition guard ─────────────────────────────────
// On the first renderNightSky call the sky mask may still be loading async.
// Rather than draw unclipped stars over mountains, we defer: save the call
// args here and re-invoke as soon as loadSkyMask() resolves (usually < 100 ms).
let _pendingRenderArgs = null;
let _maskFailed = false; // Contract 3: permanent mask failure flag

// ── Offscreen commit buffer (Contract 3) ────────────────────────────────────
// All draw operations target this buffer. Only after full success is the
// content atomically committed to the visible canvas via a single drawImage.
let _offscreen = null;

// Pre-load mask at module evaluation time so it's ready before the first tick.
loadSkyMask()
  .then(() => {
    if (_pendingRenderArgs) {
      const { container, nightFactor, date } = _pendingRenderArgs;
      _pendingRenderArgs = null;
      renderNightSky(container, nightFactor, date);
    }
  })
  .catch(() => {
    _maskFailed = true;
    _pendingRenderArgs = null;
    console.warn('[nightSky] sky mask load failed — stars disabled');
    if (typeof window !== 'undefined' && window.__twl_debug) window.__twl_debug.renderFails++;
  });

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

// ── Offscreen star field builder ──────────────────────────────────────────────
// Renders all stars once to a cached HTMLCanvasElement with per-star opacity
// tiers baked in at nightFactor=1. The live render scales uniformly via
// globalAlpha, making the per-tick cost a single drawImage instead of 180 arcs.
function _buildStarCanvas(w, h) {
  if (!w || !h) return null;
  const dpr = window.devicePixelRatio || 1;
  if (_starCanvas && _starW === w && _starH === h && _starDPR === dpr) return _starCanvas;

  _starW = w; _starH = h; _starDPR = dpr;

  const c   = document.createElement('canvas');
  c.width   = Math.floor(w * dpr);
  c.height  = Math.floor(h * dpr);
  if (!c.width || !c.height) return null;

  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  for (const star of STARS) {
    const opacity = star.mag > 0.7 ? 0.90 : star.mag > 0.35 ? 0.70 : 0.50;
    const px = star.px * w;
    const py = star.py * h;
    // Soft halo for the brightest stars (mag > 0.85) — Gaussian-style radial glow.
    // Drawn first so the star disk composites on top with full opacity.
    if (star.mag > 0.85) {
      const grd = ctx.createRadialGradient(px, py, 0, px, py, star.r * 4);
      grd.addColorStop(0,   `rgba(220,210,255,${opacity * 0.35})`);
      grd.addColorStop(1,   'rgba(220,210,255,0)');
      ctx.globalAlpha = 1;
      ctx.fillStyle   = grd;
      ctx.beginPath();
      ctx.arc(px, py, star.r * 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = opacity;
    ctx.fillStyle   = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(px, py, star.r, 0, Math.PI * 2);
    ctx.fill();
  }
  _starCanvas = c;
  return c;
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
  if (!w || !h) return; // skip frame if container has no layout yet

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

  // ── Mask readiness check ─────────────────────────────────────────────────
  const mask = getSkyMaskSync();
  if (!mask) {
    if (_maskFailed) {
      if (typeof window !== 'undefined' && window.__twl_debug) window.__twl_debug.renderFails++;
      return; // mask failed permanently — skip render entirely
    }
    _pendingRenderArgs = { container, nightFactor, date };
    return; // mask still loading — defer (offscreen not committed = no partial frame)
  }

  // ── Contract 3: Offscreen commit — draw everything to buffer first ──────
  if (!_offscreen || _offscreen.width !== w || _offscreen.height !== h) {
    _offscreen = document.createElement('canvas');
    _offscreen.width = w;
    _offscreen.height = h;
  }
  const off = _offscreen.getContext('2d');
  off.clearRect(0, 0, w, h);

  // ── Stars — single drawImage from pre-rendered offscreen canvas ───────────────
  const starC = _buildStarCanvas(w, h);
  if (!starC || starC.width <= 0 || starC.height <= 0) return;
  off.globalAlpha = nightFactor * (0.6 + 0.4 * nightFactor);
  try {
    off.drawImage(starC, 0, 0, w, h);
  } catch (e) {
    console.warn('[nightSky] drawImage failed:', e);
  }
  off.globalAlpha = 1;

  // ── Moon ──────────────────────────────────────────────────────────────────
  const moonAge     = moonPhase(date);
  const phase       = moonAge / 29.530588;
  const lunarBright = Math.sin(phase * Math.PI);
  const finalMoonOp = Math.min(0.92, (0.1 + lunarBright * 0.85) * nightFactor);

  if (finalMoonOp > 0.02) {
    const moonR = 18;
    const moonX = w * 0.72;
    const moonY = h * 0.12;

    off.globalAlpha = finalMoonOp;
    off.fillStyle   = '#FFF8E6';
    off.shadowColor = 'rgba(255,245,210,0.6)';
    off.shadowBlur  = 14;
    off.beginPath();
    off.arc(moonX, moonY, moonR, 0, Math.PI * 2);
    off.fill();
    off.shadowBlur = 0;

    if (lunarBright < 0.97) {
      const termX = moonX + Math.cos(phase * 2 * Math.PI) * moonR * 0.9;
      const grad  = off.createRadialGradient(termX, moonY, 0, termX, moonY, moonR * 1.4);
      grad.addColorStop(0,   'rgba(0,0,0,0.95)');
      grad.addColorStop(0.6, 'rgba(0,0,0,0.6)');
      grad.addColorStop(1,   'rgba(0,0,0,0)');
      off.globalCompositeOperation = 'destination-out';
      off.fillStyle = grad;
      off.beginPath();
      off.arc(moonX, moonY, moonR * 1.6, 0, Math.PI * 2);
      off.fill();
      off.globalCompositeOperation = 'source-over';
    }
  }

  // ── Clip to sky mask ──────────────────────────────────────────────────────
  off.globalAlpha = 1;
  off.globalCompositeOperation = 'destination-in';
  drawSkyMask(off, w, h);
  off.globalCompositeOperation = 'source-over';

  // ── COMMIT: atomic blit to visible canvas ─────────────────────────────────
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(_offscreen, 0, 0, w, h);
}

/**
 * Remove the night-sky canvas from the container.
 */
export function removeNightSky(container) {
  container?.querySelector(`#${CANVAS_ID}`)?.remove();
}
