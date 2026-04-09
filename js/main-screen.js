// ═══════════════════════════════════════════
//  TWILIGHT — main-screen.js v2
//  Cinematic: dynamic glow, progress bars, haptic
// ═══════════════════════════════════════════

import { scoreToColorContinuous, scoreToMetal, scoreToLabel, shortDate, buildGaugeArc, getSmartRecommendation, trendArrow, addMinutes, scoreToSkyColor } from './utils.js';
import { scheduleAlert, cancelAlert, getSavedAlerts, requestNotificationPermission } from './notifications.js';
import { logoImg, updateDynamicGradient, getCardBgLuma } from './ui.js';
import { recordUserRating, hasRatedToday } from './calibration.js';
import { haptic } from './nav.js';
import { initDebugPanel } from './debugPanel.js';
import { watchSunsetBearing } from './location.js';
import { getSunAngleDegrees } from './engine/sun.js';
import { airMass as kastenyoungAirMass } from './engine/physicsLayer.js';
import { computeSkyColor } from './engine/skyColor.js';
import { renderSunDisk, removeSunDisk } from './render/sunDisk.js';
import { renderCrepuscularRays, removeCrepuscularRays } from './render/crepuscularRays.js';
import { renderSkyCanvas, removeSkyCanvas } from './render/skyCanvas.js';

let _weekData = [];
let _city = '';
let _loc   = null;

// ─────────────────────────────────────────
//  Score → poetic Hebrew story label
//  Replaces the generic 'טוב מאוד' labels
//  with evocative descriptions for the gauge.
// ─────────────────────────────────────────
function scoreToStory(s) {
  const n = Number(s);
  if (n >= 9)   return 'שקיעת חלום';
  if (n >= 7.5) return 'ציור בשמיים';
  if (n >= 6)   return 'שווה לצאת';
  if (n >= 4)   return 'צבעים עמומים';
  if (n >= 2)   return 'שמיים עמומים';
  return 'שמיים אפורים';
}
let _spotAvgScores = null;
let _stopCompass = null;       // cleanup for DeviceOrientation listener
let _stopLiveGradient = null;  // cleanup for real-time gradient interval
let _countdownInterval = null;
let _compareIdx = -1; // index of first day selected for comparison
let _mainEventsAC = null; // AbortController for #screen-main delegated listeners

// ─────────────────────────────────────────
//  Cloud fractions for physics (Phase 1)
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

// ─────────────────────────────────────────
//  Live physics-driven score colors
// ─────────────────────────────────────────
function _updateLiveScoreColors(skyColors, mainScore) {
  if (!skyColors?.horizon) return;
  const bgLuma = getCardBgLuma();

  // 1. Main gauge arc + number
  const mainColor = scoreToSkyColor(mainScore, skyColors, bgLuma);
  const gaugeText = document.querySelector('.gauge-score-text');
  if (gaugeText) {
    gaugeText.setAttribute('fill', mainColor);
    gaugeText.style.filter = `drop-shadow(0 0 12px ${mainColor}44)`;
  }
  const gaugeArc = document.querySelector('.gauge-arc-fill');
  if (gaugeArc) {
    gaugeArc.setAttribute('stroke', mainColor);
    gaugeArc.style.filter = `drop-shadow(0 0 6px ${mainColor}66)`;
  }

  // 2. Week bar scores, hourly scores, event scores
  for (const el of document.querySelectorAll('#screen-main .week-bar-score, #screen-main .hourly-score, #screen-main .event-score-num')) {
    const s = parseFloat(el.textContent);
    if (!isNaN(s)) el.style.color = scoreToSkyColor(s, skyColors, bgLuma);
  }

  // 3. Daily card badges — text + border tint
  for (const el of document.querySelectorAll('#screen-main .score-badge')) {
    const span = el.querySelector('span');
    const s = span ? parseFloat(span.textContent) : NaN;
    if (!isNaN(s)) {
      const c = scoreToSkyColor(s, skyColors, bgLuma);
      el.style.color = c;
      el.style.borderColor = c + '55';
    }
  }

  // 4. Gauge glow — match physics color
  const gaugeWrap = document.querySelector('.score-gauge-wrap');
  if (gaugeWrap) gaugeWrap.style.setProperty('--glow-color', mainColor + '30');
}

// ─────────────────────────────────────────
//  Real-time sky gradient (30 s interval)
// ─────────────────────────────────────────

/**
 * Start a 30-second interval that recomputes the sky gradient using the
 * actual current solar elevation (not the pre-computed sunset-time elevation).
 *
 * This keeps the background visually accurate during the golden-hour /
 * twilight window when the gradient changes quickly.
 *
 * Falls back to today's pre-computed skyColors when no location is available.
 *
 * @param {Object} today  dayData for today (weekData[0])
 * @param {Object} loc    { lat, lon }
 * @returns {Function}  Cleanup function — call to stop the interval
 */
// Track how long the main screen has been open (for night vision auto-trigger)
let _screenOpenTime = 0;

function startLiveGradient(today, loc) {
  const displayScore = _spotAvgScores?.[0] ?? today.score;
  _screenOpenTime = Date.now();

  // Track score tier for haptic crossing detection
  let _prevScoreTier = displayScore >= 7 ? 'high' : displayScore >= 4 ? 'mid' : 'low';

  function update() {
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
      } catch (_) {
        // Silently fall back to pre-computed skyColors
      }
    }

    updateDynamicGradient(
      displayScore,
      today.turbidity ?? 0.3,
      today.palette?.style ?? '',
      liveSkyColors,
      today.goldenWindow?.beltOfVenus || 0
    );

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
      const _ws = today.goldenWindow.windowStart;
      const _wsStr = _ws instanceof Date
        ? `${String(_ws.getHours()).padStart(2,'0')}:${String(_ws.getMinutes()).padStart(2,'0')}`
        : String(_ws);
      const [gwH, gwM] = _wsStr.split(':').map(Number);
      const gwMs = new Date(today.date + 'T12:00:00').setHours(gwH, gwM, 0, 0);
      const secsToGW = (gwMs - Date.now()) / 1000;
      if (secsToGW >= 0 && secsToGW < 35) { // within the 30s update window
        navigator.vibrate?.([30, 50, 60, 50, 90]); // escalating = "now"
      }
    }

    // Solar elevation → --ui-sky-t: 0 at -6° (dark), 1 at +6° (bright golden hour)
    // Drives nav blur and glass recession via CSS calc()
    const skyT = Math.max(0, Math.min(1, (liveElevDeg + 6) / 12));
    document.documentElement.style.setProperty('--ui-sky-t', skyT.toFixed(3));

    // Score-driven photo mood: saturate + brightness of the background photo
    // reflects the day's forecast quality so the scene matches the prediction.
    //   score 8–10 → full vivid photo (sat 1.0, bright 1.0)
    //   score 5–7  → muted pastel  (sat 0.45, bright 0.82)
    //   score 0–4  → near-grey     (sat 0.08, bright 0.62)
    // Smooth lerp between tiers so there are no hard jumps.
    const bgEl = document.querySelector('.bg-sunset');
    if (bgEl) {
      const s = displayScore / 10; // 0..1
      const sat   = s >= 0.8 ? 1.0
                  : s >= 0.5 ? 0.45 + (s - 0.5) / 0.3 * 0.55
                  :            0.08 + (s / 0.5) * 0.37;
      const brite = s >= 0.8 ? 1.0
                  : s >= 0.5 ? 0.82 + (s - 0.5) / 0.3 * 0.18
                  :            0.62 + (s / 0.5) * 0.20;
      bgEl.style.filter = `saturate(${sat.toFixed(2)}) brightness(${brite.toFixed(2)})`;
    }

    // Night vision: auto-engage when sun is below -2° and screen open > 2 min
    const nvActive = liveElevDeg < -2 && (Date.now() - _screenOpenTime) > 120_000;
    document.body.classList.toggle('night-vision', nvActive);
    const nvIndicator = document.getElementById('nv-indicator');
    if (nvIndicator) nvIndicator.style.display = nvActive ? 'block' : 'none';

    // Canvas + sun disk + crepuscular rays — rendered into #sky-layers so the
    // canvas's `mix-blend-mode: soft-light` and the sun's `mix-blend-mode:
    // screen` both blend against the root backdrop (.bg-sunset + the canvas
    // that just painted), not against a nested stacking context.
    const skyLayers = document.getElementById('sky-layers');
    if (skyLayers) {
      renderSkyCanvas(
        skyLayers,
        liveElevDeg * (Math.PI / 180),
        today.turbidity  ?? 0.3,
        today.angstromExp ?? 0,
        today.goldenWindow?.beltOfVenus || 0,
        cloudFractionsFor(today),
        today.mieGrowthFactor ?? 1,
      );

      if (today._solarAzimuth != null) {
        renderSunDisk(skyLayers, {
          solarElevation: liveElevDeg,
          solarAzimuth:   today._solarAzimuth,
          turbidity:      today.turbidity    ?? 0.3,
          mieIntensity:   today.mieIntensity ?? 0.5,
          humidity:       today._humidityRaw ?? 50,
          airMass:        liveAirmass,
        });

        const crepProb = today.scoreEngine?.crepuscularRays ?? 0;
        renderCrepuscularRays(skyLayers, crepProb, today._solarAzimuth,
          /* sunY approx from elevation */ 65 - liveElevDeg * 1.8);
      }
    }
  }

  update(); // immediate first paint
  const id = setInterval(update, 30_000);
  return () => {
    clearInterval(id);
    const skyLayers = document.getElementById('sky-layers');
    removeSkyCanvas(skyLayers);
    removeSunDisk(skyLayers);
    removeCrepuscularRays(skyLayers);
  };
}

/**
 * Initialize and render the main screen
 */
/**
 * Compute physics-based sky colours for a single day and attach them to
 * dayData.skyColors.
 *
 * Moved here from score.js (3.3 — decouple scoring from rendering):
 * score.js now only outputs numerical scores and physics parameters; the
 * colour rendering pipeline lives entirely in the render layer.
 *
 * @param {Object} day  A dayData entry from calcWeekData()
 */
function computeDaySkyColors(day) {
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

export async function initMainScreen(loc, city, weekData, spotAvgScores = null) {
  _weekData = weekData;
  _city     = city;
  _loc      = loc;
  _spotAvgScores = spotAvgScores;

  // Render layer: compute sky colours for every day in the week.
  // (score.js only outputs numerical scores + physics params now)
  for (const day of weekData) computeDaySkyColors(day);

  // Clear any previous countdown, compass, live gradient, and night vision state
  if (_countdownInterval)   { clearInterval(_countdownInterval); _countdownInterval = null; }
  if (_stopCompass)         { _stopCompass(); _stopCompass = null; }
  if (_stopLiveGradient)    { _stopLiveGradient(); _stopLiveGradient = null; }
  document.body.classList.remove('night-vision');

  const container = document.getElementById('screen-main');
  if (!container) return;

  container.innerHTML = buildMainHTML(loc, city, weekData);
  attachMainEvents();
  startCountdown(weekData[0]);

  const today = weekData[0];
  if (today) {
    // Pulse 3: dynamic background gradient — live update every 30 s
    _stopLiveGradient = startLiveGradient(today, loc);

    // Pulse 1: debug panel — long-press on title to reveal
    initDebugPanel('.home-title', today, loc);

    // Pulse 4: azimuth compass — request permission (iOS 13+) then start
    if (today._solarAzimuth != null && window.DeviceOrientationEvent) {
      const ssAz = today._solarAzimuth;
      const startCompass = () => {
        const wrap = document.getElementById('compass-wrap');
        if (wrap) wrap.style.display = 'flex';
        _stopCompass = watchSunsetBearing(ssAz, ({ delta }) => {
          const arrow = document.getElementById('compass-arrow');
          if (arrow) arrow.style.transform = `rotate(${delta.toFixed(0)}deg)`;
        });
      };
      if (typeof DeviceOrientationEvent.requestPermission === 'function') {
        // iOS 13+ requires explicit user gesture — wire to compass-wrap tap
        const wrap = document.getElementById('compass-wrap');
        if (wrap) {
          wrap.style.display = 'flex';
          wrap.style.opacity = '0.45';
          wrap.title = 'הקש לאפשר גישה למצפן';
          wrap.addEventListener('click', () => {
            DeviceOrientationEvent.requestPermission().then(state => {
              if (state === 'granted') { wrap.style.opacity = ''; startCompass(); }
            }).catch(() => {});
          }, { once: true });
        }
      } else {
        startCompass();
      }
    }
  }
}

/**
 * Refresh main screen with new data
 */
export function refreshMain(weekData) {
  _weekData = weekData;
  const el = document.getElementById('week-bars');
  if (el) el.innerHTML = renderWeekBars(weekData);
  const scrollEl = document.getElementById('daily-scroll');
  if (scrollEl) scrollEl.innerHTML = renderDailyCards(weekData);
}

// ─────────────────────────────────────────
//  Countdown timer to next event
// ─────────────────────────────────────────
function startCountdown(today) {
  if (!today) return;
  const el = document.getElementById('countdown-timer');
  if (!el) return;

  function update() {
    const now = new Date();
    const todayDate = today.date; // 'YYYY-MM-DD'

    // Parse sunrise and sunset times
    const [srH, srM] = today.sunrise.split(':').map(Number);
    const [ssH, ssM] = today.sunset.split(':').map(Number);

    const sunriseTime = new Date(todayDate + 'T12:00:00');
    sunriseTime.setHours(srH, srM, 0, 0);
    const sunsetTime = new Date(todayDate + 'T12:00:00');
    sunsetTime.setHours(ssH, ssM, 0, 0);

    let target, label, icon;

    if (now < sunriseTime) {
      target = sunriseTime; label = 'זריחה בעוד'; icon = 'sunrise';
    } else if (now < sunsetTime) {
      target = sunsetTime; label = 'שקיעה בעוד'; icon = 'sunset';
    } else {
      // After sunset — show rating widget if not yet rated
      const todayDate = today.date;
      const alreadyRated = hasRatedToday(todayDate);

      if (alreadyRated) {
        el.innerHTML = `
          <div class="countdown-done">
            <div class="logo-circle-sm">${logoImg('twilight', 16)}</div>
            <span>תודה על הדירוג! נתראה מחר</span>
          </div>`;
      } else {
        el.innerHTML = `
          <div class="countdown-done" style="flex-direction:column;gap:8px">
            <div style="display:flex;align-items:center;gap:8px">
              <div class="logo-circle-sm">${logoImg('twilight', 16)}</div>
              <span>איך הייתה השקיעה?</span>
            </div>
            <div class="rating-stars" id="rating-stars">
              ${[1,2,3,4,5].map(n => `
                <button class="rating-star" data-rating="${n * 2}" title="${n * 2}/10">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </button>
              `).join('')}
            </div>
          </div>`;

        // Attach rating handlers directly (innerHTML is synchronous)
        document.querySelectorAll('#rating-stars .rating-star').forEach(btn => {
          btn.addEventListener('click', () => {
            const r = Number(btn.dataset.rating);
            recordUserRating(todayDate, r);
            el.innerHTML = `
              <div class="countdown-done">
                <div class="logo-circle-sm">${logoImg('twilight', 16)}</div>
                <span>דירגת ${r}/10 — תודה!</span>
              </div>`;
          });
        });
      }
      return;
    }

    const diff = target - now;
    const hours = Math.floor(diff / 3600000);
    const mins  = Math.floor((diff % 3600000) / 60000);
    const secs  = Math.floor((diff % 60000) / 1000);

    el.innerHTML = `
      <div class="countdown-row">
        <div class="logo-circle-sm">${logoImg(icon, 16)}</div>
        <span class="countdown-label">${label}</span>
        <span class="countdown-digits">${String(hours).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}</span>
      </div>`;
  }

  update();
  _countdownInterval = setInterval(update, 1000);
}

// ─────────────────────────────────────────
//  Score sparkline — tiny SVG trajectory chart
//  Shows score arc for ±3h around sunset event.
// ─────────────────────────────────────────
function buildScoreSparkline(hourlyFull, sunsetStr) {
  if (!hourlyFull || hourlyFull.length < 3) return '';

  // Find sunset index; if absent, use the highest-score hour
  let ssIdx = hourlyFull.findIndex(h => h.isSunset);
  if (ssIdx < 0) ssIdx = hourlyFull.reduce((best, h, i) => (h.score ?? 0) > (hourlyFull[best]?.score ?? 0) ? i : best, 0);

  // Take a 7-hour window centred on sunset (3h before, 3h after)
  const start = Math.max(0, ssIdx - 3);
  const end   = Math.min(hourlyFull.length - 1, ssIdx + 3);
  const slice = hourlyFull.slice(start, end + 1);
  if (slice.length < 2) return '';

  const scores  = slice.map(h => h.score ?? 0);
  const peakIdx = scores.indexOf(Math.max(...scores));
  const peakVal = scores[peakIdx];
  if (peakVal < 1) return '';

  const W = 240, H = 36, PAD = 4;
  const xStep = (W - PAD * 2) / (scores.length - 1);
  const yScale = (H - PAD * 2) / 10; // score 0-10

  const pts = scores.map((s, i) => {
    const x = PAD + i * xStep;
    const y = H - PAD - s * yScale;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  // Gradient fill area
  const areaPath = `M${PAD},${H} ` +
    scores.map((s, i) => `L${(PAD + i * xStep).toFixed(1)},${(H - PAD - s * yScale).toFixed(1)}`).join(' ') +
    ` L${(PAD + (scores.length - 1) * xStep).toFixed(1)},${H} Z`;

  // Peak dot
  const pkX = (PAD + peakIdx * xStep).toFixed(1);
  const pkY = (H - PAD - peakVal * yScale).toFixed(1);
  const pkColor = peakVal >= 7 ? '#F0B84A' : peakVal >= 4 ? '#D4820A' : 'rgba(245,230,200,0.5)';

  // Sunset marker vertical line
  const relSsIdx = ssIdx - start;
  const ssLineX  = (PAD + relSsIdx * xStep).toFixed(1);

  return `
    <div class="score-sparkline-wrap" title="מסלול הציון סביב השקיעה">
      <svg class="score-sparkline" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        <defs>
          <linearGradient id="spk-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${pkColor}" stop-opacity="0.25"/>
            <stop offset="100%" stop-color="${pkColor}" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <!-- sunset marker -->
        <line x1="${ssLineX}" y1="${PAD}" x2="${ssLineX}" y2="${H}"
              stroke="rgba(240,184,74,0.30)" stroke-width="1" stroke-dasharray="3,3"/>
        <!-- area fill -->
        <path d="${areaPath}" fill="url(#spk-fill)"/>
        <!-- line -->
        <polyline points="${pts}"
                  fill="none"
                  stroke="${pkColor}"
                  stroke-width="1.5"
                  stroke-linejoin="round"
                  stroke-linecap="round"
                  opacity="0.85"/>
        <!-- peak dot -->
        <circle cx="${pkX}" cy="${pkY}" r="3" fill="${pkColor}"/>
      </svg>
      <div class="sparkline-labels">
        <span>${slice[0].t}</span>
        <span style="color:${pkColor};font-weight:700">${peakVal.toFixed(1)}</span>
        <span>${slice[slice.length - 1].t}</span>
      </div>
    </div>`;
}

// ─────────────────────────────────────────
//  Tier-2 score explainer tray
//  Tap on .score-gauge-wrap → reveal 3 bars:
//    נראות (certainty), עוצמה (drama), ביטחון (confidence proxy)
// ─────────────────────────────────────────
function buildScoreExplainer(today) {
  const certainty  = today.certainty  ?? 0;          // 0-100, cloud clearance probability
  const drama      = today.dramaLevel ?? 0;           // 0-100, atmospheric color intensity
  // Confidence proxy: visibility (0-30 km → 0-100%) blended with cloud clearance
  const visConf    = Math.min(100, Math.round(today._visibilityRaw / 25 * 100));
  const confidence = Math.round(visConf * 0.55 + certainty * 0.45);

  const bar = (label, value, color) => `
    <div class="explainer-row">
      <span class="explainer-label">${label}</span>
      <div class="explainer-bar-track">
        <div class="explainer-bar-fill" style="width:${value}%;background:${color}"></div>
      </div>
      <span class="explainer-value">${value}%</span>
    </div>`;

  const paletteHe = today.palette?.styleHe ?? '';
  const modelLbl  = today.scoreModel
    ? ({ CloudModel: 'ענן', DustModel: 'אבק', ClearSkyModel: 'שמיים נקיים' }[today.scoreModel] ?? today.scoreModel)
    : 'ייסודי';

  return `
    <div class="score-explainer" id="score-explainer" hidden>
      ${bar('נראות',    certainty,  'var(--gold)')}
      ${bar('עוצמה',   drama,      '#E8803A')}
      ${bar('ביטחון',  confidence, '#8BA0C0')}
      ${paletteHe ? `<div class="explainer-model">מודל: ${paletteHe} · ${modelLbl}</div>` : `<div class="explainer-model">מודל: ${modelLbl}</div>`}
    </div>`;
}

// ─────────────────────────────────────────
//  Cloud coverage mini-chart (hourly gradient)
// ─────────────────────────────────────────
function renderCloudChart(hourlyFull) {
  if (!hourlyFull || !hourlyFull.length) return '';

  const segments = hourlyFull.map(h => {
    // 0% clouds → warm blue, 100% → dark grey
    const c = h.cloud;
    const r = Math.round(70 + c * 0.8);
    const g = Math.round(140 + c * -0.4);
    const b = Math.round(210 + c * -1.2);
    return `rgb(${Math.max(60,r)},${Math.max(60,g)},${Math.max(60,b)})`;
  });

  const gradientStops = segments.map((col, i) => {
    const pct = (i / (segments.length - 1)) * 100;
    return `${col} ${pct.toFixed(1)}%`;
  }).join(', ');

  // Find sunrise/sunset positions
  const srIdx = hourlyFull.findIndex(h => h.isSunrise);
  const ssIdx = hourlyFull.findIndex(h => h.isSunset);
  const total = hourlyFull.length;

  const markers = [];
  if (srIdx >= 0) markers.push({ pos: (srIdx / (total - 1)) * 100, label: '🌅', type: 'sr' });
  if (ssIdx >= 0) markers.push({ pos: (ssIdx / (total - 1)) * 100, label: '🌇', type: 'ss' });

  return `
    <div class="cloud-chart-wrap">
      <div class="cloud-chart-label">עננות לאורך היום</div>
      <div class="cloud-chart-bar-wrap">
        <div class="cloud-chart-bar" style="background:linear-gradient(to left, ${gradientStops})">
          ${markers.map(m => `
            <div class="cloud-chart-marker" style="right:${m.pos}%">
              <span>${m.label}</span>
            </div>
          `).join('')}
        </div>
        <div class="cloud-chart-labels">
          <span>${hourlyFull[0].t}</span>
          <span>${hourlyFull[hourlyFull.length - 1].t}</span>
        </div>
      </div>
    </div>`;
}

// ─────────────────────────────────────────
//  Parameter progress bar builder
//  value: current value, max: scale max
//  optLo/optHi: optimal range boundaries
// ─────────────────────────────────────────
function buildParamBar(label, value, max, optLo, optHi) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const inOptimal = value >= optLo && value <= optHi;
  const isBad = label === 'רוח' ? value > 30 : label === 'עננות' ? value > 75 : label === 'אבק' ? value > 60 : false;
  const cls = inOptimal ? 'optimal' : isBad ? 'poor' : 'neutral';
  const optLeftPct = (optLo / max) * 100;
  const optWidthPct = ((optHi - optLo) / max) * 100;

  return `
    <div class="param-bar-item">
      <div class="param-bar-label">${label}</div>
      <div class="param-bar-track">
        <div class="optimal-zone" style="right:${100 - optLeftPct - optWidthPct}%;width:${optWidthPct}%"></div>
        <div class="param-bar-fill ${cls}" style="width:${pct}%"></div>
      </div>
      <div class="param-bar-value">${Math.round(value)}</div>
    </div>`;
}

// ─────────────────────────────────────────
//  Unified twilight row — shows next relevant event with direction arrow
// ─────────────────────────────────────────
function buildTwilightRow(today) {
  const now = new Date();
  const [srH, srM] = today.sunrise.split(':').map(Number);
  const [ssH, ssM] = today.sunset.split(':').map(Number);
  const base = today.date + 'T12:00:00';
  const srTime = new Date(base); srTime.setHours(srH, srM, 0, 0);
  const ssTime = new Date(base); ssTime.setHours(ssH, ssM, 0, 0);

  // Determine which event is next
  const isSunriseNext = now < srTime;
  const arrow = isSunriseNext ? '↑' : '↓';
  const arrowColor = isSunriseNext ? 'var(--gold-light)' : '#F08040';
  const timeVal = today.twilight;

  return `
    <div class="time-row">
      <div class="logo-circle">${logoImg('twilight', 28)}</div>
      <div class="time-info">
        <div class="time-val" style="font-size:13px;display:flex;align-items:center;gap:4px">
          <span style="color:${arrowColor};font-size:15px;font-weight:700">${arrow}</span>
          ${timeVal}
        </div>
        <div class="time-lbl">חלון דמדומים</div>
      </div>
    </div>`;
}

// ─────────────────────────────────────────
//  Alert panel — 30/60/90 min toggles for a given day
// ─────────────────────────────────────────
function buildAlertPanel(dayData, scope) {
  if (!dayData) return '';
  const alerts = getSavedAlerts();
  const date = dayData.date;

  const btn = (event, mins, label) => {
    const key = `${date}-${event}-${mins}`;
    const active = alerts[key];
    return `<button class="alert-chip ${active ? 'alert-chip--on' : ''}"
      data-alert-key="${key}" data-date="${date}" data-event="${event}" data-mins="${mins}"
      data-scope="${scope}">
      ${label}
    </button>`;
  };

  return `
    <div class="alert-panel-inner">
      <div class="alert-panel-row">
        <span class="alert-panel-lbl">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--gold)" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          זריחה
        </span>
        ${btn('sunrise', 30, '30 דק׳')}
        ${btn('sunrise', 60, 'שעה')}
        ${btn('sunrise', 90, 'שעה וחצי')}
      </div>
      <div class="alert-panel-row">
        <span class="alert-panel-lbl">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#F08040" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          שקיעה
        </span>
        ${btn('sunset', 30, '30 דק׳')}
        ${btn('sunset', 60, 'שעה')}
        ${btn('sunset', 90, 'שעה וחצי')}
      </div>
    </div>`;
}

// ─────────────────────────────────────────
//  Build full HTML
// ─────────────────────────────────────────
function buildMainHTML(loc, city, weekData) {
  const today = weekData[0];
  if (!today) return '<div class="home-content"><p style="color:var(--cream)">שגיאה בטעינת נתונים</p></div>';

  const displayScore = _spotAvgScores?.[0] ?? today.score;
  const displayColor = scoreToSkyColor(displayScore, today.skyColors, getCardBgLuma());
  const displayLabel = scoreToStory(displayScore);

  const tomorrow = weekData[1] || null;
  const trend = trendArrow(today.score, tomorrow?.score);
  const recommendation = getSmartRecommendation(today);

  return `
  <div class="home-content">

    <!-- Top bar -->
    <div class="home-topbar">
      <div class="home-topbar-left">
        <div id="nv-indicator" class="nv-indicator" style="display:none" title="מצב ראיית לילה פעיל"></div>
        <div class="icon-btn" id="refresh-btn" title="רענן">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="color:var(--cream-faint)">
            <polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
          </svg>
        </div>
      </div>
      <div id="city-display" style="display:flex;align-items:center;gap:6px;cursor:pointer" title="לחץ לשינוי מיקום">
        <svg width="12" height="12" fill="var(--gold)" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/></svg>
        <span style="font-size:13px;color:var(--cream-faint);font-weight:600">${city}</span>
        <svg width="10" height="10" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      </div>
    </div>

    <!-- Location search bar (hidden by default, animated via .open class) -->
    <div id="location-search-bar" class="location-search-bar">
      <div class="loc-search-row1">
        <div class="search-input-wrap" style="flex:1">
          <svg width="14" height="14" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input id="location-search-input" class="search-input" type="text" placeholder="הקלד שם עיר..." dir="rtl" autocomplete="off" />
        </div>
        <button class="search-filter-btn" id="location-search-close" title="סגור">✕</button>
      </div>
      <div class="loc-search-row2">
        <button class="search-filter-btn loc-search-btn-wide" id="location-search-go">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          חפש מיקום
        </button>
        <button class="search-filter-btn loc-search-btn-wide" id="location-search-gps" title="מיקום GPS">
          <svg width="14" height="14" fill="var(--gold-light)" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
          מיקום נוכחי
        </button>
      </div>
    </div>

    <!-- Title -->
    <div class="home-title-block">
      <div class="home-title">TWILIGHT</div>
      <div class="home-subtitle">צבעי השמיים · 7 ימים קדימה</div>
    </div>


    <!-- ═══ TODAY SCORE CARD ═══ -->
    <div class="glass-strong score-card">
      <div class="score-top">
        <!-- Gauge arc (replaces plain number) -->
        <div class="score-gauge-wrap" data-score-tier="${displayScore >= 7 ? 'high' : displayScore >= 4 ? 'mid' : 'low'}">
          ${buildGaugeArc(displayScore, displayColor, 130)}
          <div class="score-desc">${displayLabel}</div>
          ${today.palette?.styleHe ? `<div class="palette-badge">✦ ${today.palette.styleHe}</div>` : ''}
          <!-- Trend arrow -->
          ${trend.arrow ? `
          <div class="trend-badge" style="${trend.css}">
            <span class="trend-arrow">${trend.arrow}</span>
            <span class="trend-label">${trend.label}</span>
          </div>` : ''}
        </div>

        <!-- Times column with rounded logos -->
        <div class="score-times">
          <div class="time-row">
            <div class="logo-circle">${logoImg('sunrise', 28)}</div>
            <div class="time-info">
              <div class="time-val">${today.sunrise}</div>
              <div class="time-lbl">זריחה</div>
            </div>
          </div>
          <div class="time-row">
            <div class="logo-circle">${logoImg('sunset', 28)}</div>
            <div class="time-info">
              <div class="time-val">${today.sunset}</div>
              <div class="time-lbl">שקיעה</div>
            </div>
          </div>
          ${buildTwilightRow(today)}
        </div>
      </div>

      <!-- Score trajectory sparkline -->
      ${buildScoreSparkline(today.hourlyFull, today.sunset)}

      <!-- Tier-2 explainer tray (tap gauge to reveal) -->
      ${buildScoreExplainer(today)}

      <!-- Countdown timer + alert bell -->
      <div class="countdown-bell-row">
        <div id="countdown-timer" class="countdown-wrap"></div>
        <button class="bell-btn" id="main-bell-btn" title="הגדר התראה">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        </button>
      </div>
      <!-- Alert panel (hidden by default) -->
      <div class="alert-panel" id="main-alert-panel" style="display:none">
        ${buildAlertPanel(today, 'main')}
      </div>

      <!-- Compass arrow (Pulse 4) — shown only when DeviceOrientation is available -->
      <div id="compass-wrap" class="compass-wrap" style="display:none">
        <div id="compass-arrow" class="compass-arrow" title="כיוון השקיעה">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
            <path d="M12 2L6 20l6-4 6 4L12 2z" fill="var(--gold)" opacity="0.9"/>
          </svg>
        </div>
        <span class="compass-label">כיוון השקיעה</span>
      </div>

      <!-- Smart recommendation -->
      <div class="recommendation-row">
        <span>${recommendation}</span>
      </div>

      <!-- Bottom stats row with progress fills -->
      <div class="score-stats-row">
        <div class="stat-pill" style="--fill-pct:${today._cloudRaw}%" ${today._cloudRaw >= 20 && today._cloudRaw <= 40 ? 'data-optimal="true"' : today._cloudRaw > 70 ? 'data-bad="true"' : ''}>
          <svg width="13" height="13" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/></svg>
          <span>${today.cloud}</span>
          <span class="stat-lbl">עננות</span>
        </div>
        <div class="stat-pill" style="--fill-pct:${today._humidityRaw}%" ${today._humidityRaw >= 40 && today._humidityRaw <= 60 ? 'data-optimal="true"' : today._humidityRaw > 80 ? 'data-bad="true"' : ''}>
          <svg width="13" height="13" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2a7 7 0 0 1 7 7c0 4-7 13-7 13S5 13 5 9a7 7 0 0 1 7-7z"/></svg>
          <span>${today.humidity}</span>
          <span class="stat-lbl">לחות</span>
        </div>
        <div class="stat-pill" style="--fill-pct:${Math.min(100, today._windRaw * 2.5)}%" ${today._windRaw < 10 ? 'data-optimal="true"' : today._windRaw > 30 ? 'data-bad="true"' : ''}>
          <svg width="13" height="13" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          <span>${today.wind}</span>
          <span class="stat-lbl">רוח</span>
        </div>
        <div class="stat-pill" style="--fill-pct:${Math.min(100, (today._visibilityRaw / 30) * 100)}%" ${today._visibilityRaw >= 20 ? 'data-optimal="true"' : today._visibilityRaw < 5 ? 'data-bad="true"' : ''}>
          <svg width="13" height="13" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="12" x2="16" y2="14"/></svg>
          <span>${today.visibility} ק״מ</span>
          <span class="stat-lbl">נראות</span>
        </div>
      </div>
    </div>

    <!-- 7-day bar chart -->
    <div class="glass" style="padding:16px 14px 12px">
      <div style="font-size:11px;font-weight:700;color:var(--gold);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:12px">7 ימים קרובים</div>
      <div id="week-bars" class="week-bars-wrap">
        ${renderWeekBars(weekData)}
      </div>
    </div>

    <!-- Daily accordion cards -->
    <div id="daily-scroll">
      ${renderDailyCards(weekData)}
    </div>

  </div>
  `;
}

// ─────────────────────────────────────────
//  Week bar chart
// ─────────────────────────────────────────
function renderWeekBars(weekData) {
  const dayLetters = ['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'];
  return weekData.map((d, i) => {
    let label;
    if (i === 0) label = 'היום';
    else if (i === 1) label = 'מחר';
    else {
      const dt = new Date(d.date + 'T12:00:00');
      label = dayLetters[dt.getDay()];
    }
    const ds = (_spotAvgScores != null && _spotAvgScores[i] != null) ? _spotAvgScores[i] : d.score;
    const metal = scoreToMetal(ds);
    return `
    <div class="week-bar-item" onclick="toggleDaily(${i})">
      <div class="week-bar-track">
        <div class="week-bar-fill" style="height:${ds * 10}%;background:${metal.gradient};box-shadow:0 0 8px ${metal.glow}55;position:relative;overflow:hidden;animation:barGrow 0.5s cubic-bezier(0.34,1.56,0.64,1) both;animation-delay:${i * 55}ms">
          <div style="position:absolute;inset:0;${metal.radial ? 'background:' + metal.radial : ''}"></div>
          <div style="position:absolute;top:0;left:0;width:20%;height:100%;background:linear-gradient(90deg,rgba(0,0,0,0.22) 0%,rgba(0,0,0,0) 100%)"></div>
          <div style="position:absolute;top:0;right:0;width:20%;height:100%;background:linear-gradient(270deg,rgba(0,0,0,0.22) 0%,rgba(0,0,0,0) 100%)"></div>
          <div style="position:absolute;top:0;left:10%;right:10%;height:45%;background:radial-gradient(ellipse 80% 100% at 50% 0%,rgba(255,255,255,0.30) 0%,rgba(255,255,255,0) 100%)"></div>
          <span class="week-bar-score" style="position:relative;z-index:1;color:${metal.text}">${ds.toFixed(1)}</span>
        </div>
      </div>
      <div class="week-bar-day">${label}</div>
      <div class="week-bar-date">${d.shortDate}</div>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────
//  Hourly forecast strip (full day)
// ─────────────────────────────────────────
function renderHourlyStrip(hourlyFull) {
  if (!hourlyFull || !hourlyFull.length) return '';

  const items = hourlyFull.map(h => {
    const cloudOpacity = Math.max(0.25, h.cloud / 100);
    const rainColor = h.rain >= 60 ? '#7EB8E8' : h.rain >= 30 ? '#A8C8D8' : 'var(--cream-faint)';
    let itemClass = 'hourly-item';
    if (h.isSunset)   itemClass += ' hourly-item--sunset';
    else if (h.isSunrise)  itemClass += ' hourly-item--sunrise';
    else if (h.isTwilight) itemClass += ' hourly-item--twilight';

    const eventDot = h.isSunset   ? `<div class="hourly-dot hourly-dot--sunset"></div>`
                   : h.isSunrise  ? `<div class="hourly-dot hourly-dot--sunrise"></div>`
                   : h.isTwilight ? `<div class="hourly-dot hourly-dot--twilight"></div>`
                   :                `<div class="hourly-dot"></div>`;

    const rainClass = h.rain >= 60 ? 'hourly-rain hourly-rain--heavy'
                    : h.rain >= 30 ? 'hourly-rain hourly-rain--medium'
                    :                'hourly-rain';

    return `
      <div class="${itemClass}">
        ${eventDot}
        <div class="hourly-time">${h.t}</div>
        <div class="hourly-temp">${h.temp}°</div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--cream)" stroke-width="1.5" opacity="${cloudOpacity}">
          <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z"/>
        </svg>
        <div class="${rainClass}">${h.rain}%</div>
        <div class="hourly-wind">${h.wind}</div>
        ${h.score != null
          ? `<div class="hourly-score" style="color:${scoreToColorContinuous(h.score)}">${h.score.toFixed(1)}</div>`
          : '<div class="hourly-score-spacer"></div>'
        }
      </div>`;
  }).join('');

  return `
    <div style="padding:0 16px 14px">
      <div style="font-size:10px;color:var(--gold);font-weight:700;letter-spacing:1px;margin-bottom:8px">תחזית שעתית</div>
      <div style="display:flex;gap:5px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch">
        ${items}
      </div>
    </div>`;
}

// ─────────────────────────────────────────
//  Daily accordion cards
// ─────────────────────────────────────────
function renderDailyCards(weekData) {
  return weekData.map((d, i) => {
    const ds = (_spotAvgScores != null && _spotAvgScores[i] != null) ? _spotAvgScores[i] : d.score;
    const dsMetal = scoreToMetal(ds);
    const dsColor = scoreToSkyColor(ds, d.skyColors, getCardBgLuma());
    return `
    <div class="glass daily-card" style="margin-bottom:8px">

      <!-- HEADER -->
      <div class="daily-header" onclick="toggleDaily(${i})" style="cursor:pointer;padding:14px 16px">
        <div style="display:flex;align-items:center;gap:10px">
          <div class="score-badge" style="background:${dsMetal.gradient};border:1px solid ${dsColor}55;color:${dsMetal.text};position:relative;overflow:hidden" ${ds >= 7 ? 'data-shimmer' : ''}><div style="position:absolute;inset:0;background:radial-gradient(ellipse 80% 100% at 50% 0%,rgba(255,255,255,0.25) 0%,rgba(255,255,255,0) 100%)"></div><span style="position:relative;z-index:1;font-size:13px">${ds.toFixed(1)}</span></div>
          <div>
            <div style="font-weight:700;font-size:15px;color:var(--cream)">${d.day} · ${d.shortDate}</div>
            <div style="font-size:11px;color:var(--cream-faint)">${d.cond}</div>
            <div style="display:flex;align-items:center;gap:4px;margin-top:3px">
              <div class="logo-circle-sm">${logoImg('twilight', 12)}</div>
              <span style="font-size:10px;color:var(--gold-light);font-weight:600">${d.twilight}</span>
            </div>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:6px">
          <button class="card-action-btn compare-btn" id="compare-btn-${i}" onclick="event.stopPropagation();window._compareDay(${i})"
                  title="השווה ימים">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="18"/><rect x="14" y="3" width="7" height="18"/></svg>
            <span>השווה</span>
          </button>
          <button class="card-action-btn" onclick="event.stopPropagation();window._shareDay(${i})"
                  title="שתף">
            <svg width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
            <span>שתף</span>
          </button>
          <button class="card-action-btn bell-btn" id="day-bell-btn-${i}" onclick="event.stopPropagation();window._toggleDayAlert(${i})"
                  title="הגדר התראה">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            <span>התראה</span>
          </button>
          <div class="chevron-icon" id="chevron-${i}" style="padding-right:2px">
            <svg width="14" height="14" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>
      </div>

      <!-- Alert panel (hidden until bell tapped) -->
      <div class="alert-panel" id="day-alert-panel-${i}" style="display:none">
        ${buildAlertPanel(d, `day-${i}`)}
      </div>

      <!-- EXPANDED CONTENT -->
      <div class="daily-expand" id="daily-expand-${i}">

        <!-- ① SCORES -->
        <div class="event-score-row">
          <div class="event-score-panel event-score-panel--sunrise">
            <div class="logo-circle">${logoImg('sunrise', 20)}</div>
            <div class="event-score-num" style="color:${scoreToSkyColor(d.srScore, d.skyColors, getCardBgLuma())}">${d.srScore.toFixed(1)}<span class="event-score-denom">/10</span></div>
            <div class="event-score-lbl">זריחה</div>
            <div class="event-score-time">${d.sunrise}</div>
          </div>
          <div class="event-score-panel event-score-panel--sunset">
            <div class="logo-circle">${logoImg('sunset', 20)}</div>
            <div class="event-score-num" style="color:${scoreToSkyColor(d.ssScore, d.skyColors, getCardBgLuma())}">${d.ssScore.toFixed(1)}<span class="event-score-denom">/10</span></div>
            <div class="event-score-lbl">שקיעה</div>
            <div class="event-score-time">${d.sunset}</div>
          </div>
          <div class="event-score-panel event-score-panel--twilight">
            <div class="logo-circle">${logoImg('twilight', 20)}</div>
            <div class="event-score-num" style="color:${scoreToSkyColor(d.twScore, d.skyColors, getCardBgLuma())}">${d.twScore.toFixed(1)}<span class="event-score-denom">/10</span></div>
            <div class="event-score-lbl">דמדומים</div>
            <div class="event-score-time event-score-time--gold">${d.twilight}</div>
          </div>
        </div>

        <!-- ② HOURLY FORECAST -->
        ${renderHourlyStrip(d.hourlyFull)}

        <!-- ③ Temp + condition -->
        <div class="daily-temp-row">
          <div>
            <span class="daily-temp-max">${d.temp}</span>
            <span class="daily-temp-min"> / ${d.tempMin}</span>
          </div>
          <div class="daily-cond">
            <div class="daily-cond-text">${d.cond}</div>
            <div class="daily-feels">תחושה ${d.feelsLike}</div>
          </div>
        </div>

        <!-- ④ Parameter progress bars -->
        <div class="param-bar-row">
          ${buildParamBar('עננות', d._cloudRaw, 100, 20, 40)}
          ${buildParamBar('לחות', d._humidityRaw, 100, 40, 60)}
          ${buildParamBar('נראות', d._visibilityRaw, 30, 15, 30)}
          ${buildParamBar('רוח', d._windRaw, 50, 0, 12)}
          ${d._dustRaw > 0 ? buildParamBar('אבק', d._dustRaw, 100, 10, 30) : ''}
        </div>

        <!-- ⑤ Stats grid -->
        <div class="fx-grid">
          ${[
            { lbl: 'רוח',        val: d.wind,                        sub: d.windDir   },
            { lbl: 'לחות',       val: d.humidity,                    sub: 'יחסית'     },
            { lbl: 'נראות',      val: d.visibility,                  sub: 'ק"מ'       },
            { lbl: 'עננות',      val: d.cloud,                       sub: 'כיסוי'     },
            { lbl: 'לחץ',        val: d.pressure.replace(' mb',''),   sub: 'mb'        },
            { lbl: 'שאבות',      val: d.windGusts,                   sub: 'מקס'       },
            { lbl: 'נקודת-טל',   val: d.dewPoint,                    sub: '°'         },
            { lbl: 'גשם',        val: d.rainProb,                    sub: d.rainMm    },
            { lbl: 'UV',          val: d.uvIndex,                     sub: 'מדד'       },
          ].map(c => `
            <div class="fx-cell">
              <div class="fx-cell-lbl">${c.lbl}</div>
              <div class="fx-cell-val">${c.val}</div>
              <div class="fx-cell-sub">${c.sub}</div>
            </div>
          `).join('')}
        </div>

        <!-- ⑥ Tags -->
        <div class="quality-tags">
          ${d.tags.map(t => {
            const isGood = t.includes('מעולה')||t.includes('מומלץ')||t.includes('טוב')||t.includes('נקי')||t.includes('מצוין')||t.includes('נוח')||t.includes('יבש')||t.includes('אופטימלי')||t.includes('צבעים')||t.includes('פריצת אור')||t.includes('אידאלית');
            const isBad  = t.includes('נמוכה')||t.includes('גבוהה')||t.includes('כבד')||t.includes('חזקה')||t.includes('חסימה')||t.includes('גשם')||t.includes('התעננות');
            const cls = isGood ? 'qtag-good' : isBad ? 'qtag-bad' : 'qtag-warn';
            return `<span class="qtag ${cls}">${t}</span>`;
          }).join('')}
        </div>

      </div>
    </div>
  `; }).join('');
}

// ─────────────────────────────────────────
//  Event handlers
// ─────────────────────────────────────────
function attachMainEvents() {
  // Abort any listeners attached during the previous render
  if (_mainEventsAC) _mainEventsAC.abort();
  _mainEventsAC = new AbortController();
  const { signal } = _mainEventsAC;
  // ─── Quick-alert FAB — thumb-zone shortcut for 30-min pre-sunset alert ───
  const fab     = document.getElementById('quick-alert-fab');
  const today   = _weekData[0];
  if (fab && today) {
    const minScore = (() => {
      try { return JSON.parse(localStorage.getItem('twl_settings') || '{}').minScore ?? 6; }
      catch { return 6; }
    })();
    const nowMs    = Date.now();
    const [ssH, ssM] = (today.sunset || '').split(':').map(Number);
    const sunsetMs = isNaN(ssH) ? 0 : new Date(today.date + 'T12:00:00').setHours(ssH, ssM, 0, 0);
    const worth    = today.score >= minScore && sunsetMs > nowMs;
    fab.hidden = !worth;

    fab.addEventListener('click', () => {
      haptic('medium');
      const triggerAt = new Date(sunsetMs - 30 * 60 * 1000);
      const key       = `${today.date}-sunset-30`;
      scheduleAlert(key, triggerAt, 'שקיעה בעוד 30 דקות', today.score, today.date);
      fab.hidden = true;
      window.dispatchEvent(new CustomEvent('twilight:toast', {
        detail: { msg: 'התראה נקבעה 30 דק׳ לפני שקיעה', type: 'success' }
      }));
    });
  }

  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      haptic('medium');
      window.dispatchEvent(new CustomEvent('twilight:refresh'));
    });
  }

  // ─── Location search toggle ───
  const cityDisplay = document.getElementById('city-display');
  const searchBar   = document.getElementById('location-search-bar');
  const searchInput = document.getElementById('location-search-input');
  const searchGo    = document.getElementById('location-search-go');
  const searchGps   = document.getElementById('location-search-gps');
  const searchClose = document.getElementById('location-search-close');

  if (cityDisplay && searchBar) {
    cityDisplay.addEventListener('click', () => {
      searchBar.classList.add('open');
      cityDisplay.style.visibility = 'hidden';
      searchInput?.focus();
    });
  }

  if (searchClose) {
    searchClose.addEventListener('click', () => {
      searchBar.classList.remove('open');
      cityDisplay.style.visibility = '';
    });
  }

  // Search by city name
  async function doLocationSearch() {
    const q = searchInput?.value.trim();
    if (!q) return;
    searchInput.disabled = true;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1&countrycodes=il&accept-language=he`,
        { headers: { 'User-Agent': 'TWILIGHT-PWA/1.0' }, signal: ctrl.signal }
      );
      clearTimeout(timer);
      const data = await res.json();
      if (data[0]) {
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        const name = data[0].display_name?.split(',')[0] || q;
        // Dispatch custom event with new location — app.js handles the rest
        window.dispatchEvent(new CustomEvent('twilight:setLocation', {
          detail: { lat, lon, city: name }
        }));
      } else {
        window.dispatchEvent(new CustomEvent('twilight:toast', { detail: { msg: 'מיקום לא נמצא', type: 'error' } }));
      }
    } catch {
      window.dispatchEvent(new CustomEvent('twilight:toast', { detail: { msg: 'שגיאה בחיפוש', type: 'error' } }));
    } finally {
      searchInput.disabled = false;
    }
  }

  searchGo?.addEventListener('click', doLocationSearch);
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLocationSearch();
  });

  // GPS button — re-detect location then refresh
  searchGps?.addEventListener('click', () => {
    searchBar.classList.remove('open');
    cityDisplay.style.visibility = '';
    window.dispatchEvent(new CustomEvent('twilight:refresh', { detail: { gps: true } }));
  });

  // ─── Score gauge tap → Tier-2 explainer tray ───
  const gaugeWrap    = document.querySelector('.score-gauge-wrap');
  const explainerEl  = document.getElementById('score-explainer');
  if (gaugeWrap && explainerEl) {
    gaugeWrap.style.cursor = 'pointer';
    gaugeWrap.addEventListener('click', () => {
      const open = !explainerEl.hidden;
      explainerEl.hidden = open;
      gaugeWrap.classList.toggle('gauge-explainer-open', !open);
      haptic('light');
    });
  }

  // ─── Main bell toggle ───
  const mainBell = document.getElementById('main-bell-btn');
  const mainAlertPanel = document.getElementById('main-alert-panel');
  if (mainBell && mainAlertPanel) {
    mainBell.addEventListener('click', () => {
      const open = mainAlertPanel.style.display !== 'none';
      mainAlertPanel.style.display = open ? 'none' : 'block';
      mainBell.classList.toggle('bell-btn--open', !open);
    });
  }

  // ─── Alert chip clicks (delegated) ───
  // Uses AbortController signal so the listener is removed on next initMainScreen call.
  document.getElementById('screen-main')?.addEventListener('click', async (e) => {
    const chip = e.target.closest('.alert-chip');
    if (!chip) return;
    e.stopPropagation();

    const { alertKey, date, event: evt, mins } = chip.dataset;
    const minNum = Number(mins);

    if (chip.classList.contains('alert-chip--on')) {
      cancelAlert(alertKey);
      chip.classList.remove('alert-chip--on');
      _refreshBellState(date);
    } else {
      const granted = await requestNotificationPermission();
      if (!granted) {
        window.dispatchEvent(new CustomEvent('twilight:toast', { detail: { msg: 'יש לאפשר התראות בדפדפן', type: 'error' } }));
        return;
      }
      // Find the event time from weekData
      const dayData = _weekData.find(d => d.date === date);
      if (!dayData) return;
      const timeStr = evt === 'sunrise' ? dayData.sunrise : dayData.sunset;
      const [h, m] = timeStr.split(':').map(Number);
      const eventDate = new Date(date + 'T12:00:00');
      eventDate.setHours(h, m, 0, 0);
      const triggerAt = new Date(eventDate.getTime() - minNum * 60000);
      if (triggerAt <= new Date()) {
        window.dispatchEvent(new CustomEvent('twilight:toast', { detail: { msg: 'הזמן כבר עבר', type: 'error' } }));
        return;
      }
      const label = evt === 'sunrise' ? 'זריחה' : 'שקיעה';
      const score = dayData.score;
      scheduleAlert(alertKey, triggerAt, `${minNum} דקות לפני ${label}`, score, date);
      chip.classList.add('alert-chip--on');
      _refreshBellState(date);
      window.dispatchEvent(new CustomEvent('twilight:toast', { detail: { msg: `התראה נקבעה ${minNum} דק׳ לפני ${label}`, type: 'success' } }));
    }
  }, { signal });
}

function _refreshBellState(date) {
  const alerts = getSavedAlerts();
  // Per-day bells
  _weekData.forEach((d, i) => {
    if (d.date !== date) return;
    const bell = document.getElementById(`day-bell-btn-${i}`);
    if (!bell) return;
    const hasAny = Object.keys(alerts).some(k => k.startsWith(date + '-'));
    bell.classList.toggle('bell-btn--active', hasAny);
  });
  // Main bell (today)
  if (_weekData[0]?.date === date) {
    const alerts2 = getSavedAlerts();
    const mainBell = document.getElementById('main-bell-btn');
    const hasAny = Object.keys(alerts2).some(k => k.startsWith(date + '-'));
    mainBell?.classList.toggle('bell-btn--active', hasAny);
  }
}

// ─────────────────────────────────────────
//  Per-day alert panel toggle
// ─────────────────────────────────────────
window._toggleDayAlert = function(i) {
  const panel = document.getElementById(`day-alert-panel-${i}`);
  const bell  = document.getElementById(`day-bell-btn-${i}`);
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'block';
  bell?.classList.toggle('bell-btn--open', !open);
};

// ─────────────────────────────────────────
//  Accordion toggle
// ─────────────────────────────────────────
window.toggleDaily = function(i) {
  const el = document.getElementById(`daily-expand-${i}`);
  const ch = document.getElementById(`chevron-${i}`);
  if (!el) return;

  const isOpen = el.classList.contains('open');

  if (isOpen) {
    el.style.maxHeight = el.scrollHeight + 'px';
    el.classList.remove('open');
    requestAnimationFrame(() => { el.style.maxHeight = '0'; });
    if (ch) ch.style.transform = '';
  } else {
    el.classList.add('open');
    el.style.maxHeight = el.scrollHeight + 'px';
    const onEnd = () => {
      el.style.maxHeight = 'none';
      el.removeEventListener('transitionend', onEnd);
    };
    el.addEventListener('transitionend', onEnd);
    if (ch) ch.style.transform = 'rotate(180deg)';
  }
};

// ─────────────────────────────────────────
//  Share a daily forecast (#17)
// ─────────────────────────────────────────
window._shareDay = function(i) {
  const d = _weekData[i];
  if (!d) return;
  const text = `${d.day} ${d.shortDate}: ${d.score}/10 — ${d.scoreLabel}\n` +
               `שקיעה: ${d.sunset}  |  ${d.cond}  |  עננות: ${d.cloud}`;
  if (navigator.share) {
    navigator.share({ title: 'TWILIGHT · תחזית שקיעה', text, url: window.location.href }).catch(() => {});
  } else if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      window.dispatchEvent(new CustomEvent('twilight:toast', { detail: { msg: 'הועתק ללוח', type: 'success' } }));
    }).catch(() => {});
  }
};

// ─────────────────────────────────────────
//  Day comparison (#18)
//  First click → highlight; second click → open overlay
// ─────────────────────────────────────────
window._compareDay = function(i) {
  if (_compareIdx === -1) {
    // First selection
    _compareIdx = i;
    document.querySelectorAll('.compare-btn').forEach((b, idx) => {
      b.style.opacity = idx === i ? '1' : '0.3';
      b.style.color = idx === i ? 'var(--gold)' : '';
    });
    haptic('light');
  } else if (_compareIdx === i) {
    // Deselect
    _compareIdx = -1;
    document.querySelectorAll('.compare-btn').forEach(b => { b.style.opacity = '0.55'; b.style.color = ''; });
  } else {
    // Second selection — open overlay
    _showCompareOverlay(_compareIdx, i);
    _compareIdx = -1;
    document.querySelectorAll('.compare-btn').forEach(b => { b.style.opacity = '0.55'; b.style.color = ''; });
  }
};

function _showCompareOverlay(iA, iB) {
  const a = _weekData[iA], b = _weekData[iB];
  if (!a || !b) return;

  const col = (d) => `
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;font-weight:800;color:var(--cream);margin-bottom:8px">${d.day} ${d.shortDate}</div>
      <div style="font-size:28px;font-weight:900;color:${scoreToSkyColor(d.score, d.skyColors, getCardBgLuma())};font-family:var(--font-title);line-height:1;margin-bottom:4px">${d.score.toFixed(1)}<span style="font-size:12px;color:var(--cream-faint)">/10</span></div>
      <div style="font-size:10px;color:var(--cream-faint);margin-bottom:10px">${d.scoreLabel}</div>
      ${[
        ['שקיעה', d.ssScore.toFixed(1), d.sunset],
        ['זריחה', d.srScore.toFixed(1), d.sunrise],
        ['עננות', d.cloud, ''],
        ['לחות',  d.humidity, ''],
        ['נראות', `${d.visibility} ק"מ`, ''],
        ['רוח',   d.wind, d.windDir],
      ].map(([lbl, val, sub]) => `
        <div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid rgba(245,220,180,0.07);font-size:11px">
          <span style="color:var(--cream-faint)">${lbl}</span>
          <span style="color:var(--cream);font-weight:700">${val} <span style="color:var(--cream-faint);font-weight:400">${sub}</span></span>
        </div>`).join('')}
      <div style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">
        ${(d.tags || []).slice(0, 4).map(t => `<span style="font-size:9px;padding:2px 6px;background:rgba(245,220,180,0.08);border-radius:6px;color:var(--cream-faint)">${t}</span>`).join('')}
      </div>
    </div>`;

  const overlay = document.createElement('div');
  overlay.id = 'compare-overlay';
  overlay.className = 'overlay-sheet';
  overlay.innerHTML = `
    <div style="width:100%;background:linear-gradient(180deg,#2a1505 0%,#1a0d03 100%);border-radius:24px 24px 0 0;padding:20px 16px 32px;max-height:85vh;overflow-y:auto">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <div style="font-size:12px;font-weight:700;color:var(--gold);letter-spacing:1px">השוואת ימים</div>
        <button id="compare-close" style="background:rgba(245,220,180,0.1);border:none;border-radius:50%;width:28px;height:28px;color:var(--cream);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center">✕</button>
      </div>
      <div style="display:flex;gap:12px;align-items:flex-start">
        ${col(a)}
        <div style="width:1px;background:rgba(245,220,180,0.12);align-self:stretch"></div>
        ${col(b)}
      </div>
    </div>`;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay || e.target.id === 'compare-close') overlay.remove();
  });
  haptic('medium');
}

// ─────────────────────────────────────────
//  Skeleton loading state
// ─────────────────────────────────────────
export function showMainSkeleton() {
  const container = document.getElementById('screen-main');
  if (!container) return;
  const bars = Array.from({ length: 7 }, (_, i) =>
    `<div class="skeleton-line" style="flex:1;height:${30 + Math.random() * 45}%;border-radius:6px 6px 0 0;animation-delay:${i * 60}ms"></div>`
  ).join('');
  container.innerHTML = `
  <div class="home-content" style="padding:52px 16px 110px;display:flex;flex-direction:column;gap:14px">

    <!-- top bar skeleton -->
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <div class="skeleton-line" style="width:120px;height:14px"></div>
      <div class="skeleton-line" style="width:80px;height:14px"></div>
    </div>

    <!-- score card skeleton -->
    <div class="skeleton-card" style="padding:20px 16px">
      <div style="display:flex;gap:16px;align-items:center">
        <div class="skeleton-line" style="width:80px;height:80px;border-radius:50%"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:10px">
          <div class="skeleton-line" style="height:18px;width:60%"></div>
          <div class="skeleton-line" style="height:13px;width:80%"></div>
          <div class="skeleton-line" style="height:13px;width:45%"></div>
        </div>
      </div>
    </div>

    <!-- week bars skeleton -->
    <div class="skeleton-card" style="padding:16px 14px 12px">
      <div class="skeleton-line" style="height:11px;width:90px;margin-bottom:14px"></div>
      <div class="skeleton-bar-row">${bars}</div>
    </div>

    <!-- daily cards skeleton -->
    ${Array.from({ length: 3 }, (_, i) => `
    <div class="skeleton-card" style="padding:14px 16px;animation-delay:${i * 80}ms">
      <div style="display:flex;align-items:center;gap:12px">
        <div class="skeleton-line" style="width:38px;height:38px;border-radius:10px;flex-shrink:0"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:8px">
          <div class="skeleton-line" style="height:14px;width:55%"></div>
          <div class="skeleton-line" style="height:11px;width:75%"></div>
        </div>
      </div>
    </div>`).join('')}
  </div>`;
}

// ✓ main-screen.js — complete
