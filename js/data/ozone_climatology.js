/**
 * ozone_climatology.js — Stratospheric ozone column by latitude & month
 *
 * Source: TOMS / OMI satellite climatology (zonal monthly means, Dobson Units).
 * Values represent total ozone column averaged over multi-year observations.
 *
 * Each row covers a 10° latitude band (Northern Hemisphere).
 * Months: [Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec]
 *
 * Physical significance for TWILIGHT:
 *   Stratospheric ozone absorbs 500–700 nm via the Chappuis band.
 *   Higher ozone → slightly more orange/red attenuation → bluer twilight arch.
 *   Seasonal variation is +30–50 DU at mid-latitudes (spring maximum),
 *   which produces a measurably different Belt-of-Venus blue-purple tint.
 *
 * Usage:
 *   import { getSeasonalOzone } from '../data/ozone_climatology.js';
 *   const du = getSeasonalOzone(32, 4); // lat=32°N, April → ~320 DU
 */

// Latitude bands: 0°N, 10°N, 20°N, 30°N, 40°N, 50°N, 60°N
// Monthly values [Jan .. Dec] in Dobson Units
const OZONE_TABLE = {
   0: [255, 255, 258, 262, 265, 258, 252, 250, 253, 255, 255, 255],
  10: [262, 262, 266, 268, 272, 267, 257, 252, 255, 260, 260, 262],
  20: [267, 270, 282, 292, 295, 286, 276, 267, 262, 265, 266, 266],
  30: [280, 292, 310, 320, 312, 296, 284, 280, 275, 275, 274, 276],  // Israel/Med
  40: [300, 322, 362, 372, 350, 325, 305, 294, 284, 280, 275, 292],
  50: [322, 364, 402, 420, 382, 345, 320, 304, 292, 284, 280, 306],
  60: [336, 392, 452, 462, 402, 352, 320, 304, 294, 284, 284, 318],
};

/**
 * Return the mean stratospheric ozone column (Dobson Units) for a given
 * latitude and calendar month.
 *
 * @param {number} lat    Geographic latitude in degrees (−90 to +90).
 *                        Southern hemisphere values are mirrored to the
 *                        nearest NH band (ozone is roughly symmetric about
 *                        the equator for the Chappuis band effect).
 * @param {number} month  Calendar month (1 = January … 12 = December).
 * @returns {number}  Ozone column in Dobson Units (integer, 250–470 DU typical).
 */
export function getSeasonalOzone(lat, month) {
  // Mirror southern hemisphere: ozone column is broadly symmetric
  const absLat = Math.abs(lat);

  // Find nearest 10° band
  const band = Math.min(60, Math.max(0, Math.round(absLat / 10) * 10));
  const row  = OZONE_TABLE[band] ?? OZONE_TABLE[30]; // fallback to 30°N (Israel)

  // month is 1-indexed; array is 0-indexed
  return row[Math.max(0, Math.min(11, month - 1))];
}
