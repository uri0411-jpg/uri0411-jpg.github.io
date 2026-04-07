// ═══════════════════════════════════════════
//  TWILIGHT — notifications.js
//  Local alert scheduling via Notification API + SW
// ═══════════════════════════════════════════

const STORAGE_KEY = 'twl_alerts';

// ─────────────────────────────────────────
//  Permission
// ─────────────────────────────────────────
export async function requestNotificationPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

// ─────────────────────────────────────────
//  Storage helpers
// ─────────────────────────────────────────
export function getSavedAlerts() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}

function _saveAlerts(obj) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
}

// ─────────────────────────────────────────
//  Schedule a local notification
//  key:       unique string (date-event-mins)
//  triggerAt: Date object
//  body:      notification body text
//  score:     day score for context
//  date:      'YYYY-MM-DD' — used for cleanup
// ─────────────────────────────────────────
export function scheduleAlert(key, triggerAt, body, score, date) {
  const alerts = getSavedAlerts();

  // Cancel any previous timer for this key
  if (alerts[key]?.timerId) {
    clearTimeout(alerts[key].timerId);
  }

  const delay = triggerAt.getTime() - Date.now();
  if (delay <= 0) return;

  const timerId = setTimeout(() => {
    _fireNotification(body, score);
    // Remove from storage after firing
    const current = getSavedAlerts();
    delete current[key];
    _saveAlerts(current);
  }, delay);

  alerts[key] = { key, date, body, score, triggerAt: triggerAt.toISOString(), timerId };
  _saveAlerts(alerts);
}

// ─────────────────────────────────────────
//  Cancel a scheduled alert
// ─────────────────────────────────────────
export function cancelAlert(key) {
  const alerts = getSavedAlerts();
  if (alerts[key]?.timerId) clearTimeout(alerts[key].timerId);
  delete alerts[key];
  _saveAlerts(alerts);
}

// ─────────────────────────────────────────
//  Fire the notification via SW registration or fallback
// ─────────────────────────────────────────
async function _fireNotification(body, score) {
  const title = 'TWILIGHT · דמדומים';
  const options = {
    body,
    icon: 'images/icon-192.png',
    badge: 'images/icon-192.png',
    dir: 'rtl',
    lang: 'he',
    tag: 'twilight-alert',
    data: { url: window.location.href },
  };

  // Prefer SW showNotification (works when app is backgrounded)
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) { reg.showNotification(title, options); return; }
    } catch { /* fall through */ }
  }

  // Fallback: direct Notification API
  if (Notification.permission === 'granted') {
    new Notification(title, options);
  }
}

// ─────────────────────────────────────────
//  Re-arm alerts from storage on app load
//  (restores setTimeout after page refresh)
// ─────────────────────────────────────────
export function rearmSavedAlerts() {
  const alerts = getSavedAlerts();
  const now = Date.now();
  const pruned = {};

  for (const [key, entry] of Object.entries(alerts)) {
    const triggerMs = new Date(entry.triggerAt).getTime();
    if (triggerMs <= now) continue; // already past, skip

    const timerId = setTimeout(() => {
      _fireNotification(entry.body, entry.score);
      const current = getSavedAlerts();
      delete current[key];
      _saveAlerts(current);
    }, triggerMs - now);

    pruned[key] = { ...entry, timerId };
  }

  _saveAlerts(pruned);
}
