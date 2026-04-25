// ═══════════════════════════════════════════
//  TWILIGHT — main-screen/sky-renderer.js
//  Live sky rendering subsystem: 30-second RAF loop, off-thread sky
//  canvas rendering (OffscreenCanvas Worker), score-color repaint, and
//  per-day physics-based sky color computation.
//
//  Extracted from main-screen.js to keep that orchestrator under 1100 lines.
//  Owns three module-level singletons: the active stop-fn ref, the night
//  sky hysteresis flag, and the screen-open timestamp (used by the night
//  vision auto-trigger).
// ═══════════════════════════════════════════

import { scoreToBarStyle } from '../utils.js';
import { updateDynamicGradient, getCardBgLuma } from '../ui.js';
import { getSunAngleDegrees } from '../engine/sun.js';
import { airMass as kastenyoungAirMass } from '../engine/physicsLayer.js';
import { computeSkyColor } from '../engine/skyColor.js';
import { renderSunDisk, removeSunDisk } from '../render/sunDisk.js';
import { renderCrepuscularRays, removeCrepuscularRays } from '../render/crepuscularRays.js';
import { renderSkyCanvas, removeSkyCanvas } from '../render/skyCanvas.js';
import { renderNightSky, removeNightSky } from '../render/nightSky.js';
import { getSkyMaskSync, getSkyMaskDimensions } from '../render/skyMask.js';
import { getState, isStale } from '../store.js';

let _stopLiveGradient = null;     // active cleanup fn while a gradient is running
let _nightSkyVisible = false;     // hysteresis flag to prevent flicker near threshold
let _screenOpenTime = 0;          // tracks how long the main screen has been open (night vision auto-trigger)

// ─────────────────────────────────────────
//  Cloud fractions for physics
// ─────────────────────────────────────────
// dayData carries raw cloud cover per layer as percentages (0–100) in
// _cloudLowRaw / _cloudMidRaw / _cloudHighRaw (set by score.js). Convert
// to the 0–1 fractions that atmosphere.js expects, defaulting to all-zero
// when a day is missing cloud data (backward-compatible clear sky).
function cloudFractionsFor(day) {
  return {
    low:  Math.max(0, Math.min(1, (day?._cloudLowRaw  ?? 0) / 100)),
    mid:  Math.max(0, Math.min(1, (day?._cloudMidRaw  ?? 0) / 100)),
    high: Math.max(0, Math.min(1, (day?._cloudHighRaw ?? 0) / 100)),
  };
}

// Shared scalar for all night effects (background dim, stars, moon).
// 0 at civil twilight (−6°), 1 at deep night (−26°).
function getNightFactor(elevDeg) {
  return Math.max(0, Math.min(1, (-elevDeg - 6) / 20));
}

// ─────────────────────────────────────────
//  Live physics-driven score colors
// ─────────────────────────────────────────
function _updateLiveScoreColors(skyColors, mainScore) {
  if (!skyColors?.horizon) return;
  const bgLuma = getCardBgLuma();

  // 1. Main gauge arc — neon color matches weekly forecast bar palette
  const barStyle = scoreToBarStyle(mainScore, skyColors);
  const mainColor = barStyle.scoreColor;
  const mainColorRgb = barStyle.scoreColorRgb;
  const [cr, cg, cb] = mainColorRgb.split(',').map(Number);
  const gaugeArc = document.querySelector('.gauge-arc-fill');
  if (gaugeArc) {
    gaugeArc.setAttribute('stroke', mainColor);
    gaugeArc.style.filter =
      `drop-shadow(0 0 5px ${mainColor}88) ` +
      `drop-shadow(0 0 12px ${mainColor}33)`;
  }
  const gaugeText = document.querySelector('.gauge-score-text');
  if (gaugeText) {
    gaugeText.setAttribute('fill', mainColor);
    gaugeText.style.filter =
      `drop-shadow(0 0 6px ${mainColor}66) ` +
      `drop-shadow(0 2px 4px rgba(0,0,0,0.80))`;
  }
  for (const stop of document.querySelectorAll('.gauge-grad-stop')) {
    stop.setAttribute('stop-color', `rgb(${cr},${cg},${cb})`);
  }
  const gaugeHalo = document.querySelector('.gauge-halo');
  if (gaugeHalo) gaugeHalo.setAttribute('stroke', `rgba(${cr},${cg},${cb},0.14)`);
  const gaugeBaseline = document.querySelector('.gauge-baseline');
  if (gaugeBaseline) {
    gaugeBaseline.setAttribute('stroke', `rgba(${cr},${cg},${cb},0.65)`);
    gaugeBaseline.style.filter = `drop-shadow(0 0 8px rgba(${cr},${cg},${cb},0.5)) drop-shadow(0 0 18px rgba(${cr},${cg},${cb},0.2))`;
  }
  // Update continuous score color + tier on gauge wrap
  const tier = mainScore >= 7 ? 'high' : mainScore >= 4 ? 'mid' : 'low';
  const gaugeWrap = document.querySelector('.score-gauge-wrap');
  if (gaugeWrap) {
    gaugeWrap.style.setProperty('--score-color-rgb', mainColorRgb);
    gaugeWrap.dataset.scoreTier = tier;
  }

  // 2. Hourly scores, event scores, spot scores — ALL screens (text color)
  //    Week bar scores excluded — they use fixed cream-white for contrast
  for (const el of document.querySelectorAll('.hourly-score, .event-score-num, .spot-score-cell-main .spot-score-num')) {
    const s = parseFloat(el.textContent);
    if (!isNaN(s)) el.style.color = scoreToBarStyle(s, skyColors).scoreColor;
  }

  // 3. Week bar fills — update score-color glow on live sky tick
  //    (fill body is transparent — bg-sunset bleeds through; only the glow tint changes)
  for (const el of document.querySelectorAll('.week-bar-fill')) {
    const scoreEl = el.querySelector('.week-bar-score');
    const s = scoreEl ? parseFloat(scoreEl.dataset.score ?? scoreEl.textContent) : NaN;
    if (!isNaN(s)) {
      const barStyle = scoreToBarStyle(s, skyColors);
      const track = el.closest('.week-bar-track');
      if (track) track.style.setProperty('--score-color-rgb', barStyle.scoreColorRgb);
    }
  }

  // 4. Score badges — score-color text + score-tinted glow wash
  for (const el of document.querySelectorAll('.score-badge:not(.score-badge-location)')) {
    const span = el.querySelector('span');
    const s = span ? parseFloat(span.textContent) : NaN;
    if (!isNaN(s)) {
      const bs = scoreToBarStyle(s, skyColors);
      const [nr, ng, nb] = bs.scoreColorRgb.split(',').map(Number);
      el.style.setProperty('--score-color-rgb', bs.scoreColorRgb);
      el.style.color = bs.scoreColor;                                                              // score color (not forced white)
      el.style.border = `1px solid rgba(${nr},${ng},${nb},0.35)`;
      el.style.background = `linear-gradient(to bottom,rgba(${nr},${ng},${nb},0.22) 0%,rgba(${nr},${ng},${nb},0.10) 100%)`;
      el.style.filter = '';
    }
  }

  // 5. Spot color strips + hero strips — background + --score-color-rgb for glow
  for (const el of document.querySelectorAll('.spot-color-strip, .spot-hero-strip')) {
    const card = el.closest('.spot-card, .spot-hero');
    const scoreEl = card?.querySelector('.score-badge:not(.score-badge-location) span');
    const s = scoreEl ? parseFloat(scoreEl.textContent) : NaN;
    if (!isNaN(s)) {
      const bs = scoreToBarStyle(s, skyColors);
      el.style.background = bs.scoreColor;
      el.style.setProperty('--score-color-rgb', bs.scoreColorRgb);
    }
  }

  // 6. Spot mini week bar fills — set --score-color-rgb on parent track
  for (const el of document.querySelectorAll('.spot-week-bar-fill')) {
    const scoreEl = el.parentElement?.querySelector('.spot-week-bar-score');
    const s = scoreEl ? parseFloat(scoreEl.textContent) : NaN;
    if (!isNaN(s)) {
      const barStyle = scoreToBarStyle(s, skyColors);
      const track = el.closest('.spot-week-bar-track');
      if (track) track.style.setProperty('--score-color-rgb', barStyle.scoreColorRgb);
    }
  }
}

// ─────────────────────────────────────────
//  Compute physics-based sky colours for a single day and attach them
//  to dayData.skyColors. score.js outputs only numerical scores +
//  physics parameters; the colour rendering pipeline lives here.
// ─────────────────────────────────────────
export function computeDaySkyColors(day) {
  if (!day) return;
  try {
    day.skyColors = computeSkyColor({
      solarElevation: day._solarElevation  ?? 3,
      airMass:        day.physicsContributions?.airMass ?? 10,
      turbidity:      day.turbidity        ?? 0.3,
      mieIntensity:   day.mieIntensity     ?? 0.5,
      rayleighSpread: day.rayleighSpread   ?? 0.5,
      humidity:       day._humidityRaw     ?? 50,
      angstromExp:    day.angstromExp      ?? 0,
      ozoneDU:        day.ozoneDU          ?? 300,
      clouds:         cloudFractionsFor(day),
      mieGrowth:      day.mieGrowthFactor  ?? 1,
    });
  } catch {
    day.skyColors = null;
  }
}

// ─────────────────────────────────────────
//  Force an immediate repaint of all score colors using the latest live
//  skyColors. Call after rendering a new screen.
// ─────────────────────────────────────────
export function repaintScoreColors(spotAvgScores) {
  const skyColors = getState().weekData?.[0]?.skyColors;
  if (!skyColors?.horizon) return;
  const mainScore = spotAvgScores?.[0] ?? getState().weekData?.[0]?.score ?? 5;
  _updateLiveScoreColors(skyColors, mainScore);
}

// ─────────────────────────────────────────
//  Mark the moment the main screen opened. Used by the night-vision
//  auto-trigger (activates only after >120 s on the screen).
// ─────────────────────────────────────────
export function markScreenOpened() {
  _screenOpenTime = Date.now();
}

// ─────────────────────────────────────────
//  Real-time sky gradient (30 s interval)
//
//  Starts a 30-second interval that recomputes the sky gradient using the
//  actual current solar elevation (not the pre-computed sunset-time
//  elevation). This keeps the background visually accurate during the
//  golden-hour / twilight window when the gradient changes quickly.
//
//  Falls back to today's pre-computed skyColors when no location is
//  available.
//
//  @param {Object} today              dayData for today (weekData[0])
//  @param {Object} loc                { lat, lon }
//  @param {*}      locGen             generation tag for stale-render cancel
//  @param {Function} getSpotAvgScores () => spotAvgScores | null  (closure
//                                     over the parent's _spotAvgScores)
// ─────────────────────────────────────────
export function startSkyGradient(today, loc, locGen, getSpotAvgScores) {
  // Stop any prior gradient first — defends against double-start from
  // refreshMainScores after initMainScreen.
  stopSkyGradient();

  const spotAvgScores = typeof getSpotAvgScores === 'function' ? getSpotAvgScores() : null;
  const displayScore = spotAvgScores?.[0] ?? today.score;
  // Only set screen open time on first call (not on refresh/re-render)
  if (!_screenOpenTime) _screenOpenTime = Date.now();

  // Track score tier for haptic crossing detection
  let _prevScoreTier = displayScore >= 7 ? 'high' : displayScore >= 4 ? 'mid' : 'low';
  let isReady = false;

  // ── Sky Worker setup (off-thread gradient rendering) ──
  const canOffscreen = typeof OffscreenCanvas !== 'undefined';
  let skyW = null;

  if (canOffscreen) {
    try {
      skyW = new Worker('./js/workers/skyWorker.js', { type: 'module' });
      // Transfer mask bitmap when ready
      const maskCanvas = getSkyMaskSync();
      if (maskCanvas) {
        const { photoW, photoH } = getSkyMaskDimensions();
        createImageBitmap(maskCanvas).then(bitmap => {
          skyW.postMessage({ type: 'init-mask', mask: bitmap, photoW, photoH }, [bitmap]);
        }).catch(() => { skyW = null; }); // fallback if bitmap creation fails
      }
      skyW.onmessage = ({ data: msg }) => {
        if (msg.type === 'frame') {
          const skyLayers = document.getElementById('sky-layers');
          const canvas = skyLayers?.querySelector('#sky-canvas');
          if (canvas) {
            const ctx = canvas.getContext('2d');
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(msg.bitmap, 0, 0, canvas.width, canvas.height);
          }
          msg.bitmap.close();
        }
      };
      skyW.onerror = () => { skyW = null; }; // fallback on any worker error
    } catch {
      skyW = null; // Worker creation failed — fallback to inline rendering
    }
  }

  function update() {
    // ── Location/state gate ──────────────────────────────────────────────────
    const state = getState();
    if (!state.locationResolved || !state.loc) return;
    if (locGen !== undefined && isStale(locGen)) return; // location changed → loop dead

    // ── State computation (pure, no try-catch) ─────────────────────────────
    let liveSkyColors  = today.skyColors ?? null;
    let liveElevDeg    = today._solarElevation ?? 0;
    let liveAirmass    = today.physicsContributions?.airMass ?? 10;

    if (loc?.lat != null && loc?.lon != null) {
      try {
        liveElevDeg = getSunAngleDegrees({ time: new Date(), lat: loc.lat, lon: loc.lon });
        liveAirmass = kastenyoungAirMass(Math.max(liveElevDeg, -6));
        liveSkyColors = computeSkyColor({
          solarElevation: liveElevDeg,
          airMass:        liveAirmass,
          turbidity:      today.turbidity      ?? 0.3,
          mieIntensity:   today.mieIntensity   ?? 0.5,
          rayleighSpread: today.rayleighSpread  ?? 0.5,
          humidity:       today._humidityRaw   ?? 50,
          angstromExp:    today.angstromExp    ?? 0,
          ozoneDU:        today.ozoneDU        ?? 300,
          clouds:         cloudFractionsFor(today),
          mieGrowth:      today.mieGrowthFactor ?? 1,
        });
      } catch (err) {
        if (typeof window !== 'undefined' && window.__twl_debug) window.__twl_debug.renderFails++;
        console.warn('[render] computeSkyColor failed:', err?.message);
      }
    }

    updateDynamicGradient(
      displayScore,
      today.turbidity ?? 0.3,
      today.palette?.style ?? '',
      liveSkyColors,
      today.goldenWindow?.beltOfVenus || 0
    );

    // Persist live skyColors back to weekData so other screens (spots, etc.)
    // pick up the real-time value on their next render.
    if (liveSkyColors) today.skyColors = liveSkyColors;

    // Live-tint all score elements with physics sky colors
    _updateLiveScoreColors(liveSkyColors, displayScore);

    // Score tier crossing — haptic pulse to signal entering prime time
    const newTier = displayScore >= 7 ? 'high' : displayScore >= 4 ? 'mid' : 'low';
    if (newTier !== _prevScoreTier) {
      if (newTier === 'high') {
        navigator.vibrate?.([10, 30, 10, 30, 10]); // triple pulse = entering prime time
      } else if (newTier === 'mid' && _prevScoreTier === 'high') {
        navigator.vibrate?.([20, 40, 20]);          // double pulse = leaving prime time
      }
      _prevScoreTier = newTier;
    }

    // Golden window start — escalating haptic
    if (today.goldenWindow?.windowStart) {
      // windowStart is produced as a Date by goldenWindow.js, but a round-trip
      // through JSON (cache deep-clone, localStorage rehydration, ensemble
      // averaging) turns it into an ISO string. Normalise both paths.
      const _ws = today.goldenWindow.windowStart;
      const gw  = _ws instanceof Date ? _ws
                : typeof _ws === 'string' ? new Date(_ws)
                : null;
      if (gw && !isNaN(gw.getTime())) {
        const gwMs = gw.getTime();
        const secsToGW = (gwMs - Date.now()) / 1000;
        if (secsToGW >= 0 && secsToGW < 35) { // within the 30s update window
          navigator.vibrate?.([30, 50, 60, 50, 90]); // escalating = "now"
        }
      }
    }

    // Solar elevation → --ui-sky-t: 0 at -6° (dark), 1 at +6° (bright golden hour)
    // Drives nav blur and glass recession via CSS calc()
    const skyT = Math.max(0, Math.min(1, (liveElevDeg + 6) / 12));
    document.documentElement.style.setProperty('--twl-dynamic-ui-sky-t', skyT.toFixed(3));

    const nf = getNightFactor(liveElevDeg);

    // ── Render side-effects — Contract 3: isolated stages ──────────────────
    // Each render stage is wrapped in its own try/catch so a failure in one
    // (e.g. nightSky) does not block others (skyCanvas, sunDisk, rays).
    // Each canvas render uses offscreen commit (Contract 3) so no partial frames.
    if (!isReady) return; // canvas not laid out yet — skip render

    // Stage 1: Background filter
    try {
      const bgEl = document.querySelector('.bg-sunset');
      if (bgEl) {
        const s = displayScore / 10;
        const sat   = s >= 0.8 ? 1.0
                    : s >= 0.5 ? 0.45 + (s - 0.5) / 0.3 * 0.55
                    :            0.08 + (s / 0.5) * 0.37;
        const brite = s >= 0.8 ? 1.0
                    : s >= 0.5 ? 0.82 + (s - 0.5) / 0.3 * 0.18
                    :            0.62 + (s / 0.5) * 0.20;
        const nightBrite = 1 - nf * 0.65;
        const minBrite   = 0.18 + 0.07 * (1 - nf);
        const finalBrite = Math.max(minBrite, brite * nightBrite);
        bgEl.style.filter = `saturate(${sat.toFixed(2)}) brightness(${finalBrite.toFixed(2)})`;
      }
    } catch (e) {
      console.warn('[render] bg filter:', e.message);
      if (window.__twl_debug) window.__twl_debug.renderFails++;
    }

    // Stage 2: Night sky (stars + moon)
    try {
      const skyLayersNight = document.getElementById('sky-layers');
      if (nf > 0.03) _nightSkyVisible = true;
      else if (nf < 0.01) _nightSkyVisible = false;
      if (_nightSkyVisible) {
        renderNightSky(skyLayersNight, nf, new Date());
      } else {
        removeNightSky(skyLayersNight);
      }
    } catch (e) {
      console.warn('[render] nightSky:', e.message);
      if (window.__twl_debug) window.__twl_debug.renderFails++;
    }

    // Stage 3: Night vision toggle
    try {
      const nvActive = liveElevDeg < -2 && (Date.now() - _screenOpenTime) > 120_000;
      document.body.classList.toggle('night-vision', nvActive);
      const nvIndicator = document.getElementById('nv-indicator');
      if (nvIndicator) nvIndicator.style.display = nvActive ? 'block' : 'none';
    } catch (e) {
      console.warn('[render] nightVision:', e.message);
      if (window.__twl_debug) window.__twl_debug.renderFails++;
    }

    // Stage 4: Sky canvas + sun disk + crepuscular rays
    const skyLayers = document.getElementById('sky-layers');
    if (skyLayers) {
      try {
        const sunAngle_rad = liveElevDeg * (Math.PI / 180);
        if (skyW) {
          // Off-thread: send params to worker (delta-gated inside worker)
          const _lw = skyLayers.offsetWidth || window.innerWidth;
          const _lh = skyLayers.offsetHeight || window.innerHeight;
          const _dpr = window.devicePixelRatio || 1;
          skyW.postMessage({
            type: 'render',
            sunAngle_rad,
            turbidity:    today.turbidity ?? 0.3,
            angstromExp:  today.angstromExp ?? 0,
            beltOfVenus:  today.goldenWindow?.beltOfVenus || 0,
            clouds:       cloudFractionsFor(today),
            mieGrowth:    today.mieGrowthFactor ?? 1,
            w: Math.round(_lw * _dpr),
            h: Math.round(_lh * _dpr),
          });
        } else {
          // Fallback: inline rendering (Safari, worker creation failure)
          renderSkyCanvas(
            skyLayers,
            sunAngle_rad,
            today.turbidity  ?? 0.3,
            today.angstromExp ?? 0,
            today.goldenWindow?.beltOfVenus || 0,
            cloudFractionsFor(today),
            today.mieGrowthFactor ?? 1,
          );
        }
      } catch (e) {
        console.warn('[render] skyCanvas:', e.message);
        if (window.__twl_debug) window.__twl_debug.renderFails++;
      }

      if (today._solarAzimuth != null) {
        try {
          renderSunDisk(skyLayers, {
            solarElevation: liveElevDeg,
            solarAzimuth:   today._solarAzimuth,
            turbidity:      today.turbidity    ?? 0.3,
            mieIntensity:   today.mieIntensity ?? 0.5,
            humidity:       today._humidityRaw ?? 50,
            airMass:        liveAirmass,
          });
        } catch (e) {
          console.warn('[render] sunDisk:', e.message);
          if (window.__twl_debug) window.__twl_debug.renderFails++;
        }

        try {
          const crepProb = today.scoreEngine?.crepuscularRays ?? 0;
          renderCrepuscularRays(skyLayers, crepProb, today._solarAzimuth,
            /* sunY approx from elevation */ 65 - liveElevDeg * 1.8);
        } catch (e) {
          console.warn('[render] crepRays:', e.message);
          if (window.__twl_debug) window.__twl_debug.renderFails++;
        }
      }
    }
  }

  // State-based readiness gate: poll rAF until sky-layers has valid dimensions.
  // A single rAF doesn't guarantee layout is final (fonts, CSS resize, mobile viewport).
  const skyLayers = document.getElementById('sky-layers');
  function tryInit() {
    if (skyLayers && skyLayers.offsetWidth > 0 && skyLayers.offsetHeight > 0) {
      isReady = true;
      update();
      return;
    }
    requestAnimationFrame(tryInit);
  }
  requestAnimationFrame(tryInit);

  const id = setInterval(update, 30_000);
  _stopLiveGradient = () => {
    clearInterval(id);
    if (skyW) { skyW.terminate(); skyW = null; }
    const skyLayers = document.getElementById('sky-layers');
    removeSkyCanvas(skyLayers);
    removeSunDisk(skyLayers);
    removeCrepuscularRays(skyLayers);
  };
}

// ─────────────────────────────────────────
//  Stop the active gradient (no-op if not running). Safe to call from
//  registerCleanup('main', stopSkyGradient).
// ─────────────────────────────────────────
export function stopSkyGradient() {
  if (_stopLiveGradient) {
    _stopLiveGradient();
    _stopLiveGradient = null;
  }
}
