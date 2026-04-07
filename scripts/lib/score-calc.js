// ═══════════════════════════════════════════
//  score-calc.js
//  Computes reconstructed score from actual archive conditions
//  by importing scoreEngine.js directly (pure math, no browser APIs).
// ═══════════════════════════════════════════

import { computeScore } from '../../twilight-pwa/js/engine/scoreEngine.js';

/**
 * Derive cloud height category from layer breakdown.
 */
function deriveHeightCategory(actual) {
  const cH = actual.cloudsHigh ?? 0;
  const cM = actual.cloudsMid  ?? 0;
  const cL = actual.cloudsLow  ?? 0;
  if (cH > cM && cH > cL) return 'high';
  if (cL > cM && cL > cH) return 'low';
  return 'mid';
}

/**
 * Score actual archive conditions.
 * Maps scoreEngine's 0-100 output → 1-10 scale (same as score.js).
 * @param {object} actual  — from archive-fetch
 * @returns {{ score: number, model: string, blendWeights: object }}
 */
export function scoreActualConditions(actual) {
  const clouds = Math.min(1, Math.max(0, (actual.clouds ?? 30) / 100));

  const input = {
    clouds,
    cloudHeightCategory: deriveHeightCategory(actual),
    horizonClearance:    Math.max(0, 1 - clouds * 1.2),
    dust:                actual.dust       ?? 20,
    humidity:            actual.humidity   ?? 50,
    visibility:          actual.visibility ?? 15,
    aqi:                 null,
    solarElevation:      3, // nominal sunset elevation
  };

  const result = computeScore(input);
  return {
    score:        Math.round(((result.score / 100) * 9 + 1) * 10) / 10,
    model:        result.model,
    blendWeights: result.blendWeights ?? { cloud: 0.33, dust: 0.33, clearSky: 0.34 },
  };
}
