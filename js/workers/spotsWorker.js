// ─────────────────────────────────────────
//  Spots quality Worker — TWILIGHT PWA
//
//  Computes calcLocationQuality() for batches of spots off the main thread.
//  Receives: { spots, sunsetAzimuth }
//  Returns:  { results: [{ idx, sunset, sunrise }] }
//
//  Pure computation — no DOM, no module state.
// ─────────────────────────────────────────

/* eslint-env worker */

// ── Pure helpers (duplicated from spots-screen.js to avoid import issues in Worker) ──

function isWesternCoastBeach(spot) { return spot.type === 'חוף' && spot.lon < 34.75; }

function estimateDriveMin(dist) {
  if (dist <= 3)  return Math.round(dist * 3);
  if (dist <= 15) return Math.round(dist * 2.2);
  return Math.round(dist * 1.5);
}

/**
 * Calculate location quality for a single spot.
 * Mirrors spots-screen.js calcLocationQuality() exactly.
 *
 * @param {Object} spot       — { elevation, type, lon, dist, _bearing, _horizonWarning }
 * @param {number} bearing    — bearing from user to spot (degrees)
 * @param {number} sunsetAz   — sunset azimuth (degrees)
 * @param {string} mode       — 'sunset' | 'sunrise'
 * @returns {number} 1–100
 */
function calcLocationQuality(spot, bearing, sunsetAz, mode = 'sunset') {
  const elev = spot.elevation ?? 0;

  const targetAz = mode === 'sunrise' ? (sunsetAz + 180) % 360 : sunsetAz;
  const diff     = Math.abs(bearing - targetAz);
  const norm     = diff > 180 ? 360 - diff : diff;

  // A. Direction — 30 pts
  const dirPts = norm <= 10 ? 30 : norm <= 25 ? 24 : norm <= 45 ? 16
               : norm <= 70 ?  8 : norm <= 100 ?  2 : 0;

  // B. Horizon quality — 25 pts
  const hasWarning = !!spot._horizonWarning;
  const horizPts = hasWarning ? 0
    : (isWesternCoastBeach(spot) && mode === 'sunset') ? 25
    : spot.type === 'מצוק'         ? 20
    : spot.type === 'פסגה'         ? 16
    : spot.type === 'נקודת תצפית' ? 14
    : spot.type === 'חוף'          ? 12 : 5;

  // C. Elevation — 20 pts
  const elevPts = elev >= 800 ? 20 : elev >= 500 ? 16 : elev >= 300 ? 11
               : elev >= 150 ?  7 : elev >= 50  ?  3 : 0;

  // D. Accessibility — 15 pts
  const driveMin  = estimateDriveMin(spot.dist || 0);
  const accessPts = driveMin < 10 ? 15 : driveMin < 20 ? 12
                  : driveMin < 35 ?  8 : driveMin < 60 ?  4 : 1;

  // E. Terrain type — 10 pts
  const typePts = (isWesternCoastBeach(spot) && mode === 'sunset') ? 10
                : spot.type === 'מצוק'         ?  8
                : spot.type === 'נקודת תצפית'  ?  8
                : spot.type === 'פסגה'          ?  6
                : spot.type === 'חוף'           ?  3 : 1;

  return Math.max(1, Math.min(100, dirPts + horizPts + elevPts + accessPts + typePts));
}

// ── Message handler ──────────────────────────────────────────────────────────

self.onmessage = function(e) {
  const { spots, sunsetAzimuth } = e.data;
  const results = new Array(spots.length);

  for (let i = 0; i < spots.length; i++) {
    const s = spots[i];
    results[i] = {
      idx:     i,
      sunset:  calcLocationQuality(s, s._bearing, sunsetAzimuth, 'sunset'),
      sunrise: calcLocationQuality(s, s._bearing, sunsetAzimuth, 'sunrise'),
      driveMin: estimateDriveMin(s.dist || 0),
    };
  }

  self.postMessage({ results });
};
