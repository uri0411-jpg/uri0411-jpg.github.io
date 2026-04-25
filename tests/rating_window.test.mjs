// tests/rating_window.test.mjs
// Verifies RATING_WINDOWS_MIN constants enforce correct event-rating bounds.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { RATING_WINDOWS_MIN, DUSK_OFFSET_MIN, EVENT_TYPES } = await import('../js/config.js');

// Mirror of main-screen.js _isInRatingWindow
function _isInRatingWindow(eventTime, eventType, now) {
  const w = RATING_WINDOWS_MIN[eventType];
  if (!w) return false;
  const start = eventTime.getTime() + w.start * 60 * 1000;
  const end   = eventTime.getTime() + w.end   * 60 * 1000;
  return now.getTime() >= start && now.getTime() <= end;
}

test('all event types have a window', () => {
  for (const ev of EVENT_TYPES) {
    assert.ok(RATING_WINDOWS_MIN[ev], `Missing window for ${ev}`);
    assert.ok(typeof RATING_WINDOWS_MIN[ev].start === 'number');
    assert.ok(typeof RATING_WINDOWS_MIN[ev].end   === 'number');
  }
});

test('sunset window opens before T_event and closes 4h after', () => {
  const t = new Date('2026-04-25T17:00:00Z');
  // 5 minutes before
  const before = new Date(t.getTime() - 5 * 60_000);
  assert.equal(_isInRatingWindow(t, 'sunset', before), true,
    'should be in window 5 min before sunset (start = -30)');
  // 5h after — outside
  const after = new Date(t.getTime() + 5 * 3600 * 1000);
  assert.equal(_isInRatingWindow(t, 'sunset', after), false,
    'should be out 5h after sunset');
  // 1 hour after — inside
  const oneHour = new Date(t.getTime() + 3600 * 1000);
  assert.equal(_isInRatingWindow(t, 'sunset', oneHour), true);
});

test('dusk window: open 5 min before T_dusk → closes 3h after', () => {
  const sunset = new Date('2026-04-25T17:00:00Z');
  const dusk   = new Date(sunset.getTime() + DUSK_OFFSET_MIN * 60_000);
  // Right at sunset time → 25 min before dusk → outside dusk window
  assert.equal(_isInRatingWindow(dusk, 'dusk', sunset), false);
  // 30 min after sunset = 5 min after dusk → in window
  const fivePast = new Date(sunset.getTime() + 30 * 60_000);
  assert.equal(_isInRatingWindow(dusk, 'dusk', fivePast), true);
});

test('window has positive duration', () => {
  for (const ev of EVENT_TYPES) {
    const w = RATING_WINDOWS_MIN[ev];
    assert.ok(w.end > w.start, `${ev}: end (${w.end}) must exceed start (${w.start})`);
  }
});

test('sunrise allows rating up to 4 hours after', () => {
  const sr = new Date('2026-04-25T03:30:00Z');
  const t3h = new Date(sr.getTime() + 3 * 3600 * 1000);
  const t5h = new Date(sr.getTime() + 5 * 3600 * 1000);
  assert.equal(_isInRatingWindow(sr, 'sunrise', t3h), true);
  assert.equal(_isInRatingWindow(sr, 'sunrise', t5h), false);
});

test('exact start/end boundaries are inclusive', () => {
  const t = new Date('2026-04-25T17:00:00Z');
  const w = RATING_WINDOWS_MIN.sunset;
  const startBoundary = new Date(t.getTime() + w.start * 60_000);
  const endBoundary   = new Date(t.getTime() + w.end   * 60_000);
  assert.equal(_isInRatingWindow(t, 'sunset', startBoundary), true);
  assert.equal(_isInRatingWindow(t, 'sunset', endBoundary), true);
});
