// ═══════════════════════════════════════════
//  TWILIGHT — location.js
//  GPS detection and location persistence
// ═══════════════════════════════════════════

const LOC_KEY      = 'twl_location';
const MAX_AGE_MS   = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Check geolocation permission state without triggering a prompt.
 * Returns 'granted' | 'denied' | 'prompt' | 'unknown'
 */
export async function checkLocationPermission() {
  try {
    if (!navigator.permissions) return 'unknown';
    const status = await navigator.permissions.query({ name: 'geolocation' });
    return status.state;
  } catch { return 'unknown'; }
}

/** Wrap getCurrentPosition in a clean Promise */
function _geoPos(options) {
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      err => reject(err),
      options
    );
  });
}

/**
 * Get current GPS position with permission-aware timeouts.
 *  - 'denied'  → instant fallback (no 22-second wait)
 *  - 'granted' → short timeouts (6s high / 4s low)
 *  - 'prompt'  → longer timeouts (15s high / 8s low — user needs time for dialog)
 *
 * Returns { lat, lon, isFallback?, permDenied? }
 */
export async function getGPS() {
  if (!navigator.geolocation) {
    console.warn('[location] Geolocation not supported');
    return _fallbackLocation(false);
  }

  // Check permission state before calling getCurrentPosition
  const perm = await checkLocationPermission();

  if (perm === 'denied') {
    console.warn('[location] Geolocation permission denied — skipping GPS');
    return _fallbackLocation(true);
  }

  // Adaptive timeouts: granted = fast, prompt/unknown = patient
  const fast = perm === 'granted';
  const hiTimeout  = fast ? 6000  : 15000;
  const loTimeout  = fast ? 4000  : 8000;

  try {
    return await _geoPos({ timeout: hiTimeout, enableHighAccuracy: true });
  } catch (e) {
    console.warn('[location] High-accuracy GPS failed:', e.message);
  }

  try {
    return await _geoPos({ timeout: loTimeout, enableHighAccuracy: false });
  } catch (e) {
    console.warn('[location] Low-accuracy GPS failed:', e.message);
  }

  console.warn('[location] GPS failed entirely — using fallback');
  return _fallbackLocation(false);
}

/** Return saved location or Tel Aviv default */
function _fallbackLocation(permDenied) {
  const saved = loadLocation();
  if (saved) return { ...saved, permDenied };
  console.warn('[location] No saved location, defaulting to Tel Aviv (32.0853, 34.7818)');
  return { lat: 32.0853, lon: 34.7818, isFallback: true, permDenied };
}

/**
 * Save location + city name to localStorage
 * FIX: includes savedAt timestamp for staleness check
 */
export function saveLocation(lat, lon, city) {
  try {
    localStorage.setItem(LOC_KEY, JSON.stringify({ lat, lon, city, savedAt: Date.now() }));
  } catch (e) {
    console.warn('[location] saveLocation failed:', e);
  }
}

/**
 * Load saved location from localStorage
 * FIX: returns null if location is older than 24 hours
 * Returns { lat, lon, city } or null
 */
export function loadLocation() {
  try {
    const raw = localStorage.getItem(LOC_KEY);
    if (!raw) return null;
    const loc = JSON.parse(raw);
    if (typeof loc.lat !== 'number' || typeof loc.lon !== 'number') return null;

    // FIX: stale location check
    if (loc.savedAt && (Date.now() - loc.savedAt) > MAX_AGE_MS) {
      console.warn('[location] Saved location is older than 24h — ignoring');
      return null;
    }

    return loc;
  } catch (e) {
    return null;
  }
}

/**
 * Clear saved location
 */
export function clearLocation() {
  localStorage.removeItem(LOC_KEY);
}

// ─────────────────────────────────────────
//  Azimuth compass (Pulse 4)
//  Uses the DeviceOrientationEvent to compute the bearing delta between the
//  device's current heading and the direction of sunset.
//
//  Works across browsers:
//    – Android Chrome / Firefox: e.alpha gives magnetic heading (CCW from N)
//      → convert to CW: headingCW = (360 - alpha) % 360
//    – iOS Safari: e.webkitCompassHeading gives CW from magnetic N directly
//
//  delta > 0 → sunset is to the RIGHT of where you're facing
//  delta < 0 → sunset is to the LEFT
// ─────────────────────────────────────────

/**
 * Start watching the device orientation and report the angular delta
 * between the current heading and the sunset azimuth.
 *
 * @param {number}   sunsetAzimuthDeg  Sunset direction in degrees CW from geographic North.
 * @param {Function} onUpdate          Called with { delta, heading, sunsetAzimuth }.
 *
 * @returns {Function}  Cleanup function — call to stop watching.
 */
export function watchSunsetBearing(sunsetAzimuthDeg, onUpdate) {
  if (!window.DeviceOrientationEvent) return () => {};

  let lastUpdate = 0;

  function handleOrientation(e) {
    // Throttle to 4 fps — enough for smooth arrow, cheap on battery
    const now = Date.now();
    if (now - lastUpdate < 250) return;
    lastUpdate = now;

    let heading = null;

    if (e.webkitCompassHeading != null) {
      // iOS Safari — already CW from magnetic North
      heading = e.webkitCompassHeading;
    } else if (e.alpha != null) {
      // Android Chrome/Firefox — alpha is CCW from geographic North in [0, 360)
      heading = ((360 - e.alpha) % 360) || 0;
    }

    if (heading == null) return;

    // Angular delta: how many degrees to rotate to face the sunset
    let delta = sunsetAzimuthDeg - heading;
    if (delta >  180) delta -= 360;
    if (delta < -180) delta += 360;

    onUpdate({ delta, heading, sunsetAzimuth: sunsetAzimuthDeg });
  }

  window.addEventListener('deviceorientation', handleOrientation, true);
  return () => window.removeEventListener('deviceorientation', handleOrientation, true);
}

// ✎ rebuilt: getGPS — permission-aware (Permissions API), adaptive timeouts, instant denied fallback
// ✎ added: checkLocationPermission — non-triggering permission state check
// ✎ fixed: saveLocation — adds savedAt timestamp
// ✎ fixed: loadLocation — rejects locations older than 24h
// ✎ added: watchSunsetBearing — DeviceOrientation compass (Pulse 4)
// ✓ location.js — complete
