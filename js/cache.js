// ═══════════════════════════════════════════
//  TWILIGHT — cache.js
//  localStorage cache with TTL expiration
// ═══════════════════════════════════════════

const PREFIX = 'twl_';
export const CACHE_VERSION = 2; // Bumped to invalidate stale spotImages misses from v4 strict pipeline

/**
 * Store data with TTL.
 * Handles QuotaExceededError by clearing all cache and retrying once.
 * @returns {boolean} true on success, false if the entry was not persisted
 *                    (callers can use this to surface "offline / unable to cache" state).
 */
export function setCache(key, data, ttlMin) {
  const entry = {
    _v: CACHE_VERSION,
    data,
    created: Date.now(),
    expires: Date.now() + ttlMin * 60 * 1000
  };
  const value = JSON.stringify(entry);

  try {
    localStorage.setItem(PREFIX + key, value);
    return true;
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      console.warn('[cache] Storage full — clearing all cache and retrying');
      try {
        clearAll();
        localStorage.setItem(PREFIX + key, value);
        return true;
      } catch (e2) {
        console.warn('[cache] setCache failed even after clearAll:', e2);
        return false;
      }
    } else {
      console.warn('[cache] setCache failed:', e);
      return false;
    }
  }
}

/**
 * Retrieve data if not expired
 */
export function getCache(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    // Contract 5: hard reject on version mismatch
    if (entry._v !== CACHE_VERSION) {
      localStorage.removeItem(PREFIX + key);
      if (typeof window !== 'undefined' && window.__twl_debug) window.__twl_debug.cacheRejects++;
      return null;
    }
    if (Date.now() > entry.expires) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return entry.data;
  } catch (e) {
    return null;
  }
}

/**
 * Retrieve data even if expired (stale fallback for offline/error scenarios)
 */
export function getStaleCache(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    // Contract 5: hard reject on version mismatch
    if (entry._v !== CACHE_VERSION) {
      localStorage.removeItem(PREFIX + key);
      if (typeof window !== 'undefined' && window.__twl_debug) window.__twl_debug.cacheRejects++;
      return null;
    }
    return entry.data ?? null;
  } catch (e) {
    return null;
  }
}

/**
 * Remove a single cache entry by key.
 */
export function delCache(key) {
  try { localStorage.removeItem(PREFIX + key); } catch {}
}

/**
 * Remove all expired entries from localStorage
 */
export function clearExpired() {
  try {
    const keys = Object.keys(localStorage);
    for (const k of keys) {
      if (!k.startsWith(PREFIX)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        const entry = JSON.parse(raw);
        if (Date.now() > entry.expires) localStorage.removeItem(k);
      } catch {
        localStorage.removeItem(k);
      }
    }
  } catch (e) {
    console.warn('[cache] clearExpired failed:', e);
  }
}

/**
 * Clear ALL twilight cache entries
 */
export function clearAll() {
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(PREFIX));
    keys.forEach(k => localStorage.removeItem(k));
  } catch (e) {
    console.warn('[cache] clearAll failed:', e);
  }
}

/**
 * Returns age in minutes of a valid (non-expired) cache entry.
 * Returns null if missing, expired, or created before this field was added.
 */
export function getCacheAge(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() > entry.expires) return null;
    if (!entry.created) return null; // pre-v4 entry, no timestamp
    return Math.round((Date.now() - entry.created) / 60000);
  } catch { return null; }
}

/**
 * Returns stale cache data with age info, even if expired.
 * Used for stale-while-revalidate pattern.
 * @returns {{ data: any, ageMinutes: number, isExpired: boolean } | null}
 */
export function getStaleCacheWithAge(key) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw);
    // Contract 5: hard reject on version mismatch
    if (entry._v !== CACHE_VERSION) {
      localStorage.removeItem(PREFIX + key);
      if (typeof window !== 'undefined' && window.__twl_debug) window.__twl_debug.cacheRejects++;
      return null;
    }
    if (!entry.data) return null;
    const ageMinutes = entry.created ? Math.round((Date.now() - entry.created) / 60000) : null;
    const isExpired = Date.now() > entry.expires;
    return { data: entry.data, ageMinutes, isExpired };
  } catch { return null; }
}

// ─────────────────────────────────────────
//  Inflight request deduplication
//  Prevents duplicate concurrent fetches for the same cache key.
// ─────────────────────────────────────────
const _inflight = new Map();

/**
 * Deduplicate concurrent fetches: if a request for `key` is already in-flight,
 * returns the same promise instead of firing a second network call.
 */
export function fetchWithDedup(key, fetcher) {
  if (_inflight.has(key)) return _inflight.get(key);
  const promise = fetcher().finally(() => _inflight.delete(key));
  _inflight.set(key, promise);
  return promise;
}

// ─────────────────────────────────────────
//  Pub/Sub — SWR → UI reactivity
//  Subscribers are notified when background revalidation writes fresh data.
// ─────────────────────────────────────────
const _listeners = new Map();

/**
 * Subscribe to cache updates for a given key.
 * @returns {Function} unsubscribe
 */
export function subscribe(key, cb) {
  if (!_listeners.has(key)) _listeners.set(key, new Set());
  _listeners.get(key).add(cb);
  return () => _listeners.get(key)?.delete(cb);
}

function notify(key, data) {
  const cbs = _listeners.get(key);
  if (!cbs || cbs.size === 0) return;
  // Deep-clone the payload so that subscribers mutating the object (e.g. the
  // main-screen pipeline annotates dayData with skyColors/_isStale) cannot
  // pollute the value that a later JSON.stringify will serialise back into
  // localStorage via setCache.
  let snapshot;
  try { snapshot = JSON.parse(JSON.stringify(data)); }
  catch { snapshot = data; } // circular or non-JSON — fall back to live reference
  cbs.forEach(cb => { try { cb(snapshot); } catch (e) { console.warn('[cache] subscriber error:', e); } });
}

// ─────────────────────────────────────────
//  Stale-While-Revalidate (SWR) primitive
//  Always returns cached data immediately (even if stale), and
//  triggers a background revalidation when the entry has expired.
//
//  Returns a descriptor { data, isStale, revalidatePromise }.
//  Callers MUST wrap result.data in Promise.resolve() for consistent async API.
// ─────────────────────────────────────────

/**
 * @param {string}   key      Cache key (without prefix)
 * @param {Function} fetcher  Async function that returns fresh data
 * @param {number}   ttlMin   TTL in minutes for the new cache entry
 * @returns {{ data: any|null, isStale: boolean, revalidatePromise: Promise|null }}
 */
export function swr(key, fetcher, ttlMin) {
  const entry = getStaleCacheWithAge(key);

  if (entry?.data && !entry.isExpired) {
    // Fresh cache — serve directly, no revalidation
    return { data: entry.data, isStale: false, revalidatePromise: null };
  }

  if (entry?.data && entry.isExpired) {
    // Stale cache — serve immediately, revalidate in background
    const revalidatePromise = fetchWithDedup(key, async () => {
      const fresh = await fetcher();
      setCache(key, fresh, ttlMin);
      notify(key, fresh);
      return fresh;
    });
    return { data: entry.data, isStale: true, revalidatePromise };
  }

  // No cache at all — must fetch
  return {
    data: null,
    isStale: false,
    revalidatePromise: fetchWithDedup(key, async () => {
      const fresh = await fetcher();
      setCache(key, fresh, ttlMin);
      notify(key, fresh);
      return fresh;
    }),
  };
}

// ─────────────────────────────────────────
//  Zone cache freshness check
// ─────────────────────────────────────────

/**
 * Returns true if zone weather data exists and is not expired.
 */
export function isZoneCacheFresh(zoneId) {
  const key = `weather_zone_${zoneId}`;
  return getCacheAge(key) !== null;
}

// ✓ cache.js — complete
