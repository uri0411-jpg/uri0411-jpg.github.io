/**
 * TWILIGHT v2 — Golden Window & Peak Detection
 * ============================================================================
 * Predicts the exact window of peak sunset beauty, which differs from the
 * astronomical sunset time.
 *
 * Why this matters:
 *   - Astronomical sunset = sun's center crosses the horizon.
 *   - Peak beauty often occurs 5-25 minutes AFTER astronomical sunset,
 *     when the sun is 1-6° below the horizon and the sky is lit indirectly.
 *   - The exact timing depends on cloud height (higher clouds stay
 *     illuminated longer), turbidity (aerosols shift the peak earlier
 *     and compress the window), and the rate of solar descent.
 *
 * Key physics:
 *   - Earth shadow rises at ~1° per 4 minutes after sunset at mid-latitudes.
 *   - A cloud at 10 km altitude remains sunlit until the sun is ~3.2° below
 *     the horizon (geometric calculation from Earth's curvature).
 *   - High turbidity extinguishes the scattered light faster because the
 *     already-long path through the atmosphere becomes opaque sooner.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/**
 * Approximate solar descent rate in degrees per minute.
 *
 * The rate depends on both latitude AND solar declination (δ):
 *   rate ≈ 0.25 · cos(latitude) · cos(declination)  [°/min]
 *
 * At the equator with δ=0° (equinox): 0.25°/min — fastest possible descent.
 * At 32° latitude with δ=+23° (summer solstice): 0.25 · cos(32°) · cos(23°) ≈ 0.194°/min.
 * Same latitude at equinox (δ=0°): 0.25 · cos(32°) · 1.0 ≈ 0.212°/min.
 *
 * The effect is modest (~8% slower at solstice vs equinox at mid-latitudes)
 * but becomes important near the poles.
 *
 * Floor of 0.02 handles polar regions where the sun barely descends.
 *
 * @param {number} latitudeDeg   Observer latitude in degrees
 * @param {number} [declinationDeg=0]  Solar declination in degrees (-23.5 to +23.5)
 */
const solarDescentRate = (latitudeDeg, declinationDeg = 0) => {
  const latRad = (Math.abs(latitudeDeg) * Math.PI) / 180;
  const decRad = (declinationDeg * Math.PI) / 180;
  return Math.max(0.02, 0.25 * Math.cos(latRad) * Math.cos(decRad));
};

/**
 * Maximum solar depression angle (below horizon) at which a cloud at
 * a given altitude remains illuminated by direct sunlight.
 *
 * Derived from geometry:
 *   cos(90° + depression) = R / (R + h)
 *   depression = arccos(R / (R + h)) - 90°
 *
 * where R = Earth's radius (6371 km) and h = cloud altitude (km).
 *
 * Results:
 *   h =  2 km (low stratus)   → ~1.4°  (illuminated only briefly after sunset)
 *   h =  5 km (altocumulus)    → ~2.3°
 *   h = 10 km (cirrus)         → ~3.2°  (lit for ~13 min after sunset at mid-lat)
 *   h = 12 km (high cirrus)    → ~3.5°
 */
const maxIlluminationDepression = (cloudAltitudeKm) => {
  const R = 6371;
  const angle = Math.acos(R / (R + cloudAltitudeKm)) * (180 / Math.PI);
  return angle;
};

// ─── Cloud Height → Altitude Mapping ────────────────────────────────────────

const CLOUD_ALTITUDES = {
  high: 10,  // Cirrus, cirrostratus — 6-12 km, we use 10 km as representative
  mid:   5,  // Altocumulus, altostratus — 2-6 km
  low:   1.5, // Stratus, stratocumulus — 0-2 km
};

// ─── Main Export ────────────────────────────────────────────────────────────

/**
 * Predict the golden window of peak sunset beauty.
 *
 * @param {Object} params
 * @param {Date}   params.sunsetTime          – Astronomical sunset time
 * @param {number} params.solarElevation      – Current solar elevation (degrees)
 * @param {string} params.cloudHeightCategory – 'high' | 'mid' | 'low'
 * @param {number} params.turbidity           – 0-1 from physics layer
 * @param {number} params.rayleighSpread      – 0-1 from physics layer (for Belt of Venus)
 * @param {number} params.latitude            – Observer latitude (degrees)
 * @param {number} [params.declination=0]     – Solar declination (degrees, -23.5 to +23.5).
 *                                              Pass the day's solar declination for accurate
 *                                              descent-rate calculation. Defaults to 0 (equinox).
 * @param {number} [params.clouds=0.3]        – Cloud coverage fraction, 0-1
 *
 * @returns {{
 *   peakTime: Date,             // Predicted moment of peak visual quality
 *   windowStart: Date,          // When colors begin to intensify
 *   windowEnd: Date,            // When colors have faded
 *   duration: number,           // Window duration in minutes
 *   peakOffsetMinutes: number,  // Minutes after astronomical sunset
 *   beltOfVenus: number,        // 0-1 Belt of Venus visibility (eastern sky post-sunset)
 *   contributions: Object       // Breakdown for debug panel
 * }}
 */
export function predictGoldenWindow({
  sunsetTime,
  solarElevation = 5,
  cloudHeightCategory = 'mid',
  turbidity = 0.3,
  rayleighSpread = 0.5,
  latitude = 40,
  declination = 0,
  clouds = 0.3,
} = {}) {
  const sunset = sunsetTime instanceof Date ? sunsetTime : new Date(sunsetTime);

  // ── Handle polar edge cases ────────────────────────────────────────────
  // Midnight sun: if the sun doesn't set (solarElevation stays positive
  // and descent rate is near zero), return a "perpetual golden hour" window.
  // Polar night: if solarElevation is deeply negative, return a null window.

  const descentRate = solarDescentRate(latitude, declination);

  if (descentRate < 0.03 && solarElevation > 0) {
    // Midnight sun scenario — golden light persists for hours
    return {
      peakTime: sunset,
      windowStart: new Date(sunset.getTime() - 120 * 60000),
      windowEnd: new Date(sunset.getTime() + 120 * 60000),
      duration: 240,
      peakOffsetMinutes: 0,
      contributions: {
        note: 'Midnight sun detected — extended golden window',
        descentRate,
        latitude,
      },
    };
  }

  if (solarElevation < -18) {
    // Astronomical twilight is over; no visible sunset colors
    return {
      peakTime: sunset,
      windowStart: sunset,
      windowEnd: sunset,
      duration: 0,
      peakOffsetMinutes: 0,
      contributions: {
        note: 'Polar night or deep twilight — no visible sunset',
        solarElevation,
      },
    };
  }

  // ── Compute peak offset from astronomical sunset ──────────────────────

  // Base peak offset: in clear conditions at mid-latitudes, peak color
  // typically occurs ~5-8 minutes after sunset, when the sun is ~1.5-2°
  // below the horizon and the atmosphere acts as a giant color filter.
  const basePeakOffset = 6; // minutes after sunset

  // Cloud height bonus: high clouds stay illuminated much longer.
  // The peak shifts later because the clouds continue to "burn" well
  // after the horizon-level colors have faded.
  const cloudAlt = CLOUD_ALTITUDES[cloudHeightCategory] ?? 5;
  const maxDepression = maxIlluminationDepression(cloudAlt);

  // Time for sun to descend to max illumination angle, in minutes
  const cloudIlluminationDuration = maxDepression / descentRate;

  // Cloud contribution scales with coverage — more clouds = more of the
  // show depends on cloud illumination timing.
  const cloudPeakBonus = clamp(clouds, 0, 1) * cloudIlluminationDuration * 0.6;

  // Turbidity penalty: high aerosols shift peak EARLIER because the
  // scattered light extinguishes faster.  At turbidity=1, peak shifts
  // ~4 minutes earlier than baseline.
  const turbidityShift = -4 * turbidity;

  const peakOffsetMinutes = Math.max(0, basePeakOffset + cloudPeakBonus + turbidityShift);

  // ── Compute window boundaries ─────────────────────────────────────────

  // Window start: colors begin ~15-20 minutes BEFORE sunset (sun at 3-5°).
  // High turbidity can make colors start earlier (more dramatic low-angle
  // scattering) but also means they start fading sooner.
  const windowStartOffset = -(15 + 5 * turbidity); // minutes before sunset

  // Window end: how long after peak do colors persist?
  // - Clean air: colors linger as the purple/pink belt slowly rises → long tail
  // - Dusty air: rapid extinction → short tail
  // - High clouds: they stay lit well past the surface-level color window
  const baseTailDuration = 12; // minutes of color after peak in baseline
  const clarityBonus = (1 - turbidity) * 10;  // up to 10 extra min in clean air
  const cloudTailBonus = clamp(clouds, 0, 1) * cloudIlluminationDuration * 0.4;
  const tailDuration = baseTailDuration + clarityBonus + cloudTailBonus;

  const windowEndOffset = peakOffsetMinutes + tailDuration;

  // ── Belt of Venus visibility ───────────────────────────────────────────
  //
  // The Belt of Venus is a pink anti-twilight arch visible in the EASTERN sky
  // (~15-30 min after sunset), formed by Rayleigh backscattering from the
  // deep-red twilight sky above the rising shadow of the Earth.
  //
  // Visibility conditions:
  //   - Requires clean air (high rayleighSpread) — aerosols suppress the arch
  //   - Low cloud cover in the eastern sky (proxied by overall cloud cover here)
  //   - Best seen at turbidity < 0.3; visible up to ~0.55
  //
  // The arch rises above the Earth's shadow at ~1°/4min following sunset,
  // so it's most prominent during the tail of the golden window.
  //
  // Output: 0 = invisible, 1 = spectacular (crystal-clear alpine conditions)

  const beltOfVenus = clamp(
    rayleighSpread * 0.85 +               // clean sky is primary driver
    (1 - turbidity) * 0.15               // extra credit for very clean air
    - clamp(clouds, 0, 1) * 0.4          // cloud penalty (eastern sky obstruction)
  );

  // ── Build output ──────────────────────────────────────────────────────

  const peakTime    = new Date(sunset.getTime() + peakOffsetMinutes * 60000);
  const windowStart = new Date(sunset.getTime() + windowStartOffset * 60000);
  const windowEnd   = new Date(sunset.getTime() + windowEndOffset * 60000);
  const duration    = (windowEnd - windowStart) / 60000;

  return {
    peakTime,
    windowStart,
    windowEnd,
    duration: Math.round(duration * 10) / 10,
    peakOffsetMinutes: Math.round(peakOffsetMinutes * 10) / 10,
    beltOfVenus: Math.round(beltOfVenus * 1000) / 1000,
    contributions: {
      basePeakOffset,
      cloudPeakBonus: Math.round(cloudPeakBonus * 100) / 100,
      turbidityShift: Math.round(turbidityShift * 100) / 100,
      cloudAltitudeKm: cloudAlt,
      maxIlluminationDepression: Math.round(maxDepression * 100) / 100,
      cloudIlluminationDuration: Math.round(cloudIlluminationDuration * 100) / 100,
      descentRate: Math.round(descentRate * 1000) / 1000,
      windowStartOffset: Math.round(windowStartOffset * 10) / 10,
      windowEndOffset: Math.round(windowEndOffset * 10) / 10,
      tailDuration: Math.round(tailDuration * 10) / 10,
    },
  };
}

/**
 * Debug helper — human-readable breakdown of golden window prediction.
 */
export function getContribution(windowResult) {
  const { peakTime, windowStart, windowEnd, duration, peakOffsetMinutes, beltOfVenus, contributions: c } =
    windowResult;

  const fmt = (d) => d instanceof Date ? d.toLocaleTimeString() : String(d);

  const lines = [
    `Golden Window: ${fmt(windowStart)} → ${fmt(windowEnd)}  (${duration} min)`,
    `Peak beauty:   ${fmt(peakTime)}  (${peakOffsetMinutes} min after sunset)`,
    `Belt of Venus: ${((beltOfVenus ?? 0) * 100).toFixed(0)}%  (eastern-sky arch visibility)`,
    ``,
    `Breakdown:`,
    `  Base peak offset:     +${c.basePeakOffset} min`,
    `  Cloud peak bonus:     +${c.cloudPeakBonus} min`,
    `    Cloud altitude:     ${c.cloudAltitudeKm} km`,
    `    Max illumination:   sun ${c.maxIlluminationDepression}° below horizon`,
    `    Illumination time:  ${c.cloudIlluminationDuration} min`,
    `  Turbidity shift:      ${c.turbidityShift} min`,
    `  Solar descent rate:   ${c.descentRate}°/min  (lat+declination corrected)`,
    `  Tail duration:        ${c.tailDuration} min`,
  ];

  return lines.join('\n');
}
