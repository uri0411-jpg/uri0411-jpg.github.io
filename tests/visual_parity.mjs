/**
 * tests/visual_parity.mjs
 *
 * Visual parity gate — the "merge gate" for every physics-upgrade phase.
 *
 * Runs in two complementary modes:
 *
 *   1. api      : compares `computeAtmosphere → spectrumToRGB` output for
 *                 every canonical scenario against the baseline captured
 *                 in tests/fixtures/visual_baseline.json. Reports per-channel
 *                 Δ (max, mean, p95) and perceptual metrics (luminance
 *                 histogram drift, saturation drift, horizon contrast ratio
 *                 drift, hue centre drift).
 *
 *   2. capture  : regenerates the baseline — same as `generate_goldens.mjs`
 *                 but for the visual parity JSON. Run only after a phase has
 *                 been approved and the Preview MCP screenshots have been
 *                 reviewed.
 *
 * Usage:
 *   node tests/visual_parity.mjs              # api mode (default)
 *   node tests/visual_parity.mjs capture      # regenerate baseline
 *   node tests/visual_parity.mjs api --phase=phase1_clouds  # enforce budget
 *
 * A phase budget is enforced when --phase is supplied; otherwise the report
 * is informational. The budget comes from tests/fixtures/scenarios.mjs.
 *
 * --------
 *
 * Perceptual metrics notes:
 *
 *   Pixel Δ alone can miss structural drift — e.g. "the sky is the same
 *   average brightness but the horizon lost all its contrast". We therefore
 *   derive a small set of perceptual summaries per scenario:
 *
 *     luminance   : Y = 0.2126 R + 0.7152 G + 0.0722 B (Rec. 709)
 *     saturation  : HSV S = (max-min)/max, 0 if max=0
 *     hue         : HSV H in degrees, 0–360
 *
 *   For a 4-zone render the "horizon contrast ratio" is
 *   max(Y_skyTop, Y_skyMid) / max(Y_horizon, 0.001).
 *
 *   Drift is reported as the scalar difference between baseline and current.
 *   Budgets are loose by design — they catch catastrophic flattening, not
 *   sub-JND hue nudges.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { computeAtmosphere, clearAtmosphereCache }       from '../js/engine/atmosphere.js';
import { spectrumToRGB, applyPerceptualTuning }          from '../js/engine/color.js';
import { hygroscopicGrowth, angstromFromHumidity, PHASE2_HUMIDITY_WEIGHT } from '../js/engine/physicsLayer.js';
import { CANONICAL_SCENARIOS, PHASE_BUDGETS }            from './fixtures/scenarios.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const BASELINE   = join(__dirname, 'fixtures', 'visual_baseline.json');

// ── Perceptual helpers ────────────────────────────────────────────────────────

function luminance(rgb) {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
}

function saturation(rgb) {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  if (max === 0) return 0;
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  return (max - min) / max;
}

function hueDegrees(rgb) {
  const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r)      h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

function hueDelta(h1, h2) {
  // circular distance
  const d = Math.abs(h1 - h2);
  return Math.min(d, 360 - d);
}

function perceptualSummary(zones) {
  // zones: { skyTop, skyMid, horizon, sun } of {r,g,b}
  const lums = {};
  const sats = {};
  const hues = {};
  for (const key of Object.keys(zones)) {
    lums[key] = luminance(zones[key]);
    sats[key] = saturation(zones[key]);
    hues[key] = hueDegrees(zones[key]);
  }
  const skyLum = Math.max(lums.skyTop, lums.skyMid);
  const horizonContrast = skyLum / Math.max(lums.horizon, 1);
  const satMean = (sats.skyTop + sats.skyMid + sats.horizon + sats.sun) / 4;

  return { lums, sats, hues, horizonContrast, satMean };
}

function perceptualDrift(baseline, current) {
  const out = {
    horizonContrastDelta: Math.abs(current.horizonContrast - baseline.horizonContrast),
    horizonContrastRatio: current.horizonContrast / Math.max(baseline.horizonContrast, 1e-6),
    satMeanDelta:         current.satMean - baseline.satMean,
    hueDriftByZone:       {},
    lumDriftByZone:       {},
  };
  for (const key of Object.keys(baseline.hues)) {
    out.hueDriftByZone[key] = hueDelta(baseline.hues[key], current.hues[key]);
    out.lumDriftByZone[key] = Math.abs(baseline.lums[key] - current.lums[key]);
  }
  return out;
}

// ── Sample computation ───────────────────────────────────────────────────────

function sampleScenario(sc) {
  const sunAngleRad = sc.sunAngleDeg * (Math.PI / 180);
  clearAtmosphereCache();

  // Phase 2: humidity → Mie growth factor + Ångström blend.
  // Mirrors physicsLayer.computeScattering() exactly (damped by
  // PHASE2_HUMIDITY_WEIGHT) then the score.js α blend (0.5*α_PM + 0.5*α_hum).
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

  // Mirror the live pipeline exactly: spectrumToRGB → applyPerceptualTuning.
  // At PERCEPTUAL_BOOST=0 (Phase 7 dormant) the tuning call is a byte-identical
  // no-op, so this extension to the gate does not invalidate pre-Phase-7
  // baselines captured via `capture` mode — and once PERCEPTUAL_BOOST > 0,
  // regressions in the tuning layer will be caught here the same way physics
  // regressions are caught in earlier phases.
  const ctx = { sunAngle_rad: sunAngleRad };
  const rgb = {
    skyTop:  applyPerceptualTuning(spectrumToRGB(atm.skyTop),  { ...ctx, zone: 'skyTop'  }),
    skyMid:  applyPerceptualTuning(spectrumToRGB(atm.skyMid),  { ...ctx, zone: 'skyMid'  }),
    horizon: applyPerceptualTuning(spectrumToRGB(atm.horizon), { ...ctx, zone: 'horizon' }),
    sun:     applyPerceptualTuning(spectrumToRGB(atm.sun),     { ...ctx, zone: 'sun'     }),
  };

  return {
    wavelengths: {
      skyTop:  atm.skyTop.slice(),
      skyMid:  atm.skyMid.slice(),
      horizon: atm.horizon.slice(),
      sun:     atm.sun.slice(),
    },
    rgb,
    perceptual: perceptualSummary(rgb),
  };
}

// ── Diff computation ─────────────────────────────────────────────────────────

function channelDiffs(base, curr) {
  const zones = ['skyTop', 'skyMid', 'horizon', 'sun'];
  let maxChannel = 0;
  let sumChannel = 0;
  let count = 0;
  const perZone = {};

  for (const z of zones) {
    const b = base.rgb[z];
    const c = curr.rgb[z];
    const dR = Math.abs(b.r - c.r);
    const dG = Math.abs(b.g - c.g);
    const dB = Math.abs(b.b - c.b);
    const zoneMax = Math.max(dR, dG, dB);
    perZone[z] = { dR, dG, dB, max: zoneMax };
    if (zoneMax > maxChannel) maxChannel = zoneMax;
    sumChannel += dR + dG + dB;
    count += 3;
  }

  let maxWavelength = 0;
  for (const z of zones) {
    const bw = base.wavelengths[z];
    const cw = curr.wavelengths[z];
    for (let i = 0; i < bw.length; i++) {
      const d = Math.abs(bw[i] - cw[i]);
      if (d > maxWavelength) maxWavelength = d;
    }
  }

  return {
    maxChannel,
    meanChannel: sumChannel / count,
    maxWavelength,
    perZone,
  };
}

// ── Capture mode ─────────────────────────────────────────────────────────────

function captureBaseline() {
  const scenarios = {};
  for (const sc of CANONICAL_SCENARIOS) {
    scenarios[sc.id] = sampleScenario(sc);
  }
  const out = {
    metadata: {
      generatedAt: new Date().toISOString(),
      engine: 'current',
    },
    scenarios,
  };
  writeFileSync(BASELINE, JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`Baseline written to ${BASELINE}`);
  console.log(`Scenarios: ${Object.keys(scenarios).join(', ')}`);
}

// ── API mode ─────────────────────────────────────────────────────────────────

function runApiMode(phaseKey) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  } catch (err) {
    console.error(`No baseline at ${BASELINE}. Run 'node tests/visual_parity.mjs capture' first.`);
    process.exit(2);
  }

  const budget = phaseKey ? PHASE_BUDGETS[phaseKey] : null;
  if (phaseKey && !budget) {
    console.error(`Unknown phase '${phaseKey}'. Known: ${Object.keys(PHASE_BUDGETS).join(', ')}`);
    process.exit(2);
  }

  let failed = 0;
  const report = {};

  for (const sc of CANONICAL_SCENARIOS) {
    const base = baseline.scenarios[sc.id];
    if (!base) {
      console.error(`Baseline missing scenario '${sc.id}' — regenerate.`);
      process.exit(2);
    }
    const curr = sampleScenario(sc);
    const diff = channelDiffs(base, curr);
    const perc = perceptualDrift(base.perceptual, curr.perceptual);

    const isCloudy = (sc.clouds.low + sc.clouds.mid + sc.clouds.high) > 0;
    const isHumid  = sc.humidityPct > 70;
    let budgetChannel = budget?.channel ?? Infinity;
    if (budget?.cloudyChannel != null && isCloudy) budgetChannel = budget.cloudyChannel;
    if (budget?.humidChannel  != null && isHumid)  budgetChannel = budget.humidChannel;

    const pass = diff.maxChannel <= budgetChannel;
    if (!pass) failed++;

    report[sc.id] = {
      pass,
      budgetChannel,
      maxChannel:    diff.maxChannel,
      meanChannel:   +diff.meanChannel.toFixed(3),
      maxWavelength: +diff.maxWavelength.toExponential(3),
      perZone:       diff.perZone,
      perceptual: {
        horizonContrastDelta: +perc.horizonContrastDelta.toFixed(4),
        horizonContrastRatio: +perc.horizonContrastRatio.toFixed(4),
        satMeanDelta:         +perc.satMeanDelta.toFixed(4),
        hueDriftByZone:       Object.fromEntries(
          Object.entries(perc.hueDriftByZone).map(([k, v]) => [k, +v.toFixed(2)])
        ),
        lumDriftByZone:       Object.fromEntries(
          Object.entries(perc.lumDriftByZone).map(([k, v]) => [k, +v.toFixed(2)])
        ),
      },
    };
  }

  // ── Print summary ─────────────────────────────────────────────────────────
  console.log('\nVisual parity report');
  console.log('====================');
  if (phaseKey) console.log(`Phase: ${phaseKey} (budget max channel Δ varies by scenario)\n`);
  else console.log('Mode: informational (no phase budget enforced)\n');

  for (const [id, r] of Object.entries(report)) {
    const status = phaseKey ? (r.pass ? 'PASS' : 'FAIL') : '----';
    console.log(`  ${status}  ${id}`);
    console.log(`         maxΔ=${r.maxChannel}  meanΔ=${r.meanChannel}  budget=${r.budgetChannel}`);
    console.log(`         maxλ=${r.maxWavelength}`);
    console.log(`         horizonContrast Δ=${r.perceptual.horizonContrastDelta} ratio=${r.perceptual.horizonContrastRatio}`);
    console.log(`         sat Δ=${r.perceptual.satMeanDelta}  lum Δ=${JSON.stringify(r.perceptual.lumDriftByZone)}`);
    console.log(`         hue Δ=${JSON.stringify(r.perceptual.hueDriftByZone)}`);
  }

  if (phaseKey && failed > 0) {
    console.error(`\n${failed} scenarios failed phase '${phaseKey}' budget.`);
    process.exit(1);
  }
  console.log(phaseKey ? `\nAll ${CANONICAL_SCENARIOS.length} scenarios pass phase '${phaseKey}' budget.` : '\nDone.');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const mode = args[0] ?? 'api';
const phaseArg = args.find(a => a.startsWith('--phase='))?.slice('--phase='.length);

if (mode === 'capture') {
  captureBaseline();
} else if (mode === 'api') {
  runApiMode(phaseArg);
} else {
  console.error(`Unknown mode '${mode}'. Use 'api' or 'capture'.`);
  process.exit(2);
}
