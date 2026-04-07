/**
 * environment.js — Typed data model for atmospheric environment inputs
 *
 * Centralises the parameters consumed by the physics engine (atmosphere.js)
 * into a single validated object.  Designed to be extended as the model grows:
 *   - Phase 1: turbidity + sunAngle  (current)
 *   - Future:  humidity, aerosols, ozone, altitude, …
 *
 * Usage:
 *   import { createEnvironment } from '../data/environment.js';
 *   const env = createEnvironment({ turbidity: 0.4, sunAngle: 0.087 });
 *   const atm = computeAtmosphere(env.sunAngle, env.turbidity);
 */

/**
 * Create a validated environment descriptor for the sky colour engine.
 *
 * @param {Object} params
 * @param {number}      params.turbidity   Aerosol loading 0–1 (from physicsLayer.js)
 * @param {number}      params.sunAngle    Solar elevation in radians
 * @param {number|null} [params.humidity]  Relative humidity 0–100 % (optional, future)
 * @param {number|null} [params.aerosols]  Fine-particle concentration (future)
 * @param {number|null} [params.ozone]     Ozone column depth in DU (future)
 *
 * @returns {{
 *   turbidity: number,
 *   sunAngle:  number,
 *   humidity:  number|null,
 *   aerosols:  number|null,
 *   ozone:     number|null,
 * }}
 */
export function createEnvironment({
  turbidity,
  sunAngle,
  humidity  = null,
  aerosols  = null,
  ozone     = null,
} = {}) {
  return {
    // Clamp turbidity to valid range — physicsLayer ensures 0–1 but guard here too
    turbidity: Math.max(0, Math.min(1, turbidity ?? 0.3)),
    sunAngle:  sunAngle ?? 0,          // radians; 0 = sun exactly at horizon
    humidity,                          // reserved for future Rayleigh humidity correction
    aerosols,                          // reserved for fine-particle spectral extinction
    ozone,                             // reserved for Chappuis-band ozone absorption
  };
}
