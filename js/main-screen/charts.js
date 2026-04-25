// ═══════════════════════════════════════════
//  TWILIGHT — main-screen/charts.js
//  Inline DOM/SVG builders: score sparkline, parameter bars, twilight row.
//  Pure HTML-string builders — no DOM manipulation, no event handlers.
// ═══════════════════════════════════════════

import { scoreToBarStyle } from '../utils.js';
import { logoImg } from '../ui.js';

// ─────────────────────────────────────────
//  Score sparkline — tiny SVG trajectory chart
//  Shows score arc for ±3h around sunset event.
// ─────────────────────────────────────────
export function buildScoreSparkline(hourlyFull, sunsetStr, skyColors) {
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
  // Physics-driven peak color — matches week bar / score badge colors exactly.
  const pkColor = scoreToBarStyle(peakVal, skyColors).scoreColor;

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
//  Parameter progress bar builder
//  value: current value, max: scale max
//  optLo/optHi: optimal range boundaries
// ─────────────────────────────────────────
export function buildParamBar(label, value, max, optLo, optHi) {
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
export function buildTwilightRow(today) {
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
