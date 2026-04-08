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
 * Update the dynamic background gradient based on physics sky colours.
 *
 * Primary path  (skyColors present, no ?useLegacyGradient):
 *   Delegates to skyGradient.js:renderSkyGradient — physics-derived colours.
 *
 * Neutral fallback (skyColors absent):
 *   Sets a safe dark neutral gradient.  Does NOT use score to drive colour —
 *   this avoids the architectural flaw where a quality metric changes hue.
 *
 * Legacy path (?useLegacyGradient=1 in URL):
 *   Original score + turbidity heuristic, preserved for A/B comparison.
 *
 * @param {number} score          1-10 sunset quality
 * @param {number} turbidity      0-1 aerosol index from physicsLayer
 * @param {string} [palette]      palette style name — legacy path only
 * @param {object|null} skyColors physics sky colours from skyColor.js
 * @param {number} [beltOfVenus]  0-1 probability from goldenWindow
 */
export function updateDynamicGradient(score = 5, turbidity = 0.3, palette = '', skyColors = null, beltOfVenus = 0) {
  // Adaptive glassmorphism — driven by physics sky brightness, not score.
  // Bright vivid sky → transparent crisp glass; dim overcast → opaque frosted glass.
  const root = document.documentElement.style;
  const skyBrightness = skyColors
    ? Math.min((skyColors.skyTop.r + skyColors.skyTop.g + skyColors.skyTop.b) / 765, 1)
    : Math.min(Math.max(score, 1) / 10, 1); // fallback to score when no physics available
  root.setProperty('--glass-blur',     `${(2 + (1 - skyBrightness) * 8).toFixed(1)}px`);
  root.setProperty('--glass-alpha',    (0.32 + (1 - skyBrightness) * 0.28).toFixed(2));
  root.setProperty('--glass-saturate', `${Math.round(110 + skyBrightness * 40)}%`);

  if (skyColors && !new URLSearchParams(location.search).get('useLegacyGradient')) {
    renderSkyGradient(skyColors, beltOfVenus);
    return;
  }

  // skyColors missing — use neutral dark fallback, never score-driven colour.
  // Alphas mirror the reduced shipping values in skyGradient.js so the
  // background photo stays visible even when physics data hasn't loaded yet.
  if (!skyColors) {
    document.documentElement.style.setProperty('--dyn-bg-top',    'rgba(15, 6, 2, 0.35)');
    document.documentElement.style.setProperty('--dyn-bg-mid',    'rgba(12, 5, 2, 0.28)');
    document.documentElement.style.setProperty('--dyn-bg-belt',   'rgba(10, 4, 8, 0.00)');
    document.documentElement.style.setProperty('--dyn-bg-earth',  'rgba(5, 3, 4, 0.35)');
    document.documentElement.style.setProperty('--dyn-bg-bottom', 'rgba(8,  3, 1, 0.55)');
    return;
  }

  // Legacy path — only reached when ?useLegacyGradient=1
  const s = Math.max(0, Math.min(1, (score - 1) / 9)); // normalise 1-10 → 0-1

  let top, mid, bottom;

  if (turbidity > 0.60 && s > 0.55) {
    // Mie-dominated: intense red/orange sun disk
    top    = `rgba(${Math.round(70 + s * 40)}, ${Math.round(10 + s * 8)}, 0, 0.42)`;
    mid    = `rgba(${Math.round(70 + s * 40)}, ${Math.round(10 + s * 8)}, 0, 0.42)`;
    bottom = `rgba(18, 4, 0, 0.97)`;

  } else if (turbidity < 0.25 && s > 0.60) {
    // Clean-air Rayleigh: broad purple-to-pink gradient
    const r = Math.round(28 + s * 32);
    const g = Math.round(5  + s * 10);
    const b = Math.round(50 + s * 40);
    top    = `rgba(${r}, ${g}, ${b}, 0.42)`;
    mid    = `rgba(${r}, ${g}, ${b}, 0.42)`;
    bottom = `rgba(10, 3, 22, 0.97)`;

  } else if (s > 0.55 && turbidity > 0.35) {
    // Mixed: warm amber top, deep plum bottom
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
  document.documentElement.style.setProperty('--dyn-bg-belt',   'rgba(10, 4, 8, 0.00)');
  document.documentElement.style.setProperty('--dyn-bg-earth',  'rgba(5, 3, 4, 0.60)');
  document.documentElement.style.setProperty('--dyn-bg-bottom', bottom);
}

// ✓ ui.js — complete
