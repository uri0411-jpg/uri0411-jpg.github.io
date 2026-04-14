/**
 * sunDisk.js — CSS sun-disk element renderer
 *
 * Injects a <div id="sun-disk"> behind the .home-content children and updates
 * its appearance (colour, size, glow blur) from computeSunAppearance() output.
 *
 * Positioning:
 *   Horizontal — solar azimuth mapped to screen width.
 *                270° (due West) → 50%.  Range ±90° either side → 10–90%.
 *   Vertical   — solar elevation mapped to viewport height.
 *                0° (horizon) → 65%.  +10° → ~55%.  −6° → ~75%.
 *
 * The disk is rendered as a radial-gradient glow rather than a hard circle to
 * blend naturally with the CSS sky gradient behind it.
 *
 * @module render/sunDisk
 */

import { computeSunAppearance } from '../engine/skyColor.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DISK_ID          = 'sun-disk';
const HALO_ID          = 'sun-halo';   // wider turbidity-driven atmospheric glow
const HORIZON_Y_PCT    = 65;   // % from top where elevation = 0°
const ELEV_TO_Y_SCALE  = 1.8;  // % per degree of solar elevation
const AZ_CENTER_DEG    = 270;  // azimuth mapped to horizontal centre (due West)
const AZ_HALF_RANGE    = 90;   // ±degrees that span 10%–90% of screen width
const BASE_DISK_PX     = 80;   // base diameter in px (at size=1.0)

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Map solar azimuth (degrees, 0=N clockwise) to horizontal CSS percentage.
 * Centred on AZ_CENTER_DEG (West).
 */
function azimuthToX(azimuthDeg) {
  const offset = azimuthDeg - AZ_CENTER_DEG;
  // Wrap to ±180°
  const wrapped = ((offset + 180) % 360) - 180;
  const frac    = wrapped / AZ_HALF_RANGE;            // −1 to +1
  return clamp(50 + frac * 40, 8, 92);                // 8% – 92%
}

/**
 * Map solar elevation (degrees, +above horizon) to vertical CSS percentage.
 */
function elevationToY(elevationDeg) {
  return clamp(HORIZON_Y_PCT - elevationDeg * ELEV_TO_Y_SCALE, 15, 85);
}

// ── Primary export ────────────────────────────────────────────────────────────

/**
 * Create (or update) the #sun-disk element inside a given container.
 *
 * @param {Element}  container      The .home-content element (position:relative)
 * @param {Object}   params
 * @param {number}   params.solarElevation  Degrees (negative = below horizon)
 * @param {number}   params.solarAzimuth    Degrees (0=N, 90=E, 180=S, 270=W)
 * @param {number}   params.turbidity       0–1
 * @param {number}   params.mieIntensity    0–1
 * @param {number}   params.humidity        0–100
 * @param {number}   params.airMass         Kasten-Young air mass
 */
export function renderSunDisk(container, { solarElevation, solarAzimuth, turbidity, mieIntensity, humidity, airMass }) {
  if (!container) return;

  // Sun is not visible more than 6° below horizon — remove disk
  if (solarElevation < -6) {
    removeSunDisk(container);
    return;
  }

  const { color, size, blur, intensity } = computeSunAppearance({
    solarElevation, turbidity, mieIntensity, humidity, airMass,
  });

  // Opacity scales: 1.0 at horizon, fades as sun goes below horizon
  const opacity = solarElevation >= 0
    ? clamp(0.55 + intensity * 0.45, 0.3, 1.0)
    : clamp(1 + solarElevation / 6, 0, 0.6); // fades linearly from 0° to −6°

  const x   = azimuthToX(solarAzimuth ?? AZ_CENTER_DEG);
  const y   = elevationToY(solarElevation);
  const dia = Math.round(BASE_DISK_PX * size);
  const blurPx = Math.round(blur);

  // ── Find or create the disk element ──────────────────────────────────────
  let disk = container.querySelector(`#${DISK_ID}`);
  if (!disk) {
    disk = document.createElement('div');
    disk.id = DISK_ID;
    // Insert as first child so it sits behind content
    container.insertBefore(disk, container.firstChild);
  }

  // ── Style ─────────────────────────────────────────────────────────────────
  const { r, g, b } = color;
  const glowR = Math.min(r + 30, 255);
  const glowG = Math.min(g + 10, 255);
  const glowB = Math.min(b +  5, 255);

  Object.assign(disk.style, {
    position:        'absolute',
    left:            `${x}%`,
    top:             `${y}%`,
    transform:       'translate(-50%, -50%)',
    width:           `${dia}px`,
    height:          `${dia}px`,
    borderRadius:    '50%',
    background:      `radial-gradient(circle, rgba(${r},${g},${b},0.95) 0%, rgba(${glowR},${glowG},${glowB},0.60) 35%, rgba(${r},${g},${b},0) 70%)`,
    filter:          `blur(${blurPx}px)`,
    opacity:         opacity.toFixed(2),
    pointerEvents:   'none',
    zIndex:          '0',
    mixBlendMode:    'lighten',
    transition:      'left 2s ease, top 2s ease, opacity 2s ease',
  });

  // ── Turbidity atmospheric halo (wider than disk, opacity scales with turbidity) ──
  // High turbidity (dust/haze) scatters light over a wide angle around the sun
  if (turbidity > 0.10) {
    let halo = container.querySelector(`#${HALO_ID}`);
    if (!halo) {
      halo = document.createElement('div');
      halo.id = HALO_ID;
      container.insertBefore(halo, container.firstChild);
    }
    const haloDia  = Math.round(BASE_DISK_PX * size * (2.5 + turbidity * 4));
    const haloAlpha = clamp(0.04 + turbidity * 0.22, 0, 0.28);
    Object.assign(halo.style, {
      position:      'absolute',
      left:          `${x}%`,
      top:           `${y}%`,
      transform:     'translate(-50%, -50%)',
      width:         `${haloDia}px`,
      height:        `${haloDia}px`,
      borderRadius:  '50%',
      background:    `radial-gradient(circle, rgba(${glowR},${Math.min(glowG+20,255)},${Math.round(b*0.4)},${haloAlpha}) 0%, rgba(${r},${Math.round(g*0.5)},0,0) 70%)`,
      pointerEvents: 'none',
      zIndex:        '-1',
      mixBlendMode:  'lighten',
      transition:    'left 2s ease, top 2s ease, opacity 2s ease',
      opacity:       opacity.toFixed(2),
    });
  } else {
    container.querySelector(`#${HALO_ID}`)?.remove();
  }
}

/**
 * Remove the #sun-disk element from the container (e.g. after astronomical twilight).
 */
export function removeSunDisk(container) {
  container?.querySelector(`#${DISK_ID}`)?.remove();
  container?.querySelector(`#${HALO_ID}`)?.remove();
}
