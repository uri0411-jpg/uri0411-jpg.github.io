/**
 * tests/fixtures/scenarios.mjs
 *
 * Canonical visual regression scenarios for the physics engine upgrade.
 * Shared between golden fixture generation, golden regression tests, and
 * visual parity screenshots.
 *
 * Each scenario is a frozen input tuple representing a distinct atmospheric
 * condition that the rendering pipeline must handle. A phase of the upgrade
 * plan that changes the output of `computeAtmosphere` for any scenario must
 * either (a) stay within the visual budget for that scenario/phase pair, or
 * (b) regenerate the golden fixture in a dedicated commit.
 *
 * Fields:
 *   id            stable key for diffs and screenshots
 *   label         human-readable (Hebrew-OK) description
 *   sunAngleDeg   solar elevation in degrees (negative = below horizon)
 *   turbidity     aerosol loading 0–1 (from physicsLayer composite)
 *   humidityPct   relative humidity 0–100 (Phase 2 input)
 *   clouds        { low, mid, high } each 0–1 (Phase 1 input)
 *   angstromExp   Ångström exponent for Mie wavelength dependence
 *   ozoneDU       stratospheric ozone column in Dobson Units
 */

export const CANONICAL_SCENARIOS = Object.freeze([
  {
    id:          'clean_sunset',
    label:       'Clean sunset (sun above horizon, dry, no clouds)',
    sunAngleDeg: 3,
    turbidity:   0.15,
    humidityPct: 40,
    clouds:      { low: 0, mid: 0, high: 0 },
    angstromExp: 0,
    ozoneDU:     300,
  },
  {
    id:          'hazy_sunset',
    label:       'Hazy sunset (warm horizon glow, humid, no clouds)',
    sunAngleDeg: 1,
    turbidity:   0.45,
    humidityPct: 70,
    clouds:      { low: 0, mid: 0, high: 0 },
    angstromExp: 0,
    ozoneDU:     300,
  },
  {
    id:          'overcast_stratus',
    label:       'Overcast stratus (low clouds dominate, wet)',
    sunAngleDeg: -1,
    turbidity:   0.25,
    humidityPct: 85,
    clouds:      { low: 0.60, mid: 0.20, high: 0 },
    angstromExp: 0,
    ozoneDU:     300,
  },
  {
    id:          'cirrus_afterglow',
    label:       'Cirrus afterglow (sun just set, high clouds glow warm)',
    sunAngleDeg: -3,
    turbidity:   0.20,
    humidityPct: 50,
    clouds:      { low: 0, mid: 0, high: 0.40 },
    angstromExp: 0,
    ozoneDU:     300,
  },
  {
    id:          'civil_twilight',
    label:       'Civil twilight (Belt of Venus territory, mid clouds)',
    sunAngleDeg: -5,
    turbidity:   0.15,
    humidityPct: 55,
    clouds:      { low: 0, mid: 0.15, high: 0 },
    angstromExp: 0,
    ozoneDU:     300,
  },
]);

/**
 * Per-phase visual parity budgets. Consumed by tests/visual_parity.mjs and
 * by the golden regression test when running in "phase X" mode.
 *
 * channel:     max Δ per RGB channel per pixel (post spectrumToRGB)
 * wavelength:  max Δ per per-wavelength intensity (pre spectrumToRGB)
 *
 * Scenarios where clouds > 0 or humidity > 70 are allowed higher drift on
 * phases that introduce new physics for those parameters.
 */
export const PHASE_BUDGETS = Object.freeze({
  phase0_baseline: { channel: 0,  wavelength: 0       }, // sanity: no changes
  phase1_clouds:   { channel: 3,  wavelength: 1e-4,   cloudyChannel: 130 },
  phase2_humidity: { channel: 8,  wavelength: 5e-3,   humidChannel:  20 },
  phase3_phase_funcs: { channel: 12, wavelength: 1e-2, horizonChannel: 15 },
  phase4_multiscatter: { channel: 5, wavelength: 5e-3 },
  phase5_cleanup:    { channel: 0,  wavelength: 0 },
  // Phase 7 dormant: PERCEPTUAL_BOOST=0 → applyPerceptualTuning is a
  // byte-identical no-op, so the gate must see Δ=0 even though the layer is
  // now wired into the pipeline. This is the "ship-safe" budget.
  phase7_dormant:    { channel: 0,  wavelength: 0 },
  // Phase 7 active: PERCEPTUAL_BOOST>0 — intentional aesthetic change,
  // re-enabled only after explicit user visual sign-off. Budget is loose.
  phase7_perceptual: { channel: 25, wavelength: null, note: 'intentional visual change' },
});
