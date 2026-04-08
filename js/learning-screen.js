// ═══════════════════════════════════════════
//  TWILIGHT — learning-screen.js
//
//  Dedicated full-screen view of the self-learning system.
//  Replaces the cramped sections that used to live inside
//  settings-screen.js (buildCalibrationSection / buildLearningSection).
//
//  Layout:
//    1. Header (back arrow + title)
//    2. KPI strip            — דיוק / דגימות / מגמה / ביטחון
//    3. Accuracy time chart  — full-width SVG, predicted vs actual
//    4. Forecast bias panel  — 4 cards: clouds, humidity, dust, visibility
//    5. Histogram            — recent vs older error distribution
//    6. Learned parameters   — drama weights, bell peaks, model biases
//    7. Entries table        — last 90 records, scrollable
//    8. Reset button
// ═══════════════════════════════════════════

import { showToast } from './ui.js';
import { showScreen } from './nav.js';
import { getLearningStats, clearLearningData } from './engine/learningEngine.js';
import { getCalibrationStats } from './calibration.js';

// ─────────────────────────────────────────────
//  Public entry point
// ─────────────────────────────────────────────
export function initLearningScreen() {
  const container = document.getElementById('screen-learning');
  if (!container) return;

  const lStats = getLearningStats();
  const cStats = getCalibrationStats();

  container.innerHTML = buildShell(lStats, cStats);
  attachEvents();
}

// ─────────────────────────────────────────────
//  Shell HTML
// ─────────────────────────────────────────────
function buildShell(lStats, cStats) {
  const empty = lStats.sampleSize === 0;

  if (empty) {
    return `
    <div class="learning-content">
      ${renderHeader()}
      <div class="glass" style="padding:24px;text-align:center;font-size:13px;color:var(--cream-faint);line-height:1.9">
        אין עדיין נתוני למידה.<br>
        המערכת תתחיל ללמוד אחרי 10 שקיעות עם נתוני מזג אוויר בפועל.<br>
        בינתיים — נסה לרענן את האפליקציה כדי לטעון את ה-seed ההיסטורי.
      </div>
    </div>`;
  }

  return `
  <div class="learning-content">
    ${renderHeader()}
    ${renderKPIs(lStats)}
    ${renderAccuracyChart(lStats)}
    ${renderBiasPanel(lStats)}
    ${renderHistogram(lStats)}
    ${renderParamsPanel(lStats)}
    ${renderEntriesTable(lStats)}
    ${renderResetBtn()}
  </div>`;
}

// ─────────────────────────────────────────────
//  Header — back arrow + title
// ─────────────────────────────────────────────
function renderHeader() {
  return `
  <div class="learning-header">
    <button class="learning-back-btn" id="learning-back-btn" aria-label="חזרה להגדרות">
      <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
    <div class="learning-title">מערכת הלמידה</div>
    <div style="width:36px"></div>
  </div>`;
}

// ─────────────────────────────────────────────
//  1. KPI strip
// ─────────────────────────────────────────────
function renderKPIs(stats) {
  const acc       = stats.forecastAccuracy;
  const accColor  = acc == null         ? 'var(--cream-faint)'
                  : acc >= 85           ? 'var(--gold)'
                  : acc >= 70           ? '#ffd580'
                  :                       '#ffaaaa';

  const trendIcon  = stats.trend === 'improving' ? '↗'
                   : stats.trend === 'worsening' ? '↘'
                   :                                '→';
  const trendColor = stats.trend === 'improving' ? '#aaffcc'
                   : stats.trend === 'worsening' ? '#ffaaaa'
                   :                                'var(--cream-faint)';

  return `
  <div class="learning-kpi-grid">
    <div class="glass learning-kpi">
      <div class="kpi-value" style="color:${accColor}">${acc != null ? acc + '%' : '—'}</div>
      <div class="kpi-label">דיוק תחזית</div>
    </div>
    <div class="glass learning-kpi">
      <div class="kpi-value" style="color:var(--cream)">${stats.sampleSize}</div>
      <div class="kpi-label">דגימות</div>
    </div>
    <div class="glass learning-kpi">
      <div class="kpi-value" style="color:${trendColor}">${trendIcon}</div>
      <div class="kpi-label">מגמה</div>
    </div>
    <div class="glass learning-kpi">
      <div class="kpi-value" style="color:var(--gold)">${stats.confidence}%</div>
      <div class="kpi-label">ביטחון</div>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────
//  2. Accuracy time chart — full-width SVG
// ─────────────────────────────────────────────
function renderAccuracyChart(stats) {
  const ts = stats.timeSeries;
  if (!ts || ts.length < 2) {
    return `
    <div class="settings-section-label">דיוק לאורך זמן</div>
    <div class="glass" style="padding:16px;text-align:center;font-size:11px;color:var(--cream-faint)">
      מצטברים נתונים…
    </div>`;
  }

  const W = 320, H = 140, padX = 8, padY = 12;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const n = ts.length;
  const xStep = n > 1 ? innerW / (n - 1) : 0;

  // y maps score 1..10 → top..bottom (1 at bottom, 10 at top)
  const yScale = (v) => v == null ? null : padY + ((10 - v) / 9) * innerH;

  const buildPolyline = (key) => {
    const pts = ts.map((e, i) => {
      const v = e[key];
      const y = yScale(v);
      return y != null ? `${(padX + i * xStep).toFixed(1)},${y.toFixed(1)}` : null;
    }).filter(Boolean).join(' ');
    return pts;
  };

  const predPts  = buildPolyline('predicted');
  const reconPts = buildPolyline('reconstructed');
  const ratingDots = ts.map((e, i) => {
    if (e.userRating == null) return '';
    const cx = (padX + i * xStep).toFixed(1);
    const cy = yScale(e.userRating).toFixed(1);
    return `<circle cx="${cx}" cy="${cy}" r="3" fill="#b39ddb"/>`;
  }).join('');

  // y-axis grid lines (3, 5, 7, 9)
  const grid = [3, 5, 7, 9].map(v => {
    const y = yScale(v).toFixed(1);
    return `<line x1="${padX}" y1="${y}" x2="${W - padX}" y2="${y}" stroke="rgba(245,220,180,0.08)" stroke-width="1" stroke-dasharray="2 4"/>
            <text x="${W - padX - 2}" y="${y - 2}" font-size="8" fill="rgba(245,220,180,0.35)" text-anchor="end">${v}</text>`;
  }).join('');

  return `
  <div class="settings-section-label">דיוק לאורך זמן (${n} דגימות אחרונות)</div>
  <div class="glass learning-chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="learning-chart">
      ${grid}
      ${predPts  ? `<polyline points="${predPts}"  fill="none" stroke="var(--gold)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>` : ''}
      ${reconPts ? `<polyline points="${reconPts}" fill="none" stroke="#7eefb2"     stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>` : ''}
      ${ratingDots}
    </svg>
    <div class="learning-legend">
      <span><span class="legend-line" style="background:var(--gold)"></span>תחזית</span>
      <span><span class="legend-line" style="background:#7eefb2"></span>בפועל</span>
      <span><span class="legend-dot"  style="background:#b39ddb"></span>דירוג משתמש</span>
    </div>
  </div>`;
}

// ─────────────────────────────────────────────
//  3. Forecast bias panel — 4 cards
// ─────────────────────────────────────────────
function renderBiasPanel(stats) {
  const { cloudBias, humidityBias, dustBias, visibilityBias } = stats.forecastBias;

  const card = (label, val, hint) => {
    if (val == null) {
      return `
      <div class="glass bias-card">
        <div class="bias-label">${label}</div>
        <div class="bias-value" style="color:var(--cream-faint)">—</div>
        <div class="bias-hint">אין נתונים</div>
      </div>`;
    }
    const scale = 1 + val;
    const arrow = scale > 1.05 ? '↑' : scale < 0.95 ? '↓' : '→';
    const color = (scale > 1.20 || scale < 0.80) ? '#ffaaaa'
                : (scale > 1.10 || scale < 0.90) ? '#ffd580'
                : '#aaffcc';
    return `
    <div class="glass bias-card">
      <div class="bias-label">${label}</div>
      <div class="bias-value" style="color:${color}">${scale.toFixed(2)}× ${arrow}</div>
      <div class="bias-hint">${hint}</div>
    </div>`;
  };

  const hintFor = (val, what) => {
    if (val == null) return '';
    if (Math.abs(val) < 0.05) return `התחזית מדויקת`;
    return val > 0
      ? `התחזית מאמדת חסר ${what}`
      : `התחזית מאמדת יתר ${what}`;
  };

  return `
  <div class="settings-section-label">הטיית תחזית מול מציאות</div>
  <div class="learning-bias-grid">
    ${card('ענן',    cloudBias,      hintFor(cloudBias, 'ענן'))}
    ${card('לחות',  humidityBias,   hintFor(humidityBias, 'לחות'))}
    ${card('אבק',   dustBias,       hintFor(dustBias, 'אבק'))}
    ${card('נראות', visibilityBias, hintFor(visibilityBias, 'נראות'))}
  </div>`;
}

// ─────────────────────────────────────────────
//  4. Error histogram — recent vs older
// ─────────────────────────────────────────────
function renderHistogram(stats) {
  const ts = stats.timeSeries;
  if (!ts || ts.length < 6) return '';

  const errors = ts
    .filter(e => e.predicted != null && e.reconstructed != null)
    .map(e => e.predicted - e.reconstructed);
  if (errors.length < 4) return '';

  // Bins: -5..-3, -3..-1.5, -1.5..-0.5, -0.5..0.5, 0.5..1.5, 1.5..3, 3..5
  const bins = [
    { lo: -5,   hi: -3,   count: 0, label: '-3<' },
    { lo: -3,   hi: -1.5, count: 0, label: '-2'  },
    { lo: -1.5, hi: -0.5, count: 0, label: '-1'  },
    { lo: -0.5, hi:  0.5, count: 0, label: '0'   },
    { lo:  0.5, hi:  1.5, count: 0, label: '+1'  },
    { lo:  1.5, hi:  3,   count: 0, label: '+2'  },
    { lo:  3,   hi:  5,   count: 0, label: '+3<' },
  ];
  for (const err of errors) {
    for (const b of bins) {
      if (err >= b.lo && err < b.hi) { b.count++; break; }
    }
  }

  const max = Math.max(...bins.map(b => b.count), 1);
  const bars = bins.map(b => {
    const heightPct = (b.count / max) * 100;
    return `
      <div class="hist-col">
        <div class="hist-bar" style="height:${heightPct}%"></div>
        <div class="hist-label">${b.label}</div>
      </div>`;
  }).join('');

  return `
  <div class="settings-section-label">התפלגות שגיאת תחזית</div>
  <div class="glass learning-hist-wrap">
    <div class="learning-hist">${bars}</div>
    <div class="hist-axis-label">שגיאה (תחזית − בפועל), נקודות</div>
  </div>`;
}

// ─────────────────────────────────────────────
//  5. Learned parameters
// ─────────────────────────────────────────────
function renderParamsPanel(stats) {
  const w  = stats.currentWeights;
  const mb = stats.modelBiases;

  const param = (label, val, def, unit = '') => `
    <div class="param-row">
      <span class="param-label">${label}</span>
      <span class="param-value">${val}${unit}</span>
      <span class="param-default">ברירת מחדל ${def}${unit}</span>
    </div>`;

  return `
  <div class="settings-section-label">פרמטרים נלמדים</div>
  <div class="glass learning-params">
    <div class="param-group-title">משקלי דרמה</div>
    ${param('ענן',       w.cloudDramaW,      0.30)}
    ${param('אבק',       w.dustDramaW,       0.27)}
    ${param('אטמוספרה', w.atmosphereDramaW, 0.27)}

    <div class="param-group-title">אופטימום בלי</div>
    ${param('לחות', w.humidityOptimum, 60, '%')}
    ${param('אבק',  w.dustOptimum,     25, ' µg')}

    <div class="param-group-title">הטיית מודלים</div>
    ${param('Cloud',    (mb.CloudModel    > 0 ? '+' : '') + mb.CloudModel,    '0')}
    ${param('Dust',     (mb.DustModel     > 0 ? '+' : '') + mb.DustModel,     '0')}
    ${param('ClearSky', (mb.ClearSkyModel > 0 ? '+' : '') + mb.ClearSkyModel, '0')}
  </div>`;
}

// ─────────────────────────────────────────────
//  6. Entries table — last 90, scrollable
// ─────────────────────────────────────────────
function renderEntriesTable(stats) {
  const ts = stats.timeSeries;
  if (!ts || ts.length === 0) return '';

  // Show newest first in the table
  const rows = ts.slice().reverse().map(e => {
    const err = (e.predicted != null && e.reconstructed != null)
      ? Math.round((e.predicted - e.reconstructed) * 10) / 10
      : null;
    const errStr   = err == null ? '—' : (err > 0 ? '+' : '') + err.toFixed(1);
    const errColor = err == null            ? 'var(--cream-faint)'
                   : Math.abs(err) < 0.5    ? '#aaffcc'
                   : Math.abs(err) < 1.5    ? '#ffd580'
                   :                          '#ffaaaa';
    const dateShort = e.date ? e.date.slice(5) : '—'; // MM-DD
    return `
      <div class="entries-row">
        <div class="entries-cell entries-date">${dateShort}</div>
        <div class="entries-cell entries-pred">${e.predicted != null ? e.predicted.toFixed(1) : '—'}</div>
        <div class="entries-cell entries-actual">${e.reconstructed != null ? e.reconstructed.toFixed(1) : '—'}</div>
        <div class="entries-cell entries-err" style="color:${errColor}">${errStr}</div>
        <div class="entries-cell entries-rating">${e.userRating != null ? e.userRating.toFixed(1) : '—'}</div>
      </div>`;
  }).join('');

  return `
  <div class="settings-section-label">היסטוריית דגימות (${ts.length})</div>
  <div class="glass entries-table">
    <div class="entries-row entries-head">
      <div class="entries-cell entries-date">תאריך</div>
      <div class="entries-cell entries-pred">תחזית</div>
      <div class="entries-cell entries-actual">בפועל</div>
      <div class="entries-cell entries-err">שגיאה</div>
      <div class="entries-cell entries-rating">דירוג</div>
    </div>
    <div class="entries-scroll">${rows}</div>
  </div>`;
}

// ─────────────────────────────────────────────
//  7. Reset button
// ─────────────────────────────────────────────
function renderResetBtn() {
  return `
  <div class="learning-reset-wrap">
    <button class="learning-reset-btn" id="learning-reset-btn">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M2.5 2v6h6M2.66 15.57a10 10 0 1 0 .57-4.3"/></svg>
      אפס נתוני למידה
    </button>
  </div>`;
}

// ─────────────────────────────────────────────
//  Events
// ─────────────────────────────────────────────
function attachEvents() {
  document.getElementById('learning-back-btn')?.addEventListener('click', () => {
    showScreen('settings');
  });

  document.getElementById('learning-reset-btn')?.addEventListener('click', () => {
    if (!confirm('לאפס את כל נתוני הלמידה? לא ניתן לשחזור.')) return;
    clearLearningData();
    showToast('נתוני הלמידה אופסו', 'info');
    initLearningScreen(); // re-render to show empty state
  });
}

// ✓ learning-screen.js — complete
