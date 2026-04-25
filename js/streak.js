// ═══════════════════════════════════════════
//  TWILIGHT — streak.js
//  Tracks consecutive days the user has rated at least one sky event.
//  Persisted to localStorage under RATING_STREAK_KEY.
//
//  Shape:
//    { current: number, best: number, lastDate: 'YYYY-MM-DD' }
//
//  The streak resets if a calendar day is skipped. Multiple ratings on
//  the same day count as one streak day.
// ═══════════════════════════════════════════

import { RATING_STREAK_KEY } from './config.js';

function todayDateStr() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function dayDiff(a, b) {
  // Whole-day difference between YYYY-MM-DD strings (b - a).
  const ta = new Date(a + 'T12:00:00').getTime();
  const tb = new Date(b + 'T12:00:00').getTime();
  return Math.round((tb - ta) / 86400000);
}

function load() {
  try {
    const raw = localStorage.getItem(RATING_STREAK_KEY);
    if (!raw) return { current: 0, best: 0, lastDate: null };
    const data = JSON.parse(raw);
    return {
      current:  data.current  ?? 0,
      best:     data.best     ?? 0,
      lastDate: data.lastDate ?? null,
    };
  } catch {
    return { current: 0, best: 0, lastDate: null };
  }
}

function save(state) {
  try {
    localStorage.setItem(RATING_STREAK_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[streak] save failed:', e);
  }
}

/**
 * Record a rating for the given date and return the new streak state plus
 * a `unlocked` field naming any milestone this rating crossed (3 / 7 / 30).
 */
export function recordRatingForStreak(dateStr = todayDateStr()) {
  const s = load();

  if (s.lastDate === dateStr) {
    // Already counted today — no change
    return { ...s, unlocked: null, alreadyCountedToday: true };
  }

  if (s.lastDate == null) {
    s.current = 1;
  } else {
    const diff = dayDiff(s.lastDate, dateStr);
    if (diff === 1)      s.current += 1;
    else if (diff === 0) {/* same day — no-op */}
    else                 s.current = 1; // skipped one or more days → reset
  }

  s.lastDate = dateStr;
  if (s.current > s.best) s.best = s.current;

  let unlocked = null;
  if (s.current === 3)       unlocked = 'streak3';
  else if (s.current === 7)  unlocked = 'streak7';
  else if (s.current === 30) unlocked = 'streak30';

  save(s);
  return { ...s, unlocked, alreadyCountedToday: false };
}

export function getStreak() {
  const s = load();
  // Auto-reset if more than 1 day has passed since lastDate
  if (s.lastDate) {
    const diff = dayDiff(s.lastDate, todayDateStr());
    if (diff > 1) {
      const reset = { current: 0, best: s.best, lastDate: s.lastDate };
      return reset; // do not write — only writes on next rating
    }
  }
  return s;
}

export function clearStreak() {
  try { localStorage.removeItem(RATING_STREAK_KEY); }
  catch (e) { console.warn('[streak] clear failed:', e); }
}

// ✓ streak.js — complete
