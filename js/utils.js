// ═══════════════════════════════════════════
//  TWILIGHT — utils.js
//  Helper: colors, labels, time, distance
// ═══════════════════════════════════════════

import { WIND_DIRS } from './config.js';

// 7-stop sunset ramp — physics-driven, mapped to sun altitude
const SUNSET = [
  { r: 62,  g: 40,  b: 120 },  // t=0.00 — deep purple (end of twilight)
  { r: 95,  g: 45,  b: 145 },  // t=0.17 — rich violet
  { r: 165, g: 50,  b: 120 },  // t=0.33 — warm magenta (sunset start)
  { r: 210, g: 85,  b: 90  },  // t=0.50 — rose coral
  { r: 240, g: 120, b: 70  },  // t=0.67 — sunset orange
  { r: 240, g: 165, b: 55  },  // t=0.83 — warm amber
  { r: 255, g: 185, b: 65  },  // t=1.00 — soft gold (peak moment)
];

function sampleSunset(t) {
  t = Math.max(0, Math.min(1, t));
  const idx = t * (SUNSET.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, SUNSET.length - 1);
  const frac = idx - lo;
  return lerpRGB(SUNSET[lo], SUNSET[hi], frac);
}

// ─── Canvas watercolor bar texture ───────────────────────────────────────────
const _watercolorCache = new Map();

function generateWatercolorBar(score, width = 60, height = 120) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const t = (Math.max(1, Math.min(10, score)) - 1) / 9;
  const base = sampleSunset(t);
  const bHsl = rgbToHsl(base.r, base.g, base.b);
  const top = hslToRgb(bHsl.h, bHsl.s * 0.75, Math.min(0.90, bHsl.l + 0.22));
  const bot = hslToRgb(bHsl.h, Math.min(1, bHsl.s * 1.15), Math.max(0.08, bHsl.l - 0.30));

  // 1. Base gradient — semi-transparent so sky bleeds through
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0,   `rgba(${top.r},${top.g},${top.b},0.60)`);
  grad.addColorStop(0.5, `rgba(${base.r},${base.g},${base.b},0.72)`);
  grad.addColorStop(1,   `rgba(${bot.r},${bot.g},${bot.b},0.80)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // 2. Watercolor blobs — semi-transparent radial spots
  // Use seeded random (score-based) for consistent look per score
  let seed = Math.round(score * 100);
  const rand = () => { seed = (seed * 16807 + 0) % 2147483647; return seed / 2147483647; };

  for (let i = 0; i < 14; i++) {
    const blobT = Math.max(0, Math.min(1, t + (rand() - 0.5) * 0.28));
    const c = sampleSunset(blobT);
    const x = rand() * width;
    const y = rand() * height;
    const r = 12 + rand() * 35;

    const rg = ctx.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0,   `rgba(${c.r},${c.g},${c.b},0.12)`);
    rg.addColorStop(0.5, `rgba(${c.r},${c.g},${c.b},0.05)`);
    rg.addColorStop(1,   `rgba(${c.r},${c.g},${c.b},0)`);
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, width, height);
  }

  // 3. Top gem highlight — intensity increases with score (sun glow)
  const glowAlpha = 0.10 + t * 0.22; // low scores: subtle, high scores: strong
  const shine = ctx.createRadialGradient(width / 2, 0, 0, width / 2, 0, height * 0.6);
  shine.addColorStop(0, `rgba(255,255,255,${glowAlpha.toFixed(2)})`);
  shine.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = shine;
  ctx.fillRect(0, 0, width, height);

  return canvas.toDataURL('image/png');
}

export function getWatercolorBg(score) {
  const key = Math.round(score * 10);
  if (!_watercolorCache.has(key)) {
    _watercolorCache.set(key, generateWatercolorBar(score));
  }
  return _watercolorCache.get(key);
}

/**
 * Sky-derived background for score bars, badges, and strips.
 * Replaces the old metallic palette with physics-driven sky colours.
 *
 * @param {number} score         1.0–10.0
 * @param {object|null} skyColors  { skyTop, skyMid, horizon, sun } each {r,g,b}
 * @returns {{ gradient:string, glow:string, strip:string }}
 */
export function scoreToSkyBg(score, skyColors) {
  const s = Math.max(1, Math.min(10, Number(score) || 5));
  const t = (s - 1) / 9; // 0→1

  let rgb;
  if (skyColors?.horizon) {
    // Physics path — same piecewise lerp as scoreToSkyColor
    if (t <= 1/3)      rgb = lerpRGB(skyColors.skyTop, skyColors.skyMid, t * 3);
    else if (t <= 2/3) rgb = lerpRGB(skyColors.skyMid, skyColors.horizon, (t - 1/3) * 3);
    else               rgb = lerpRGB(skyColors.horizon, skyColors.sun, (t - 2/3) * 3);
  } else {
    // Offline / pre-render fallback: score→hue ramp (blue→purple→red→orange→gold)
    const hue = 220 - t * 190;
    const sat = 0.28 + t * 0.22;
    const lit = 0.32 + t * 0.18;
    rgb = hslToRgb(hue, sat, lit);
  }

  // Watercolor slice: wide span (±0.22) across 7 organic stops.
  // Asymmetric sampling with saturation modulation:
  //   top = dry wet-front (light, desaturated)
  //   center = loaded brush (peak saturation)
  //   bottom = settled pigment (darkest)
  const SLICE = 0.22;
  const r0 = sampleSunset(Math.max(0, t - SLICE));
  const r1 = sampleSunset(Math.max(0, t - SLICE * 0.6));
  const r2 = sampleSunset(Math.max(0, t - SLICE * 0.2));
  const r3 = sampleSunset(t);
  const r4 = sampleSunset(Math.min(1, t + SLICE * 0.3));
  const r5 = sampleSunset(Math.min(1, t + SLICE * 0.65));
  const r6 = sampleSunset(Math.min(1, t + SLICE));

  // Wet front: lighten + desaturate (paper showing through)
  const h0 = rgbToHsl(r0.r, r0.g, r0.b);
  const wet = hslToRgb(h0.h, h0.s * 0.78, Math.min(0.68, h0.l + 0.12));

  // Loaded center: boost saturation
  const hc = rgbToHsl(r3.r, r3.g, r3.b);
  const loaded = hslToRgb(hc.h, Math.min(1, hc.s * 1.08), hc.l);

  // Settled bottom: darken
  const hb = rgbToHsl(r6.r, r6.g, r6.b);
  const settled = hslToRgb(hb.h, Math.min(1, hb.s * 1.05), Math.max(0.10, hb.l * 0.92));

  const hex = rgbToHex(loaded.r, loaded.g, loaded.b);
  const c  = (c) => rgbToHex(c.r, c.g, c.b);

  // Glass gradient — same 7 stops but low-alpha rgba for glassmorphism
  const alpha = 0.18 + t * 0.17;
  const ga = (col, a) => `rgba(${col.r},${col.g},${col.b},${a.toFixed(2)})`;

  return {
    gradient: `linear-gradient(180deg,${c(wet)} 0%,${c(r1)} 10%,${c(r2)} 28%,${hex} 50%,${c(r4)} 68%,${c(r5)} 85%,${c(settled)} 100%)`,
    glassGradient: `rgba(${loaded.r},${loaded.g},${loaded.b},0.20)`,
    glow: `${hex}88`,
    strip: hex,
  };
}

/** Lerp between two {r,g,b} objects */
function lerpRGB(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function rgbToHex(r, g, b) {
  return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r)      h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else                h = ((r - g) / d + 4) / 6;
  return { h: h * 360, s, l };
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r, g, b;
  if (h < 60)       { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else              { r = c; g = 0; b = x; }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

/** WCAG relative luminance from linear-light 0-255 RGB */
export function relativeLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map(c => {
    c /= 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function contrastRatio(lum1, lum2) {
  const lighter = Math.max(lum1, lum2);
  const darker  = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Adjust lightness of {r,g,b} until contrast ratio against bgLum >= minRatio.
 * Tries up to 8 nudges of ±0.05 lightness.
 */
function ensureContrast(r, g, b, bgLum, minRatio) {
  let hsl = rgbToHsl(r, g, b);
  const textLum = relativeLuminance(r, g, b);
  const direction = textLum > bgLum ? 1 : -1; // push lighter if already lighter, darker otherwise
  for (let i = 0; i < 8; i++) {
    const lum = relativeLuminance(r, g, b);
    if (contrastRatio(lum, bgLum) >= minRatio) break;
    hsl.l = Math.max(0, Math.min(1, hsl.l + direction * 0.06));
    const adj = hslToRgb(hsl.h, hsl.s, hsl.l);
    r = adj.r; g = adj.g; b = adj.b;
  }
  return { r, g, b };
}

/**
 * Physics-driven score TEXT color: sample the live sky gradient.
 *   score 1 → skyTop (cool/muted)
 *   score 4 → skyMid (transitional)
 *   score 7 → horizon (warm/gold)
 *   score 10 → sun (bright gold/white)
 *
 * Includes WCAG contrast safeguard against the glass card background.
 * Falls back to score→hue ramp when skyColors unavailable.
 *
 * @param {number} score            1.0–10.0
 * @param {object|null} skyColors   { skyTop, skyMid, horizon, sun } each {r,g,b}
 * @param {number} [cardBgLuma]     pre-computed glass card background luminance (0–1)
 * @returns {string} hex color
 */
export function scoreToSkyColor(score, skyColors, cardBgLuma) {
  const s = Math.max(1, Math.min(10, Number(score) || 5));
  const t = (s - 1) / 9; // 0→1

  let rgb;
  if (skyColors?.horizon) {
    // Piecewise lerp across 4 sky zones
    if (t <= 1/3) {
      rgb = lerpRGB(skyColors.skyTop, skyColors.skyMid, t * 3);
    } else if (t <= 2/3) {
      rgb = lerpRGB(skyColors.skyMid, skyColors.horizon, (t - 1/3) * 3);
    } else {
      rgb = lerpRGB(skyColors.horizon, skyColors.sun, (t - 2/3) * 3);
    }
  } else {
    // Offline fallback: score→hue ramp (blue→purple→red→orange→gold)
    const hue = 220 - t * 190;
    rgb = hslToRgb(hue, 0.28 + t * 0.22, 0.45 + t * 0.18);
  }

  // Boost saturation: physics sky colors tend to be desaturated (sat ~0.1-0.2)
  // but score text needs to pop. Minimum saturation floor based on score range.
  let hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const satFloor = 0.25 + t * 0.35; // low scores 0.25, high scores 0.60
  if (hsl.s < satFloor) hsl.s = satFloor;
  // Lightness floor: ensure text isn't too dark to read
  if (hsl.l < 0.35) hsl.l = 0.35;
  if (hsl.l > 0.85) hsl.l = 0.85;
  rgb = hslToRgb(hsl.h, hsl.s, hsl.l);

  // Contrast safeguard against glass card background
  if (cardBgLuma != null) {
    rgb = ensureContrast(rgb.r, rgb.g, rgb.b, cardBgLuma, 3.0);
  }

  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * Score 1-10 → Hebrew label
 */
export function scoreToLabel(s) {
  const n = Number(s);
  if (n >= 9) return 'מעולה';
  if (n >= 7) return 'טוב מאוד';
  if (n >= 5) return 'טוב';
  if (n >= 3) return 'בינוני';
  if (n >= 2) return 'חלש';
  return 'לא מומלץ';
}

/**
 * ISO datetime string → 'HH:MM'
 */
export function formatTime(iso) {
  if (!iso) return '--:--';
  const d = new Date(iso);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 'HH:MM' string + minutes → 'HH:MM' string
 */
export function addMinutes(timeStr, mins) {
  if (!timeStr || timeStr === '--:--') return '--:--';
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + mins;
  const nh = ((Math.floor(total / 60) % 24) + 24) % 24;
  const nm = ((total % 60) + 60) % 60;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

/**
 * ISO sunset → 'HH:MM–HH:MM' civil twilight range
 */
export function twilightRange(sunsetISO) {
  const t = formatTime(sunsetISO);
  const mins = getTwilightDuration(sunsetISO);
  return `${t}–${addMinutes(t, mins)}`;
}

/**
 * Return civil twilight duration in minutes based on month (Israel)
 */
export function getTwilightDuration(sunsetISO) {
  if (!sunsetISO) return 28;
  const month = new Date(sunsetISO).getMonth() + 1;
  if (month >= 11 || month <= 2) return 22;
  if (month === 3 || month === 10) return 26;
  return 32;
}

/**
 * Haversine distance in km between two lat/lon pairs
 */
export function distKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Compute destination point given start, bearing (degrees) and distance (km) */
export function destPoint(lat, lon, bearingDeg, distKmVal) {
  const R = 6371;
  const d = distKmVal / R;
  const brng = bearingDeg * Math.PI / 180;
  const la1 = lat * Math.PI / 180;
  const lo1 = lon * Math.PI / 180;
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(brng));
  const lo2 = lo1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: la2 * 180 / Math.PI, lon: lo2 * 180 / Math.PI };
}

/**
 * Wind degree → Hebrew direction string
 */
export function degToDir(deg) {
  const idx = Math.round(((deg % 360) / 45)) % 8;
  return WIND_DIRS[idx];
}

/**
 * Date string → Hebrew day name
 */
export function dateToHebDay(dateStr) {
  const days = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];
  const d = new Date(dateStr + 'T12:00:00');
  return days[d.getDay()];
}

/**
 * Date string → short date 'DD/MM'
 */
export function shortDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

/**
 * Generate quality tags array from DayData
 * v2: cloud layers, delta, rain intensity
 */
export function buildTags(d) {
  const tags = [];
  const clouds = typeof d._cloudRaw === 'number' ? d._cloudRaw : parseFloat(d.cloud) || 0;
  const hum    = typeof d._humidityRaw === 'number' ? d._humidityRaw : parseFloat(d.humidity) || 0;
  const vis    = typeof d._visibilityRaw === 'number' ? d._visibilityRaw : parseFloat(d.visibility) || 0;
  const wind   = typeof d._windRaw === 'number' ? d._windRaw : parseFloat(d.wind) || 0;
  const cHigh  = d._cloudHighRaw || 0;
  const cLow   = d._cloudLowRaw || 0;
  const rainMm = d._rainMmRaw || 0;
  const delta  = d._cloudDelta || 0;

  // Sunset quality
  if (d.ssScore >= 8) tags.push('שקיעה מעולה');
  else if (d.ssScore >= 6) tags.push('שקיעה טובה');

  // Purple light potential — civil twilight glow 15-25 min post-sunset
  if ((d.twScore || 0) >= 7.5 && (d.ssScore || 0) >= 6) tags.push('פוטנציאל לאור סגול');

  // Cloud cover
  if (clouds < 20) tags.push('שמיים נקיים');
  else if (clouds > 70) tags.push('עננות כבדה');
  else if (clouds >= 20 && clouds <= 40) tags.push('עננות אופטימלית');

  // Cloud layers
  if (cHigh > 30 && cLow < 30) tags.push('עננים גבוהים — צבעים');
  if (cLow > 60) tags.push('עננים נמוכים — חסימה');

  // Cloud delta (clearing)
  if (delta < -20) tags.push('פריצת אור');
  else if (delta > 20) tags.push('התעננות');

  // Humidity
  if (hum >= 40 && hum <= 60) tags.push('לחות אידאלית');
  else if (hum < 25) tags.push('אוויר יבש מאוד');
  else if (hum < 40) tags.push('אוויר יבש');
  else if (hum > 80) tags.push('לחות גבוהה');

  // Visibility
  if (vis >= 20) tags.push('נראות מצוינת');
  else if (vis < 5) tags.push('נראות נמוכה');

  // Wind
  if (wind < 10) tags.push('רוח נוחה');
  else if (wind > 30) tags.push('רוח חזקה');

  // Rain
  if (rainMm > 2) tags.push('גשם פעיל');
  else if (rainMm > 0.3) tags.push('טפטוף');

  // Dust / aerosol
  const dustLevel = d._dustRaw || 0;
  if (dustLevel > 80)      tags.push('אבק כבד');
  else if (dustLevel > 40) tags.push('אבק מתון');
  else if (dustLevel > 15) tags.push('אבק קל — צבעים חמים');

  return tags;
}

// ─────────────────────────────────────────
//  Smart condition: תיאור מילולי לפי גורמי הציון האמיתיים
//  מחזיר ביטוי עברי קצר שמסביר למה הציון הוא מה שהוא,
//  או null אם אין גורם דומיננטי (ה-caller ישתמש בקוד מזג האוויר).
// ─────────────────────────────────────────
export function buildSmartCond(d) {
  const clouds = d._cloudRaw      || 0;
  const vis    = d._visibilityRaw || 0;
  const dust   = d._dustRaw       || 0;
  const delta  = d._cloudDelta    || 0;
  const cHigh  = d._cloudHighRaw  || 0;
  const cLow   = d._cloudLowRaw   || 0;
  const rainMm = d._rainMmRaw     || 0;

  // גורמים חוסמים (שליליים) — עדיפות גבוהה
  if (rainMm > 2)  return 'גשם פעיל';
  if (dust > 80)   return 'אבק כבד';
  if (cLow > 60)   return 'עננים נמוכים';

  // דינמיקה — פריצת אור (ירידה מהירה בעננות לפני השקיעה)
  if (delta < -25) return 'פריצת אור';

  // עננים גבוהים ללא חסימה — מיטיבים עם הצבעים
  if (cHigh > 40 && cLow < 25) return 'עננים גבוהים — צבעים';

  // נראות מצוינת
  if (vis >= 20 && clouds < 50) return 'נראות מצוינת';

  // אבק קל — מגביר פיזור Mie וצבעים חמים
  if (dust >= 15 && dust <= 60) return 'אבק קל — צבעים';

  // עננות אופטימלית לשקיעה צבעונית
  if (clouds >= 20 && clouds <= 45) return 'עננות אופטימלית';

  // שמיים נקיים
  if (clouds < 15) return 'שמיים נקיים';

  return null; // fallback לקוד מזג האוויר
}

// ─────────────────────────────────────────
//  Smart recommendation text
// ─────────────────────────────────────────
export function getSmartRecommendation(dayData) {
  const s = dayData.score;
  const tags = dayData.tags || [];
  const hasClean     = tags.includes('שמיים נקיים');
  const hasCloudy    = tags.includes('עננות כבדה');
  const hasWind      = tags.includes('רוח חזקה');
  const hasGoodVis   = tags.includes('נראות מצוינת');
  const hasDryAir    = tags.includes('אוויר יבש');
  const hasHighCloud = tags.includes('עננים גבוהים — צבעים');
  const hasBreak     = tags.includes('פריצת אור');
  const hasOptCloud  = tags.includes('עננות אופטימלית');
  const hasRain      = tags.includes('גשם פעיל') || tags.includes('טפטוף');
  const hasIdealHum  = tags.includes('לחות אידאלית');
  const hasLightDust = tags.includes('אבק קל — צבעים חמים');
  const hasHeavyDust = tags.includes('אבק כבד');

  if (hasRain) return '🌧️ גשם צפוי בשעת השקיעה — לא הערב.';
  if (hasHeavyDust) return '🌫️ אבק כבד באוויר — שקיעה אפרורית צפויה.';

  if (s >= 9) {
    if (hasHighCloud && hasBreak) return '🔥 פריצת אור דרך עננים גבוהים — שקיעה דרמטית צפויה!';
    if (hasLightDust && hasGoodVis) return '🔥 אבק קל באוויר — צפו לצבעי אדום-כתום עמוקים!';
    if (hasOptCloud && hasGoodVis) return '🔥 עננות מושלמת ונראות גבוהה — תנאי שקיעה נדירים!';
    if (hasClean && hasGoodVis) return '🔥 שמיים נקיים ונראות מצוינת. אל תפספסו!';
    return '🔥 ציון גבוה במיוחד — ערב מצוין לדמדומים.';
  }
  if (s >= 7) {
    if (hasHighCloud) return '🌅 עננים גבוהים צפויים — פוטנציאל לצבעים חמים.';
    if (hasIdealHum && hasGoodVis) return '🌅 לחות אידאלית ונראות גבוהה — צפו לצבעים עמוקים.';
    if (hasOptCloud) return '🌅 עננות חלקית אופטימלית — שקיעה צבעונית צפויה.';
    if (hasClean) return '🌅 שמיים נקיים ברובם, שקיעה טובה מאוד צפויה.';
    return '🌅 תנאים טובים מאוד — שווה לצאת לצפות.';
  }
  if (s >= 5) {
    if (hasBreak) return '⛅ עננים נפתחים — ייתכן רגע דרמטי של אור.';
    if (hasCloudy) return '⛅ עננות חלקית — ייתכנו צבעים מעניינים בין העננים.';
    return '⛅ תנאים סבירים, שקיעה טובה אך לא יוצאת דופן.';
  }
  if (s >= 3) {
    if (hasCloudy && hasWind) return '🌥️ עננות כבדה ורוח — לא הערב הטוב ביותר.';
    if (hasCloudy) return '🌥️ מעונן ברובו, סיכוי נמוך לשקיעה יפה.';
    return '🌥️ תנאים בינוניים, שקיעה לא מומלצת במיוחד.';
  }
  return '☁️ תנאים לא מתאימים — שמרו אנרגיה ליום אחר.';
}

// ─────────────────────────────────────────
//  Trend arrow (today vs tomorrow)
// ─────────────────────────────────────────
export function trendArrow(todayScore, tomorrowScore) {
  if (tomorrowScore == null) return { arrow: '', label: '', css: '', dir: '' };
  const diff = tomorrowScore - todayScore;
  if (diff >= 2)  return { arrow: '↑', label: 'מחר טוב יותר',   css: 'color:#7fd87f', dir: 'up' };
  if (diff >= 1)  return { arrow: '↗', label: 'שיפור קל מחר',   css: 'color:#b8d87f', dir: 'up' };
  if (diff <= -2) return { arrow: '↓', label: 'מחר פחות טוב',   css: 'color:#ff8888', dir: 'down' };
  if (diff <= -1) return { arrow: '↘', label: 'ירידה קלה מחר',  css: 'color:#d8a87f', dir: 'down' };
  return { arrow: '→', label: 'מחר דומה להיום', css: 'color:var(--cream-faint)', dir: 'flat' };
}

// ─────────────────────────────────────────
//  Solar elevation angle (degrees)
//  Simplified astronomical formula
//  Returns degrees above horizon (negative = below)
// ─────────────────────────────────────────
export function calcSolarElevation(lat, lon, date) {
  if (!date || !lat) return 3;
  const d = date instanceof Date ? date : new Date(date);

  // Day of year
  const start = new Date(d.getFullYear(), 0, 0);
  const diff  = d - start;
  const dayOfYear = Math.floor(diff / 86400000);

  // Solar declination (simplified)
  const declination = 23.45 * Math.sin((2 * Math.PI / 365) * (dayOfYear - 81));
  const decRad = declination * Math.PI / 180;

  // Hour angle
  const hours = d.getHours() + d.getMinutes() / 60;
  // Solar noon approximation for longitude (Israel ~34.8° → UTC+2/3)
  const solarNoon = 12 - (lon - 30) / 15; // rough estimate
  const hourAngle = (hours - solarNoon) * 15;
  const haRad = hourAngle * Math.PI / 180;

  // Latitude in radians
  const latRad = lat * Math.PI / 180;

  // Solar elevation
  const sinElev = Math.sin(latRad) * Math.sin(decRad) +
                  Math.cos(latRad) * Math.cos(decRad) * Math.cos(haRad);

  return Math.asin(sinElev) * 180 / Math.PI;
}

/**
 * Solar declination for a given date (degrees, -23.5 to +23.5).
 * Uses the same simplified formula as calcSolarElevation.
 */
export function getSolarDeclination(date) {
  const d = date instanceof Date ? date : new Date(date);
  const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  return 23.45 * Math.sin((2 * Math.PI / 365) * (dayOfYear - 81));
}

// ─────────────────────────────────────────
//  SVG gauge arc for score (half-circle)
// ─────────────────────────────────────────
export function buildGaugeArc(score, color, size = 120) {
  const cx = size / 2;
  const cy = size / 2 + 4;
  const r  = size / 2 - 10;
  const pct = Math.max(0, Math.min(1, (score - 1) / 9));
  const totalArc = Math.PI * r;
  const filled   = totalArc * pct;
  const gap      = totalArc - filled;
  const startX = cx - r;
  const endX   = cx + r;
  const displayScore = typeof score === 'number' ? score.toFixed(1) : score;

  // Extract RGB from "rgb(r, g, b)" for transparent fills
  const rgb = color.match(/\d+/g) || [212, 130, 10];
  const [cr, cg, cb] = rgb.map(Number);

  // Sector fill: pie-slice from center to scored arc boundary
  const angle = Math.PI * (1 - pct);
  const sEx = (cx + r * Math.cos(angle)).toFixed(2);
  const sEy = (cy - r * Math.sin(angle)).toFixed(2);
  const sectorD = pct > 0.01
    ? `M ${cx} ${cy} L ${startX} ${cy} A ${r} ${r} 0 0 1 ${sEx} ${sEy} Z`
    : `M ${cx} ${cy} Z`; // invisible point for pct≈0

  const arcTarget = `${filled} ${gap}`;
  return `
    <svg width="${size}" height="${size / 2 + 18}" viewBox="0 0 ${size} ${size / 2 + 18}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <!-- D-shape vessel background -->
      <path d="M ${startX} ${cy} A ${r} ${r} 0 0 1 ${endX} ${cy} L ${startX} ${cy} Z"
            fill="rgba(12,6,2,0.42)" />
      <!-- Track border (outer arc edge, 1px) -->
      <path d="M ${startX} ${cy} A ${r} ${r} 0 0 1 ${endX} ${cy}"
            stroke="rgba(245,224,190,0.08)" stroke-width="1" fill="none" />
      <!-- Sector fill (scored area, transparent wash) -->
      <path class="gauge-sector-fill" d="${sectorD}"
            fill="rgba(${cr},${cg},${cb},0.13)" />
      <!-- Baseline ember line (completes the D-shape visually) -->
      <line class="gauge-baseline"
            x1="${startX}" y1="${cy}" x2="${endX}" y2="${cy}"
            stroke="rgba(${cr},${cg},${cb},0.55)" stroke-width="1.5"
            style="filter:drop-shadow(0 0 5px rgba(${cr},${cg},${cb},0.4))" />
      <!-- Ember arc at score boundary (animates in via dasharray) -->
      <path class="gauge-arc-fill" d="M ${startX} ${cy} A ${r} ${r} 0 0 1 ${endX} ${cy}"
            stroke="${color}" stroke-width="3" fill="none"
            stroke-linecap="round"
            stroke-dasharray="0 ${totalArc}"
            data-arc-target="${arcTarget}"
            style="filter:drop-shadow(0 0 5px ${color}88) drop-shadow(0 0 12px ${color}33);transition:stroke-dasharray 1.1s cubic-bezier(0.22,1,0.36,1)" />
      <!-- Score number (inside the vessel) -->
      <text class="gauge-score-text" x="${cx}" y="${cy - 14}" text-anchor="middle"
            font-family="var(--font-title)" font-size="30" font-weight="900"
            fill="${color}" style="filter:drop-shadow(0 0 6px ${color}66) drop-shadow(0 2px 4px rgba(0,0,0,0.80))">
        ${displayScore}
      </text>
      <text x="${cx}" y="${cy - 1}" text-anchor="middle"
            font-family="var(--font-body)" font-size="11" fill="rgba(245,230,200,0.5)">
        /10
      </text>
    </svg>`;
}

// ─────────────────────────────────────────
//  Solar azimuth (bearing from North, clockwise)
//  Standard formula: Az = atan2(-sin(H), tan(dec)*cos(lat) - sin(lat)*cos(H))
//  Verified: summer sunset Israel ≈ 300–305°, winter ≈ 240–245°
// ─────────────────────────────────────────
export function calcSolarAzimuth(lat, lon, date) {
  if (!date || lat == null) return 270;
  const d = date instanceof Date ? date : new Date(date);
  const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  const decRad = (23.45 * Math.sin((2 * Math.PI / 365) * (dayOfYear - 81))) * Math.PI / 180;
  const latRad = lat * Math.PI / 180;
  const hours = d.getHours() + d.getMinutes() / 60;
  const solarNoon = 12 - (lon - 30) / 15;
  const haRad = ((hours - solarNoon) * 15) * Math.PI / 180;
  const az = Math.atan2(
    -Math.sin(haRad),
    Math.tan(decRad) * Math.cos(latRad) - Math.sin(latRad) * Math.cos(haRad)
  ) * 180 / Math.PI;
  return (az + 360) % 360;
}

// ─────────────────────────────────────────
//  Golden hour duration in minutes
//  Based on rate of solar elevation change at sunset:
//  rate = 15 * cos(lat) * cos(dec) * sin(H_sunset) deg/hr
//  golden hour = 6 / rate * 60 minutes
// ─────────────────────────────────────────
export function calcGoldenHourMin(lat, date) {
  if (!date || lat == null) return 28;
  const d = date instanceof Date ? date : new Date(date);
  const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 0)) / 86400000);
  const decRad = (23.45 * Math.sin((2 * Math.PI / 365) * (dayOfYear - 81))) * Math.PI / 180;
  const latRad = lat * Math.PI / 180;
  const tanProduct = Math.tan(latRad) * Math.tan(decRad);
  if (Math.abs(tanProduct) >= 1) return 28;
  const sinH = Math.sqrt(1 - tanProduct * tanProduct);
  const rateDegPerHour = 15 * Math.cos(latRad) * Math.cos(decRad) * sinH;
  if (rateDegPerHour <= 0) return 28;
  return Math.round(6 / rateDegPerHour * 60);
}
// ─── Cinematic Bar Style ─────────────────────────────────────────────────────

/**
 * Maps score 3→10 to a highly-saturated neon palette:
 * purple (3) → deep red (5) → scarlet-orange (7) → sun-gold (10)
 */
function scoreToNeonColor(score) {
  const STOPS = [
    { s: 3,  r: 120, g:  40, b: 100 }, // warm purple-maroon
    { s: 5,  r: 180, g:  55, b:  45 }, // deep maroon-amber
    { s: 7,  r: 230, g: 120, b:  25 }, // warm sunset orange
    { s: 10, r: 255, g: 190, b:  40 }, // rich gold
  ];
  const clamped = Math.max(3, Math.min(10, score));
  let lo = STOPS[0], hi = STOPS[STOPS.length - 1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (clamped >= STOPS[i].s && clamped <= STOPS[i + 1].s) {
      lo = STOPS[i]; hi = STOPS[i + 1]; break;
    }
  }
  const t = (clamped - lo.s) / (hi.s - lo.s);
  return {
    r: Math.round(lo.r + (hi.r - lo.r) * t),
    g: Math.round(lo.g + (hi.g - lo.g) * t),
    b: Math.round(lo.b + (hi.b - lo.b) * t),
  };
}

/**
 * scoreToBarStyle(score, skyColors)
 * Returns { gradient, borderColor, glow, shimmer } for bar fills.
 * Luminous Sky Bar Style v2
 * Premium depth + sky-glow aesthetic for dark theme.
 */
export function scoreToLuminousBarStyle(score, skyColors) {
  const bg = scoreToSkyBg(score, skyColors);
  const neon = scoreToNeonColor(score);
  const shimmer = score >= 7;
  const scoreColor = `rgb(${neon.r},${neon.g},${neon.b})`;
  const scoreColorRgb = `${neon.r},${neon.g},${neon.b}`;
  const scoreGlow = `rgba(${neon.r},${neon.g},${neon.b},0.9)`;
  return { gradient: bg.gradient, glassGradient: scoreColor, scoreColor, scoreColorRgb, scoreGlow, shimmer };
}
export { scoreToLuminousBarStyle as scoreToBarStyle };

// ── Contract 5 — Deep immutability for state snapshots ──────────────────
export function deepFreeze(obj) {
  if (obj == null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  Object.freeze(obj);
  for (const val of Object.values(obj)) {
    if (typeof val === 'object' && val !== null) deepFreeze(val);
  }
  return obj;
}
