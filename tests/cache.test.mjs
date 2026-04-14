import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── localStorage polyfill for Node.js ────────────────────────────────────────
const _store = new Map();
globalThis.localStorage = {
  getItem(k)    { return _store.get(k) ?? null; },
  setItem(k, v) { _store.set(k, String(v)); },
  removeItem(k) { _store.delete(k); },
  clear()       { _store.clear(); },
  get length()  { return _store.size; },
  key(i)        { return [..._store.keys()][i] ?? null; },
};
// Object.keys(localStorage) compatibility
Object.defineProperty(globalThis.localStorage, Symbol.iterator, {
  value: function* () { yield* _store.keys(); },
});
// Make Object.keys work on localStorage
const origKeys = Object.keys;
Object.keys = function(obj) {
  if (obj === globalThis.localStorage) return [..._store.keys()];
  return origKeys(obj);
};

// ── window stub for __twl_debug ──────────────────────────────────────────────
globalThis.window = globalThis.window || {};

// Import AFTER polyfill
const { setCache, getCache, getStaleCache, getCacheAge, getStaleCacheWithAge,
        clearExpired, clearAll, fetchWithDedup, subscribe, swr, isZoneCacheFresh
      } = await import('../js/cache.js');

beforeEach(() => {
  _store.clear();
});

// ── setCache / getCache ──────────────────────────────────────────────────────

test('setCache + getCache: stores and retrieves data', () => {
  setCache('test1', { a: 1 }, 60);
  const result = getCache('test1');
  assert.deepEqual(result, { a: 1 });
});

test('getCache: returns null for missing key', () => {
  assert.equal(getCache('nonexistent'), null);
});

test('getCache: returns null for expired entry', () => {
  // Inject an entry that expired 1 second ago
  const entry = { _v: 1, data: { x: 1 }, created: Date.now() - 120000, expires: Date.now() - 1000 };
  _store.set('twl_expired', JSON.stringify(entry));
  const result = getCache('expired');
  assert.equal(result, null);
});

test('setCache: overwrites previous value', () => {
  setCache('overwrite', 'old', 60);
  setCache('overwrite', 'new', 60);
  assert.equal(getCache('overwrite'), 'new');
});

// ── getStaleCache ────────────────────────────────────────────────────────────

test('getStaleCache: returns data even if expired', () => {
  const entry = { _v: 1, data: { v: 42 }, created: Date.now() - 120000, expires: Date.now() - 1000 };
  _store.set('twl_stale1', JSON.stringify(entry));
  const result = getStaleCache('stale1');
  assert.deepEqual(result, { v: 42 });
});

test('getStaleCache: returns null for missing key', () => {
  assert.equal(getStaleCache('missing'), null);
});

// ── getCacheAge ──────────────────────────────────────────────────────────────

test('getCacheAge: returns age in minutes for fresh entry', () => {
  setCache('age1', 'data', 60);
  const age = getCacheAge('age1');
  assert.equal(typeof age, 'number');
  assert.ok(age >= 0 && age <= 1, `age should be ~0 minutes, got ${age}`);
});

test('getCacheAge: returns null for expired entry', () => {
  const entry = { _v: 1, data: 'data', created: Date.now() - 120000, expires: Date.now() - 1000 };
  _store.set('twl_age-exp', JSON.stringify(entry));
  assert.equal(getCacheAge('age-exp'), null);
});

test('getCacheAge: returns null for missing key', () => {
  assert.equal(getCacheAge('age-miss'), null);
});

// ── getStaleCacheWithAge ─────────────────────────────────────────────────────

test('getStaleCacheWithAge: returns data + metadata for fresh entry', () => {
  setCache('swa1', { d: 1 }, 60);
  const result = getStaleCacheWithAge('swa1');
  assert.ok(result);
  assert.deepEqual(result.data, { d: 1 });
  assert.equal(result.isExpired, false);
  assert.equal(typeof result.ageMinutes, 'number');
});

test('getStaleCacheWithAge: marks expired entries', () => {
  const entry = { _v: 1, data: { d: 2 }, created: Date.now() - 120000, expires: Date.now() - 1000 };
  _store.set('twl_swa2', JSON.stringify(entry));
  const result = getStaleCacheWithAge('swa2');
  assert.ok(result);
  assert.deepEqual(result.data, { d: 2 });
  assert.equal(result.isExpired, true);
});

test('getStaleCacheWithAge: returns null for missing key', () => {
  assert.equal(getStaleCacheWithAge('swa-miss'), null);
});

// ── Version mismatch ─────────────────────────────────────────────────────────

test('getCache: rejects entry with wrong version', () => {
  // Manually inject an entry with wrong version
  const entry = { _v: 999, data: 'old', created: Date.now(), expires: Date.now() + 60000 };
  _store.set('twl_vtest', JSON.stringify(entry));
  assert.equal(getCache('vtest'), null);
  // Entry should be removed
  assert.equal(_store.has('twl_vtest'), false);
});

test('getStaleCache: rejects entry with wrong version', () => {
  const entry = { _v: 0, data: 'old', created: Date.now(), expires: Date.now() + 60000 };
  _store.set('twl_vtest2', JSON.stringify(entry));
  assert.equal(getStaleCache('vtest2'), null);
});

// ── clearExpired ─────────────────────────────────────────────────────────────

test('clearExpired: removes expired entries, keeps fresh', () => {
  setCache('keep', 'fresh', 60);
  // Inject expired entry
  const entry = { _v: 1, data: 'stale', created: Date.now() - 120000, expires: Date.now() - 1000 };
  _store.set('twl_remove', JSON.stringify(entry));
  clearExpired();
  assert.ok(getStaleCache('keep'));
  assert.equal(_store.has('twl_remove'), false);
});

test('clearExpired: ignores non-twilight keys', () => {
  _store.set('other_app', 'data');
  setCache('mine', 'data', 0);
  clearExpired();
  assert.equal(_store.get('other_app'), 'data');
});

// ── clearAll ─────────────────────────────────────────────────────────────────

test('clearAll: removes all twl_ keys', () => {
  setCache('a', 1, 60);
  setCache('b', 2, 60);
  _store.set('other', 'keep');
  clearAll();
  assert.equal(_store.has('twl_a'), false);
  assert.equal(_store.has('twl_b'), false);
  assert.equal(_store.get('other'), 'keep');
});

// ── fetchWithDedup ───────────────────────────────────────────────────────────

test('fetchWithDedup: deduplicates concurrent calls', async () => {
  let callCount = 0;
  const fetcher = async () => { callCount++; return 'result'; };
  const p1 = fetchWithDedup('dedup1', fetcher);
  const p2 = fetchWithDedup('dedup1', fetcher);
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 'result');
  assert.equal(r2, 'result');
  assert.equal(callCount, 1, 'fetcher should only be called once');
});

test('fetchWithDedup: allows new call after previous completes', async () => {
  let callCount = 0;
  const fetcher = async () => { callCount++; return callCount; };
  await fetchWithDedup('dedup2', fetcher);
  const result = await fetchWithDedup('dedup2', fetcher);
  assert.equal(result, 2);
  assert.equal(callCount, 2);
});

test('fetchWithDedup: cleans up on error', async () => {
  let attempt = 0;
  const fetcher = async () => {
    attempt++;
    if (attempt === 1) throw new Error('fail');
    return 'ok';
  };
  await assert.rejects(() => fetchWithDedup('dedup3', fetcher));
  // Should allow retry after failure
  const result = await fetchWithDedup('dedup3', fetcher);
  assert.equal(result, 'ok');
});

// ── subscribe ────────────────────────────────────────────────────────────────

test('subscribe: callback receives data on notify', async () => {
  let received = null;
  const unsub = subscribe('sub1', (data) => { received = data; });

  // Inject expired cache → SWR will revalidate in background
  const entry = { _v: 1, data: 'old', created: Date.now() - 120000, expires: Date.now() - 1000 };
  _store.set('twl_sub1', JSON.stringify(entry));
  const fetcher = async () => 'fresh-data';
  const { revalidatePromise } = swr('sub1', fetcher, 60);
  await revalidatePromise;

  assert.equal(received, 'fresh-data');
  unsub();
});

test('subscribe: unsubscribe prevents further callbacks', async () => {
  let count = 0;
  const unsub = subscribe('sub2', () => count++);
  unsub();

  setCache('sub2', 'old', 0);
  const { revalidatePromise } = swr('sub2', async () => 'new', 60);
  await revalidatePromise;

  assert.equal(count, 0, 'callback should not fire after unsubscribe');
});

// ── swr ──────────────────────────────────────────────────────────────────────

test('swr: fresh cache returns data immediately, no revalidation', () => {
  setCache('swr1', 'cached', 60);
  const result = swr('swr1', async () => 'fresh', 60);
  assert.equal(result.data, 'cached');
  assert.equal(result.isStale, false);
  assert.equal(result.revalidatePromise, null);
});

test('swr: no cache returns null + revalidatePromise', async () => {
  const result = swr('swr-miss', async () => 'fetched', 60);
  assert.equal(result.data, null);
  assert.equal(result.isStale, false);
  assert.ok(result.revalidatePromise instanceof Promise);
  const fresh = await result.revalidatePromise;
  assert.equal(fresh, 'fetched');
});

test('swr: stale cache returns data + isStale + revalidatePromise', async () => {
  // Inject expired cache
  const entry = { _v: 1, data: 'old-data', created: Date.now() - 120000, expires: Date.now() - 1000 };
  _store.set('twl_swr-stale', JSON.stringify(entry));
  const result = swr('swr-stale', async () => 'new-data', 60);
  assert.equal(result.data, 'old-data');
  assert.equal(result.isStale, true);
  assert.ok(result.revalidatePromise instanceof Promise);
  const fresh = await result.revalidatePromise;
  assert.equal(fresh, 'new-data');
  // Cache should now be updated
  assert.equal(getCache('swr-stale'), 'new-data');
});

// ── isZoneCacheFresh ─────────────────────────────────────────────────────────

test('isZoneCacheFresh: returns true for fresh zone cache', () => {
  setCache('weather_zone_coast-tlv', { temp: 25 }, 60);
  assert.equal(isZoneCacheFresh('coast-tlv'), true);
});

test('isZoneCacheFresh: returns false for missing zone cache', () => {
  assert.equal(isZoneCacheFresh('nonexistent-zone'), false);
});

test('isZoneCacheFresh: returns false for expired zone cache', () => {
  const entry = { _v: 1, data: { temp: 20 }, created: Date.now() - 120000, expires: Date.now() - 1000 };
  _store.set('twl_weather_zone_expired-zone', JSON.stringify(entry));
  assert.equal(isZoneCacheFresh('expired-zone'), false);
});

// ── Corrupted data ───────────────────────────────────────────────────────────

test('getCache: handles corrupted JSON gracefully', () => {
  _store.set('twl_corrupt', '{invalid json');
  assert.equal(getCache('corrupt'), null);
});

test('getStaleCache: handles corrupted JSON gracefully', () => {
  _store.set('twl_corrupt2', 'not-json');
  assert.equal(getStaleCache('corrupt2'), null);
});
