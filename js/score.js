// ═══════════════════════════════════════════
//  TWILIGHT — score.js v6
//  Sunset scoring: certainty × drama (exponential gate)
//  v6: Plug & Play modules (cloudScore/aodScore/atmosphereScore),
//      Dynamic Palette, Afterglow model, Cloud Base Height proxy,
//      Sea Salt bell curve, Washout visibility boost,
//      Crowdsourced cLow penalty calibration
// ═══════════════════════════════════════════

import { formatTime, twilightRange, addMinutes, scoreToLabel,
         degToDir, dateToHebDay, shortDate, buildTags, buildSmartCond,
         calcSolarElevation, calcSolarAzimuth, calcGoldenHourMin, getSolarDeclination } from './utils.js';
import { WEATHER_CODES, SEASONAL_BASELINE, COAST_LON,
         LOCATION_CLIMATE, OVERRIDE_CODES } from './config.js';
import { getBiasCorrection, getDynamicSeasonalBaseline, getCloudPenaltyAdjustment } from './calibration.js';
import { computeScattering } from './engine/physicsLayer.js';
import { predictGoldenWindow } from './engine/goldenWindow.js';
import { getSeasonalOzone }    from './data/ozone_climatology.js';
import { getLearningAdjustments } from './engine/learningEngine.js';
import { computeScore as computeEngineScore } from './engine/scoreEngine.js';

// ─── Helpers ─────────────────────────────

function bell(value, peak, width, maxVal = 1.0) {
  const x = (value - peak) / width;
  return maxVal * Math.exp(-0.5 * x * x);
}

function findHourIndex(hourlyTimes, isoTarget) {
  if (!isoTarget || !hourlyTimes) return -1;
  return hourlyTimes.findIndex(t => t.startsWith(isoTarget.substring(0, 13)));
}

function avgAround(arr, idx, w = 1) {
  if (idx < 0 || !arr) return arr?.[0] ?? 0;
  const s = Math.max(0, idx - w), e = Math.min(arr.length - 1, idx + w);
  const sl = arr.slice(s, e + 1);
  return sl.reduce((a, b) => a + (b || 0), 0) / sl.length;
}

function valAt(arr, idx, fb = 0) {
  if (!arr || idx < 0 || idx >= arr.length) return fb;
  return arr[idx] ?? fb;
}

function cloudDelta(arr, idx) {
  if (!arr || idx < 3) return 0;
  return (arr[idx] ?? 0) - (arr[idx - 3] ?? 0);
}

function sunsetWindowDip(arr, idx) {
  if (!arr || idx < 0) return 0;
  const neighbours = [-2, -1, 1, 2].map(o => {
    const i = idx + o;
    return (i >= 0 && i < arr.length) ? (arr[i] ?? 50) : (arr[idx] ?? 50);
  });
  const avg = neighbours.reduce((a, b) => a + b, 0) / neighbours.length;
  return Math.max(0, avg - (arr[idx] ?? 50));
}

// ─────────────────────────────────────────
//  CERTAINTY SCORE (0–1)
//  "How likely is the sunset to be visible at all?"
// ─────────────────────────────────────────
function calcCertainty(params) {
  const { clouds, cloudsLow, cloudsMid, cloudsHigh, visibility, rain, rainProb,
          weatherCode, cloudsLowWest, inversionStrength, lat, lon } = params;
  const c   = Number(clouds)     || 0;
  const cLo = Number(cloudsLow)  ?? c;
  const v   = Number(visibility) || 10;
  const r   = Number(rain)       || 0;
  const rp  = Number(rainProb)   || 0;

  // L1: fallback if per-layer data is missing
  const hasLayers = cloudsLow != null;
  const cMidCert  = hasLayers ? (Number(cloudsMid)  ?? 0) : c * 0.25;
  const cHighCert = hasLayers ? (Number(cloudsHigh) ?? 0) : c * 0.10;

  // Cloud Base Height proxy:
  // When cLow > 50 but visibility remains good (>8km), the cloud base is likely
  // elevated (cumulus at 600–1500m rather than stratus at 50–200m). Elevated base
  // allows light to reach the horizon underneath, so we reduce the penalty.
  // Calibration multiplier (0.60–1.40) learns from user ratings over time.
  let cLoBaseHtMult = 1.0;
  if (cLo > 50 && v > 8) {
    // Reduce penalty proportionally: 8km vis → 1.0×, 20km → ~0.80×
    cLoBaseHtMult = Math.max(0.8, 1 - (v - 8) / 60);
  }
  const cloAdjust  = getCloudPenaltyAdjustment(lat, lon); // crowdsource multiplier
  const cLoPenalty = (cLo / 100) * cLoBaseHtMult * cloAdjust;

  // Cloud penalty by layer (using calibrated cLo penalty)
  const cloudPenalty = cLoPenalty * 0.42
                     + (cMidCert / 100) * 0.28
                     + (cHighCert / 100) * 0.06
                     + (c / 100) * 0.11;
  const cloudCert = Math.max(0, 1 - cloudPenalty);

  // Visibility: <3km very bad, >15km good
  const visCert = Math.min(1, Math.max(0, (v - 2) / 13));

  // Rain
  let rainCert = 1.0;
  if (r > 3)         rainCert = 0.0;
  else if (r > 1)    rainCert = 0.1;
  else if (r > 0.3)  rainCert = 0.3;
  else if (r > 0)    rainCert = 0.6;
  else if (rp > 70)  rainCert = 0.35;
  else if (rp > 50)  rainCert = 0.55;
  else if (rp > 30)  rainCert = 0.80;

  // F5: differentiated fog penalty by code
  let fogPenalty = 0;
  if      (weatherCode === 48)              fogPenalty = 0.85; // freezing fog
  else if (weatherCode === 45)              fogPenalty = 0.65; // fog
  else if (OVERRIDE_CODES.has(weatherCode)) fogPenalty = 0.50;

  // L3: drizzle — partial penalty
  const drizzlePenalty = weatherCode === 55 ? 0.25
                       : weatherCode === 53 ? 0.15
                       : weatherCode === 51 ? 0.08 : 0;

  // A2: Western horizon — low clouds 50km west block the sunset light path
  const wLow = Number(cloudsLowWest) || 0;
  const westPenalty = Math.max(0, (wLow - 40) / 100) * 0.35;

  // Inversion: trapped pollution reduces apparent visibility
  const inv = Number(inversionStrength) || 0;
  const invPenalty = inv > 15 ? 0.15 : inv > 8 ? 0.08 : 0;

  return Math.max(0, Math.min(1,
    cloudCert * 0.45 + visCert * 0.30 + rainCert * 0.25
    - fogPenalty - drizzlePenalty - westPenalty - invPenalty
  ));
}

// ═══════════════════════════════════════════
//  PLUG & PLAY SCORING MODULES (0–1 each)
//  Each module captures one physical domain.
//  Combined with weighted sum + multiplicative synergy in calcDrama.
// ═══════════════════════════════════════════

// ── cloudScore: cloud structure, dynamics & opacity ──────────────
function cloudScore(params) {
  const { clouds, cloudsHigh, cloudsMid, cloudsLow,
          cloudDelta: cD, cloudDelta6h, sunsetWindow, twilightMode } = params;

  const c     = Number(clouds)    || 0;
  const cHigh = Number(cloudsHigh) ?? 0;
  const cMid  = Number(cloudsMid)  ?? 0;
  const cLow  = Number(cloudsLow)  ?? 0;

  // F2: Weighted cloud — cirrus >> mid >> stratus
  const dramaCloud = Math.min(100, cHigh * 0.55 + cMid * 0.30 + Math.max(0, c - cHigh - cMid) * 0.15);
  const rawCloud   = bell(dramaCloud, 35, 32, 0.75);

  // N3: Cloud Opacity Class multiplier
  let opacityMult = 1.0;
  if      (cHigh > 20 && cLow < 20)    opacityMult = 1.25; // thin cirrus → vivid
  else if (cLow  > 55)                  opacityMult = 0.45; // stratus → grey
  else if (cMid  > 50 && cLow < 25)    opacityMult = 0.80; // altostratus → muted

  // N6: High cloud bonus — cirrus is the best afterglow scatterer
  // Twilight mode weights this 1.6× for post-sunset glow
  const highBonusMult = twilightMode ? 1.6 : 1.0;
  const highBonus = cHigh > 10 ? Math.min(cHigh / 100, 0.35) * 0.6 * highBonusMult : 0;
  const midBonus  = (cMid > 15 && cMid < 55) ? 0.08 : 0;

  // B1 FIX: correct order — combined check before simple check (was unreachable)
  const delta = Number(cD)           || 0;
  const d6    = Number(cloudDelta6h) || 0;
  let deltaDrama = 0.3;
  if      (delta < -25 && d6 < -15)  deltaDrama = 0.95; // accelerating clear
  else if (delta < -25)               deltaDrama = 0.90;
  else if (delta < -15)               deltaDrama = 0.70;
  else if (delta < -5  && d6 < 0)    deltaDrama = 0.55; // slow clear confirmed
  else if (delta < -5)                deltaDrama = 0.50;
  else if (delta > 20  && d6 > 15)   deltaDrama = 0.08; // rapid build
  else if (delta > 15)                deltaDrama = 0.10;

  // Sunset window dip bonus
  const win = Number(sunsetWindow) || 0;
  const windowBonus = win > 30 ? 0.20 : win > 20 ? 0.14 : win > 10 ? 0.07 : 0;

  return Math.max(0, Math.min(1,
    rawCloud * opacityMult * 0.55
    + highBonus + midBonus
    + deltaDrama * 0.15
    + windowBonus
  ));
}

// ── aodScore: aerosol optical depth & particle composition ───────
function aodScore(params) {
  const { dust, pm2_5, pm10, aod } = params;

  const d   = Number(dust)  || 0;
  const p25 = Number(pm2_5) || 0;
  const p10 = Number(pm10)  || 0;
  const ao  = Number(aod)   || 0;

  // F6: Dust bell curve — sweet spot 20–30µg: warm glow; >60: grey haze
  // dustOptimum is learned from user ratings via learningEngine (default 25)
  const dustLevel = Math.max(d, p10 * 0.3);
  let dustDrama   = bell(dustLevel, params.dustOptimum ?? 25, 20, 0.72);
  if (ao > 0.5) dustDrama = Math.min(dustDrama, 0.15); // heavy aerosol column override

  // PM2.5 fine-particle colour enhancement
  let pm25Bonus = 0;
  if      (p25 > 0  && p25 <= 12)  pm25Bonus =  0.04;
  else if (p25 <= 35)               pm25Bonus =  0.08;
  else if (p25 <= 55)               pm25Bonus =  0.02;
  else                              pm25Bonus = -0.08;
  dustDrama = Math.max(0, Math.min(1, dustDrama + pm25Bonus));

  // N4: Angstrom proxy — fine vs coarse particle ratio
  // High ratio (≈1) = fine smoke/urban → vivid pink/violet scatter
  // Low ratio (≈0)  = coarse dust → warm orange, less vivid
  const angstromProxy = (p10 + d + 1) > 2 ? p25 / (p10 + d + 1) : 0.5;
  const angstromBonus = angstromProxy > 0.7 ? 0.06 : angstromProxy < 0.25 ? -0.03 : 0;

  return Math.max(0, Math.min(1, dustDrama + angstromBonus));
}

// ── atmosphereScore: humidity, visibility, solar geometry, wind, temp ──
function atmosphereScore(params) {
  const { humidity, visibility, solarElevation, windDir, windSpeed,
          distFromCoast, tempDropRate, inversionStrength, ozone,
          seasonalAnomaly, solarAzimuth, pm2_5 } = params;

  const h     = Number(humidity)          || 50;
  const v     = Number(visibility)        || 10;
  const sEl   = Number(solarElevation)    || 3;
  const ws    = Number(windSpeed)         || 0;
  const wd    = Number(windDir)           || 270;
  const dc    = Number(distFromCoast)     || 1;
  const tDrop = Number(tempDropRate)      || 0;
  const inv   = Number(inversionStrength) || 0;
  const oz    = Number(ozone)             || 0;
  const az    = Number(solarAzimuth)      || 270;
  const p25   = Number(pm2_5)             || 0;

  // F4: Humidity bell — peak at 60% (Rayleigh scattering optimum for Israel)
  // humidityOptimum is learned from user ratings via learningEngine (default 60)
  const humDrama = bell(h, params.humidityOptimum ?? 60, 25, 0.7);

  // F3: Visibility contribution — 15–25km optimal; <8km opaque; >35km too clean
  let visDrama = 0;
  if      (v >= 8 && v <= 35) visDrama = bell(v, 18, 10, 0.12);
  else if (v < 8)              visDrama = -0.12;
  else                         visDrama =  0.03;

  // Solar angle drama
  let solarDrama = 0.4;
  if      (sEl >= 0 && sEl <= 5)  solarDrama = 0.80;
  else if (sEl > 5 && sEl <= 10)  solarDrama = 0.60;
  else if (sEl < 0 && sEl >= -6)  solarDrama = 0.65; // civil twilight

  // N1: Optical Air Mass — longer path = deeper colours
  // Math.max(sEl, 0.5) prevents sin(0); cap at 40 for near-horizon angles
  const oam = Math.min(40, 1 / Math.sin(Math.max(sEl, 0.5) * Math.PI / 180));
  const oamBonus = oam > 12 ? 0.12 : oam > 7 ? 0.08 : oam > 5 ? 0.04 : 0;

  // N2: Solar azimuth — sunset directly into the sea (Israel west coast)
  const seaSunsetBonus = (az >= 255 && az <= 305 && dc < 0.4) ? 0.09 : 0;

  // N5: Sea salt — bell curve on wind speed (peak ~25 km/h)
  // Coastal west wind + humidity = salt spray haze → large red disc, less colour
  // Bell replaces hard threshold for smooth, realistic response
  const seaSaltPenalty = (wd >= 240 && wd <= 310 && h > 65 && dc < 0.3)
    ? bell(ws, 25, 10, 0.10)
    : 0;

  // L2: Wind direction — enhanced Sharav detection
  let windDirBonus = 0;
  if      (wd >= 220 && wd <= 300)  windDirBonus =  0.06; // W/SW sea breeze
  else if (wd >= 300 || wd < 45)   windDirBonus =  0.03; // N: crisp horizon
  else if (wd >= 45  && wd < 135)  windDirBonus = p25 > 35 ? -0.12 : p25 > 15 ? -0.08 : -0.04; // E/NE Sharav

  // N7: Temperature drop rate — rapid cooling = atmosphere clearing
  const tempDropBonus = tDrop > 3.0 ? 0.11 : tDrop > 1.5 ? 0.05 : tDrop < -1 ? -0.04 : 0;

  // Inversion penalty — warmer air aloft traps pollution
  const invPenalty = inv > 15 ? 0.15 : inv > 8 ? 0.08 : inv > 4 ? 0.03 : 0;

  // Ozone: surface O3 in µg/m³ = tropospheric smog indicator
  // Note: stratospheric O3 (DU) deepens twilight blues — opposite effect.
  // Open-Meteo AQ provides surface-level values; high surface O3 = smog.
  const ozPenalty = oz > 180 ? 0.05 : oz > 120 ? 0.02 : 0;

  // Seasonal anomaly
  const seasonDrama = Math.max(0, Math.min(0.8, 0.3 + (seasonalAnomaly || 0) * 0.15));

  return Math.max(0, Math.min(1,
    humDrama   * 0.25
    + solarDrama * 0.20
    + visDrama
    + seasonDrama * 0.12
    + oamBonus
    + seaSunsetBonus
    + windDirBonus
    + tempDropBonus
    - invPenalty
    - ozPenalty
    - seaSaltPenalty
  ));
}

// ─────────────────────────────────────────
//  DRAMA SCORE (0–1)
//  Combines Plug & Play modules with multiplicative synergy.
//  Synergy: good clouds + right aerosol = richer drama than sum of parts.
// ─────────────────────────────────────────
function calcDrama(params) {
  const cScore  = cloudScore(params);
  const aScore  = aodScore(params);
  const atScore = atmosphereScore(params);

  // Multiplicative synergy: cirrus + light dust creates electric orange-pink glow
  const synergy = cScore * aScore;

  // Use learned drama weights (returns defaults 0.30/0.27/0.27 when < 10 samples)
  const adj     = getLearningAdjustments(params.lat, params.lon, params.month);
  const cloudW  = adj.formulaWeights.cloudDramaW;
  const dustW   = adj.formulaWeights.dustDramaW;
  const atmW    = adj.formulaWeights.atmosphereDramaW;

  return Math.max(0, Math.min(1,
    cScore  * cloudW
    + aScore  * dustW
    + atScore * atmW
    + synergy * 0.09
    + 0.07        // small base floor — clear skies still get colour
  ));
}

// ─────────────────────────────────────────
//  DYNAMIC PALETTE
//  Maps dominant atmospheric conditions to a sunset style category.
//  Returns style name (EN/HE), primary/secondary hex colors, description.
// ─────────────────────────────────────────
function calcPalette(params, certainty, drama) {
  const { dust, pm2_5, pm10, cloudsHigh, cloudsMid, cloudsLow,
          humidity, visibility, windDir, windSpeed, distFromCoast,
          cloudDelta: cD } = params;

  const cHigh = Number(cloudsHigh)    ?? 0;
  const cMid  = Number(cloudsMid)     ?? 0;
  const cLow  = Number(cloudsLow)     ?? 0;
  const h     = Number(humidity)      || 50;
  const v     = Number(visibility)    || 10;
  const d     = Number(dust)          || 0;
  const p25   = Number(pm2_5)         || 0;
  const p10   = Number(pm10)          || 0;
  const ws    = Number(windSpeed)     || 0;
  const wd    = Number(windDir)       || 270;
  const dc    = Number(distFromCoast) || 1;
  const delta = Number(cD)            || 0;

  const dustLevel     = Math.max(d, p10 * 0.3);
  const angstromProxy = (p10 + d + 1) > 2 ? p25 / (p10 + d + 1) : 0.5;

  // Decision tree — first match wins
  // 1. Grey Veil: low certainty or thick low cloud
  if (certainty < 0.30 || cLow > 70) {
    return {
      style: 'Grey Veil', styleHe: 'מסך אפור',
      primary: '#5C5C6E', secondary: '#3A3A48',
      description: 'עננות כבדה — שקיעה מכוסה',
    };
  }

  // 2. Desert Fire: heavy dust + easterly wind + high drama
  if (dustLevel > 40 && drama > 0.55 && wd >= 45 && wd < 180) {
    return {
      style: 'Desert Fire', styleHe: 'אש מדבר',
      primary: '#C84B00', secondary: '#8B1A00',
      description: 'אבק מדברי — שמש אדומה כגחלים',
    };
  }

  // 3. Storm Break: rapid clearing after clouds, high drama
  if (delta < -20 && drama > 0.65 && certainty > 0.50) {
    return {
      style: 'Storm Break', styleHe: 'פריצת סערה',
      primary: '#FF6B35', secondary: '#6B2FBF',
      description: 'שמיים מתבהרים — אור דרמטי ורוחות',
    };
  }

  // 4. Purple Twilight: high cirrus + fine particles → violet scatter
  if (cHigh > 35 && angstromProxy > 0.60 && drama > 0.60) {
    return {
      style: 'Purple Twilight', styleHe: 'דמדומים סגולים',
      primary: '#7B2FBE', secondary: '#4A0080',
      description: 'ענני סירוס גבוהים — זוהר סגול-ורוד',
    };
  }

  // 5. Sea Haze: coastal west wind + high humidity
  if (dc < 0.30 && wd >= 240 && wd <= 310 && h > 70 && ws > 12) {
    return {
      style: 'Sea Haze', styleHe: 'אובך ים',
      primary: '#E8A87C', secondary: '#B5541C',
      description: 'אובך ים — שמש כתומה ורחבה',
    };
  }

  // 6. Deep Glow: moderate dust + cirrus + strong drama
  if (dustLevel > 15 && dustLevel <= 40 && cHigh > 15 && drama > 0.60) {
    return {
      style: 'Deep Glow', styleHe: 'זוהר עמוק',
      primary: '#E05C00', secondary: '#9B2500',
      description: 'אבק קל + ענני גובה — שקיעה עמוקה ועשירה',
    };
  }

  // 7. Crystal Clear: very clean air, high visibility, low humidity
  if (v > 25 && h < 50 && dustLevel < 15 && certainty > 0.70) {
    return {
      style: 'Crystal Clear', styleHe: 'בהיר קריסטל',
      primary: '#FFB347', secondary: '#FF6600',
      description: 'אוויר נקי — שקיעה צלולה וצהובה',
    };
  }

  // 8. Golden Hour (default)
  return {
    style: 'Golden Hour', styleHe: 'שעת זהב',
    primary: '#FFA500', secondary: '#FF4500',
    description: 'שעת הזהב הקלאסית',
  };
}

// ─────────────────────────────────────────
//  AFTERGLOW MODEL
//  Estimates post-sunset glow quality, peak timing, and duration.
//  Called with sunset params; works best with twilightMode context.
// ─────────────────────────────────────────
export function calcAfterglow(params) {
  const { cloudsHigh, cloudsMid, cloudsLow, dust, pm2_5, pm10,
          humidity, visibility, aod } = params;

  const cHigh = Number(cloudsHigh) ?? 0;
  const cMid  = Number(cloudsMid)  ?? 0;
  const cLow  = Number(cloudsLow)  ?? 0;
  const h     = Number(humidity)   || 50;
  const v     = Number(visibility) || 10;
  const d     = Number(dust)       || 0;
  const p25   = Number(pm2_5)      || 0;
  const p10   = Number(pm10)       || 0;
  const ao    = Number(aod)        || 0;

  const dustLevel = Math.max(d, p10 * 0.3);

  // Quality drivers:
  const cirrBase   = Math.min(1, cHigh / 60);        // cirrus = primary afterglow scatterer
  const dustBase   = bell(dustLevel, 30, 25, 0.70);  // dust extends red/orange glow
  const humBase    = bell(h, 55, 28, 0.60);          // moderate humidity → pink glow
  const visBase    = v > 5 ? bell(v, 20, 15, 0.70) : 0.1;

  const aodPenalty = ao > 0.60 ? 0.30 : ao > 0.35 ? 0.12 : 0; // heavy aerosol blocks
  const lowPenalty = cLow > 60 ? 0.35 : cLow > 35 ? 0.15 : 0; // stratus blocks

  const qualityRaw = cirrBase * 0.40 + dustBase * 0.25 + humBase * 0.20 + visBase * 0.15
                   - aodPenalty - lowPenalty;
  const quality = Math.round(Math.max(1, Math.min(10, qualityRaw * 9 + 1)) * 10) / 10;

  // Peak timing: cirrus peaks late (~18min); dust peaks early (~10min)
  let peakMinutes = 12;
  if      (cHigh > 40 && cLow < 30)     peakMinutes = 18; // high cirrus → Belt of Venus
  else if (dustLevel > 30)               peakMinutes = 10; // dust glow is lower, earlier
  else if (cMid > 30 && cLow < 20)      peakMinutes = 14;

  // Duration: cirrus + humidity extends glow; stratus / heavy AOD cuts it short
  let durationMinutes = 20;
  if      (cHigh > 50 && h > 55)               durationMinutes = 38;
  else if (cHigh > 30)                          durationMinutes = 28;
  else if (dustLevel > 25 && h > 50)            durationMinutes = 25;
  else if (cLow > 50 || ao > 0.50)              durationMinutes = 10;

  // Style
  let style, styleHe;
  if      (cHigh > 30 && cLow < 25 && quality >= 6) { style = 'Belt of Venus';  styleHe = 'חגורת ונוס'; }
  else if (h > 60 && dustLevel < 25 && quality >= 5) { style = 'Pink Afterglow'; styleHe = 'זוהר ורוד'; }
  else if (dustLevel > 20 && quality >= 4)            { style = 'Warm Fade';      styleHe = 'דעיכה חמה'; }
  else if (quality >= 5)                              { style = 'Classic Dusk';   styleHe = 'דמדום קלאסי'; }
  else                                                { style = 'Rapid Fade';     styleHe = 'דעיכה מהירה'; }

  return { quality, peakMinutes, durationMinutes, style, styleHe };
}

// ─────────────────────────────────────────
//  Infer dominant model regime from params
//  Mirrors scoreEngine's smoothstep thresholds
// ─────────────────────────────────────────
function inferModel(params) {
  const clouds    = (Number(params.clouds) || 0) / 100;
  const turbidity = Math.min(1, (Number(params.dust) || 0) / 100 + (Number(params.aod) || 0));
  if (clouds > 0.60)    return 'CloudModel';
  if (turbidity > 0.45) return 'DustModel';
  return 'ClearSkyModel';
}

// ─────────────────────────────────────────
//  COMBINED SCORE
//  F1: drama × certainty^1.8  (exponential gate)
//  certainty=1.0 → full drama; certainty=0.3 → drama×0.11
//
//  extended=true: also returns palette + afterglow
// ─────────────────────────────────────────
export function calcScore(params, extended = false) {
  const certainty = calcCertainty(params);
  const drama     = calcDrama(params);

  let raw = drama * Math.pow(certainty, 1.3);

  // Hard overrides: certainty floor
  if (certainty < 0.15) raw = Math.min(raw, 0.12);
  if (certainty < 0.30) raw = Math.min(raw, 0.30);

  // Hard override: extreme weather codes
  if (OVERRIDE_CODES.has(params.weatherCode)) raw = Math.min(raw, 0.18);

  // Hard override: heat wave (>40°C at sunset) = severe haze
  if (params.tempAtSunset > 40) raw = Math.min(raw, 0.35);

  // Scale 0–1 → 1.0–10.0
  let score = raw * 9 + 1;

  // B3 FIX: apply geographic bonus (computed in buildScoreParams)
  score += (params.geoBonus || 0) * 5;

  // Calibration bias correction (location-aware)
  const { bias } = getBiasCorrection(params.lat, params.lon);
  if (bias !== 0) score -= bias;

  // Learning: per-model bias correction (additive, active only after 10+ sunsets)
  const _ladj = getLearningAdjustments(params.lat, params.lon, params.month);
  if (_ladj.active) {
    score += _ladj.modelBiases[inferModel(params)] || 0;
  }

  score = Math.round(Math.min(10, Math.max(1, score)) * 10) / 10;

  const result = {
    score,
    certainty: Math.round(certainty * 100),
    drama:     Math.round(drama     * 100),
  };

  if (extended) {
    result.palette   = calcPalette(params, certainty, drama);
    result.afterglow = calcAfterglow(params);
  }

  return result;
}

// ─────────────────────────────────────────
//  Build params for scoring
// ─────────────────────────────────────────
function buildScoreParams(h, idx, aq, aqIdx, lat, lon, eventISO, date, weatherCode, tempAtSunset, options = {}) {
  const { westernData = null, twilightMode = false } = options;

  const solarEl = eventISO ? calcSolarElevation(lat, lon, new Date(eventISO)) : 3;
  const solarAz = eventISO ? calcSolarAzimuth(lat, lon, new Date(eventISO)) : 270;

  const month    = date ? new Date(date + 'T12:00:00').getMonth() + 1 : 6;
  const baseline = getDynamicSeasonalBaseline(month) || SEASONAL_BASELINE[month] || SEASONAL_BASELINE[6];

  // Aerosol fallback: use seasonal baseline when AQ API unavailable (e.g. 503)
  // rather than assuming zero aerosols (which underestimates scattering colour).
  // Ratios: pm10 ≈ 1.5× dust, pm2_5 ≈ 0.25× dust, AOD ≈ dust / 220 (dimensionless).
  const _aqDust = baseline.dust;
  let dustVal    = aq ? valAt(aq.hourly?.dust,                  aqIdx, _aqDust)           : _aqDust;
  const pm25Val  = aq ? valAt(aq.hourly?.pm2_5,                 aqIdx, _aqDust * 0.25)    : _aqDust * 0.25;
  const pm10Val  = aq ? valAt(aq.hourly?.pm10,                  aqIdx, _aqDust * 1.5)     : _aqDust * 1.5;
  // AOD from API (direct measurement); fallback derived from dustVal after learning scaling below.
  const _aodFromAPI  = aq ? (aq.hourly?.aerosol_optical_depth?.[aqIdx] ?? null) : null;
  const ozoneVal = aq ? valAt(aq.hourly?.ozone,                 aqIdx, 0)                 : 0;

  // Learning: apply forecast API input bias corrections + get learned bell peaks
  const _ladj = getLearningAdjustments(lat, lon, month);
  let _cloudsVal     = avgAround(h.cloudcover,          idx);
  let _humidityVal   = avgAround(h.relativehumidity_2m, idx);
  let _visibilityVal = avgAround(h.visibility,          idx) / 1000;
  if (_ladj.active) {
    _cloudsVal     *= _ladj.inputScales.cloudScale;
    _humidityVal   *= _ladj.inputScales.humidityScale;
    dustVal        *= _ladj.inputScales.dustScale;
    _visibilityVal *= _ladj.inputScales.visibilityScale;
  }
  // AOD: use direct API measurement when available; otherwise derive from (scaled) dustVal
  // so AOD stays consistent with dust after learning corrections are applied.
  const aodVal = (_aodFromAPI != null && !isNaN(_aodFromAPI) && _aodFromAPI >= 0) ? _aodFromAPI : dustVal / 220;

  const cloudAnomaly = (baseline.clouds - _cloudsVal) / 30;
  const visAnomaly   = (_visibilityVal - baseline.visibility) / 10;
  const seasonalAnomaly = (cloudAnomaly + visAnomaly) / 2;

  const distFromCoast = Math.abs(lon - LOCATION_CLIMATE.coastLon);
  const geoBonus = distFromCoast < 0.15 ? 0.1 : distFromCoast < 0.5 ? 0.03 : 0;

  const cd6h = (idx >= 6 && h.cloudcover)
    ? (h.cloudcover[idx] ?? 0) - (h.cloudcover[idx - 6] ?? 0)
    : cloudDelta(h.cloudcover, idx);

  // N7: Temperature drop rate (°C/h, positive = cooling = clearing)
  const tempNow  = valAt(h.temperature_2m, idx,                  tempAtSunset ?? 25);
  const tempPrev = valAt(h.temperature_2m, Math.max(0, idx - 1), tempAtSunset ?? 25);
  const tempDropRate = tempPrev - tempNow;

  // A3: Temperature inversion — 850hPa warmer than surface = trapped pollution
  const temp850Raw = h.temperature_850hPa
    ? valAt(h.temperature_850hPa, idx, null)
    : null;
  const inversionStrength = (temp850Raw != null) ? Math.max(0, temp850Raw - tempNow) : 0;

  // A2: Western horizon — low clouds at lon-0.5° block the light path
  let cloudsLowWest = 0;
  if (westernData) {
    const wTimes  = westernData.hourly?.time;
    const wISOKey = eventISO ? eventISO.substring(0, 13) : null;
    const wIdx    = (wTimes && wISOKey) ? findHourIndex(wTimes, wISOKey) : -1;
    cloudsLowWest = wIdx >= 0 ? valAt(westernData.hourly?.cloudcover_low, wIdx, 0) : 0;
  }
  // horizonGap: fraction of western horizon that is clear (0 = blocked, 1 = open)
  const horizonGap = Math.max(0, (100 - cloudsLowWest) / 100);

  return {
    clouds:           _cloudsVal,
    cloudsLow:        valAt(h.cloudcover_low,           idx),
    cloudsMid:        valAt(h.cloudcover_mid,           idx),
    cloudsHigh:       valAt(h.cloudcover_high,          idx),
    visibility:       _visibilityVal,
    humidity:         _humidityVal,
    windSpeed:        avgAround(h.windspeed_10m,        idx),
    windDir:          valAt(h.winddirection_10m,        idx, 270),
    rain:             valAt(h.precipitation,            idx, 0),
    rainProb:         valAt(h.precipitation_probability,idx, 0),
    cloudDelta:       cloudDelta(h.cloudcover, idx),
    cloudDelta6h:     cd6h,
    sunsetWindow:     sunsetWindowDip(h.cloudcover, idx),
    dust:             dustVal,
    pm2_5:            pm25Val,
    pm10:             pm10Val,
    aod:              aodVal,
    ozone:            ozoneVal,
    solarElevation:   solarEl,
    solarAzimuth:     solarAz,
    seasonalAnomaly,
    geoBonus,
    distFromCoast,
    tempDropRate,
    inversionStrength,
    cloudsLowWest,
    horizonGap,
    twilightMode,
    weatherCode:      weatherCode || 0,
    tempAtSunset:     tempAtSunset || 25,
    // Learning: bell curve peaks passed through to aodScore + atmosphereScore
    humidityOptimum:  _ladj.bellPeaks.humidityOptimum,
    dustOptimum:      _ladj.bellPeaks.dustOptimum,
    month,
    lat, lon,
  };
}

// ─────────────────────────────────────────
//  Safe fallback day — returned when weather data is missing/malformed.
//  Contains every property that downstream consumers (buildMainHTML,
//  computeDaySkyColors, decisionEngine, etc.) read.
// ─────────────────────────────────────────
function _safeFallbackDay(dayIndex) {
  const today = new Date();
  today.setDate(today.getDate() + dayIndex);
  const date = today.toISOString().slice(0, 10);
  return {
    date, day: '', shortDate: date,
    score: 0, srScore: 0, ssScore: 0, twScore: 0, dramaLevel: 0, goldenHourMin: 0,
    certainty: 0, scoreLabel: 'אין נתונים',
    sunrise: '06:00', sunset: '19:00', twilight: '', purpleLightTime: '19:18',
    temp: '--°', tempMin: '--°', feelsLike: '--°',
    cond: 'אין נתונים', wind: '0 קמ"ש', windDir: '',
    windGusts: '0 קמ"ש', humidity: '0%', dewPoint: '0°',
    visibility: '0', cloud: '0%', pressure: '1013 mb', uvIndex: '0',
    rainProb: '0%', rainMm: '0 מ"מ', dust: '0 µg',
    _cloudRaw: 0, _humidityRaw: 50, _visibilityRaw: 10, _windRaw: 0,
    _cloudLowRaw: 0, _cloudMidRaw: 0, _cloudHighRaw: 0,
    _rainMmRaw: 0, _cloudDelta: 0, _dustRaw: 0, _pm10Raw: 0,
    palette: null, afterglow: 0,
    _solarAzimuth: 270, _solarElevation: 0,
    turbidity: 0.05, mieIntensity: 0, rayleighSpread: 0,
    physicsContributions: null, mieGrowthFactor: 1, angstromExp: 0.5,
    ozoneDU: 300, goldenWindow: null,
    scoreEngine: null, scoreModel: null,
    hourlyFull: [], tags: [], skyColors: null,
  };
}

// ─────────────────────────────────────────
//  CalcDayData
// ─────────────────────────────────────────
export function calcDayData(dayIndex, weatherData, airQuality = null, lat = 32, lon = 34.78, westernData = null) {
  // Guard: malformed or empty weather data → return safe placeholder
  if (!weatherData?.daily?.time || !weatherData?.hourly?.time) {
    return _safeFallbackDay(dayIndex);
  }

  const d  = weatherData.daily;
  const h  = weatherData.hourly;
  const ht = h.time;

  const date    = d.time[dayIndex];
  const sunrise = d.sunrise[dayIndex];
  const sunset  = d.sunset[dayIndex];
  const sunriseStr      = formatTime(sunrise);
  const sunsetStr       = formatTime(sunset);
  const purpleLightTime = addMinutes(sunsetStr, 18);

  const srIdx = findHourIndex(ht, sunrise);
  const ssIdx = findHourIndex(ht, sunset);
  const twIdx = ssIdx >= 0 ? Math.min(ssIdx + 1, ht.length - 1) : -1;

  const wcode    = d.weathercode[dayIndex] || 0;
  const tempAtSS = ssIdx >= 0 ? (h.temperature_2m[ssIdx] || 25) : 25;

  const aqTimes = airQuality?.hourly?.time;
  const aqSsIdx = aqTimes ? findHourIndex(aqTimes, sunset)  : -1;
  const aqSrIdx = aqTimes ? findHourIndex(aqTimes, sunrise) : -1;
  const aqTwIdx = (aqSsIdx >= 0 && ssIdx >= 0) ? Math.min(aqSsIdx + 1, (aqTimes?.length || 1) - 1) : -1;

  const baseOpts = { westernData };

  // extended=true for ssResult — includes palette + afterglow
  const ssParams = buildScoreParams(h, ssIdx, airQuality, aqSsIdx, lat, lon, sunset, date, wcode, tempAtSS, baseOpts);
  const ssResult = calcScore(ssParams, true);
  const srResult = calcScore(buildScoreParams(h, srIdx, airQuality, aqSrIdx, lat, lon, sunrise, date, wcode, tempAtSS, baseOpts));
  // N6: twilight mode — high clouds weighted 1.6× for afterglow effect
  const twResult = calcScore(buildScoreParams(h, twIdx, airQuality, aqTwIdx, lat, lon, sunset,  date, wcode, tempAtSS, { westernData, twilightMode: true }));

  // ── Physics layer (Pulse 2): turbidity, Mie/Rayleigh for gradient + golden window ──
  const physics = computeScattering({
    dust:          ssParams.dust,
    humidity:      ssParams.humidity,
    visibility:    ssParams.visibility,
    aqi:           null,
    solarElevation: ssParams.solarElevation,
  });

  // ── Golden Window (Pulse 2): physics-aware peak time prediction ──
  const cloudHeightCat = ssParams.cloudsHigh > 40 ? 'high'
                       : ssParams.cloudsLow  > 40 ? 'low'
                       : 'mid';
  const goldenWindow = predictGoldenWindow({
    sunsetTime:          new Date(`${date}T${sunsetStr}:00`),
    solarElevation:      ssParams.solarElevation,
    cloudHeightCategory: cloudHeightCat,
    turbidity:           physics.turbidity,
    latitude:            lat,
    clouds:              ssParams.clouds / 100,
    declination:         getSolarDeclination(date),
  });

  // Ångström exponent — blend of two physical signals (Phase 2):
  //   α_PM:         PM2.5 / (PM10 + dust) ratio → aerosol size distribution
  //                 high ratio (≈1) → fine smoke/urban → blue-tinted haze
  //                 low  ratio (≈0) → coarse dust/salt → white/grey haze
  //   α_humidity:   κ-Köhler hygroscopic growth shifts particle size
  //                 distribution toward maritime/wet values as RH rises.
  //
  // 50/50 soft blend avoids a hard swap when humidity changes while still
  // letting wet air pull the exponent toward maritime α≈0.3.
  const _p25 = Number(ssParams.pm2_5) || 0;
  const _p10 = Number(ssParams.pm10)  || 0;
  const _d   = Number(ssParams.dust)  || 0;
  const _alphaPM       = (_p10 + _d + 1) > 2 ? _p25 / (_p10 + _d + 1) : 0.5;
  const _alphaHumidity = physics.angstromEffective ?? 0;
  const angstromExp = 0.5 * _alphaPM + 0.5 * _alphaHumidity;

  // Seasonal ozone: varies by latitude band and month (~±50 DU over the year).
  // Stored on dayData so the render layer (main-screen.js) can use it for live
  // canvas updates without re-deriving the month/lat lookup.
  const seasonalOzone = getSeasonalOzone(lat, ssParams.month);

  const ssScore = ssResult.score;
  const srScore = srResult.score;
  const twScore = twResult.score;

  // ── Physics-based scoreEngine (replaces legacy composite for display) ───────
  // computeEngineScore uses Gaussian sweet-spots + 3 piecewise models and a
  // crepuscular-ray bonus.  Result (0–100) is scaled to 1–10 for backward compat.
  const engineResult = (() => {
    try {
      return computeEngineScore({
        clouds:             ssParams.clouds / 100,  // convert % → fraction (scoreEngine expects 0-1)
        cloudHeightCategory: cloudHeightCat,
        turbidity:          physics.turbidity,
        mieIntensity:       physics.mieIntensity,
        rayleighSpread:     physics.rayleighSpread,
        atmosphericClarity: physics.atmosphericClarity,
        solarElevation:     ssParams.solarElevation,
        horizonClearance:   ssParams.horizonGap ?? 0.3,
        humidity:           ssParams.humidity,
        dust:               ssParams.dust,
      });
    } catch (e) {
      console.warn('[score] engineResult failed:', e.message || e);
      return null; // safe fallback — use legacy score below
    }
  })();

  // SCORING AUTHORITY: scoreEngine.js (0–100) is the sole source of truth for
  // the sunset component.  Legacy calcScore (0–1 certainty × drama) is only a
  // fallback if the engine throws.  The composite (effectiveSsScore * 0.6 +
  // twScore * 0.25 + srScore * 0.15) produces the final day.score (1–10).
  const effectiveSsScore = engineResult
    ? Math.round((engineResult.score / 10) * 10) / 10   // 0–100 → 1–10
    : ssScore;
  const score = Math.round((effectiveSsScore * 0.6 + twScore * 0.25 + srScore * 0.15) * 10) / 10;

  const dramaLevel = ssResult.drama;

  const weatherCond = WEATHER_CODES[wcode] || 'תנאים לא ידועים';
  const windDirDeg = ssIdx >= 0 ? (h.winddirection_10m[ssIdx] || 0) : 0;
  const windDir    = degToDir(windDirDeg);

  // Pre-compute per-hour scores for the 3h window around sunset
  const sunsetScoreWindow = new Map();
  if (ssIdx >= 0) {
    for (let offset = -3; offset <= 2; offset++) {
      const hIdx = ssIdx + offset;
      if (hIdx < 0 || hIdx >= ht.length || !ht[hIdx].startsWith(date)) continue;
      const aqHIdx = aqTimes ? findHourIndex(aqTimes, ht[hIdx].substring(0, 13)) : -1;
      const r = calcScore(buildScoreParams(h, hIdx, airQuality, aqHIdx, lat, lon, ht[hIdx], date, wcode, tempAtSS, baseOpts));
      sunsetScoreWindow.set(hIdx, r.score);
    }
  }

  const hourlyFull = ht.reduce((acc, time, idx) => {
    if (!time.startsWith(date)) return acc;
    const hourNum = parseInt(time.substring(11, 13), 10);
    if (hourNum < 5 || hourNum > 22) return acc;
    const entry = {
      t: `${String(hourNum).padStart(2, '0')}:00`,
      temp:  Math.round(h.temperature_2m[idx] ?? 20),
      cloud: Math.round(h.cloudcover[idx]     ?? 0),
      wind:  Math.round(h.windspeed_10m[idx]  ?? 0),
      rain:  Math.round(h.precipitation_probability[idx] ?? 0),
      isSunrise:  idx === srIdx,
      isSunset:   idx === ssIdx,
      isTwilight: idx === twIdx,
    };
    if (sunsetScoreWindow.has(idx)) entry.score = sunsetScoreWindow.get(idx);
    acc.push(entry);
    return acc;
  }, []);

  const _cloudRaw      = ssIdx >= 0 ? Math.round(h.cloudcover[ssIdx] || 0) : 0;
  const _humidityRaw   = ssIdx >= 0 ? Math.round(h.relativehumidity_2m[ssIdx] || 50) : 50;
  const _visibilityRaw = ssIdx >= 0 ? Math.round((h.visibility[ssIdx] || 0) / 1000 * 10) / 10 : 10;
  const _windRaw       = ssIdx >= 0 ? Math.round(h.windspeed_10m[ssIdx] || 0) : 0;
  const _cloudLowRaw   = ssIdx >= 0 ? Math.round(valAt(h.cloudcover_low,  ssIdx)) : 0;
  const _cloudMidRaw   = ssIdx >= 0 ? Math.round(valAt(h.cloudcover_mid,  ssIdx)) : 0;
  const _cloudHighRaw  = ssIdx >= 0 ? Math.round(valAt(h.cloudcover_high, ssIdx)) : 0;
  const _rainMmRaw     = ssIdx >= 0 ? valAt(h.precipitation, ssIdx, 0) : 0;
  const _cloudDelta    = cloudDelta(h.cloudcover, ssIdx);
  const _dustRaw       = airQuality && aqSsIdx >= 0 ? Math.round(valAt(airQuality.hourly?.dust,  aqSsIdx, 0)) : 0;
  const _pm10Raw       = airQuality && aqSsIdx >= 0 ? Math.round(valAt(airQuality.hourly?.pm10,  aqSsIdx, 0)) : 0;

  const windGusts = ssIdx >= 0 ? Math.round(h.windgusts_10m[ssIdx]      || 0)    : 0;
  const dewPoint  = ssIdx >= 0 ? Math.round(h.dewpoint_2m[ssIdx]        || 10)   : 10;
  const pressure  = ssIdx >= 0 ? Math.round(h.surface_pressure[ssIdx]   || 1013) : 1013;
  const uvIndex   = ssIdx >= 0 ? Math.round(h.uv_index[ssIdx]           || 0)    : 0;
  const rainProb  = d.precipitation_probability_max[dayIndex] || 0;
  const rainMm    = Math.round((d.precipitation_sum[dayIndex] || 0) * 10) / 10;
  const temp      = Math.round(d.temperature_2m_max[dayIndex] || 20);
  const tempMin   = Math.round(d.temperature_2m_min[dayIndex] || 12);
  const feelsLike = ssIdx >= 0 ? Math.round(h.apparent_temperature?.[ssIdx] || temp) : temp;

  const goldenHourMin = calcGoldenHourMin(lat, new Date(`${date}T${sunsetStr}:00`));

  const dayData = {
    date, day: dateToHebDay(date), shortDate: shortDate(date),
    score, srScore, ssScore: effectiveSsScore, twScore, dramaLevel, goldenHourMin,
    certainty: ssResult.certainty,
    scoreLabel: scoreToLabel(score),
    sunrise: sunriseStr, sunset: sunsetStr, twilight: twilightRange(sunset), purpleLightTime,
    temp: `${temp}°`, tempMin: `${tempMin}°`, feelsLike: `${feelsLike}°`,
    cond: weatherCond, wind: `${_windRaw} קמ"ש`, windDir,
    windGusts: `${windGusts} קמ"ש`,
    humidity: `${_humidityRaw}%`, dewPoint: `${dewPoint}°`,
    visibility: `${_visibilityRaw}`, cloud: `${_cloudRaw}%`,
    pressure: `${pressure} mb`, uvIndex: String(uvIndex),
    rainProb: `${rainProb}%`, rainMm: `${rainMm} מ"מ`,
    dust: `${_dustRaw} µg`,
    _cloudRaw, _humidityRaw, _visibilityRaw, _windRaw,
    _cloudLowRaw, _cloudMidRaw, _cloudHighRaw,
    _rainMmRaw, _cloudDelta, _dustRaw, _pm10Raw,
    // Extended: palette + afterglow from sunset scoring
    palette:   ssResult.palette,
    afterglow: ssResult.afterglow,
    // Pulse 4: solar azimuth + elevation at sunset — azimuth for compass, elevation for sky color engine
    _solarAzimuth:   ssParams.solarAzimuth,
    _solarElevation: ssParams.solarElevation,
    // Pulse 2: physics layer outputs (turbidity for dynamic gradient + debug panel)
    turbidity:      physics.turbidity,
    mieIntensity:   physics.mieIntensity,
    rayleighSpread: physics.rayleighSpread,
    physicsContributions: physics.contributions,
    // Phase 2: humidity → Mie physical drivers (κ-Köhler growth + α blend)
    mieGrowthFactor: physics.mieGrowthFactor ?? 1,
    angstromExp,                     // blended α_PM × α_humidity for render layer
    ozoneDU:        seasonalOzone,  // seasonal ozone column (DU) for render layer
    // Pulse 2: golden window — physics-aware peak time prediction
    goldenWindow,
    // scoreEngine: richer physics-based scorer (0–100) for debug + decisionEngine
    scoreEngine:  engineResult ?? null,
    scoreModel:   engineResult?.model ?? null,
    hourlyFull, tags: []
  };

  dayData.tags = buildTags(dayData);
  dayData.cond = buildSmartCond(dayData) || weatherCond;
  return dayData;
}

export function calcWeekData(weatherData, airQuality = null, lat = 32, lon = 34.78, westernData = null) {
  const count = weatherData?.daily?.time?.length || 0;
  const days  = Array.from({ length: count }, (_, i) =>
    calcDayData(i, weatherData, airQuality, lat, lon, westernData)
  );

  // L4: Post-rain clear sky bonus — differentiated by rain intensity
  for (let i = 1; i < days.length; i++) {
    const prev = days[i - 1];
    const curr = days[i];
    if (curr._cloudRaw >= 30 || curr._visibilityRaw <= 15) continue;

    if (prev._rainMmRaw > 5) {
      // Heavy rain: washes air thoroughly — score boost + visibility display boost
      curr.ssScore = Math.min(10, Math.round((curr.ssScore + 0.7) * 10) / 10);
      curr.score   = Math.min(10, Math.round((curr.score   + 0.4) * 10) / 10);
      // Washout visibility boost: heavy rain scrubs aerosols — display 20% better
      curr._visibilityRaw = Math.round(curr._visibilityRaw * 1.20 * 10) / 10;
      curr.visibility = `${curr._visibilityRaw}`;
      curr.tags = [...curr.tags, 'אחרי גשם כבד — אוויר נקי'];
    } else if (prev._rainMmRaw > 1.5) {
      curr.ssScore = Math.min(10, Math.round((curr.ssScore + 0.5) * 10) / 10);
      curr.score   = Math.min(10, Math.round((curr.score   + 0.3) * 10) / 10);
      curr.tags = [...curr.tags, 'אחרי גשם — שמיים נקיים'];
    }
  }

  return days;
}

// ✓ score.js v6 — complete
