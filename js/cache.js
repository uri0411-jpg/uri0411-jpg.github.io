// ═══════════════════════════════════════════
//  TWILIGHT — cache.js
//  localStorage cache with TTL expiration
// ═══════════════════════════════════════════

const PREFIX = 'twl_';

/**
 * Store data with TTL
 * FIX: handles QuotaExceededError by clearing all cache and retrying
 */
export function setCache(key, data, ttlMin) {
  const entry = {
    data,
    created: Date.now(),
    expires: Date.now() + ttlMin * 60 * 1000
  };
  const value = JSON.stringify(entry);

  try {
    localStorage.setItem(PREFIX + key, value);
  } catch (e) {
    if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      console.warn('[cache] Storage full — clearing all cache and retrying');
      try {
        clearAll();
        localStorage.setItem(PREFIX + key, value);
      } catch (e2) {
        console.warn('[cache] setCache failed even after clearAll:', e2);
      }
    } else {
      console.warn('[cache] setCache failed:', e);
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
    return JSON.parse(raw).data ?? null;
  } catch (e) {
    return null;
  }
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
    if (!entry.data) return null;
    const ageMinutes = entry.created ? Math.round((Date.now() - entry.created) / 60000) : null;
    const isExpired = Date.now() > entry.expires;
    return { data: entry.data, ageMinutes, isExpired };
  } catch { return null; }
}

// ✓ cache.js — complete
