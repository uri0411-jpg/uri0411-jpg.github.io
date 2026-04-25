// tests/streak.test.mjs
// Daily-rating streak counter — increment, reset, milestone unlocks.

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const _store = new Map();
globalThis.localStorage = {
  getItem(k) { return _store.get(k) ?? null; },
  setItem(k, v) { _store.set(k, String(v)); },
  removeItem(k) { _store.delete(k); },
  clear() { _store.clear(); },
};

const { recordRatingForStreak, getStreak, clearStreak } = await import('../js/streak.js');

beforeEach(() => { _store.clear(); });

test('first rating: current=1, best=1, no milestone', () => {
  const r = recordRatingForStreak('2026-04-20');
  assert.equal(r.current, 1);
  assert.equal(r.best, 1);
  assert.equal(r.unlocked, null);
});

test('consecutive days increment current', () => {
  recordRatingForStreak('2026-04-20');
  recordRatingForStreak('2026-04-21');
  const r = recordRatingForStreak('2026-04-22');
  assert.equal(r.current, 3);
  assert.equal(r.unlocked, 'streak3');
});

test('skipping a day resets current to 1, preserves best', () => {
  recordRatingForStreak('2026-04-20');
  recordRatingForStreak('2026-04-21');
  recordRatingForStreak('2026-04-22');
  const r = recordRatingForStreak('2026-04-25'); // gap
  assert.equal(r.current, 1);
  assert.equal(r.best, 3);
});

test('rating same day twice does not double-count', () => {
  recordRatingForStreak('2026-04-20');
  const r = recordRatingForStreak('2026-04-20');
  assert.equal(r.current, 1);
  assert.equal(r.alreadyCountedToday, true);
});

test('streak7 milestone fires on 7th day', () => {
  for (let d = 20; d <= 25; d++) recordRatingForStreak(`2026-04-${String(d).padStart(2,'0')}`);
  const r = recordRatingForStreak('2026-04-26');
  assert.equal(r.current, 7);
  assert.equal(r.unlocked, 'streak7');
});

test('clearStreak wipes state', () => {
  recordRatingForStreak('2026-04-20');
  clearStreak();
  const s = getStreak();
  assert.equal(s.current, 0);
  assert.equal(s.best, 0);
});
