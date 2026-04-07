/**
 * TWILIGHT v2 — Physics Layer
 * ============================================================================
 * Models atmospheric scattering to differentiate between "Sun Intensity"
 * (Mie-dominated, red/orange disk) and "Sky Color Spread" (Rayleigh-dominated,
 * pink/purple gradients across the sky).
 *
 * Core physics references:
 *   - Rayleigh scattering ∝ 1/λ⁴  → short wavelengths (blue/violet) scatter
 *     most in clean air; at low sun angles the long path depletes blue,
 *     leaving red/orange transmitted and pink/purple scattered overhead.
 *   - Mie scattering is wavelength-independent and dominates when aerosol
 *     particles (dust, pollution, humidity droplets) are ≥ λ of visible light.
 *     This produces a bright, reddened sun disk but washes out the broader
 *     sky gradient.
 *   - Beer-Lambert law: I = I₀ · exp(−τ · m)  where τ is optical depth and
 *     m is air-mass (path length through atmosphere). At sunset m ≈ 38 when
 *     the sun is on the horizon (Kasten & Young 1989).
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Clamp a value to [min, max].
 */
const clamp = (v, min = 0, max = 1) => Math.min(Math.max(v, min), max);

/**
 * Safe normalization: maps `value` from [lo, hi] → [0, 1].
 * Returns `fallback` when the range is degenerate.
 */
const normalize = (value, lo, hi, fallback = 0.5) => {
  if (hi <= lo) return fallback;
  return clamp((value - lo) / (hi - lo));
};

/**
 * Atmospheric refraction correction (Saemundsson 1986).
 * The atmosphere bends light so the sun appears ~0.5° higher than its true
 * geometric position.  At the horizon (h=0°) this means the sun is already
 * geometrically ~0.5° below the horizon when it appears to touch it —
 * adding ~2 minutes to the visible golden window.
 *
 * Returns the apparent (refracted) elevation in degrees.
 * For elevations below −1° refraction is negligible / uncalculable.
 */
const refractedElevation = (trueElevationDeg) => {
  if (trueElevationDeg < -1) return trueElevationDeg;
  // Saemundsson approximation: R ≈ 1.02 / tan(h + 10.3/(h+5.11))  [arcminutes]
  const h = Math.max(trueElevationDeg, 0.1);
  const R = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * Math.PI / 180) / 60; // convert to degrees
  return trueElevationDeg + R;
};

/**
 * Compute relative air-mass using Kasten & Young (1989) approximation.
 *   m = 1 / [ sin(h) + 0.50572 · (h + 6.07995)^(−1.6364) ]
 * where h is solar elevation in degrees.
 *
 * At h = 90° → m ≈ 1  (sun overhead, shortest path).
 * At h =  0° → m ≈ 38 (sun on horizon, longest path through atmosphere).
 * Below h = −2° we cap m at ~80 to avoid singularity; light is essentially
 * fully attenuated at that point.
 *
 * Input is the TRUE (geometric) elevation; refraction is applied internally
 * so air-mass reflects the actual atmospheric path length.
 */
const airMass = (solarElevationDeg) => {
  if (solarElevationDeg < -2) return 80;
  // Use refracted elevation for path-length calculation — the atmosphere
  // doesn't know the geometric position, only the apparent one.
  const h = Math.max(refractedElevation(solarElevationDeg), 0.1);
  const hRad = (h * Math.PI) / 180;
  return 1 / (Math.sin(hRad) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
};

// ─── Main Export ────────────────────────────────────────────────────────────

/**
 * Compute the atmospheric scattering profile for the current conditions.
 *
 * @param {Object} params
 * @param {number} params.dust            – Dust concentration (µg/m³), 0–500+
 * @param {number} params.humidity         – Relative humidity (%), 0–100
 * @param {number} params.visibility       – Visibility (km), 0–50+
 * @param {number} params.aqi             – Air Quality Index, 0–500
 * @param {number} params.solarElevation  – Solar elevation angle (degrees),
 *                                           negative = below horizon
 *
 * @returns {{
 *   turbidity: number,            // 0-1 composite aerosol index
 *   mieIntensity: number,         // 0-1 strength of Mie forward-scatter
 *   rayleighSpread: number,       // 0-1 quality of broad-sky color gradient
 *   atmosphericClarity: number,   // 0-1 Beer-Lambert transmittance proxy
 *   contributions: Object         // per-input contribution breakdown
 * }}
 */
export function computeScattering({
  dust = null,
  humidity = null,
  visibility = null,
  aqi = null,
  solarElevation = 5,
}) {
  // ── 1. Normalize raw inputs to 0-1 ─────────────────────────────────────

  // Dust: 0 µg/m³ = pristine, 150+ µg/m³ = heavy haze / sandstorm.
  // We use 150 as the upper bound because beyond this the sky is simply
  // opaque — no aesthetic benefit.
  const dustNorm = dust != null ? normalize(dust, 0, 150) : null;

  // Humidity: hygroscopic growth of aerosol particles is highly non-linear.
  // Below ~60% RH the effect is negligible; above 80% RH particle radius grows
  // rapidly following kappa-Köhler theory: growth ∝ (1 - RH)^(-1/3).
  //
  // We model this as a piecewise function:
  //   0–60%  → linear 0→0.15  (slight baseline growth)
  //   60–80% → linear 0.15→0.40  (moderate hygroscopic growth)
  //   80–99% → accelerated: 0.40 + 0.60 * (1 - (1 - rh_frac)^(1/3))
  //                          where rh_frac = (RH - 80) / 19
  // This captures the inflection point and rapid growth at high RH that the
  // original linear model missed, especially for coastal/humid conditions.
  const humNorm = humidity != null ? (() => {
    const rh = clamp(humidity, 0, 99);
    if (rh <= 60) return normalize(rh, 0, 60) * 0.15;
    if (rh <= 80) return 0.15 + normalize(rh, 60, 80) * 0.25;
    // Above 80%: kappa-Köhler accelerated growth
    const frac = (rh - 80) / 19; // 0→1 for RH 80→99%
    return clamp(0.40 + 0.60 * (1 - Math.pow(1 - frac, 1 / 3)));
  })() : null;

  // Visibility: inverted — low visibility = high aerosol.
  // 50 km = exceptionally clear; < 5 km = heavy haze.
  const visNorm = visibility != null ? 1 - normalize(visibility, 2, 50) : null;

  // AQI: 0 = clean, 200+ = very unhealthy.  We saturate at 200 because
  // beyond that the sun disk is barely visible.
  const aqiNorm = aqi != null ? normalize(aqi, 0, 200) : null;

  // ── 2. Turbidity Index ──────────────────────────────────────────────────
  //
  // Turbidity is a weighted composite of all aerosol proxies.
  // Weights reflect each input's relative contribution to total aerosol
  // optical depth (AOD) in typical continental conditions:
  //   - AQI (0.30): direct proxy for PM2.5 / PM10 — strongest AOD predictor.
  //   - Dust (0.25): coarse-mode particles, strong Mie scatterer.
  //   - Humidity (0.20): hygroscopic growth swells particles by 1.5-3× their
  //     dry radius when RH > 80 %, substantially increasing cross-section.
  //   - Visibility (0.25): integrates ALL extinction sources as observed;
  //     acts as a cross-check on the other three.

  const weights = { dust: 0.25, humidity: 0.20, visibility: 0.25, aqi: 0.30 };
  const values  = { dust: dustNorm, humidity: humNorm, visibility: visNorm, aqi: aqiNorm };

  let turbiditySum = 0;
  let weightSum = 0;
  const contributions = {};

  for (const [key, w] of Object.entries(weights)) {
    if (values[key] != null) {
      turbiditySum += w * values[key];
      weightSum += w;
      contributions[key] = { normalized: values[key], weight: w, contribution: w * values[key] };
    }
  }

  // If no data at all, fall back to moderate turbidity (0.3) — a conservative
  // "we don't know" default that neither inflates nor deflates the score.
  const turbidity = weightSum > 0 ? clamp(turbiditySum / weightSum) : 0.3;

  // ── 3. Mie Intensity ───────────────────────────────────────────────────
  //
  // Mie scattering is forward-peaked and wavelength-neutral.  High aerosol
  // loading (turbidity) increases the brightness of the sun disk and produces
  // intense orange/red coloring because short-wavelength light is extinguished
  // over the long path.
  //
  // The interaction term (dust × humidity) captures hygroscopic growth:
  // dust particles swell in humid air, dramatically increasing their Mie
  // cross-section — this is why the most vivid red sun-disks occur in
  // humid, dusty conditions (e.g. Gulf Coast, Southeast Asia).
  //
  // Formula:  mie = 0.7·turbidity + 0.3·(dust·humidity interaction)

  const interactionTerm =
    dustNorm != null && humNorm != null
      ? dustNorm * humNorm
      : turbidity * 0.5; // fallback: assume moderate interaction

  const mieIntensity = clamp(0.7 * turbidity + 0.3 * interactionTerm);

  contributions.dustHumidityInteraction = interactionTerm;

  // ── 4. Rayleigh Spread ─────────────────────────────────────────────────
  //
  // Rayleigh scattering produces the broad pink-to-purple gradient across
  // the sky *away* from the sun.  It is strongest in CLEAN air because
  // aerosols (Mie) wash out the color separation that Rayleigh depends on.
  //
  // Base formula:  rayleigh_base = (1 - turbidity)^1.5
  //
  // The exponent 1.5 accelerates the drop-off — in practice, even moderate
  // aerosol loading (turbidity > 0.5) sharply degrades sky gradients.
  //
  // Additionally, Rayleigh scattering strengthens as the sun descends toward
  // the horizon — the longer atmospheric path (high air mass) allows more
  // wavelength separation.  We model this as an elevation boost:
  //
  //   elevBoost = log(m+1) / log(39)    [0 at overhead, 1 at horizon]
  //   rayleighSpread = base * (1 + 0.30 * elevBoost)   [capped at 1.0]
  //
  // Physical meaning: at sunset (m≈38) clean air produces ~30% stronger
  // pink-purple spread than at the same turbidity with the sun overhead.

  const m            = airMass(solarElevation);
  const rayleighBase  = Math.pow(1 - turbidity, 1.5);
  const elevBoost     = Math.log(m + 1) / Math.log(39); // 0→1 overhead→horizon
  const rayleighSpread = clamp(rayleighBase * (1 + 0.30 * elevBoost));

  // ── 5. Atmospheric Clarity (Beer-Lambert proxy) ────────────────────────
  //
  // Beer-Lambert: transmittance T = exp(−τ_ext · m)
  //
  // τ_ext (extinction optical depth) is modeled as:
  //   τ_ext = 0.05 + 0.45 · turbidity
  //
  // Baseline 0.05 represents molecular (Rayleigh) extinction in pristine
  // air.  The 0.45 coefficient scales aerosol extinction — at turbidity=1
  // total τ_ext = 0.50, which at m=38 (horizon) gives T ≈ exp(−19) ≈ 0,
  // i.e., the sun is invisible.
  //
  // For the sunset aesthetic we evaluate clarity at the CURRENT solar
  // elevation, not at the horizon — this lets us track how the light
  // evolves as the sun descends.

  const tauExt = 0.05 + 0.45 * turbidity;

  // We compress the air-mass contribution by taking log(m)/log(38) so
  // the transmittance curve is more gradual and useful for scoring.
  // Raw exp(−τ·m) at m=38 is essentially zero for any realistic τ.
  const effectiveOpticalPath = tauExt * Math.log(m + 1) / Math.log(39);
  const atmosphericClarity = clamp(Math.exp(-2.5 * effectiveOpticalPath));

  contributions.tauExt = tauExt;
  contributions.airMass = m;
  contributions.effectiveOpticalPath = effectiveOpticalPath;

  return {
    turbidity,
    mieIntensity,
    rayleighSpread,
    atmosphericClarity,
    contributions,
  };
}

/**
 * Debug helper — returns a human-readable breakdown of how each input
 * influenced the physics outputs.  Used by the Debug Panel.
 */
export function getContribution(physicsResult) {
  const { turbidity, mieIntensity, rayleighSpread, atmosphericClarity, contributions } =
    physicsResult;

  const lines = [
    `Turbidity Index: ${(turbidity * 100).toFixed(1)}%`,
    `  Components:`,
  ];

  for (const [key, entry] of Object.entries(contributions)) {
    if (entry && typeof entry === 'object' && 'contribution' in entry) {
      lines.push(
        `    ${key}: norm=${entry.normalized?.toFixed(3) ?? '?'}, ` +
        `w=${entry.weight.toFixed(2)}, contrib=${entry.contribution.toFixed(4)}`
      );
    }
  }

  lines.push(
    `Mie Intensity: ${(mieIntensity * 100).toFixed(1)}%`,
    `  dust×humidity interaction: ${(contributions.dustHumidityInteraction ?? 0).toFixed(3)}`,
    `Rayleigh Spread: ${(rayleighSpread * 100).toFixed(1)}%`,
    `  (1 - turbidity)^1.5 = (${(1 - turbidity).toFixed(3)})^1.5`,
    `Atmospheric Clarity: ${(atmosphericClarity * 100).toFixed(1)}%`,
    `  τ_ext=${contributions.tauExt?.toFixed(4)}, air-mass=${contributions.airMass?.toFixed(2)}`,
    `  effective optical path=${contributions.effectiveOpticalPath?.toFixed(4)}`,
  );

  return lines.join('\n');
}
