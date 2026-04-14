// ─────────────────────────────────────────
//  Structured error logger — TWILIGHT PWA
//  Provides scope/action tagging for all error paths.
//  Centralises output format so debugging is traceable.
// ─────────────────────────────────────────

let _bootId = null;

/** Generate a short unique ID for the current boot session */
export function initBootId() {
  _bootId = Math.random().toString(36).slice(2, 8);
  return _bootId;
}

/**
 * Log a structured error/warning.
 * @param {{ scope: string, action: string, error?: Error|string, meta?: any, severity?: 'error'|'warn'|'info' }} opts
 */
export function logError({ scope, action, error, meta, severity = 'error' }) {
  const prefix = _bootId ? `[${scope}:${_bootId}]` : `[${scope}]`;
  const msg = error instanceof Error ? error.message : (error || '');
  const args = [`${prefix} ${action}:`, msg];
  if (meta !== undefined) args.push(meta);

  if (severity === 'error') console.error(...args);
  else if (severity === 'warn') console.warn(...args);
  else console.log(...args);
}

/**
 * Log a structured info message (non-error).
 * @param {{ scope: string, action: string, meta?: any }} opts
 */
export function logInfo({ scope, action, meta }) {
  logError({ scope, action, meta, severity: 'info' });
}
