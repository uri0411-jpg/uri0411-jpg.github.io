// ═══════════════════════════════════════════
//  seed-export.js
//  Converts backtest results to learningEngine entry format
//  and writes learning-seed.json for browser import.
// ═══════════════════════════════════════════

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

function getLocBucket(lat, lon) {
  if (lon < 35.0) return 'coast';
  if (lat > 32.5) return 'north';
  if (lat < 31.5) return 'south';
  return 'central';
}

function buildEntry(result) {
  const date   = result.date;
  const month  = new Date(date + 'T12:00:00').getMonth() + 1;
  const tsHour = String(result.sunsetHour ?? 18).padStart(2, '0');
  const ts     = new Date(`${date}T${tsHour}:00:00+03:00`).getTime();

  return {
    date,
    locBucket:         result.locBucket ?? getLocBucket(result.lat, result.lon),
    month,
    predicted:         result.reconstructedScore,  // no historical forecast available
    reconstructed:     result.reconstructedScore,
    userRating:        result.photoRating    ?? null,
    paramRatios:       result.paramRatios ?? {},       // actual/forecast ratios from historical-forecast-api
    dominantModel:     result.model          ?? 'ClearSkyModel',
    cloudScoreContrib: result.blendWeights?.cloud    ?? 0.33,
    dustScoreContrib:  result.blendWeights?.dust     ?? 0.33,
    atmosphereContrib: result.blendWeights?.clearSky ?? 0.34,
    forecastError:     0,                            // predicted === reconstructed
    formulaError:      result.photoRating != null
      ? Math.round((result.reconstructedScore - result.photoRating) * 10) / 10
      : null,
    actualHumidity:    result.actual?.humidity ?? null,
    actualDust:        result.actual?.dust     ?? null,
    stateSnapshot:     {},  // filled by seedFromBacktest() in the browser
    ts,
  };
}

/**
 * Export all backtest results to scripts/data/learning-seed.json.
 * Entries are sorted oldest-first for correct EMA convergence.
 * @param {object[]} allResults  flat array of per-day results across all locations
 * @param {string}   outputDir   directory to write output files
 * @returns {string} path to the written seed file
 */
export function exportSeed(allResults, outputDir) {
  mkdirSync(outputDir, { recursive: true });

  const entries = allResults
    .filter(r => r.actual != null && r.reconstructedScore != null)
    .map(buildEntry)
    .sort((a, b) => a.ts - b.ts);  // oldest first

  const withPhoto = entries.filter(e => e.userRating != null).length;
  const locations = [...new Set(allResults.map(r => r.locationName).filter(Boolean))];

  const seed = {
    version:          2,
    generated:        new Date().toISOString(),
    locationCoverage: locations,
    entryCount:       entries.length,
    withPhotoRating:  withPhoto,
    entries,
  };

  const outPath = join(outputDir, 'learning-seed.json');
  writeFileSync(outPath, JSON.stringify(seed, null, 2), 'utf8');
  console.log(`[seed-export] ${entries.length} entries (${withPhoto} with photo rating) → ${outPath}`);
  return outPath;
}

/**
 * Write per-location raw results JSON for debugging / inspection.
 */
export function exportRawResults(locationKey, results, outputDir) {
  mkdirSync(outputDir, { recursive: true });
  const outPath = join(outputDir, `results-${locationKey}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
}
