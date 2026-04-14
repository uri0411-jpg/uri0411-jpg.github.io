// ─────────────────────────────────────────
//  Screen lifecycle — cleanup registry
//
//  Each screen (main, spots, settings, learning) can register cleanup
//  functions that run when the screen is replaced or the app navigates.
//  This replaces scattered module-level cleanup variables (_stopCompass,
//  _stopLiveGradient, etc.) with a single contract.
//
//  Usage:
//    registerCleanup('main', () => clearInterval(id));
//    runCleanup('main');  // called on screen change
// ─────────────────────────────────────────

const _cleanups = new Map();

/**
 * Register a cleanup function for a specific screen.
 * @param {string} screenId — e.g. 'main', 'spots', 'settings'
 * @param {Function} fn — cleanup callback (should be idempotent)
 */
export function registerCleanup(screenId, fn) {
  if (typeof fn !== 'function') return;
  if (!_cleanups.has(screenId)) _cleanups.set(screenId, []);
  _cleanups.get(screenId).push(fn);
}

/**
 * Run and clear all registered cleanups for a screen.
 * @param {string} screenId
 */
export function runCleanup(screenId) {
  const fns = _cleanups.get(screenId);
  if (!fns) return;
  for (const fn of fns) {
    try { fn(); } catch (e) { console.warn(`[lifecycle] cleanup error in ${screenId}:`, e.message); }
  }
  _cleanups.delete(screenId);
}

/**
 * Clear all registered cleanups without running them.
 * @param {string} screenId
 */
export function clearCleanup(screenId) {
  _cleanups.delete(screenId);
}
