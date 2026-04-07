/**
 * sun.js — Solar position API for the engine layer
 *
 * Thin wrapper over the simplified astronomical formulas in utils.js.
 * Provides a clean, radians-based interface for atmosphere.js and any
 * future engine modules that need solar geometry.
 *
 * The underlying calcSolarElevation() uses a standard declination +
 * hour-angle model (±1–2° accuracy), which is sufficient for sky colour
 * computation.
 */

import { calcSolarElevation } from '../utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const DEG_TO_RAD = Math.PI / 180;

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Solar elevation angle in radians.
 *
 * @param {Object} params
 * @param {Date|string|number} params.time  Moment to evaluate (Date, ISO string, or ms timestamp)
 * @param {number}             params.lat   Geographic latitude in degrees (+N)
 * @param {number}             params.lon   Geographic longitude in degrees (+E)
 * @returns {number}  Elevation in radians — positive above horizon, negative below
 */
export function getSunAngle({ time, lat, lon }) {
  const date = time instanceof Date ? time : new Date(time);
  return calcSolarElevation(lat, lon, date) * DEG_TO_RAD;
}

/**
 * Solar elevation angle in degrees (convenience wrapper).
 *
 * @param {Object} params  Same as getSunAngle
 * @returns {number}  Elevation in degrees
 */
export function getSunAngleDegrees({ time, lat, lon }) {
  const date = time instanceof Date ? time : new Date(time);
  return calcSolarElevation(lat, lon, date);
}
