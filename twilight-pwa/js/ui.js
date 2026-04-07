// ═══════════════════════════════════════════
//  TWILIGHT — ui.js
//  Toast notifications and loading overlay
// ═══════════════════════════════════════════
import { renderSkyGradient } from './render/skyGradient.js';

let toastTimer = null;

/**
 * Show a toast notification
 * @param {string} msg - message text
 * @param {'success'|'error'|'info'} type
 */
export function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;

  el.textContent = msg;
  el.className = `toast toast-${type}`;
  el.style.display = 'flex';

  // Clear previous timer
  if (toastTimer) clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => {
      el.style.display = 'none';
      el.style.opacity = '';
    }, 300);
  }, 2500);
}

/**
 * Show or hide the loading overlay
 * @param {boolean} show
 */
export function showLoading(show) {
  const el = document.getElementById('loading');
  if (!el) return;
  if (show) {
    el.classList.remove('hidden');
    el.style.display = 'flex';
  } else {
    el.classList.add('hidden');
    el.style.display = 'none';
  }
}

/**
 * Create an image element with the twilight logo set
 * @param {'sunrise'|'sunset'|'twilight'} type
 * @param {number} size - px
 */
export function logoImg(type, size = 24) {
  const srcMap = {
    sunrise:  'images/sunrise.png',
    sunset:   'images/sunset.png',
    twilight: 'images/twilight.png'
  };
  return `<img src="${srcMap[type] || srcMap.twilight}" width="${size}" height="${size}" style="object-fit:contain;flex-shrink:0" alt="${type}">`;
}

/**
 * Sanitize a string for safe innerHTML insertion
 */
export function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Update the dynamic background gradient based on score + turbidity.
 *
 * High score + low turbidity  → wide Rayleigh gradient (deep purple/pink)
 * High score + high turbidity → Mie-dominated (deep red/orange)
 * Low score                   → muted dark tones (clouds expected)
 *
 * Sets CSS custom properties --dyn-bg-top / --dyn-bg-bottom on :root.
 *
 * @param {number} score       1-10 sunset quality
 * @param {number} turbidity   0-1 aerosol index from physicsLayer
 * @param {string} [palette]   palette style name (e.g. 'Desert Fire')
 */
export function updateDynamicGradient(score = 5, turbidity = 0.3, palette = '', skyColors = null) {
  if (skyColors && !new URLSearchParams(location.search).get('useLegacyGradient')) {
    renderSkyGradient(skyColors);
    return;
  }
  const s = Math.max(0, Math.min(1, (score - 1) / 9)); // normalise 1-10 → 0-1

  let top, mid, bottom;

  if (palette === 'Desert Fire' || (turbidity > 0.60 && s > 0.55)) {
    // Mie-dominated: intense red/orange sun disk
    top    = `rgba(${Math.round(70 + s * 40)}, ${Math.round(10 + s * 8)}, 0, 0.42)`;
    mid    = `rgba(${Math.round(70 + s * 40)}, ${Math.round(10 + s * 8)}, 0, 0.42)`;
    bottom = `rgba(18, 4, 0, 0.97)`;

  } else if (palette === 'Purple Twilight' || (turbidity < 0.25 && s > 0.60)) {
    // Clean-air Rayleigh: broad purple-to-pink gradient
    const r = Math.round(28 + s * 32);
    const g = Math.round(5  + s * 10);
    const b = Math.round(50 + s * 40);
    top    = `rgba(${r}, ${g}, ${b}, 0.42)`;
    mid    = `rgba(${r}, ${g}, ${b}, 0.42)`;
    bottom = `rgba(10, 3, 22, 0.97)`;

  } else if (palette === 'Storm Break' || (s > 0.55 && turbidity > 0.35)) {
    // Storm break / mixed: warm amber top, deep plum bottom
    top    = `rgba(${Math.round(55 + s * 35)}, ${Math.round(20 + s * 15)}, 0, 0.42)`;
    mid    = `rgba(${Math.round(55 + s * 35)}, ${Math.round(20 + s * 15)}, 0, 0.42)`;
    bottom = `rgba(12, 4, 18, 0.97)`;

  } else if (s > 0.55) {
    // Golden Hour default for good scores
    const r = Math.round(45 + s * 30);
    const g = Math.round(14 + s * 10);
    top    = `rgba(${r}, ${g}, 0, ${0.35 + s * 0.08})`;
    mid    = `rgba(${r}, ${g}, 0, ${0.35 + s * 0.08})`;
    bottom = `rgba(12, 4, 0, 0.97)`;

  } else {
    // Poor / mediocre — near-neutral dark (clouds expected)
    const dim = Math.round(22 + s * 18);
    top    = `rgba(${dim}, ${Math.round(dim * 0.45)}, ${Math.round(dim * 0.15)}, 0.35)`;
    mid    = `rgba(${dim}, ${Math.round(dim * 0.45)}, ${Math.round(dim * 0.15)}, 0.35)`;
    bottom = `rgba(8, 4, 2, 0.97)`;
  }

  document.documentElement.style.setProperty('--dyn-bg-top',    top);
  document.documentElement.style.setProperty('--dyn-bg-mid',    mid);
  document.documentElement.style.setProperty('--dyn-bg-bottom', bottom);
}

// ✓ ui.js — complete
