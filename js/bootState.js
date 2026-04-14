// ─────────────────────────────────────────
//  Boot state machine — TWILIGHT PWA
//
//  Tracks the boot lifecycle as discrete states so debugging is clear.
//  Transitions are logged via the structured logger.
// ─────────────────────────────────────────

import { logInfo } from './logger.js';

export const BOOT_STATES = Object.freeze({
  INIT:    'init',
  LOADING: 'loading',
  READY:   'ready',
  ERROR:   'error',
  TIMEOUT: 'timeout',
});

let _state = BOOT_STATES.INIT;

/**
 * Transition to a new boot state.
 * @param {string} newState — one of BOOT_STATES values
 */
export function setBootState(newState) {
  const prev = _state;
  _state = newState;
  logInfo({ scope: 'boot', action: 'state', meta: { from: prev, to: newState } });
}

/** @returns {string} current boot state */
export function getBootState() {
  return _state;
}
