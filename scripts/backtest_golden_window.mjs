/**
 * scripts/backtest_golden_window.mjs
 *
 * Back-test for predictGoldenWindow() against a curated set of representative
 * sunset cases with physically-motivated expected peak offsets.
 *
 * Usage:
 *   node scripts/backtest_golden_window.mjs
 *
 * Exit code:
 *   0 — RMSE ≤ 5 min  (model within acceptable tolerance)
 *   1 — RMSE > 5 min  (model needs recalibration)
 *
 * "Expected" values are derived from known atmospheric optics and sunset
 * photography literature, not from a live observation database.  They
 * represent the physical consensus of when peak color should occur given
 * each set of conditions, and serve as a regression anchor to detect
 * model drift when the formula coefficients are changed.
 *
 * Case selection rationale:
 *   Cases cover the 3 principal axes of variation:
 *     • Turbidity axis: 0.05 (alpine clean) → 0.80 (heavy dust)
 *     • Cloud axis: 0% → 80%, all three height categories
 *     • Latitude axis: 5° (equatorial) → 60° (sub-polar)
 */

import { predictGoldenWindow } from '../js/engine/goldenWindow.js';

// ── Reference date & sunset time ─────────────────────────────────────────────

// Use a fixed reference sunset in Israel for consistency across all cases.
// Julian date chosen for equinox (declination ≈ 0) so descent rate is the
// baseline value without seasonal corrections.
const SUNSET = new Date('2025-03-20T17:51:00+02:00'); // Spring equinox sunset, Israel

// ── Test cases ────────────────────────────────────────────────────────────────

/**
 * Each case:
 *   label       — human-readable name
 *   params      — inputs to predictGoldenWindow (merged with defaults)
 *   expected    — expected peakOffsetMinutes (physically motivated)
 *   tolerance   — acceptable deviation (minutes) for this specific case
 *
 * tolerance is tighter for well-constrained cases (no clouds, single axis
 * varies) and looser for complex multi-parameter combinations.
 */
const CASES = [
  // ── Clean sky (no clouds) ────────────────────────────────────────────────
  {
    label:    'Clear day, moderate turbidity (baseline)',
    params:   { turbidity: 0.30, clouds: 0.00, cloudHeightCategory: 'mid', latitude: 32 },
    expected: 6,
    tolerance: 3,
  },
  {
    label:    'Clean alpine air, no clouds',
    params:   { turbidity: 0.05, clouds: 0.00, cloudHeightCategory: 'mid', latitude: 32 },
    expected: 8,
    tolerance: 3,
  },
  {
    label:    'Moderate haze, no clouds',
    params:   { turbidity: 0.50, clouds: 0.00, cloudHeightCategory: 'mid', latitude: 32 },
    expected: 4,
    tolerance: 3,
  },
  {
    label:    'Heavy Saharan dust, no clouds',
    params:   { turbidity: 0.80, clouds: 0.00, cloudHeightCategory: 'mid', latitude: 32 },
    expected: 2,
    tolerance: 3,
  },

  // ── Cloud height effects ─────────────────────────────────────────────────
  {
    label:    'High cirrus (50%), moderate turbidity',
    params:   { turbidity: 0.25, clouds: 0.50, cloudHeightCategory: 'high', latitude: 32 },
    expected: 13,
    tolerance: 4,
  },
  {
    label:    'Mid altocumulus (30%), moderate turbidity',
    params:   { turbidity: 0.30, clouds: 0.30, cloudHeightCategory: 'mid', latitude: 32 },
    expected: 10,
    tolerance: 4,
  },
  {
    label:    'Low stratus (40%), moderate turbidity',
    params:   { turbidity: 0.35, clouds: 0.40, cloudHeightCategory: 'low', latitude: 32 },
    expected: 6,
    tolerance: 3,
  },
  {
    label:    'Near overcast low cloud (80%), high turbidity',
    params:   { turbidity: 0.60, clouds: 0.80, cloudHeightCategory: 'low', latitude: 32 },
    expected: 3,
    tolerance: 4,
  },

  // ── Perfect sunset conditions ─────────────────────────────────────────────
  {
    label:    'Ideal: clean air + scattered cirrus',
    // Model: basePeak(6) + cloudBonus(clouds=0.4 × illumTime×0.6) + turbShift(-0.6) ≈ 9
    // Observed cirrus sunsets: peak typically 8-12 min — model is on the low end
    params:   { turbidity: 0.15, clouds: 0.40, cloudHeightCategory: 'high', latitude: 32 },
    expected: 10,
    tolerance: 4,
  },
  {
    label:    'Coastal Mediterranean summer (sea spray haze)',
    params:   { turbidity: 0.40, clouds: 0.20, cloudHeightCategory: 'low',  latitude: 32 },
    expected: 6,
    tolerance: 3,
  },

  // ── Latitude effects ──────────────────────────────────────────────────────
  {
    label:    'Equatorial (fast descent rate)',
    params:   { turbidity: 0.20, clouds: 0.10, cloudHeightCategory: 'mid', latitude: 5,  declination: 0 },
    expected: 7,
    tolerance: 4,
  },
  {
    label:    'High latitude (slow descent rate)',
    params:   { turbidity: 0.15, clouds: 0.10, cloudHeightCategory: 'mid', latitude: 60, declination: 0 },
    expected: 10,
    tolerance: 5,
  },

  // ── Seasonal declination correction ─────────────────────────────────────
  {
    label:    'Israel summer solstice (slower descent)',
    params:   { turbidity: 0.30, clouds: 0.05, cloudHeightCategory: 'mid', latitude: 32, declination: 23.5 },
    expected: 7,
    tolerance: 3,
  },
  {
    label:    'Israel winter solstice (faster descent)',
    params:   { turbidity: 0.30, clouds: 0.05, cloudHeightCategory: 'mid', latitude: 32, declination: -23.5 },
    expected: 6,
    tolerance: 3,
  },
];

// ── Runner ────────────────────────────────────────────────────────────────────

let sumSqErr  = 0;
let sumBias   = 0;
let passCount = 0;
const rows    = [];

for (const tc of CASES) {
  const result = predictGoldenWindow({
    sunsetTime:          SUNSET,
    solarElevation:      5,        // typical value at forecast time
    rayleighSpread:      0.6,
    ...tc.params,
  });

  const predicted = result.peakOffsetMinutes;
  const err       = predicted - tc.expected;
  const pass      = Math.abs(err) <= tc.tolerance;

  sumSqErr  += err * err;
  sumBias   += err;
  if (pass) passCount++;

  rows.push({ label: tc.label, expected: tc.expected, predicted, err, pass, tolerance: tc.tolerance });
}

// ── Output ────────────────────────────────────────────────────────────────────

const n    = CASES.length;
const rmse = Math.sqrt(sumSqErr / n);
const bias = sumBias / n;

const COL = { label: 46, exp: 8, pred: 8, err: 8, tol: 6, ok: 5 };
const pad  = (s, w, right = false) => right ? String(s).padStart(w) : String(s).padEnd(w);
const hr   = '-'.repeat(COL.label + COL.exp + COL.pred + COL.err + COL.tol + COL.ok + 5);

console.log('\n── Golden Window Backtest ──────────────────────────────────────────────────\n');
console.log(
  pad('Case', COL.label) +
  pad('Exp', COL.exp, true) +
  pad('Pred', COL.pred, true) +
  pad('Err', COL.err, true) +
  pad('Tol', COL.tol, true) +
  '  OK'
);
console.log(hr);

for (const r of rows) {
  const errStr = (r.err >= 0 ? '+' : '') + r.err.toFixed(1);
  console.log(
    pad(r.label, COL.label) +
    pad(r.expected.toFixed(0) + ' min', COL.exp, true) +
    pad(r.predicted.toFixed(1) + ' min', COL.pred, true) +
    pad(errStr + ' min', COL.err, true) +
    pad('±' + r.tolerance, COL.tol, true) +
    '  ' + (r.pass ? '✔' : '✘')
  );
}

console.log(hr);
console.log(`\nResults: ${passCount}/${n} cases within tolerance`);
console.log(`RMSE:    ${rmse.toFixed(2)} min  (target ≤ 5 min)`);
console.log(`Bias:    ${bias >= 0 ? '+' : ''}${bias.toFixed(2)} min  (positive = model predicts too late)\n`);

if (rmse > 5) {
  console.error(`FAIL: RMSE ${rmse.toFixed(2)} > 5 min — goldenWindow.js needs recalibration.`);
  console.error('      Check basePeakOffset, turbidityShift, and cloudPeakBonus coefficients.\n');
  process.exit(1);
} else {
  console.log(`PASS: RMSE within 5-minute tolerance.\n`);
  process.exit(0);
}
