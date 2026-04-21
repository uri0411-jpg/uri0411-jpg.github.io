// ═══════════════════════════════════════════
//  TWILIGHT — learning-screen.js
//
//  Full-screen view of the self-learning system.
//  v3 — restructured for clarity, storytelling, and mobile readability.
//
//  Layout:
//    1. Header with freshness indicator
//    2. Today-influence banner (when bias corrections are actively applied)
//    3. "How it works" — expandable 4-phase primer (regular mode)
//    4. Natural-language summary
//    5. KPI strip with per-card story
//    6. Accuracy chart with RTL axis hints + tap-tooltips
//    7. Bias panel — always shows % + arrow
//    8. Histogram — ±0.5 center bin, softer skew heuristic
//    9. Per-location breakdown (≥2 buckets)
//   10. Biggest learning moments (Advanced, replaces raw table)
//   11. Params panel (Advanced)
//   12. Reset + Export buttons
// ═══════════════════════════════════════════

import { showToast, isAdvancedMode } from './ui.js';
import { showScreen } from './nav.js';
import { getLearningStats, clearLearningData } from './engine/learningEngine.js';
import { getCalibrationStats } from './calibration.js';

// Session state for open accordions (lost on screen re-render, which is fine)
const _openSections = new Set();

const LOC_LABELS_HE = {
  coast:   'חוף הים',
  north:   'צפון',
  central: 'מרכז',
  east:    'מזרח ובקעות',
  jerusalem: 'ירושלים',
};

const MODEL_LABELS_HE = {
  CloudModel:    'מודל עננים',
  DustModel:     'מודל אבק',
  ClearSkyModel: 'מודל שמיים נקיים',
};

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
      ${renderHeader(lStats)}
      ${renderHowItWorks(adv)}
      <div class="glass" style="padding:24px;text-align:center;font-size:13px;color:var(--cream-faint);line-height:1.9">
        אין עדיין נתוני למידה.<br>
        המערכת תתחיל ללמוד אחרי 10 שקיעות עם נתוני מזג אוויר בפועל.<br>
        בינתיים — נסה לרענן את האפליקציה כדי לטעון את ה-seed ההיסטורי.
      </div>
    </div>`;
  }

  return `
  <div class="learning-content">
    ${renderHeader(lStats)}
    ${renderTodayInfluence(lStats)}
    ${renderHowItWorks(adv)}
    ${renderNaturalSummary(lStats)}
    ${renderKPIs(lStats)}
    ${renderAccuracyChart(lStats)}
    ${renderBiasPanel(lStats)}
    ${renderHistogram(lStats)}
    ${renderPerLocationPanel(lStats)}
    ${adv ? renderBiggestMoments(lStats) : ''}
    ${adv ? renderParamsPanel(lStats) : ''}
    ${renderActionButtons(adv)}
  </div>`;
}

// ─────────────────────────────────────────────
//  Header with freshness indicator
// ─────────────────────────────────────────────
function renderHeader(lStats) {
  const freshLabel = formatFreshness(lStats.lastUpdated);
  return `
  <div class="learning-header">
    <button class="learning-back-btn" id="learning-back-btn" aria-label="חזרה להגדרות">
      <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
    <div class="learning-title">מערכת הלמידה</div>
    <div class="learning-fresh-chip" aria-label="עודכן לאחרונה ${freshLabel}">${freshLabel}</div>
  </div>`;
}

function formatFreshness(ts) {
  if (!ts) return 'טרם';
  const ms = Date.now() - ts;
  const days = Math.floor(ms / (24 * 3600 * 1000));
  const hours = Math.floor(ms / (3600 * 1000));
  if (days >= 30) return 'לפני חודש+';
  if (days >= 7)  return `לפני ${days} ימים`;
  if (days >= 2)  return `לפני ${days} ימים`;
  if (days === 1) return 'אתמול';
  if (hours >= 2) return `לפני ${hours} שעות`;
  if (hours === 1) return 'לפני שעה';
  return 'זה עתה';
}

// ─────────────────────────────────────────────
//  Today-influence banner — dynamic story about live corrections
// ─────────────────────────────────────────────
function renderTodayInfluence(stats) {
  if (!stats.activeInfluence) return '';

  const b = stats.forecastBias;
  const items = [];
  if (b.cloudBias     != null && Math.abs(b.cloudBias) >= 0.05)
    items.push(biasPhrase('עננות', b.cloudBias));
  if (b.humidityBias  != null && Math.abs(b.humidityBias) >= 0.05)
    items.push(biasPhrase('לחות', b.humidityBias));
  if (b.visibilityBias != null && Math.abs(b.visibilityBias) >= 0.05)
    items.push(biasPhrase('נראות', b.visibilityBias));
  if (b.dustBias      != null && Math.abs(b.dustBias) >= 0.05)
    items.push(biasPhrase('אבק', b.dustBias));
  if (items.length === 0) return '';

  const topItems = items.slice(0, 2).join(' · ');

  return `
  <div class="today-influence-banner glass" role="status">
    <div class="today-influence-icon" aria-hidden="true">
      <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="3"/>
        <path d="M12 1v6M12 17v6M4.22 4.22l4.24 4.24M15.54 15.54l4.24 4.24M1 12h6M17 12h6M4.22 19.78l4.24-4.24M15.54 8.46l4.24-4.24"/>
      </svg>
    </div>
    <div class="today-influence-body">
      <div class="today-influence-title">הלמידה משפיעה על התחזית שלך כרגע</div>
      <div class="today-influence-desc">${topItems}.</div>
    </div>
  </div>`;
}

function biasPhrase(paramHe, bias) {
  const pct = Math.round(bias * 100);
  if (pct > 0) return `${paramHe}: ה-API מזלזל ב-${pct}% — תיקנו כלפי מעלה`;
  return `${paramHe}: ה-API מגזים ב-${Math.abs(pct)}% — תיקנו כלפי מטה`;
}

// ─────────────────────────────────────────────
//  Edu-accordion helper
// ─────────────────────────────────────────────
let _sectionCounter = 0;
function eduSection(title, eduHTML, opts = {}) {
  const id = `edu-${++_sectionCounter}`;
  const open = _openSections.has(id);
  return `
  <div class="edu-section-label">
    <span>${title}</span>
    <button class="edu-toggle-btn" data-edu="${id}" aria-expanded="${open}" aria-label="הסבר על ${title}">?</button>
  </div>
  <div class="edu-explainer ${open ? 'open' : ''}" id="${id}">${eduHTML}</div>`;
}

// ─────────────────────────────────────────────
//  "How it works" primer — simplified for non-technical users
// ─────────────────────────────────────────────
function renderHowItWorks(adv) {
  const id = 'edu-how';
  const open = _openSections.has(id);
  return `
  <button class="how-it-works-btn glass" id="how-it-works-btn" data-edu="${id}" aria-expanded="${open}" aria-label="איך המערכת לומדת">
    <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/>
    </svg>
    <span>איך TWILIGHT לומדת?</span>
    <svg class="how-chevron ${open ? 'open' : ''}" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  </button>
  <div class="edu-explainer how-explainer ${open ? 'open' : ''}" id="${id}">
    <p>אחרי כל שקיעה, TWILIGHT משווה את מה שניבאה לבין נתוני מזג האוויר בפועל. ההפרש מזין את מנגנון הכיול — אם ניבאנו גבוה מדי שוב ושוב, המערכת מתאימה את עצמה.</p>
    <p>הלמידה מתבצעת ב-4 שלבים, כל אחד מכוון היבט אחר:</p>
    <div class="how-steps">
      <div class="how-step">
        <span class="how-step-num">①</span>
        <div>
          <strong>תיקון תחזיות</strong>
          <div class="how-step-desc">ממשקי מזג האוויר לא תמיד מדויקים לאזורך. TWILIGHT לומדת האם ה-API מגזים או מזלזל בענן, לחות, נראות ואבק — ומתקנת את הנתונים לפני כל חישוב.</div>
        </div>
      </div>
      <div class="how-step">
        <span class="how-step-num">②</span>
        <div>
          <strong>כיול מודלים</strong>
          <div class="how-step-desc">לכל שקיעה פועל מודל מתוך שלושה: עננים, אבק, או שמיים נקיים. כל מודל מקבל תיקון מספרי משלו כדי לפצות על נטיות שיטתיות.</div>
        </div>
      </div>
      <div class="how-step">
        <span class="how-step-num">③</span>
        <div>
          <strong>משקלי דרמה</strong>
          <div class="how-step-desc">הציון משלב ענן, אבק ואטמוספרה. המערכת לומדת מה תורם יותר לשקיעות יפות <em>באזורך</em> — לחוף הים פרופיל שונה מהגליל.</div>
        </div>
      </div>
      <div class="how-step">
        <span class="how-step-num">④</span>
        <div>
          <strong>נקודות מתיקות</strong>
          <div class="how-step-desc">לחות ~60% ואבק ~25µg/m³ נחשבים אופטימליים בממוצע עולמי. TWILIGHT לומדת את הערכים האופטימליים לאקלים המקומי שלך.</div>
        </div>
      </div>
    </div>
    <p class="how-ema-note">הלמידה הדרגתית — שקיעה אחת לא משנה הרבה, הרבה שקיעות משנות בצורה עקבית. שינוי קיצוני לא יקרה מדגימה בודדת.</p>
    ${adv ? `<p class="how-adv-note"><strong>מצב מתקדם:</strong> הפאזות מבוססות EMA (Exponential Moving Average) עם α ∈ [0.03, 0.10]. כל דגימה תורמת 3–10% לכיול; 90–97% נשאר מהמצב הקודם.</p>` : ''}
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
//  KPI strip with per-card story
// ─────────────────────────────────────────────
function renderKPIs(stats) {
  const acc       = stats.forecastAccuracy;
  const accColor  = acc == null ? 'var(--cream-faint)'
                  : acc >= 85  ? 'var(--gold)'
                  : acc >= 70  ? '#ffd580'
                  :               '#ffaaaa';

  const trendIcon  = stats.trend === 'improving' ? '↗' : stats.trend === 'worsening' ? '↘' : '→';
  const trendColor = stats.trend === 'improving' ? '#aaffcc' : stats.trend === 'worsening' ? '#ffaaaa' : 'var(--cream-faint)';

  const accExplain = acc == null ? 'אין עדיין נתונים'
                   : acc >= 85  ? 'הניבויים קולעים ברוב המקרים'
                   : acc >= 70  ? 'דיוק סביר, ממשיכים ללמוד'
                   :              'עדיין לומדים את התנאים המקומיים';

  const sampleExplain = stats.sampleSize < 20  ? 'צריך לפחות 20 לדיוק טוב'
                       : stats.sampleSize < 50 ? 'מאגר בבנייה'
                       :                          'מאגר בוגר';

  const trendExplain = stats.trend === 'improving' ? 'הדיוק משתפר'
                     : stats.trend === 'worsening' ? 'ירידה לאחרונה'
                     :                                'הדיוק יציב';

  const confExplain = stats.confidence >= 80 ? 'ביטחון גבוה'
                    : stats.confidence >= 50 ? 'ביטחון בינוני'
                    :                           'עוד צריך נתונים';

  // Stories: one-line impact under the explain label
  const accStory = acc == null ? ''
                 : acc >= 85  ? 'סומכים על התחזיות במידה רבה'
                 : acc >= 70  ? 'תחזיות שימושיות אך לא מושלמות'
                 :              'התחזיות עדיין לא סומכים עליהן באזורך';

  const sampleStory = stats.sampleSize < 20  ? 'כל שקיעה שתצפה בה מקרבת אותנו'
                    : stats.sampleSize < 50  ? 'עוד מעט נתחיל לזהות דפוסים עונתיים'
                    :                           'הלמידה כבר משפיעה על הציון שלך';

  const trendStory = stats.trend === 'improving' ? 'השקיעות האחרונות שיפרו את המערכת'
                   : stats.trend === 'worsening' ? 'אולי שינוי עונתי — תתכייל שוב'
                   :                                'התחזיות עקביות לאורך זמן';

  const confStory = stats.confidence >= 80 ? 'הכיול אמין ועדכני'
                  : stats.confidence >= 50 ? 'הכיול נבנה, עוד לא מלא'
                  :                           'המערכת עדיין בחימום';

  const kpiEdu = {
    accuracy: `נמדד כממוצע משוקלל של 4 פרמטרים: ענן, לחות, נראות ואבק. בכל דגימה, TWILIGHT בודקת כמה קרוב הניבוי שלה לנתוני מזג האוויר בפועל. ציון 85%+ = טוב; 70–84% = סביר; מתחת ל-70% = עוד בכיול.`,
    samples:  `כל "דגימה" = שקיעה שבה השווינו תחזית למדידות בפועל. עד 10 — אין מספיק מידע לכיול אמין. 10–50 — המערכת לומדת אבל לא התייצבה. מעל 50 — מאגר בוגר המאפשר זיהוי דפוסים עונתיים.`,
    trend:    `השוואה בין הדיוק הממוצע של 10 הדגימות האחרונות ל-10 שלפניהן. מגמת ירידה לא בהכרח בעיה — עשויה לנבוע משינוי עונה. המערכת תתכייל מחדש.`,
    conf:     `ציון מורכב: כמה הכיול עדכני ומעודכן × כמה לאחרונה הצטברו דגימות. מתחת ל-50% = המערכת "ישנה" — לא עודכנה זמן רב.`,
  };

  const kpi = (id, val, color, label, sub, story, eduText) => {
    const eduId = `edu-kpi-${id}`;
    const open = _openSections.has(eduId);
    return `
    <div class="glass learning-kpi">
      <div class="kpi-header-row">
        <div class="kpi-value" style="color:${color}">${val}</div>
        <button class="edu-toggle-btn edu-toggle-sm" data-edu="${eduId}" aria-expanded="${open}" aria-label="הסבר על ${label}">?</button>
      </div>
      <div class="kpi-label">${label}</div>
      <div class="kpi-explain">${sub}</div>
      ${story ? `<div class="kpi-story">${story}</div>` : ''}
      <div class="edu-explainer kpi-edu ${open ? 'open' : ''}" id="${eduId}">${eduText}</div>
    </div>`;
  };

  return `
  <div class="learning-kpi-grid">
    ${kpi('acc',    acc != null ? acc + '%' : '—', accColor,          'דיוק תחזית', accExplain,    accStory,    kpiEdu.accuracy)}
    ${kpi('n',      stats.sampleSize,              'var(--cream)',     'דגימות',     sampleExplain, sampleStory, kpiEdu.samples)}
    ${kpi('trend',  trendIcon,                     trendColor,        'מגמה',       trendExplain,  trendStory,  kpiEdu.trend)}
    ${kpi('conf',   stats.confidence + '%',        'var(--gold)',      'ביטחון',     confExplain,   confStory,   kpiEdu.conf)}
  </div>`;
}

// ─────────────────────────────────────────────
//  Accuracy chart — readable labels + RTL axis hints
// ─────────────────────────────────────────────
function renderAccuracyChart(stats) {
  const ts = stats.timeSeries;
  if (!ts || ts.length < 2) {
    return `
    ${eduSection('דיוק לאורך זמן', 'הגרף יופיע לאחר איסוף מספיק דגימות.')}
    <div class="glass" style="padding:16px;text-align:center;font-size:11px;color:var(--cream-faint)">מצטברים נתונים…</div>`;
  }

  const W = 320, H = 150, padX = 16, padY = 14;
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
    return `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#b39ddb"/>`;
  }).join('');

  // Enlarged tap targets for mobile (28px wide)
  const hitAreas = ts.map((e, i) => {
    const cx = padX + i * xStep;
    const pred  = e.predicted     != null ? e.predicted.toFixed(1)     : '—';
    const recon = e.reconstructed != null ? e.reconstructed.toFixed(1) : '—';
    const err   = (e.predicted != null && e.reconstructed != null)
      ? (e.predicted - e.reconstructed).toFixed(1) : '—';
    const dateStr = e.date ? e.date.slice(5) : '';
    const aria = `תאריך ${dateStr}, ניבוי ${pred}, בפועל ${recon}, הפרש ${err}`;
    return `<rect x="${(cx - 14).toFixed(1)}" y="0" width="28" height="${H}"
              fill="transparent" class="chart-hit"
              role="button" tabindex="0" aria-label="${aria}"
              data-date="${dateStr}" data-pred="${pred}" data-recon="${recon}" data-err="${err}"/>`;
  }).join('');

  const grid = [3, 5, 7, 9].map(v => {
    const y = yScale(v).toFixed(1);
    return `<line x1="${padX}" y1="${y}" x2="${W-padX}" y2="${y}" stroke="rgba(245,220,180,0.08)" stroke-width="1" stroke-dasharray="2 4"/>
            <text x="${W-padX-4}" y="${y-2}" font-size="10" fill="rgba(245,220,180,0.45)" text-anchor="end">${v}</text>`;
  }).join('');

  // RTL axis hints: in RTL, "older" is on the right, "newer" on the left
  const axisHints = `
    <text x="${padX + 2}" y="${H - 2}" font-size="9" fill="rgba(245,220,180,0.5)" text-anchor="start">חדש</text>
    <text x="${W - padX - 2}" y="${H - 2}" font-size="9" fill="rgba(245,220,180,0.5)" text-anchor="end">ישן</text>
  `;

  const chartEdu = `
    <strong>קו זהב = מה TWILIGHT ניבאה.</strong> קו ירוק = מה שנמדד בפועל אחרי השקיעה.
    נקודות סגולות = הדירוג שנתת אחרי שיצאת לצפות. כשהקווים קרובים — הניבוי מדויק.
    פער גדול ביניהם = דגימה שהמערכת לומדת ממנה להבא.`;

  return `
  ${eduSection(`דיוק לאורך זמן (${n} דגימות אחרונות)`, chartEdu)}
  <div class="glass learning-chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" class="learning-chart" id="learning-accuracy-chart" role="img" aria-label="גרף דיוק לאורך זמן">
      ${grid}
      ${axisHints}
      ${predPts  ? `<polyline points="${predPts}"  fill="none" stroke="var(--gold)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.94"/>` : ''}
      ${reconPts ? `<polyline points="${reconPts}" fill="none" stroke="#7eefb2"     stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" opacity="0.88"/>` : ''}
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
//  Bias panel — always shows percentage
// ─────────────────────────────────────────────
function renderBiasPanel(stats) {
  const { cloudBias, humidityBias, dustBias, visibilityBias } = stats.forecastBias;

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
    const pct = Math.round(val * 100);
    const absPct = Math.abs(pct);
    const arrow = pct > 5 ? '↑' : pct < -5 ? '↓' : '✓';
    const color = absPct > 20 ? '#ffaaaa'
                : absPct > 10 ? '#ffd580'
                :                '#aaffcc';

    const display = absPct < 5
      ? `${arrow}`
      : `${pct > 0 ? '+' : '−'}${absPct}% ${arrow}`;

    let meaning;
    if (absPct < 5)       meaning = `ה-API מדויק — אין תיקון נחוץ`;
    else if (pct > 0)     meaning = `ה-API מזלזל ב${paramHe} — הגדלנו את הנתון`;
    else                  meaning = `ה-API מגזים ב${paramHe} — הקטנו את הנתון`;

    return `
    <div class="glass bias-card">
      <div class="bias-label">${label}</div>
      <div class="bias-value" style="color:${color}">${display}</div>
      <div class="bias-hint">${meaning}</div>
    </div>`;
  };

  return `
  ${eduSection('הטיית תחזית מול מציאות', biasEdu)}
  <div class="learning-bias-grid">
    ${card('עננות',  cloudBias,      'עננות')}
    ${card('לחות',   humidityBias,   'לחות')}
    ${card('אבק',    dustBias,       'אבק')}
    ${card('נראות',  visibilityBias, 'נראות')}
  </div>`;
}

// ─────────────────────────────────────────────
//  Histogram — ±0.5 center bin, softer skew heuristic
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
    { lo: -0.5, hi:  0.5, count: 0, label: '±0.5'   },
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
  const maxIdx = bins.findIndex(b => b.count === max);

  const total      = errors.length;
  const centerBin  = bins[3].count;
  const centerPct  = Math.round(centerBin / total * 100);
  const avgErr     = (errors.reduce((s, e) => s + Math.abs(e), 0) / total).toFixed(1);
  const leftSum    = bins[0].count + bins[1].count + bins[2].count;
  const rightSum   = bins[4].count + bins[5].count + bins[6].count;
  const leftHeavy  = leftSum > rightSum * 1.2 && leftSum >= 3;
  const rightHeavy = rightSum > leftSum * 1.2 && rightSum >= 3;

  const bars = bins.map((b, i) => {
    const heightPct = (b.count / max) * 100;
    const avgTag = i === maxIdx && max >= 3
      ? `<div class="hist-peak-tag">ממוצע |שגיאה| ${avgErr}</div>`
      : '';
    return `
      <div class="hist-col">
        ${avgTag}
        <div class="hist-bar" style="height:${heightPct}%"></div>
        <div class="hist-label">${b.label}</div>
      </div>`;
  }).join('');

  let summary;
  if (centerPct >= 50)        summary = `רוב הניבויים קולעים למטרה (${centerPct}% בטווח ±0.5 נקודות)`;
  else if (centerPct >= 30)   summary = `דיוק סביר — שגיאה ממוצעת ${avgErr} נקודות`;
  else                        summary = `שגיאה ממוצעת ${avgErr} נקודות — המערכת עדיין מתכיילת`;

  if (rightHeavy) summary += ` · נטייה לניבוי גבוה מהמציאות`;
  if (leftHeavy)  summary += ` · נטייה לניבוי נמוך מהמציאות`;

  const histEdu = `
    <strong>ציר X</strong> = הפרש בין הניבוי לבפועל, בנקודות ציון.
    עמודה ב-<strong>±0.5</strong> = ניבוי קולע (שגיאה עד חצי נקודה).
    עמודה ב-<strong>+2</strong> = TWILIGHT ניבאה 2 נקודות <em>מעל</em> המציאות.
    <br><br>
    <strong>התפלגות בריאה</strong> נראית כפעמון סביב 0 — שגיאות לשני הכיוונים בשכיחות דומה.
    <strong>בעייתית</strong> = רוב העמודות לצד אחד = הטיה שיטתית שהמערכת עדיין מתקנת.`;

  return `
  ${eduSection('התפלגות שגיאת תחזית', histEdu)}
  <div class="glass learning-hist-wrap">
    <div class="hist-explain">${summary}</div>
    <div class="learning-hist">${bars}</div>
    <div class="hist-axis-label">שגיאה (ניבוי − בפועל), נקודות</div>
  </div>`;
}

// ─────────────────────────────────────────────
//  Per-location panel — samples + accuracy per bucket
// ─────────────────────────────────────────────
function renderPerLocationPanel(stats) {
  const locs = (stats.locationSummary || []).filter(l => l.samples > 0);
  if (locs.length < 2) return '';

  const edu = `
    המערכת מפצלת את הלמידה לפי אזור גיאוגרפי (חוף, צפון, מרכז, מזרח).
    כל אזור מקבל כיול נפרד כי תנאי האקלים שונים: לחות החוף ≠ יובש הנגב.
    ככל שיותר שקיעות באזור — הדיוק שם משתפר.`;

  const card = (loc) => {
    const name = LOC_LABELS_HE[loc.bucket] || loc.bucket;
    const accColor = loc.accuracy == null ? 'var(--cream-faint)'
                   : loc.accuracy >= 80   ? 'var(--gold)'
                   : loc.accuracy >= 65   ? '#ffd580'
                   :                         '#ffaaaa';
    const accText = loc.accuracy != null ? `${loc.accuracy}%` : '—';
    return `
    <div class="glass loc-card">
      <div class="loc-name">${name}</div>
      <div class="loc-accuracy" style="color:${accColor}">${accText}</div>
      <div class="loc-samples">${loc.samples} דגימות${loc.meanAbsErr != null ? ` · שגיאה ${loc.meanAbsErr}` : ''}</div>
    </div>`;
  };

  return `
  ${eduSection('סיכום לפי אזור', edu)}
  <div class="per-location-grid">${locs.map(card).join('')}</div>`;
}

// ─────────────────────────────────────────────
//  Biggest learning moments (Advanced)
// ─────────────────────────────────────────────
function renderBiggestMoments(stats) {
  const moments = stats.biggestLearningMoments || [];
  if (moments.length === 0) return '';

  const edu = `
    רשימת חמש הדגימות שהפתיעו הכי הרבה — שקיעות שבהן הניבוי היה רחוק מהמציאות.
    אלה הדגימות שמסבירות למה הפרמטרים שלמעלה זזו מברירת המחדל.
    ככל שיש יותר הפתעות — המערכת לומדת מהר יותר.`;

  const card = (m) => {
    const loc = LOC_LABELS_HE[m.locBucket] || m.locBucket || '?';
    const model = MODEL_LABELS_HE[m.dominantModel] || m.dominantModel;
    const pred = m.predicted != null ? m.predicted.toFixed(1) : '—';
    const recon = m.reconstructed != null ? m.reconstructed.toFixed(1) : '—';
    const err = m.forecastError != null ? m.forecastError.toFixed(1) : '—';
    const direction = m.forecastError > 0 ? 'למעלה' : 'למטה';
    const dateStr = m.date ? m.date.slice(5) : '—';
    return `
    <div class="glass moment-card">
      <div class="moment-left">
        <div class="moment-date">${dateStr}</div>
        <div class="moment-loc">${loc}</div>
      </div>
      <div class="moment-mid">
        <div class="moment-err">${err > 0 ? '+' : ''}${err}</div>
        <div class="moment-err-label">הפרש</div>
      </div>
      <div class="moment-right">
        <div class="moment-nums">ניבוי ${pred} · בפועל ${recon}</div>
        <div class="moment-narrative">${model} החמיץ ${direction}</div>
      </div>
    </div>`;
  };

  return `
  ${eduSection(`רגעי למידה גדולים (${moments.length})`, edu)}
  <div class="moment-list">${moments.map(card).join('')}</div>`;
}

// ─────────────────────────────────────────────
//  Params panel (Advanced)
// ─────────────────────────────────────────────
function renderParamsPanel(stats) {
  const w  = stats.currentWeights;
  const mb = stats.modelBiases;

  const paramsEdu = `
    <strong>משקלי דרמה</strong> — נוסחת הדרמה משלבת שלושה מרכיבים:
    (ענן × w₁) + (אבק × w₂) + (אטמוספרה × w₃). המשקלים לא קבועים —
    המערכת לומדת מה תורם יותר לשקיעות יפות <em>באזורך</em>.
    <br><br>
    <strong>נקודות מתיקות</strong> — לחות ~60% ואבק ~25µg/m³ אופטימליים לפי מחקר.
    ישראל מגוונת — בחוף אולי 55%, בנגב אולי 45%. המערכת לומדת מקומית.
    <br><br>
    <strong>הטיות מודלים</strong> — כל אחד משלושת המודלים מקבל תיקון ייחודי.
    חיובי = המודל ניבא גבוה מדי, צריך להוריד.`;

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

    <div class="param-group-title">נקודות מתיקות</div>
    ${param('humidityOptimum', 'לחות', w.humidityOptimum, 60, '%')}
    ${param('dustOptimum',     'אבק',  w.dustOptimum,     25, ' µg')}

    <div class="param-group-title">הטיית מודלים</div>
    ${param('CloudModel',    'Cloud',    (mb.CloudModel    > 0 ? '+' : '') + mb.CloudModel,    '0')}
    ${param('DustModel',     'Dust',     (mb.DustModel     > 0 ? '+' : '') + mb.DustModel,     '0')}
    ${param('ClearSkyModel', 'ClearSky', (mb.ClearSkyModel > 0 ? '+' : '') + mb.ClearSkyModel, '0')}
  </div>`;
}

// ─────────────────────────────────────────────
//  Action buttons: reset + (advanced) export
// ─────────────────────────────────────────────
function renderActionButtons(adv) {
  return `
  <div class="learning-actions-wrap">
    ${adv ? `
    <button class="learning-export-btn" id="learning-export-btn" aria-label="שתף התקדמות — העתק נתונים ללוח">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      העתק התקדמות
    </button>` : ''}
    <button class="learning-reset-btn" id="learning-reset-btn" aria-label="איפוס — פעולה הרסנית, מוחק את כל נתוני הלמידה">
      <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 2v6h6M2.66 15.57a10 10 0 1 0 .57-4.3"/></svg>
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
    if (e.target.closest('#learning-back-btn')) {
      showScreen('settings');
      return;
    }

    if (e.target.closest('#learning-reset-btn')) {
      if (!confirm('לאפס את כל נתוני הלמידה? לא ניתן לשחזור.')) return;
      clearLearningData();
      _openSections.clear();
      showToast('נתוני הלמידה אופסו', 'info');
      initLearningScreen();
      return;
    }

    if (e.target.closest('#learning-export-btn')) {
      exportStatsToClipboard(lStats);
      return;
    }

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

  // Chart tooltips + keyboard support
  const chart   = document.getElementById('learning-accuracy-chart');
  const tooltip = document.getElementById('chart-tooltip');
  if (chart && tooltip) {
    const showTip = (rect, ev) => {
      const d = rect.dataset;
      tooltip.innerHTML = `<strong>${d.date}</strong><br>ניבוי: ${d.pred} · בפועל: ${d.recon}<br>הפרש: ${d.err}`;
      tooltip.style.display = 'block';
      const chartRect = chart.getBoundingClientRect();
      const x = ev ? ev.clientX : (rect.getBoundingClientRect().left + rect.getBoundingClientRect().width / 2);
      tooltip.style.left = Math.min(Math.max(8, x - chartRect.left), chartRect.width - 170) + 'px';
    };
    chart.querySelectorAll('.chart-hit').forEach(rect => {
      rect.addEventListener('click', (ev) => { ev.stopPropagation(); showTip(rect, ev); });
      rect.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); showTip(rect, null); }
      });
    });
    screen?.addEventListener('click', () => { tooltip.style.display = 'none'; });
  }
}

function exportStatsToClipboard(stats) {
  const payload = {
    version: 1,
    generated: new Date().toISOString(),
    sampleSize: stats.sampleSize,
    forecastAccuracy: stats.forecastAccuracy,
    confidence: stats.confidence,
    trend: stats.trend,
    forecastBias: stats.forecastBias,
    currentWeights: stats.currentWeights,
    modelBiases: stats.modelBiases,
    locationSummary: stats.locationSummary,
  };
  const text = JSON.stringify(payload, null, 2);
  const copy = () => navigator.clipboard?.writeText(text);
  try {
    const p = copy();
    if (p?.then) {
      p.then(() => showToast('הנתונים הועתקו ללוח', 'info'))
       .catch(() => showToast('ההעתקה נכשלה', 'error'));
    } else {
      showToast('הנתונים הועתקו ללוח', 'info');
    }
  } catch {
    showToast('ההעתקה נכשלה', 'error');
  }
}

// ✓ learning-screen.js — v3 restructured
