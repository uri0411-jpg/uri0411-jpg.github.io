/**
 * tests/fixtures/generate_goldens.mjs
 *
 * Generates atmosphere_goldens.json from the current computeAtmosphere output
 * on every canonical scenario. Run intentionally whenever a phase introduces
 * physics that changes expected output — after reviewing the visual parity
 * gate and confirming the change is desired.
 *
 * Usage:
 *   node tests/fixtures/generate_goldens.mjs
 *
 * Never run this blindly. Regenerating goldens invalidates the regression
 * safety net for every phase that came before. The workflow is:
 *   1. Make a code change in a phase.
 *   2. Run `node --test tests/golden.test.mjs` — expect a failure.
 *   3. Inspect the diff to confirm the change is intentional.
 *   4. Run `npm run visual:parity` (or tests/visual_parity.mjs) to confirm
 *      the screen output is within the phase budget.
 *   5. Only then run this generator and commit the updated fixture.
 *
 * The output format is:
 *   {
 *     "metadata": { "generatedAt": ..., "engine": "pre-phase-1" },
 *     "scenarios": {
 *       "clean_sunset": {
 *         "input": {...},
 *         "output": {
 *           "skyTop":  [5 floats],
 *           "skyMid":  [5 floats],
 *           "horizon": [5 floats],
 *           "sun":     [5 floats],
 *           "airmass": number
 *         }
 *       },
 *       ...
 *     }
 *   }
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { computeAtmosphere, clearAtmosphereCache } from '../../js/engine/atmosphere.js';
import { hygroscopicGrowth, angstromFromHumidity, PHASE2_HUMIDITY_WEIGHT } from '../../js/engine/physicsLayer.js';
import { CANONICAL_SCENARIOS } from './scenarios.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const OUT_PATH   = join(__dirname, 'atmosphere_goldens.json');

// Force a clean cache so fixtures are not polluted by stale memoized values
clearAtmosphereCache();

const scenarios = {};
for (const sc of CANONICAL_SCENARIOS) {
  const sunAngleRad = sc.sunAngleDeg * (Math.PI / 180);

  // Phase 1: clouds (defaults to {0,0,0} — no-op for clear-sky scenarios).
  // Phase 2: humidity → mieGrowth + Ångström blend. Mirrors physicsLayer
  // (damped by PHASE2_HUMIDITY_WEIGHT) + the score.js α blend, so the
  // fixture reflects the exact output the render layer would see.
  const rhFrac = sc.humidityPct != null ? sc.humidityPct / 100 : null;
  const _rawG     = rhFrac != null ? hygroscopicGrowth(rhFrac)    : 1;
  const _rawAlpha = rhFrac != null ? angstromFromHumidity(rhFrac) : 0;
  const mieGrowth       = 1 + (_rawG - 1) * PHASE2_HUMIDITY_WEIGHT;
  const alphaHumidity   = _rawAlpha * PHASE2_HUMIDITY_WEIGHT;
  const angstromBlended = 0.5 * sc.angstromExp + 0.5 * alphaHumidity;

  const atm = computeAtmosphere(
    sunAngleRad,
    sc.turbidity,
    angstromBlended,
    sc.ozoneDU,
    sc.clouds,  // Phase 1
    mieGrowth,  // Phase 2
  );

  scenarios[sc.id] = {
    input: {
      sunAngleDeg: sc.sunAngleDeg,
      turbidity:   sc.turbidity,
      humidityPct: sc.humidityPct,
      clouds:      sc.clouds,
      angstromExp: sc.angstromExp,
      ozoneDU:     sc.ozoneDU,
      // Phase 2 derived inputs (for reproducibility)
      mieGrowth:       round(mieGrowth, 6),
      angstromBlended: round(angstromBlended, 6),
    },
    output: {
      skyTop:  roundArray(atm.skyTop,  8),
      skyMid:  roundArray(atm.skyMid,  8),
      horizon: roundArray(atm.horizon, 8),
      sun:     roundArray(atm.sun,     8),
      airmass: round(atm.airmass, 6),
    },
  };
}

function round(v, digits) {
  const f = Math.pow(10, digits);
  return Math.round(v * f) / f;
}

function roundArray(arr, digits) {
  return arr.map(v => round(v, digits));
}

const fixture = {
  metadata: {
    generatedAt: new Date().toISOString(),
    note: 'Canonical sky rendering fixtures. Regenerate only after deliberate phase changes that pass visual parity.',
    wavelengths_um: [0.430, 0.450, 0.550, 0.600, 0.650],
    zones: ['skyTop', 'skyMid', 'horizon', 'sun'],
  },
  scenarios,
};

writeFileSync(OUT_PATH, JSON.stringify(fixture, null, 2) + '\n', 'utf8');
console.log(`Wrote ${OUT_PATH}`);
console.log(`Scenarios: ${Object.keys(scenarios).join(', ')}`);
