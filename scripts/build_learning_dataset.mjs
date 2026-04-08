// ═══════════════════════════════════════════
//  TWILIGHT — build_learning_dataset.mjs
//
//  Real forecast-vs-actual backtest dataset builder.
//
//  For each (city, date) over the last 365 days, fetches:
//    1. The historical FORECAST that Open-Meteo issued for that date,
//       via the historical-forecast-api  (this is what the user would
//       have actually seen 1-2 days before the sunset).
//    2. The actual ERA5 reanalysis values via the archive-api.
//
//  Then runs the project's scoreEngine.computeScore() ON BOTH and
//  writes a learning-seed.json with REAL forecast bias signals
//  (paramRatios ≠ 1, forecastError ≠ 0) so the EMA in
//  learningEngine.js Phase 1 (updateInputScales) actually learns
//  something instead of cementing 1.0× scales.
//
//  Run:
//    node scripts/build_learning_dataset.mjs
//
//  Output:
//    learning-seed.json (overwrites the existing file)
// ═══════════════════════════════════════════

import { computeScore } from '../js/engine/scoreEngine.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_PATH  = resolve(__dirname, '..', 'learning-seed.json');

// ─── Cities ──────────────────────────────────────────────────────────
// Same six locations the existing scripts/data/results-*.json files
// already cover. locBucket matches js/calibration.js:13 getLocBucket().
const CITIES = [
  { name: 'Tel Aviv Gordon Beach', lat: 32.087, lon: 34.767, locBucket: 'coast'   },
  { name: 'Herzliya Marina',       lat: 32.166, lon: 34.793, locBucket: 'coast'   },
  { name: 'Haifa Port',            lat: 32.819, lon: 34.999, locBucket: 'north'   },
  { name: 'Jerusalem',             lat: 31.778, lon: 35.235, locBucket: 'east'    },
  { name: "Be'er Sheva",           lat: 31.252, lon: 34.791, locBucket: 'central' },
  { name: 'Tiberias',              lat: 32.793, lon: 35.531, locBucket: 'north'   },
];

// ─── API params ──────────────────────────────────────────────────────
const HOURLY_FORECAST = [
  'cloudcover', 'cloudcover_low', 'cloudcover_mid', 'cloudcover_high',
  'relativehumidity_2m', 'visibility',
].join(',');

const HOURLY_ARCHIVE = [
  'cloudcover', 'cloudcover_low', 'cloudcover_mid', 'cloudcover_high',
  'relativehumidity_2m',
].join(',');

const HOURLY_AQ = ['dust', 'pm10', 'pm2_5'].join(',');

// ─── Helpers ─────────────────────────────────────────────────────────
async function fetchJson(url, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.slice(0, 80)}…`);
      return await res.json();
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

function inferCloudHeightCategory(low = 0, mid = 0, high = 0) {
  if (high >= mid && high >= low) return 'high';
  if (low  >  mid && low  >  high) return 'low';
  return 'mid';
}

// Israel sunset hour by month (rounded to nearest hour) — used to pick
// the right slice from the hourly arrays. Off-by-one is fine because
// the score model is smooth across +/- 1h around true sunset.
function approxSunsetHour(month) {
  // Jan..Dec, evening sunset hour (24h) for ~32°N
  const map = [17, 17, 18, 18, 19, 19, 19, 19, 18, 17, 16, 16];
  return map[month - 1];
}

// ERA5 reanalysis lag is ~5 days — anything closer than that returns
// nulls. We start the window 7 days back to be safe.
function dateRange(daysBack) {
  const out = [];
  const today = new Date();
  for (let i = daysBack + 7; i > 7; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function buildScoreInput(slice) {
  const cloudsFraction = (slice.clouds ?? 30) / 100;
  return {
    clouds:              cloudsFraction,
    cloudHeightCategory: inferCloudHeightCategory(slice.cloudsLow, slice.cloudsMid, slice.cloudsHigh),
    horizonClearance:    Math.max(0, Math.min(1, 1 - cloudsFraction * 1.2)),
    dust:                slice.dust       ?? 20,
    humidity:            slice.humidity   ?? 50,
    visibility:          slice.visibility ?? 15,
    aqi:                 null,
    solarElevation:      3,
  };
}

function scaleTo1to10(score0to100) {
  return Math.round(((score0to100 / 100) * 9 + 1) * 10) / 10;
}

// ─── Per-city processing ─────────────────────────────────────────────
async function processCity(city, dates) {
  const startDate = dates[0];
  const endDate   = dates[dates.length - 1];

  const forecastUrl = `https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&start_date=${startDate}&end_date=${endDate}&hourly=${HOURLY_FORECAST}&timezone=Asia%2FJerusalem`;
  const archiveUrl  = `https://archive-api.open-meteo.com/v1/archive?latitude=${city.lat}&longitude=${city.lon}&start_date=${startDate}&end_date=${endDate}&hourly=${HOURLY_ARCHIVE}&timezone=Asia%2FJerusalem`;
  const aqUrl       = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${city.lat}&longitude=${city.lon}&start_date=${startDate}&end_date=${endDate}&hourly=${HOURLY_AQ}&timezone=Asia%2FJerusalem`;

  console.log(`  → fetching forecast / archive / aq …`);
  const [forecast, actual, aq] = await Promise.all([
    fetchJson(forecastUrl),
    fetchJson(archiveUrl),
    fetchJson(aqUrl).catch(e => {
      console.warn(`    aq archive failed: ${e.message}`);
      return null;
    }),
  ]);

  // Index time arrays once for O(1) lookup
  const fTimes = forecast?.hourly?.time ?? [];
  const aTimes = actual?.hourly?.time   ?? [];
  const qTimes = aq?.hourly?.time       ?? [];
  const fIdxByTime = new Map(fTimes.map((t, i) => [t, i]));
  const aIdxByTime = new Map(aTimes.map((t, i) => [t, i]));
  const qIdxByTime = new Map(qTimes.map((t, i) => [t, i]));

  const entries = [];
  for (const date of dates) {
    const month = parseInt(date.slice(5, 7), 10);
    const sunsetHour = approxSunsetHour(month);
    const targetTime = `${date}T${String(sunsetHour).padStart(2, '0')}:00`;

    const fIdx = fIdxByTime.get(targetTime);
    const aIdx = aIdxByTime.get(targetTime);
    const qIdx = qIdxByTime.get(targetTime);

    if (fIdx == null || aIdx == null) continue;

    const fSlice = {
      clouds:     forecast.hourly.cloudcover?.[fIdx],
      cloudsLow:  forecast.hourly.cloudcover_low?.[fIdx]  ?? 0,
      cloudsMid:  forecast.hourly.cloudcover_mid?.[fIdx]  ?? 0,
      cloudsHigh: forecast.hourly.cloudcover_high?.[fIdx] ?? 0,
      humidity:   forecast.hourly.relativehumidity_2m?.[fIdx],
      visibility: forecast.hourly.visibility?.[fIdx] != null
                    ? forecast.hourly.visibility[fIdx] / 1000  // m → km
                    : null,
      dust:       null,
    };

    const aSlice = {
      clouds:     actual.hourly.cloudcover?.[aIdx],
      cloudsLow:  actual.hourly.cloudcover_low?.[aIdx]  ?? 0,
      cloudsMid:  actual.hourly.cloudcover_mid?.[aIdx]  ?? 0,
      cloudsHigh: actual.hourly.cloudcover_high?.[aIdx] ?? 0,
      humidity:   actual.hourly.relativehumidity_2m?.[aIdx],
      visibility: null,  // ERA5 archive doesn't expose visibility
      dust:       null,
    };

    // AQ archive (same value used for both — Open-Meteo's air-quality
    // archive is reanalysis, so it's the "actual" both ways. We still
    // expose it so the score can use a real dust value.)
    if (qIdx != null) {
      const dustVal = aq.hourly.dust?.[qIdx];
      if (dustVal != null) {
        fSlice.dust = dustVal;
        aSlice.dust = dustVal;
      }
    }

    if (fSlice.clouds == null || aSlice.clouds == null) continue;

    const fInput  = buildScoreInput(fSlice);
    const aInput  = buildScoreInput(aSlice);
    const fResult = computeScore(fInput);
    const aResult = computeScore(aInput);

    const predicted     = scaleTo1to10(fResult.score);
    const reconstructed = scaleTo1to10(aResult.score);

    // Real forecast bias ratios (actual / forecast)
    const ratios = {};
    if (fSlice.clouds > 0) {
      ratios.cloudRatio = Math.round((aSlice.clouds / fSlice.clouds) * 100) / 100;
    }
    if (fSlice.humidity > 0 && aSlice.humidity != null) {
      ratios.humidityRatio = Math.round((aSlice.humidity / fSlice.humidity) * 100) / 100;
    }
    // visibilityRatio omitted: ERA5 archive lacks visibility
    // dustRatio omitted: AQ archive used identically for both sides

    entries.push({
      date,
      locBucket: city.locBucket,
      month,
      predicted,
      reconstructed,
      userRating: null,
      paramRatios: ratios,
      dominantModel: aResult.model,
      cloudScoreContrib: aResult.blendWeights.cloud,
      dustScoreContrib:  aResult.blendWeights.dust,
      atmosphereContrib: aResult.blendWeights.clearSky,
      forecastError: Math.round((predicted - reconstructed) * 10) / 10,
      formulaError:  null,
      actualHumidity: aSlice.humidity ?? null,
      actualDust:     aSlice.dust     ?? null,
      stateSnapshot: {},
      ts: new Date(date + 'T12:00:00Z').getTime(),
    });
  }

  return entries;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const dates = dateRange(365);
  console.log(`Backtest range: ${dates[0]} → ${dates[dates.length - 1]} (${dates.length} days)`);
  console.log(`Cities: ${CITIES.length}`);
  console.log();

  const allEntries = [];
  for (const city of CITIES) {
    console.log(`[${city.name}]`);
    try {
      const entries = await processCity(city, dates);
      console.log(`  ✓ ${entries.length} entries`);
      allEntries.push(...entries);
    } catch (e) {
      console.error(`  ✗ failed: ${e.message}`);
    }
    // Be polite to Open-Meteo
    await new Promise(r => setTimeout(r, 800));
  }

  // Sort oldest-first — required by seedFromBacktest's EMA convergence
  allEntries.sort((a, b) => a.ts - b.ts);

  // Stats summary
  const errs    = allEntries.map(e => e.forecastError).filter(x => x != null);
  const meanErr = errs.length ? errs.reduce((s, x) => s + x, 0) / errs.length : 0;
  const meanAbs = errs.length ? errs.reduce((s, x) => s + Math.abs(x), 0) / errs.length : 0;
  const cRatios = allEntries.map(e => e.paramRatios?.cloudRatio).filter(x => x != null);
  const meanCR  = cRatios.length ? cRatios.reduce((s, x) => s + x, 0) / cRatios.length : 0;
  const hRatios = allEntries.map(e => e.paramRatios?.humidityRatio).filter(x => x != null);
  const meanHR  = hRatios.length ? hRatios.reduce((s, x) => s + x, 0) / hRatios.length : 0;

  const modelCounts = allEntries.reduce((acc, e) => {
    acc[e.dominantModel] = (acc[e.dominantModel] ?? 0) + 1;
    return acc;
  }, {});

  const output = {
    version: 2,
    generated: new Date().toISOString(),
    locationCoverage: CITIES.map(c => c.name),
    entryCount: allEntries.length,
    withPhotoRating: 0,
    backtest: {
      method: 'historical-forecast-api vs archive-api (ERA5)',
      dateRange: { start: dates[0], end: dates[dates.length - 1] },
      meanForecastError:    Math.round(meanErr * 100) / 100,
      meanAbsForecastError: Math.round(meanAbs * 100) / 100,
      meanCloudRatio:       Math.round(meanCR  * 100) / 100,
      meanHumidityRatio:    Math.round(meanHR  * 100) / 100,
      modelCounts,
    },
    entries: allEntries,
  };

  writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));

  console.log();
  console.log(`✓ Wrote ${allEntries.length} entries to ${OUT_PATH}`);
  console.log(`  Mean forecast error:     ${meanErr.toFixed(2)}`);
  console.log(`  Mean |forecast error|:   ${meanAbs.toFixed(2)}`);
  console.log(`  Mean cloud ratio (a/f):  ${meanCR.toFixed(2)}`);
  console.log(`  Mean humidity ratio:     ${meanHR.toFixed(2)}`);
  console.log(`  Model distribution:      ${JSON.stringify(modelCounts)}`);
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});
