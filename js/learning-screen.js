// ═══════════════════════════════════════════
//  TWILIGHT — learning-screen.js
//
//  Dedicated full-screen view of the self-learning system.
//  Every section has an expandable ? button with educational context
//  explaining the mechanism behind the data, not just the value itself.
//
//  Layout:
//    1. Header
//    2. "How it works" — expandable 4-phase EMA primer
//    3. KPI strip       — with educational accordion per metric
//    4. Accuracy chart  — predicted vs actual + tooltips
//    5. Bias panel      — forecast API corrections + conceptual intro
//    6. Histogram       — error distribution + statistical explanation
//    7. Params panel    — (advanced) learned weights with descriptions
//    8. Entries table   — (advanced) filterable history
//    9. Reset button
// ═══════════════════════════════════════════

import { showToast, isAdvancedMode } from './ui.js';
import { showScreen } from './nav.js';
import { getLearningStats, clearLearningData } from './engine/learningEngine.js';
import { getCalibrationStats } from './calibration.js';

// Session state for open accordions (lost on screen re-render, which is fine)
const _openSections = new Set();

// ─────────────────────────────────────────────
//  Public entry point
// ─────────────────────────────────────────────
export function initLearningScreen() {
  const container = document.getElementById('screen-learning');
  if (!container) return;

  const lStats = getLearningStats();
  const cStats = getCalibrationStats();

  container.innerHTML = buildShell(lStats, cStats);
  attachEvents(lStats);
}

// ─────────────────────────────────────────────
//  Shell HTML
// ─────────────────────────────────────────────
function buildShell(lStats, cStats) {
  const empty = lStats.sampleSize === 0;
  const adv = isAdvancedMode();

  if (empty) {
    return `
    <div class="learning-content">
      ${renderHeader()}
      ${renderHowItWorks()}
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
    ${renderHowItWorks()}
    ${renderNaturalSummary(lStats)}
    ${renderKPIs(lStats)}
    ${renderAccuracyChart(lStats)}
    ${renderBiasPanel(lStats)}
    ${renderHistogram(lStats)}
    ${adv ? renderParamsPanel(lStats) : ''}
    ${adv ? renderEntriesTable(lStats) : ''}
    ${renderResetBtn()}
  </div>`;
}

// ─────────────────────────────────────────────
//  Header
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
//  Edu-accordion section label helper
//  Renders:  [title text]  [?]
//            [hidden edu text — toggled on ? click]
// ─────────────────────────────────────────────
let _sectionCounter = 0;
function eduSection(title, eduHTML, opts = {}) {
  const id = `edu-${++_sectionCounter}`;
  const open = _openSections.has(id);
  return `
  <div class="edu-section-label">
    <span>${title}</span>
    <button class="edu-toggle-btn" data-edu="${id}" aria-expanded="${open}" aria-label="הסבר">?</button>
  </div>
  <div class="edu-explainer ${open ? 'open' : ''}" id="${id}">${eduHTML}</div>`;
}

// ─────────────────────────────────────────────
//  "How it works" — expandable EMA primer
// ─────────────────────────────────────────────
function renderHowItWorks() {
  const id = 'edu-how';
  const open = _openSections.has(id);
  return `
  <button class="how-it-works-btn glass" id="how-it-works-btn" data-edu="${id}" aria-expanded="${open}">
    <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/>
    </svg>
    <span>איך TWILIGHT לומדת?</span>
    <svg class="how-chevron ${open ? 'open' : ''}" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  </button>
  <div class="edu-explainer how-explainer ${open ? 'open' : ''}" id="${id}">
    <p>אחרי כל שקיעה, TWILIGHT משווה את מה שניבאה לבין נתוני מזג האוויר בפועל שנאספו בדיעבד. ההפרש בין הניבוי למציאות מזין את מנגנון הכיול.</p>
    <p>הלמידה מתבצעת ב-4 שלבים מצטברים, כל שלב מכוון היבט אחר של החישוב:</p>
    <div class="how-steps">
      <div class="how-step">
        <span class="how-step-num">①</span>
        <div>
          <strong>כיול כניסות</strong>
          <div class="how-step-desc">ממשקי מזג האוויר (Open-Meteo) לא תמיד מדויקים לאזורך. TWILIGHT לומדת האם ה-API מגזים או מזלזל בענן, לחות, נראות ואבק — ומתקנת את הנתונים לפני כל חישוב.</div>
        </div>
      </div>
      <div class="how-step">
        <span class="how-step-num">②</span>
        <div>
          <strong>כיול מודלים</strong>
          <div class="how-step-desc">לכל שקיעה פועל מודל אחד מתוך שלושה: עננים, אבק, או שמיים נקיים. כל מודל מקבל הטיה מתכווננת משלו כדי לפצות על נטיות שיטתיות.</div>
        </div>
      </div>
      <div class="how-step">
        <span class="how-step-num">③</span>
        <div>
          <strong>משקלי דרמה</strong>
          <div class="how-step-desc">הציון משלב ענן, אבק ואטמוספרה. המערכת לומדת מה תורם יותר לשקיעות יפות <em>במקומך</em> — לחוף הים יש פרופיל אחר מהגליל.</div>
        </div>
      </div>
      <div class="how-step">
        <span class="how-step-num">④</span>
        <div>
          <strong>עקומות הצלצול</strong>
          <div class="how-step-desc">לחות ~60% ואבק ~25µg/m³ נותנים שקיעות מיטביות בממוצע עולמי. אבל TWILIGHT לומדת את הערכים האופטימליים לאקלים המקומי שלך.</div>
        </div>
      </div>
    </div>
    <p class="how-ema-note">הלמידה מבוצעת באמצעות <strong>EMA — ממוצע נע אקספוננציאלי</strong>. כל דגימה חדשה משנה את הכיול ב-3–10% בלבד, כך שאין שינויים קיצוניים ממדידה בודדת אחת.</p>
  </div>`;
}

// ─────────────────────────────────────────────
//  Natural language summary
// ─────────────────────────────────────────────
function renderNaturalSummary(stats) {
  const n   = stats.sampleSize;
  const acc = stats.forecastAccuracy;
  const tr  = stats.trend;

  const parts = [];
  if (n < 15)       parts.push(`המערכת למדה רק מ-${n} שקיעות — עדיין מוקדם להסיק מסקנות`);
  else if (n < 40)  parts.push(`המערכת למדה מ-${n} שקיעות ועדיין מתכיילת`);
  else              parts.push(`המערכת למדה מ-${n} שקיעות`);

  if (acc != null) {
    if (acc >= 85)      parts.push(`הדיוק מצוין (${acc}%)`);
    else if (acc >= 70) parts.push(`הדיוק סביר (${acc}%)`);
    else                parts.push(`הדיוק עדיין נמוך (${acc}%) — צפוי להשתפר עם הזמן`);
  }

  if (tr === 'improving')      parts.push('ויש מגמת שיפור');
  else if (tr === 'worsening') parts.push('אבל יש מגמת ירידה');
  else if (n >= 20)            parts.push('והדיוק יציב');

  return `
  <div class="glass learning-summary">
    <div class="learning-summary-text">${parts.join(', ')}.</div>
  </div>`;
}

// ─────────────────────────────────────────────
//  KPI strip — with educational accordions
// ─────────────────────────────────────────────
function renderKPIs(stats) {
  const acc       = stats.forecastAccuracy;
  const accColor  = acc == null ? 'var(--cream-faint)'
                  : acc >= 85  ? 'var(--gold)'
                  : acc >= 70  ? '#ffd580'
                  :               '#ffaaaa';

  const trendIcon  = stats.trend === 'improving' ? '↗' : stats.trend === 'worsening' ? '↘' : '→';
  const trendColor = stats.trend === 'improving' ? '#aaffcc' : stats.trend === 'worsening' ? '#ffaaaa' : 'var(--cream-faint)';

  const accExplain = acc == null ? 'לא מספיק נתונים'
                   : acc >= 85  ? 'הניבויים קולעים ברוב המקרים'
                   : acc >= 70  ? 'דיוק סביר, המערכת ממשיכה ללמוד'
                   :              'המערכת עדיין לומדת את התנאים המקומיים';

  const sampleExplain = stats.sampleSize < 20  ? 'צריך לפחות 20 לדיוק טוב'
                       : stats.sampleSize < 50 ? 'מצטבר מאגר נתונים'
                       :                          'מאגר נתונים בוגר';

  const trendExplain = stats.trend === 'improving' ? 'הדיוק משתפר'
                     : stats.trend === 'worsening' ? 'ירידה לאחרונה'
                     :                                'הדיוק יציב';

  const confExplain = stats.confidence >= 80 ? 'ביטחון גבוה'
                    : stats.confidence >= 50 ? 'ביטחון בינוני'
                    :                           'עוד צריך נתונים';

  // Educational texts per KPI
  const kpiEdu = {
    accuracy: `נמדד כממוצע משוקלל של 4 פרמטרים: ענן, לחות, נראות ואבק. בכל דגימה, TWILIGHT בודקת כמה קרוב הניבוי שלה לנתוני מד האוויר בפועל שנאספו בדיעבד מתחנות מדידה. ציון 85%+ = טוב; 70–84% = סביר; מתחת ל-70% = עוד בכיול.`,
    samples:  `כל "דגימה" = שקיעה אחת שבה השווינו תחזית מקדימה למדידות בפועל. עד 10 דגימות — אין מספיק מידע לכיול אמין. בין 10 ל-50 — המערכת לומדת אבל עדיין לא התייצבה. מעל 50 — מאגר בוגר שמאפשר זיהוי דפוסים עונתיים.`,
    trend:    `מחושב כהשוואה בין הדיוק הממוצע של 10 הדגימות האחרונות לבין 10 שלפניהן. מגמת ירידה לא בהכרח בעיה — עשויה לנבוע משינוי עונה, כשהתנאים שהמערכת למדה קיץ שונים מחורף. היא תתכייל מחדש.`,
    conf:     `ציון מורכב: 70% מגיע מ"ביטחון כיול" (כמה עקביים ומעודכנים הפרמטרים הנלמדים) ו-30% מ"רמת פעילות" (כמה לאחרונה התבצעה דגימה). מתחת ל-50% = המערכת "ישנה" — לא עודכנה זמן רב.`,
  };

  const kpi = (id, val, color, label, sub, eduText) => {
    const eduId = `edu-kpi-${id}`;
    const open = _openSections.has(eduId);
    return `
    <div class="glass learning-kpi">
      <div class="kpi-header-row">
        <div class="kpi-value" style="color:${color}">${val}</div>
        <button class="edu-toggle-btn edu-toggle-sm" data-edu="${eduId}" aria-expanded="${open}">?</button>
      </div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-explain">${sub}</div>
      <div class="edu-explainer kpi-edu ${open ? 'open' : ''}" id="${eduId}">${eduText}</div>
    </div>`;
  };

  return `
  <div class="learning-kpi-grid">
    ${kpi('acc',    acc != null ? acc + '%' : '—', accColor,          'דיוק תחזית', accExplain,    kpiEdu.accuracy)}
    ${kpi('n',      stats.sampleSize,              'var(--cream)',     'דגימות',     sampleExplain, kpiEdu.samples)}
    ${kpi('trend',  trendIcon,                     trendColor,        'מגמה',       trendExplain,  kpiEdu.trend)}
    ${kpi('conf',   stats.confidence + '%',        'var(--gold)',      'ביטחון',     confExplain,   kpiEdu.conf)}
  </div>`;
}

// ─────────────────────────────────────────────
//  Accuracy chart — SVG with tap-tooltips
// ─────────────────────────────────────────────
function renderAccuracyChart(stats) {
  const ts = stats.timeSeries;
  if (!ts || ts.length < 2) {
    return `
    ${eduSection('דיוק לאורך זמן', 'הגרף יופיע לאחר איסוף מספיק דגימות.')}
    <div class="glass" style="padding:16px;text-align:center;font-size:11px;color:var(--cream-faint)">מצטברים נתונים…</div>`;
  }

  const W = 320, H = 140, padX = 8, padY = 12;
  const innerW = W - padX * 2;
  const innerH = H - padY * 2;
  const n = ts.length;
  const xStep = n > 1 ? innerW / (n - 1) : 0;
  const yScale = (v) => v == null ? null : padY + ((10 - v) / 9) * innerH;

  const buildPolyline = (key) => ts.map((e, i) => {
    const v = e[key]; const y = yScale(v);
    return y != null ? `${(padX + i * xStep).toFixed(1)},${y.toFixed(1)}` : null;
  }).filter(Boolean).join(' ');

  const predPts  = buildPolyline('predicted');
  const reconPts = buildPolyline('reconstructed');
  const ratingDots = ts.map((e, i) => {
    if (e.userRating == null) return '';
    const cx = (padX + i * xStep).toFixed(1);
    const cy = yScale(e.userRating).toFixed(1);
    return `<circle cx="${cx}" cy="${cy}" r="3" fill="#b39ddb"/>`;
  }).join('');

  const hitAreas = ts.map((e, i) => {
    const cx = padX + i * xStep;
    const pred  = e.predicted     != null ? e.predicted.toFixed(1)     : '—';
    const recon = e.reconstructed != null ? e.reconstructed.toFixed(1) : '—';
    const err   = (e.predicted != null && e.reconstructed != null)
      ? (e.predicted - e.reconstructed).toFixed(1) : '—';
    const dateStr = e.date ? e.date.slice(5) : '';
    return `<rect x="${(cx - 10).toFixed(1)}" y="0" width="20" height="${H}"
              fill="transparent" class="chart-hit"
              data-date="${dateStr}" data-pred="${pred}" data-recon="${recon}" data-err="${err}"/>`;
  }).join('');

  const grid = [3, 5, 7, 9].map(v => {
    const y = yScale(v).toFixed(1);
    return `<line x1="${padX}" y1="${y}" x2="${W-padX}" y2="${y}" stroke="rgba(245,220,180,0.08)" stroke-width="1" stroke-dasharray="2 4"/>
            <text x="${W-padX-2}" y="${y-2}" font-size="8" fill="rgba(245,220,180,0.35)" text-anchor="end">${v}</text>`;
  }).join('');

  const chartEdu = `
    <strong>קו זהב = מה TWILIGHT ניבאה.</strong> קו ירוק = מה שנמדד בפועל אחרי השקיעה.
    נקודות סגולות = הדירוג שנתת אחרי שיצאת לצפות. כשהקווים קרובים — הניבוי מדויק.
    פער גדול ביניהם = דגימה שהמערכת לומדת ממנה להבא.`;

  return `
  ${eduSection(`דיוק לאורך זמן (${n} דגימות אחרונות)`, chartEdu)}
  <div class="glass learning-chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="learning-chart" id="learning-accuracy-chart">
      ${grid}
      ${predPts  ? `<polyline points="${predPts}"  fill="none" stroke="var(--gold)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.92"/>` : ''}
      ${reconPts ? `<polyline points="${reconPts}" fill="none" stroke="#7eefb2"     stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" opacity="0.85"/>` : ''}
      ${ratingDots}
      ${hitAreas}
    </svg>
    <div id="chart-tooltip" class="chart-tooltip" style="display:none"></div>
    <div class="learning-legend">
      <span><span class="legend-line" style="background:var(--gold)"></span>ניבוי</span>
      <span><span class="legend-line" style="background:#7eefb2"></span>בפועל</span>
      <span><span class="legend-dot"  style="background:#b39ddb"></span>דירוג שלך</span>
    </div>
    <div class="chart-explain">לחץ על נקודה בגרף לפרטים</div>
  </div>`;
}

// ─────────────────────────────────────────────
//  Bias panel — with conceptual intro + scale meaning
// ─────────────────────────────────────────────
function renderBiasPanel(stats) {
  const { cloudBias, humidityBias, dustBias, visibilityBias } = stats.forecastBias;
  const adv = isAdvancedMode();

  const biasEdu = `
    <strong>למה יש הטיה?</strong> ממשקי מזג האוויר (Open-Meteo, ERA5) מבוססים על מודלים אזוריים
    בסקאלה של עשרות ק"מ. הם מדויקים ברמת מדינה, פחות ברמת שכונה. חוף הים מקבל לחות אחרת
    מהשפלה; בקעת ירדן חמה מהגליל. TWILIGHT מפצה על הטיות אלה בנפרד לכל פרמטר,
    בעזרת מקדם תיקון שמתעדכן אחרי כל שקיעה.`;

  const card = (label, val, paramHe) => {
    if (val == null) {
      return `
      <div class="glass bias-card">
        <div class="bias-label">${label}</div>
        <div class="bias-value" style="color:var(--cream-faint)">—</div>
        <div class="bias-hint">אין נתונים</div>
      </div>`;
    }
    const scale = 1 + val;
    const arrow = scale > 1.05 ? '↑' : scale < 0.95 ? '↓' : '✓';
    const color = (scale > 1.20 || scale < 0.80) ? '#ffaaaa'
                : (scale > 1.10 || scale < 0.90) ? '#ffd580'
                : '#aaffcc';

    // Directional human description
    let meaning;
    if (Math.abs(val) < 0.05) {
      meaning = `ה-API מדויק — אין תיקון נחוץ`;
    } else if (val > 0) {
      meaning = `ה-API מזלזל ב${paramHe} — TWILIGHT מגדילה את הנתון לפני החישוב`;
    } else {
      meaning = `ה-API מגזים ב${paramHe} — TWILIGHT מוצמתת את הנתון לפני החישוב`;
    }

    return `
    <div class="glass bias-card">
      <div class="bias-label">${label}</div>
      <div class="bias-value" style="color:${color}">${adv ? scale.toFixed(2) + '× ' : ''}${arrow}</div>
      <div class="bias-hint">${meaning}</div>
    </div>`;
  };

  return `
  ${eduSection('הטיית תחזית מול מציאות', biasEdu)}
  <div class="learning-bias-grid">
    ${card('ענן',    cloudBias,      'עננים')}
    ${card('לחות',  humidityBias,   'לחות')}
    ${card('אבק',   dustBias,       'אבק')}
    ${card('נראות', visibilityBias, 'נראות')}
  </div>`;
}

// ─────────────────────────────────────────────
//  Histogram — with statistical context
// ─────────────────────────────────────────────
function renderHistogram(stats) {
  const ts = stats.timeSeries;
  if (!ts || ts.length < 6) return '';

  const errors = ts
    .filter(e => e.predicted != null && e.reconstructed != null)
    .map(e => e.predicted - e.reconstructed);
  if (errors.length < 4) return '';

  const bins = [
    { lo: -5,   hi: -3,   count: 0, label: '−3<' },
    { lo: -3,   hi: -1.5, count: 0, label: '−2'  },
    { lo: -1.5, hi: -0.5, count: 0, label: '−1'  },
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

  const total      = errors.length;
  const centerBin  = bins[3].count;
  const centerPct  = Math.round(centerBin / total * 100);
  const avgErr     = (errors.reduce((s, e) => s + Math.abs(e), 0) / total).toFixed(1);
  const leftHeavy  = (bins[0].count + bins[1].count + bins[2].count) > (bins[4].count + bins[5].count + bins[6].count) * 1.5;
  const rightHeavy = (bins[4].count + bins[5].count + bins[6].count) > (bins[0].count + bins[1].count + bins[2].count) * 1.5;

  let summary;
  if (centerPct >= 50)        summary = `רוב הניבויים קולעים למטרה (${centerPct}% בטווח ±0.5 נקודות)`;
  else if (centerPct >= 30)   summary = `דיוק סביר — שגיאה ממוצעת ${avgErr} נקודות`;
  else                        summary = `שגיאה ממוצעת ${avgErr} נקודות — המערכת עדיין מתכיילת`;

  if (rightHeavy) summary += ` · נטייה לניבוי גבוה מהמציאות`;
  if (leftHeavy)  summary += ` · נטייה לניבוי נמוך מהמציאות`;

  const histEdu = `
    <strong>ציר X</strong> = הפרש בין הניבוי לבפועל, בנקודות ציון.
    עמודה ב-<strong>0</strong> = ניבוי מדויק.
    עמודה ב-<strong>+2</strong> = TWILIGHT ניבאה 2 נקודות <em>מעל</em> מה שהיה בפועל.
    <br><br>
    <strong>התפלגות בריאה</strong> נראית כפעמון סביב 0 — שגיאות לשני הכיוונים בשכיחות דומה.
    <strong>בעייתית</strong> = רוב העמודות לצד אחד = הטיה שיטתית שה-EMA עדיין מנסה לתקן.`;

  return `
  ${eduSection('התפלגות שגיאת תחזית', histEdu)}
  <div class="glass learning-hist-wrap">
    <div class="hist-explain">${summary}</div>
    <div class="learning-hist">${bars}</div>
    <div class="hist-axis-label">שגיאה (ניבוי − בפועל), נקודות</div>
  </div>`;
}

// ─────────────────────────────────────────────
//  Params panel — advanced, with descriptions
// ─────────────────────────────────────────────
function renderParamsPanel(stats) {
  const w  = stats.currentWeights;
  const mb = stats.modelBiases;

  const paramsEdu = `
    <strong>משקלי דרמה</strong> — נוסחת הדרמה משלבת שלושה מרכיבים:
    (ענן × w₁) + (אבק × w₂) + (אטמוספרה × w₃). ב-TWILIGHT המשקלים לא קבועים —
    היא לומדת מה תורם יותר לשקיעות יפות <em>במקומך</em> ספציפית.
    <br><br>
    <strong>עקומות הצלצול</strong> — לחות ~60% ואבק ~25µg/m³ נותנים שקיעות מיטביות
    לפי מחקרים אופטיים. אבל ישראל מגוונת — בחוף הים אולי 55% עדיף, בנגב אולי 45%.
    TWILIGHT לומדת את הנקודות האופטימליות לאזורך.
    <br><br>
    <strong>הטיות מודלים</strong> — כל אחד משלושת המודלים (עננים/אבק/שמיים נקיים)
    מקבל תיקון מספרי ייחודי. ערך חיובי = המודל ניבא גבוה מדי, צריך להוריד.`;

  const paramDescriptions = {
    cloudDramaW:      'כמה עוצמה לתת לעננים ביצירת צבע',
    dustDramaW:       'כמה עוצמה לתת לאירוסולי אבק וחלקיקים',
    atmosphereDramaW: 'כמה עוצמה לריילי-סקטרינג ולחות (שמיים נקיים)',
    humidityOptimum:  '% לחות שנותן את צבעי השמיים הכי עמוקים אצלך',
    dustOptimum:      'ריכוז אבק (µg/m³) שנותן זהב-כתום, לא עכירות',
    CloudModel:       'תיקון לנוסחה שמחשבת שקיעות ענן',
    DustModel:        'תיקון לנוסחה שמחשבת שקיעות אבק',
    ClearSkyModel:    'תיקון לנוסחה שמחשבת שקיעות שמיים נקיים',
  };

  const param = (key, label, val, def, unit = '') => {
    const numVal = parseFloat(val);
    const numDef = parseFloat(def);
    const diff = isNaN(numVal) || isNaN(numDef) ? 0 : Math.abs(numVal - numDef);
    const diffColor = diff < 0.02 ? '#aaffcc' : diff < 0.08 ? '#ffd580' : '#ffaaaa';
    const desc = paramDescriptions[key] ?? '';
    return `
    <div class="param-row">
      <div class="param-label-col">
        <span class="param-label">${label}</span>
        ${desc ? `<span class="param-desc">${desc}</span>` : ''}
      </div>
      <span class="param-value" style="color:${diffColor}">${val}${unit}</span>
      <span class="param-default">ברירת מחדל ${def}${unit}</span>
    </div>`;
  };

  return `
  ${eduSection('פרמטרים נלמדים', paramsEdu)}
  <div class="glass learning-params">
    <div class="param-group-title">משקלי דרמה</div>
    ${param('cloudDramaW',      'ענן',       w.cloudDramaW,      0.30)}
    ${param('dustDramaW',       'אבק',       w.dustDramaW,       0.27)}
    ${param('atmosphereDramaW', 'אטמוספרה', w.atmosphereDramaW, 0.27)}

    <div class="param-group-title">אופטימום בלי</div>
    ${param('humidityOptimum', 'לחות', w.humidityOptimum, 60, '%')}
    ${param('dustOptimum',     'אבק',  w.dustOptimum,     25, ' µg')}

    <div class="param-group-title">הטיית מודלים</div>
    ${param('CloudModel',    'Cloud',    (mb.CloudModel    > 0 ? '+' : '') + mb.CloudModel,    '0')}
    ${param('DustModel',     'Dust',     (mb.DustModel     > 0 ? '+' : '') + mb.DustModel,     '0')}
    ${param('ClearSkyModel', 'ClearSky', (mb.ClearSkyModel > 0 ? '+' : '') + mb.ClearSkyModel, '0')}
  </div>`;
}

// ─────────────────────────────────────────────
//  Entries table — advanced, with filter
// ─────────────────────────────────────────────
function renderEntriesTable(stats) {
  const ts = stats.timeSeries;
  if (!ts || ts.length === 0) return '';

  return `
  <div class="settings-section-label" style="margin-top:6px">היסטוריית דגימות (${ts.length})</div>
  <div class="entries-filter-row">
    <button class="entries-filter-btn active" data-filter="all">הכל</button>
    <button class="entries-filter-btn" data-filter="high-error">שגיאה גבוהה</button>
    <button class="entries-filter-btn" data-filter="rated">עם דירוג</button>
  </div>
  <div class="glass entries-table" id="entries-table-wrap">
    <div class="entries-row entries-head">
      <div class="entries-cell entries-date">תאריך</div>
      <div class="entries-cell entries-pred">ניבוי</div>
      <div class="entries-cell entries-actual">בפועל</div>
      <div class="entries-cell entries-err">שגיאה</div>
      <div class="entries-cell entries-rating">דירוג</div>
    </div>
    <div class="entries-scroll" id="entries-scroll">${buildRows(ts, 'all')}</div>
  </div>`;
}

function buildRows(ts, filter) {
  return ts.slice().reverse().filter(e => {
    if (filter === 'high-error') {
      const err = (e.predicted != null && e.reconstructed != null)
        ? Math.abs(e.predicted - e.reconstructed) : 0;
      return err >= 1.5;
    }
    if (filter === 'rated') return e.userRating != null;
    return true;
  }).map(e => {
    const err = (e.predicted != null && e.reconstructed != null)
      ? Math.round((e.predicted - e.reconstructed) * 10) / 10 : null;
    const errStr   = err == null ? '—' : (err > 0 ? '+' : '') + err.toFixed(1);
    const errColor = err == null ? 'var(--cream-faint)'
                   : Math.abs(err) < 0.5 ? '#aaffcc'
                   : Math.abs(err) < 1.5 ? '#ffd580'
                   :                        '#ffaaaa';
    const rowClass = (err != null && Math.abs(err) >= 2) ? ' entries-row-bad' : '';
    const dateShort = e.date ? e.date.slice(5) : '—';
    return `
      <div class="entries-row${rowClass}">
        <div class="entries-cell entries-date">${dateShort}</div>
        <div class="entries-cell entries-pred">${e.predicted     != null ? e.predicted.toFixed(1)     : '—'}</div>
        <div class="entries-cell entries-actual">${e.reconstructed != null ? e.reconstructed.toFixed(1) : '—'}</div>
        <div class="entries-cell entries-err" style="color:${errColor}">${errStr}</div>
        <div class="entries-cell entries-rating">${e.userRating != null ? e.userRating.toFixed(1) : '—'}</div>
      </div>`;
  }).join('');
}

// ─────────────────────────────────────────────
//  Reset button
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
function attachEvents(lStats) {
  const screen = document.getElementById('screen-learning');

  screen?.addEventListener('click', (e) => {
    // Back button
    if (e.target.closest('#learning-back-btn')) {
      showScreen('settings');
      return;
    }

    // Reset button
    if (e.target.closest('#learning-reset-btn')) {
      if (!confirm('לאפס את כל נתוני הלמידה? לא ניתן לשחזור.')) return;
      clearLearningData();
      _openSections.clear();
      showToast('נתוני הלמידה אופסו', 'info');
      initLearningScreen();
      return;
    }

    // Any ? / how-it-works accordion toggle
    const btn = e.target.closest('[data-edu]');
    if (btn) {
      e.stopPropagation();
      const id = btn.dataset.edu;
      const panel = document.getElementById(id);
      if (!panel) return;

      const isOpen = _openSections.has(id);
      if (isOpen) {
        _openSections.delete(id);
        panel.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        // rotate chevron back if how-it-works
        const chevron = screen.querySelector('.how-chevron');
        if (chevron && id === 'edu-how') chevron.classList.remove('open');
      } else {
        _openSections.add(id);
        panel.classList.add('open');
        btn.setAttribute('aria-expanded', 'true');
        const chevron = screen.querySelector('.how-chevron');
        if (chevron && id === 'edu-how') chevron.classList.add('open');
      }
      return;
    }
  });

  // Chart tooltips
  const chart   = document.getElementById('learning-accuracy-chart');
  const tooltip = document.getElementById('chart-tooltip');
  if (chart && tooltip) {
    chart.querySelectorAll('.chart-hit').forEach(rect => {
      rect.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const d = rect.dataset;
        tooltip.innerHTML = `<strong>${d.date}</strong><br>ניבוי: ${d.pred} · בפועל: ${d.recon}<br>הפרש: ${d.err}`;
        tooltip.style.display = 'block';
        const chartRect = chart.getBoundingClientRect();
        tooltip.style.left = Math.min(ev.clientX - chartRect.left, chartRect.width - 140) + 'px';
      });
    });
    screen?.addEventListener('click', () => { tooltip.style.display = 'none'; });
  }

  // Table filter buttons (advanced mode)
  const filterBtns = document.querySelectorAll('.entries-filter-btn');
  const scrollWrap  = document.getElementById('entries-scroll');
  if (filterBtns.length && scrollWrap && lStats) {
    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        scrollWrap.innerHTML = buildRows(lStats.timeSeries, btn.dataset.filter);
      });
    });
  }
}

// ✓ learning-screen.js — educational accordions v2
