/**
 * tests/golden.test.mjs
 *
 * Golden-image regression tests for the physics engine.
 *
 * Reads `tests/fixtures/atmosphere_goldens.json` and verifies that
 * `computeAtmosphere` still produces the same per-wavelength intensities
 * for every canonical scenario.
 *
 * This is the primary regression safety net for the multi-phase physics
 * upgrade. Any phase that changes output values must either:
 *   1. Stay within a tolerance that allows the fixture to be unchanged, or
 *   2. Be followed by a deliberate regeneration of the fixture via
 *      `node tests/fixtures/generate_goldens.mjs` after visual parity has
 *      been confirmed via the Preview MCP workflow.
 *
 * Run with:  node --test tests/golden.test.mjs
 */

import { test }           from 'node:test';
import assert             from 'node:assert/strict';
import { readFileSync }   from 'node:fs';
import { fileURLToPath }  from 'node:url';
import { dirname, join }  from 'node:path';

import { computeAtmosphere, clearAtmosphereCache } from '../js/engine/atmosphere.js';
import { hygroscopicGrowth, angstromFromHumidity, PHASE2_HUMIDITY_WEIGHT } from '../js/engine/physicsLayer.js';
import { CANONICAL_SCENARIOS }                     from './fixtures/scenarios.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const FIXTURE    = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'atmosphere_goldens.json'), 'utf8')
);

// Tolerance — fixtures are rounded to 8 decimal places in the JSON, so any
// difference larger than 1e-6 is a real physics change and should fail.
const TOL = 1e-6;

function assertZoneMatches(actual, expected, zone, scenarioId) {
  assert.strictEqual(
    actual.length, expected.length,
    `[${scenarioId}/${zone}] wavelength count mismatch: got ${actual.length}, expected ${expected.length}`
  );
  for (let i = 0; i < expected.length; i++) {
    const diff = Math.abs(actual[i] - expected[i]);
    assert.ok(
      diff <= TOL,
      `[${scenarioId}/${zone}] λ[${i}] drift ${diff.toExponential(3)} exceeds tolerance ${TOL}: got ${actual[i]}, expected ${expected[i]}`
    );
  }
}

// Make sure every scenario in the fixture file is also in the shared
// scenarios.mjs list — and vice-versa. Prevents orphaned fixtures or silent
// addition of scenarios without updating the regression set.
test('golden fixture matches canonical scenarios list', () => {
  const fixtureIds = Object.keys(FIXTURE.scenarios).sort();
  const sharedIds  = CANONICAL_SCENARIOS.map(s => s.id).sort();
  assert.deepStrictEqual(
    fixtureIds, sharedIds,
    'Fixture scenario IDs must match tests/fixtures/scenarios.mjs exactly'
  );
});

// One test per canonical scenario — isolates failures and makes Δ diffs
// point to the specific condition that drifted.
for (const scenario of CANONICAL_SCENARIOS) {
  test(`golden: ${scenario.id} (${scenario.label})`, () => {
    // Fresh cache per scenario — defensive against unintended memoisation leaks
    clearAtmosphereCache();

    const expected = FIXTURE.scenarios[scenario.id];
    assert.ok(expected, `Fixture missing for scenario '${scenario.id}'`);

    const sunAngleRad = scenario.sunAngleDeg * (Math.PI / 180);

    // Phase 2: mirror the generator's derivation of mieGrowth + α blend from
    // humidityPct, damped by PHASE2_HUMIDITY_WEIGHT. This keeps the golden
    // test output in lock-step with generate_goldens.mjs and visual_parity.mjs.
    const rhFrac = scenario.humidityPct != null ? scenario.humidityPct / 100 : null;
    const _rawG     = rhFrac != null ? hygroscopicGrowth(rhFrac)    : 1;
    const _rawAlpha = rhFrac != null ? angstromFromHumidity(rhFrac) : 0;
    const mieGrowth       = 1 + (_rawG - 1) * PHASE2_HUMIDITY_WEIGHT;
    const alphaHumidity   = _rawAlpha * PHASE2_HUMIDITY_WEIGHT;
    const angstromBlended = 0.5 * scenario.angstromExp + 0.5 * alphaHumidity;

    const atm = computeAtmosphere(
      sunAngleRad,
      scenario.turbidity,
      angstromBlended,
      scenario.ozoneDU,
      scenario.clouds, // Phase 1
      mieGrowth,       // Phase 2
    );

    assertZoneMatches(atm.skyTop,  expected.output.skyTop,  'skyTop',  scenario.id);
    assertZoneMatches(atm.skyMid,  expected.output.skyMid,  'skyMid',  scenario.id);
    assertZoneMatches(atm.horizon, expected.output.horizon, 'horizon', scenario.id);
    assertZoneMatches(atm.sun,     expected.output.sun,     'sun',     scenario.id);

    const airmassDiff = Math.abs(atm.airmass - expected.output.airmass);
    assert.ok(
      airmassDiff <= 1e-3,
      `[${scenario.id}] airmass drift ${airmassDiff} exceeds tolerance: got ${atm.airmass}, expected ${expected.output.airmass}`
    );
  });
}
