// ═══════════════════════════════════════════
//  TWILIGHT — main-screen/explainer.js
//  Tier-2 score explainer tray: why-sentence + 3 bars + per-bar detail.
//  Extracted from main-screen.js — pure read-only functions over dayData.
// ═══════════════════════════════════════════

import { isAdvancedMode } from '../ui.js';

// ─────────────────────────────────────────
//  Tier-2 score explainer tray
//  Tap on .score-gauge-wrap → reveal:
//    Basic:    why-sentence + 3 bars + model in Hebrew
//    Advanced: + per-bar detail + raw values
// ─────────────────────────────────────────
export function buildScoreExplainer(today) {
  const certainty  = today.certainty  ?? 0;
  const drama      = today.dramaLevel ?? 0;
  const visConf    = Math.min(100, Math.round(today._visibilityRaw / 25 * 100));
  const confidence = Math.round(visConf * 0.55 + certainty * 0.45);
  const adv = isAdvancedMode();
  const score = today.score ?? 0;

  // ── Human-readable "why this score?" sentence ──
  const whySentence = buildWhySentence(today, score, certainty, drama);

  // ── Model names in plain Hebrew ──
  const modelMap = {
    CloudModel:    'שקיעת עננים — עננים גבוהים שנצבעים',
    DustModel:     'שקיעת אבק — אירוסולים שמפזרים אור',
    ClearSkyModel: 'שקיעה נקייה — שיפוע צבעים טבעי'
  };
  const modelShort = {
    CloudModel: 'ענן', DustModel: 'אבק', ClearSkyModel: 'שמיים נקיים'
  };
  const modelLbl = today.scoreModel
    ? (adv ? (modelShort[today.scoreModel] ?? today.scoreModel)
           : (modelMap[today.scoreModel] ?? today.scoreModel))
    : 'בסיסי';
  const paletteHe = today.palette?.styleHe ?? '';

  // ── Bar builder with optional detail ──
  // color is expected as rgba(…) for glass transparency to show through
  const bar = (label, value, color, detail) => `
    <div class="explainer-row">
      <span class="explainer-label">${label}</span>
      <div class="explainer-bar-track">
        <div class="explainer-bar-fill" style="width:${value}%;background:${color}"></div>
      </div>
      <span class="explainer-value">${value}%</span>
    </div>
    ${detail ? `<div class="explainer-detail">${detail}</div>` : ''}`;

  // ── Per-bar explanations (advanced mode) ──
  const certDetail = adv ? buildCertaintyDetail(today, certainty) : '';
  const dramaDetail = adv ? buildDramaDetail(today, drama) : '';
  const confDetail = adv ? `נראות ${today._visibilityRaw} ק"מ · כיסוי ענן ${today._cloudRaw}%` : '';

  return `
    <div class="score-explainer" id="score-explainer" hidden>
      <div class="explainer-why">${whySentence}</div>
      ${bar('נראות',    certainty,  'var(--gold)',   certDetail)}
      ${bar('עוצמה',   drama,      '#E8803A',       dramaDetail)}
      ${bar('ביטחון',  confidence, '#8BA0C0',       confDetail)}
      <div class="explainer-model">${paletteHe ? `${paletteHe} · ` : ''}${modelLbl}</div>
    </div>`;
}

function buildWhySentence(today, score, certainty, drama) {
  const parts = [];
  const cloud = today._cloudRaw ?? 0;
  const vis = today._visibilityRaw ?? 10;
  const humidity = today._humidityRaw ?? 50;
  const dust = today._dustRaw ?? 0;

  if (score >= 8) {
    if (cloud >= 30 && cloud <= 60) parts.push('עננים בגובה אידאלי ייצרו צבעים חמים');
    else if (dust >= 15 && dust <= 40) parts.push('אבק מתון יפזר אור בגוונים כתומים');
    else parts.push('תנאים מצוינים לשקיעה צבעונית');
  } else if (score >= 6) {
    if (cloud > 70) parts.push('עננים רבים, אבל יתכנו פריצות אור');
    else if (certainty < 50) parts.push('נראות בינונית');
    else parts.push('תנאים סבירים לשקיעה יפה');
    if (drama >= 50) parts.push('פוטנציאל לצבעים חמים');
  } else if (score >= 4) {
    if (cloud > 80) parts.push('כיסוי ענן כבד חוסם חלק מהאור');
    else if (vis < 8) parts.push('נראות נמוכה מטשטשת את השקיעה');
    else parts.push('תנאים בינוניים');
  } else {
    if (cloud > 90) parts.push('עננים נמוכים וכבדים חוסמים את האור');
    else if (vis < 5) parts.push('נראות חלשה מאוד');
    else parts.push('תנאים לא מתאימים לשקיעה מרשימה');
  }

  if (humidity > 75 && score < 8) parts.push('לחות גבוהה מטשטשת');
  if (dust > 50) parts.push('ריכוז אבק גבוה');

  return parts.join(' · ');
}

function buildCertaintyDetail(today, certainty) {
  const cloud = today._cloudRaw ?? 0;
  const vis = today._visibilityRaw ?? 10;
  const parts = [];
  if (cloud > 70)     parts.push(`כיסוי ענן כבד (${cloud}%)`);
  else if (cloud > 40) parts.push(`כיסוי ענן חלקי (${cloud}%)`);
  if (vis < 10)        parts.push(`נראות ${vis} ק"מ`);
  return parts.join(' · ') || (certainty >= 70 ? 'שמיים פתוחים' : '');
}

function buildDramaDetail(today, drama) {
  const parts = [];
  const highCloud = today._cloudHighRaw ?? 0;
  const dust = today._dustRaw ?? 0;
  if (highCloud > 30) parts.push(`ענני גובה ${highCloud}% — פוטנציאל צבעים`);
  if (dust >= 10 && dust <= 40) parts.push('אבק מתון — פיזור אור');
  else if (dust > 40) parts.push('אבק כבד — עלול לטשטש');
  if (!parts.length) parts.push(drama >= 50 ? 'אטמוספרה עשירה' : 'אטמוספרה שקטה');
  return parts.join(' · ');
}
