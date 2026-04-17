// ═══════════════════════════════════════════
//  TWILIGHT — spots-screen.js v6
//  MapLibre GL JS vector map, haptic
// ═══════════════════════════════════════════

import { fetchSpots, fetchCityName } from './api.js';
import { loadLocation, getGPS, saveLocation, checkLocationPermission } from './location.js';
import { scoreToSkyBg, scoreToBarStyle, scoreToSkyColor, scoreToLabel, distKm, addMinutes, calcSolarAzimuth, destPoint, getWatercolorBg } from './utils.js';
import { showToast, showLoading, logoImg, esc, getCardBgLuma } from './ui.js';
import { haptic } from './nav.js';
import { decide } from './engine/decisionEngine.js';
import { fetchSpotImage, invalidateSpotImage, pickGenericSunset, rejectSpotImageUrl, getStaticMapForSpot, subscribeSpotImage } from './spotImages.js';
import { initLocationSearch } from './locationSearch.js';

let _spots        = [];
let _sortMode     = 'score';
let _filterType   = 'all';
let _radiusKm     = 25;
// Pre-load cache
let _preloadedSpots       = null;
let _preloadedForLat      = null;
let _preloadedForLon      = null;
let _preloadedForRadius   = null;
let _preloadedForWeekData = null;
let _map          = null;
let _mapEl        = null; // detachable map container element
let _userMarker   = null;
let _markers      = [];
let _markerSpotMap = {};
let _popupHandlerRegistered = false;
let _mapStyleLoaded = false; // tracks whether MapLibre style 'load' has fired
let _loc          = null;
let _weekData     = null;
let _favorites    = loadFavorites();
let _visited      = loadVisited();
let _mlReady      = false;
let _visibleCount = 15;
let _loadingSpots = false; // guard against parallel loadSpots() calls
let _searchCleanup = null;
let _spotsWorker   = null; // lazy-init Web Worker for location quality
let _extendedMode  = false; // true when user clicked "הצג 15 נוספים"
let _loadingMore   = false; // guard against parallel "load more" taps

// ─────────────────────────────────────────
//  Spots quality Worker — offloads calcLocationQuality × N to a background thread.
//  Falls back to batched setTimeout if Workers are unavailable.
// ─────────────────────────────────────────
function _getSpotsWorker() {
  if (_spotsWorker) return _spotsWorker;
  try {
    _spotsWorker = new Worker('./js/workers/spotsWorker.js');
  } catch {
    _spotsWorker = null;
  }
  return _spotsWorker;
}

/**
 * Score spots' location quality using the Worker (or sync fallback).
 * Mutates each spot with _locationQualitySunset, _locationQualitySunrise, _driveMin.
 * @param {Array} spots       — array of spot objects (must have _bearing, _horizonWarning set)
 * @param {number} sunsetAz   — sunset azimuth in degrees
 * @returns {Promise<void>}
 */
function computeLocationQualityBatch(spots, sunsetAz) {
  const worker = _getSpotsWorker();
  if (worker) {
    return new Promise((resolve) => {
      // Prepare minimal transferable data (only fields the worker needs)
      const payload = spots.map(s => ({
        elevation: s.elevation,
        type:      s.type,
        lon:       s.lon,
        dist:      s.dist,
        _bearing:  s._bearing,
        _horizonWarning: s._horizonWarning,
      }));
      const handler = (e) => {
        worker.removeEventListener('message', handler);
        const { results } = e.data;
        for (const r of results) {
          spots[r.idx]._locationQualitySunset  = r.sunset;
          spots[r.idx]._locationQualitySunrise = r.sunrise;
          spots[r.idx]._driveMin               = r.driveMin;
        }
        resolve();
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ spots: payload, sunsetAzimuth: sunsetAz });
    });
  }

  // Fallback: batched setTimeout (avoids blocking main thread for large arrays)
  return new Promise((resolve) => {
    const BATCH = 50;
    let i = 0;
    function processBatch() {
      const end = Math.min(i + BATCH, spots.length);
      for (; i < end; i++) {
        const s = spots[i];
        s._locationQualitySunset  = calcLocationQuality(s, s._bearing, 'sunset');
        s._locationQualitySunrise = calcLocationQuality(s, s._bearing, 'sunrise');
        s._driveMin               = estimateDriveMin(s.dist || 0);
      }
      if (i < spots.length) {
        setTimeout(processBatch, 0);
      } else {
        resolve();
      }
    }
    processBatch();
  });
}

// ─────────────────────────────────────────
//  Lazy-load MapLibre GL JS CSS + JS on demand
//  Bundled locally → served cache-first by SW (no CDN latency)
// ─────────────────────────────────────────
let _mlLoadPromise = null; // dedup guard — only one load in-flight
export function warmMapLibre() { return loadMapLibre().catch(() => {}); }
function loadMapLibre() {
  if (_mlReady || typeof maplibregl !== 'undefined') { _mlReady = true; return Promise.resolve(); }
  if (_mlLoadPromise) return _mlLoadPromise;
  _mlLoadPromise = new Promise((resolve, reject) => {
    // CSS — only add if not already in DOM
    if (!document.querySelector('link[href*="maplibre-gl.css"]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = './css/maplibre-gl.css';
      document.head.appendChild(link);
    }

    // JS — only add if not already in DOM
    if (document.querySelector('script[src*="vendor/maplibre-gl"]')) {
      _mlReady = true; resolve(); return;
    }
    const script = document.createElement('script');
    script.src = './js/vendor/maplibre-gl.js';
    script.onload  = () => { _mlReady = true; resolve(); };
    script.onerror = () => { _mlLoadPromise = null; reject(new Error('MapLibre load failed')); };
    document.head.appendChild(script);
  });
  return _mlLoadPromise;
}

// ─── Favorites ───────────────────────────
const FAV_KEY = 'twl_fav_spots';
function loadFavorites() { try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch { return []; } }
function saveFavorites() { try { localStorage.setItem(FAV_KEY, JSON.stringify(_favorites)); } catch {} }
function isFavorite(name, lat, lon) { return _favorites.some(f => f.name === name && Math.abs(f.lat - lat) < 0.001); }
function toggleFavorite(name, lat, lon) {
  const idx = _favorites.findIndex(f => f.name === name && Math.abs(f.lat - lat) < 0.001);
  if (idx >= 0) _favorites.splice(idx, 1); else _favorites.push({ name, lat, lon });
  saveFavorites();
}

// ─── Visited ────────────────────────────
const VIS_KEY = 'twl_visited_spots';
function loadVisited() { try { return JSON.parse(localStorage.getItem(VIS_KEY)) || []; } catch { return []; } }
function saveVisited() { try { localStorage.setItem(VIS_KEY, JSON.stringify(_visited)); } catch {} }
function isVisited(name, lat, lon) { return _visited.some(v => v.name === name && Math.abs(v.lat - lat) < 0.001); }
function toggleVisited(name, lat, lon) {
  const idx = _visited.findIndex(v => v.name === name && Math.abs(v.lat - lat) < 0.001);
  if (idx >= 0) _visited.splice(idx, 1);
  else _visited.push({ name, lat, lon, date: new Date().toISOString().slice(0, 10) });
  saveVisited();
}

// ─── Type icons ──────────────────────────
const TYPE_ICONS = {
  'פסגה': `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8 21l4-11 4 11"/><path d="M2 21h20"/><path d="M12 6l2 4"/></svg>`,
  'נקודת תצפית': `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="5" r="3"/><path d="M5 21l3-12h8l3 12"/></svg>`,
  'מצוק': `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 21V8l5-5 4 7 5-3 4 4v10H3z"/></svg>`,
  'חוף': `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 20c2-1 4-1 6 0s4 1 6 0 4-1 6 0"/><path d="M2 17c2-1 4-1 6 0s4 1 6 0 4-1 6 0"/><circle cx="16" cy="6" r="3"/></svg>`,
};
function getTypeIcon(type) { return TYPE_ICONS[type] || TYPE_ICONS['נקודת תצפית']; }

// ─── Compass arrow ───────────────────────
function compassArrow(bearing) {
  return `<svg class="spot-compass" width="20" height="20" viewBox="0 0 24 24" style="transform:rotate(${bearing}deg)">
    <path d="M12 2l3 8h-6l3-8z" fill="var(--gold-light)" opacity="0.9"/>
    <path d="M12 22l-3-8h6l-3 8z" fill="var(--cream-faint)" opacity="0.4"/>
    <circle cx="12" cy="12" r="2" fill="none" stroke="var(--cream-faint)" stroke-width="1"/>
  </svg>`;
}

// ─── Bearing / azimuth ───────────────────
function calcBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const la1 = lat1 * Math.PI / 180, la2 = lat2 * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360;
}
function isWestFacing(b) { return b >= 210 && b <= 330; }
function isEastFacing(b) { return b >= 30 && b <= 150; }

function getSunsetAzimuth() {
  // Use accurate solar azimuth at today's sunset if weekData is available
  const today = _weekData?.[0];
  if (today?.sunset && _loc?.lat) {
    const [h, m] = today.sunset.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return calcSolarAzimuth(_loc.lat, _loc.lon, d);
  }
  // Fallback: seasonal approximation
  const month = new Date().getMonth() + 1;
  if (month >= 5 && month <= 8) return 295;
  if (month >= 11 || month <= 2) return 245;
  return 270;
}
function getNextEvent() {
  const today = _weekData?.[0];
  if (!today?.sunrise || !today?.sunset) return { type: 'sunset', azimuth: getSunsetAzimuth() };
  const now = new Date();
  const [srH, srM] = today.sunrise.split(':').map(Number);
  const [ssH, ssM] = today.sunset.split(':').map(Number);
  const sunriseTime = new Date(); sunriseTime.setHours(srH, srM, 0, 0);
  const sunsetTime  = new Date(); sunsetTime.setHours(ssH, ssM, 0, 0);
  const ssAz = getSunsetAzimuth();
  const srAz = (ssAz + 180) % 360;
  if (now < sunriseTime) return { type: 'sunrise', azimuth: srAz };
  if (now < sunsetTime)  return { type: 'sunset',  azimuth: ssAz };
  return { type: 'sunrise', azimuth: srAz }; // after sunset → next is sunrise
}

function azimuthBonus(bearing, idealAz) {
  const diff = Math.abs(bearing - idealAz);
  const norm = diff > 180 ? 360 - diff : diff;
  if (norm <= 30) return 0.15;
  if (norm <= 60) return 0.07;
  return 0;
}

// ─── Helpers ─────────────────────────────
function estimateDriveMin(dist) {
  if (dist <= 3)  return Math.round(dist * 3);
  if (dist <= 15) return Math.round(dist * 2.2);
  return Math.round(dist * 1.5);
}
function calcDepartureTime(driveMin, eventTime, eventType) {
  if (!eventTime || eventTime === '--:--') return null;
  const buffer = eventType === 'sunrise' ? 15 : 30;
  return addMinutes(eventTime, -(driveMin + buffer));
}
function isWesternCoastBeach(spot) { return spot.type === 'חוף' && spot.lon < 34.75; }
function spotKey(name, lat) { return name + '|' + Math.round(lat * 1000); }

function bearingToHeb(b) {
  if (b >= 337 || b < 23)  return 'צפון';
  if (b < 68)  return 'צפון-מזרח';
  if (b < 113) return 'מזרח';
  if (b < 158) return 'דרום-מזרח';
  if (b < 203) return 'דרום';
  if (b < 248) return 'דרום-מערב';
  if (b < 293) return 'מערב';
  return 'צפון-מערב';
}

// ─── Format decimal score ────────────────
function fmtScore(v) { return v.toFixed(1); }

// ─── Spot Potential (1-5 stars) ──────────
// Based on location traits + next event direction
function calcSpotPotential(spot, bearing) {
  let p = 2.0; // baseline
  const elev = spot.elevation || 0;
  // Elevation
  if (elev > 600) p += 1.2;
  else if (elev > 300) p += 0.8;
  else if (elev > 150) p += 0.4;
  // Azimuth for next event
  const idealAz = getNextEvent().azimuth;
  const diff = Math.abs(bearing - idealAz);
  const norm = diff > 180 ? 360 - diff : diff;
  if (norm <= 25) p += 1.0;
  else if (norm <= 50) p += 0.5;
  // Type
  if (isWesternCoastBeach(spot)) p += 0.6;
  else if (spot.type === 'חוף') p += 0.2;
  if (spot.type === 'נקודת תצפית') p += 0.4;
  if (spot.type === 'מצוק') p += 0.3;

  return Math.max(1, Math.min(5, Math.round(p * 2) / 2)); // round to 0.5
}

// ─── Location Quality Score (1-100) ──────────────────────────────────────────
// Rates the geographic quality of a spot for a specific event (sunset/sunrise).
// Pure geography — independent of weather conditions.
//
// Scoring (100 pts total):
//   A. Direction alignment to sun azimuth  30 pts  (event-specific, inverted between events)
//   B. Horizon clearance quality           25 pts  (terrain type + obstruction warning)
//   C. Elevation above cloud layer         20 pts  (cleaner air, above low cloud)
//   D. Accessibility from user location    15 pts  (estimated drive time)
//   E. Terrain / landscape suitability    10 pts  (coast bonus for relevant event)
function calcLocationQuality(spot, bearing, mode = 'sunset') {
  const elev = spot.elevation ?? 0;

  // Target azimuth: sunset faces west, sunrise faces opposite (east)
  const ssAz     = getSunsetAzimuth();
  const targetAz = mode === 'sunrise' ? (ssAz + 180) % 360 : ssAz;
  const diff     = Math.abs(bearing - targetAz);
  const norm     = diff > 180 ? 360 - diff : diff;

  // A. Direction — 30 pts (most important factor, event-specific)
  const dirPts = norm <= 10 ? 30 : norm <= 25 ? 24 : norm <= 45 ? 16
               : norm <= 70 ?  8 : norm <= 100 ?  2 : 0;

  // B. Horizon quality — 25 pts (open sky toward event direction)
  const hasWarning = !!spot._horizonWarning;
  const horizPts = hasWarning ? 0
    : (isWesternCoastBeach(spot) && mode === 'sunset') ? 25
    : spot.type === 'מצוק'         ? 20
    : spot.type === 'פסגה'         ? 16
    : spot.type === 'נקודת תצפית' ? 14
    : spot.type === 'חוף'          ? 12 : 5;

  // C. Elevation — 20 pts (above marine boundary layer + cleaner air)
  const elevPts = elev >= 800 ? 20 : elev >= 500 ? 16 : elev >= 300 ? 11
               : elev >= 150 ?  7 : elev >= 50  ?  3 : 0;

  // D. Accessibility — 15 pts (estimated drive time from user)
  const driveMin  = estimateDriveMin(spot.dist || 0);
  const accessPts = driveMin < 10 ? 15 : driveMin < 20 ? 12
                  : driveMin < 35 ?  8 : driveMin < 60 ?  4 : 1;

  // E. Terrain type — 10 pts (landscape suitability, coast bonus is event-specific)
  const typePts = (isWesternCoastBeach(spot) && mode === 'sunset') ? 10
                : spot.type === 'מצוק'         ?  8
                : spot.type === 'נקודת תצפית'  ?  8
                : spot.type === 'פסגה'          ?  6
                : spot.type === 'חוף'           ?  3 : 1;

  return Math.max(1, Math.min(100, dirPts + horizPts + elevPts + accessPts + typePts));
}

// ─── Stars HTML ──────────────────────────
function starsHTML(potential) {
  const full = Math.floor(potential);
  const half = (potential % 1) >= 0.5;
  let html = '';
  for (let i = 0; i < full; i++) html += '★';
  if (half) html += '½';
  return `<span class="spot-potential-stars">${html}</span>`;
}

// ═════════════════════════════════════════
//  SCORING
// ═════════════════════════════════════════
// Sky quality (ss/sr/tw/combined) = day.score from the physics engine.
// The atmosphere is the same at every spot — only location quality differs.
// Location quality is handled separately via _locationQualitySunset / _locationQualitySunrise.
function calcSpotScores(spot, weekData, userLat, userLon) {
  const bearing = calcBearing(userLat, userLon, spot.lat, spot.lon);
  spot._bearing = bearing;
  spot._potential = calcSpotPotential(spot, bearing);

  const days = (weekData || []).slice(0, 5).map(day => {
    if (!day) return { ss: 5.0, sr: 5.0, tw: 5.0, combined: 5.0 };
    return {
      ss:       Math.round((day.ssScore ?? day.score ?? 5.0) * 10) / 10,
      sr:       Math.round((day.srScore ?? day.score ?? 5.0) * 10) / 10,
      tw:       Math.round((day.twScore ?? day.score ?? 5.0) * 10) / 10,
      combined: Math.round((day.score   ?? 5.0)              * 10) / 10,
    };
  });

  return days.length ? days : [{ ss: 5.0, sr: 5.0, tw: 5.0, combined: 5.0 }];
}

// ─── Per-day sky quality for main-screen display ────────────────────────────
// Sky quality is uniform across all spots (same atmosphere), so return the
// physics scores from weekData directly — no spot averaging needed.
export function calcNearbyAvgScore(spots, weekData) {
  if (!weekData?.length) return null;
  return weekData.slice(0, 5).map(d => Math.round((d.score ?? 5.0) * 10) / 10);
}

// ─── Per-spot prep: scores + horizon warnings. Uses module _weekData/_loc. ───
function _prepSpot(s, weekData = _weekData, lat = _loc?.lat, lon = _loc?.lon) {
  s._allScores = calcSpotScores(s, weekData, lat, lon);
  const inland      = s.lon > 34.92;
  const lowElev     = s.elevation !== null && s.elevation < 60;
  const unknownElev = s.elevation === null && s.lon > 35.0;
  if (inland && s.type !== 'חוף' && (lowElev || unknownElev)) {
    s._horizonWarning = lowElev
      ? 'גובה נמוך — בדוק ראות מערבית'
      : 'גובה לא ידוע — בדוק ראות מערבית';
  }
}

// ─── Background pre-load (called by app.js right after boot) ───
export async function preloadSpotsData(weekData, loc) {
  if (!loc) return;
  const radius = 25;
  try {
    const spots = await fetchSpots(loc.lat, loc.lon, radius);
    spots.forEach(s => _prepSpot(s, weekData, loc.lat, loc.lon));
    // Publish immediately so an early tab-open hits the fast path.
    _preloadedSpots       = spots;
    _preloadedForLat      = loc.lat;
    _preloadedForLon      = loc.lon;
    _preloadedForRadius   = radius;
    _preloadedForWeekData = weekData;
    // Location quality fills in via Worker; mutates spots in place.
    computeLocationQualityBatch(spots, getSunsetAzimuth()).catch(() => {});
    // Warm image cache for the top 3 spots (by distance — matches default sort).
    // SWR-cached, silent failure: just fills localStorage so the first tap is instant.
    for (let k = 0; k < Math.min(3, spots.length); k++) {
      fetchSpotImage(spots[k]).catch(() => {});
    }
  } catch (e) {
    console.warn('[spots] preload failed, will fetch on demand:', e);
    _preloadedSpots = null;
  }
}

// ─── Tile prefetch: preload map tiles for user's area on idle ───
export function prefetchAreaTiles(lat, lon) {
  // Prefetch CARTO vector tiles for user's area
  const SUBDOMAINS = ['a', 'b', 'c', 'd'];
  const ZOOMS = [9, 10, 11, 12, 13];
  const RADIUS = 3; // tiles around center in each direction

  function lat2tile(lat, z) { return Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * (1 << z)); }
  function lon2tile(lon, z) { return Math.floor((lon + 180) / 360 * (1 << z)); }

  const urls = [];
  for (const z of ZOOMS) {
    const cx = lon2tile(lon, z), cy = lat2tile(lat, z);
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      for (let dy = -RADIUS; dy <= RADIUS; dy++) {
        const x = cx + dx, y = cy + dy;
        const s = SUBDOMAINS[(x + y) % SUBDOMAINS.length];
        urls.push(`https://tiles-${s}.basemaps.cartocdn.com/vectortiles/carto.streets/v1/${z}/${x}/${y}.mvt`);
      }
    }
  }

  // Fetch in small batches to avoid flooding the network
  let i = 0;
  function fetchBatch() {
    const batch = urls.slice(i, i + 6);
    if (!batch.length) return;
    i += 6;
    Promise.allSettled(batch.map(u => fetch(u, { mode: 'no-cors' }))).then(() => {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(fetchBatch, { timeout: 5000 });
      } else {
        setTimeout(fetchBatch, 200);
      }
    });
  }

  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(fetchBatch, { timeout: 10000 });
  } else {
    setTimeout(fetchBatch, 6000);
  }
}

export function invalidatePreloadedSpots() {
  _preloadedSpots       = null;
  _preloadedForLat      = null;
  _preloadedForLon      = null;
  _preloadedForRadius   = null;
  _preloadedForWeekData = null;
  _extendedMode         = false;
}

// ─── Best day label ──────────────────────
function bestDayLabel(allScores) {
  if (!allScores || allScores.length < 2) return null;
  const dayNames = ['היום','מחר'];
  const days = ['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'];
  let bestIdx = 0, bestVal = allScores[0].combined;
  for (let i = 1; i < allScores.length; i++) {
    if (allScores[i].combined > bestVal) { bestVal = allScores[i].combined; bestIdx = i; }
  }
  if (bestIdx === 0) return null; // today is already best — no need for badge
  let label;
  if (bestIdx < 2) label = dayNames[bestIdx];
  else {
    const d = _weekData?.[bestIdx]?.date;
    label = d ? 'יום ' + days[new Date(d + 'T12:00:00').getDay()] : '';
  }
  return { label, score: bestVal };
}

// ─── Per-spot decision badge (Pulse 3→Spot Finder) ──
// Bridges legacy dayData → decisionEngine format, adds travel time per spot.
function buildSpotDecision(spot, today) {
  if (!today) return '';
  const driveMin = spot._driveMin || 0;
  const sc = spot._allScores?.[0]?.combined ?? today.score;

  // Build weatherData in engine format
  const weatherData = {
    clouds:              (today._cloudRaw ?? 50) / 100,
    cloudHeightCategory: today._cloudHighRaw > 40 ? 'high' : today._cloudLowRaw > 40 ? 'low' : 'mid',
    horizonClearance:    Math.max(0, (100 - (today._cloudLowRaw ?? 50)) / 100),
    dust:                today._dustRaw ?? 0,
    humidity:            today._humidityRaw ?? 50,
    visibility:          today._visibilityRaw ?? 10,
    aqi:                 null,
    solarElevation:      3,
    sunsetTime:          today.sunset ? (() => {
      const [h, m] = today.sunset.split(':').map(Number);
      const d = new Date(today.date + 'T12:00:00');
      d.setHours(h, m, 0, 0);
      return d;
    })() : new Date(),
  };

  let result;
  try {
    result = decide({
      weatherData,
      travelTimeMinutes: driveMin,
      bufferMinutes: 10,
      latitude: _loc?.lat ?? 32,
    });
  } catch {
    return '';
  }

  const d = result.decision; // 'YES' | 'MAYBE' | 'NO'
  const tier = d === 'YES' ? 'go' : d === 'MAYBE' ? 'maybe' : 'no';

  let text;
  if (d === 'YES') {
    text = 'שווה לנסוע';
  } else if (d === 'MAYBE') {
    text = driveMin > 20 ? 'רק אם קרוב' : 'אפשרי';
  } else {
    text = driveMin > 0 ? 'לא שווה' : 'שקיעה חלשה';
  }

  return `<span class="spot-badge spot-decision-${tier}">${text}</span>`;
}

// ═════════════════════════════════════════
//  INIT
// ═════════════════════════════════════════
export async function initSpotsScreen(weekData) {
  if (weekData) _weekData = weekData;
  _loc = loadLocation();
  _favorites = loadFavorites();
  _visited = loadVisited();
  _visibleCount = 15;
  const container = document.getElementById('screen-spots');
  if (!container) return;

  // Detach existing map element before rebuilding the shell so MapLibre
  // instance survives. We'll reattach it into the new #spot-map-wrap.
  const reuseMap = !!(_map && _mapEl);
  if (reuseMap) _mapEl.remove(); // detach from old DOM, not destroyed

  container.innerHTML = buildSpotsShell();
  attachSpotsEvents();

  if (reuseMap) {
    // Reattach the preserved map element
    const wrap = document.getElementById('spot-map-wrap');
    const placeholder = document.getElementById('spots-map');
    if (wrap && placeholder) {
      wrap.replaceChild(_mapEl, placeholder);
      _map.resize();
      // Update user marker position if location changed
      const lat = _loc?.lat || 32.0853, lon = _loc?.lon || 34.7818;
      if (_userMarker) _userMarker.setLngLat([lon, lat]);
      _map.jumpTo({ center: [lon, lat], zoom: _map.getZoom() });
      drawEventArc();
      if (_spots.length) updateMapMarkers(getFilteredSpots());
    }
  } else {
    if (_map) { _map.remove(); _map = null; _mapEl = null; _userMarker = null; _markers = []; _popupHandlerRegistered = false; _mapStyleLoaded = false; }
    initMap();
  }

  if (!_loc) { showToast('לא נמצא מיקום — לחץ GPS', 'error'); return; }
  await loadSpots();
}

// ═════════════════════════════════════════
//  SHELL HTML — no radius slider
// ═════════════════════════════════════════
function buildSpotsShell() {
  return `
  <div class="spot-content">
    <div class="spot-title-row">
      <div class="spot-main-title">Spot Finder</div>
      <div class="spot-main-sub">נקודות תצפית לדמדומים · ${_radiusKm} ק"מ סביבך</div>
    </div>

    <!-- Search bar — autocomplete module -->
    <div class="glass spot-search-wrap" id="spots-search-container"></div>

    <!-- Radius pills -->
    <div class="spot-sort-row">
      <span style="font-size:11px;color:var(--cream-faint);margin-left:6px">טווח:</span>
      ${[10, 25].map(r => `
        <button class="sort-pill radius-pill${_radiusKm === r ? ' active' : ''}" data-radius="${r}">${r} ק"מ</button>
      `).join('')}
    </div>

    <!-- Type filter pills -->
    <div class="spot-filter-row">
      ${[
        { val: 'all',             label: 'הכל' },
        { val: 'favorites',      label: '★ מועדפים' },
        { val: 'visited',        label: '✓ ביקרתי' },
        { val: 'פסגה',            label: 'פסגות' },
        { val: 'נקודת תצפית',     label: 'תצפית' },
        { val: 'חוף',             label: 'חופים' },
        { val: 'מצוק',            label: 'מצוקים' },
      ].map(f => `
        <button class="spot-filter-pill${_filterType === f.val ? ' active' : ''}" data-filter="${f.val}">
          ${f.val !== 'all' && f.val !== 'favorites' && f.val !== 'visited' ? `<span class="spot-filter-icon">${TYPE_ICONS[f.val]}</span>` : ''}${f.label}
        </button>
      `).join('')}
    </div>

    <!-- Map -->
    <div class="glass spot-map-wrap" id="spot-map-wrap">
      <div id="spots-map" style="height:280px;width:100%;border-radius:18px"><div style="height:100%;display:flex;align-items:center;justify-content:center;color:var(--cream-faint);font-size:12px">טוען מפה...</div></div>
      <button class="spot-map-expand-btn" id="map-expand-btn" title="הגדל מפה">
        <svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
      </button>
    </div>

    <!-- Sort pills -->
    <div class="spot-sort-row">
      <button class="sort-pill ${_sortMode==='smart'?'active':''}" id="sort-smart">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        מומלץ
      </button>
      <button class="sort-pill ${_sortMode==='score'?'active':''}" id="sort-score">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        איכות צפייה
      </button>
      <button class="sort-pill ${_sortMode==='dist'?'active':''}" id="sort-dist">
        <svg width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
        קרוב
      </button>
    </div>

    <!-- Best spot hero -->
    <div id="best-spot-hero"></div>

    <!-- Spots count -->
    <div id="spots-count" class="spots-count-label"></div>

    <!-- Spots list -->
    <div id="spots-list">
      <div style="text-align:center;padding:24px;color:var(--cream-faint)">טוען נקודות...</div>
    </div>
  </div>
  `;
}

// ═════════════════════════════════════════
//  MAP (MapLibre GL JS)
// ═════════════════════════════════════════
async function initMap() {
  if (_map) return; // already initialized — guard against stale retry timers
  try {
    await loadMapLibre();
  } catch (e) {
    console.warn('[map] MapLibre load failed, retrying in 2s:', e.message);
    setTimeout(initMap, 2000);
    return;
  }
  if (_map) return; // another call completed while we were loading MapLibre
  const el = document.getElementById('spots-map');
  if (!el) return;

  // Enable Hebrew (RTL) text rendering — must be called before map creation.
  // Guard against "cannot be called multiple times" error on re-init.
  try {
    maplibregl.setRTLTextPlugin(
      'https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.min.js',
      true // lazy-load
    );
  } catch (_) { /* already set */ }

  const lat = _loc?.lat || 32.0853, lon = _loc?.lon || 34.7818;
  _map = new maplibregl.Map({
    container: 'spots-map',
    style: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
    center: [lon, lat],
    zoom: 11,
    attributionControl: true
  });
  _mapEl = _map.getContainer();

  // User marker — pulsing gold dot
  const userEl = document.createElement('div');
  userEl.innerHTML = '<div style="width:14px;height:14px;background:#F0B84A;border:2px solid #fff;border-radius:50%;box-shadow:0 0 10px rgba(240,184,74,0.9);animation:pulse 1.5s ease-in-out infinite"></div>';
  _userMarker = new maplibregl.Marker({ element: userEl, anchor: 'center' })
    .setLngLat([lon, lat])
    .setPopup(new maplibregl.Popup({ offset: 10 }).setText('המיקום שלך'))
    .addTo(_map);

  // Delegated click handler — attach ONCE as soon as the map container exists,
  // independent of whether spot markers have been drawn yet. This fires reliably
  // on first tap of "הצג פרטים" in any popup, and avoids racing with loadSpots.
  if (!_popupHandlerRegistered) {
    _popupHandlerRegistered = true;
    _map.getContainer().addEventListener('click', (ev) => {
      const link = ev.target.closest?.('.spot-popup-link');
      if (!link) return;
      ev.preventDefault();
      ev.stopPropagation();
      scrollToSpotCard(parseInt(link.dataset.spotIdx));
    });
  }

  _map.on('load', () => {
    _mapStyleLoaded = true;

    // Prefer Hebrew names on all label layers (CARTO defaults to name:latin).
    try {
      _map.getStyle().layers.forEach(layer => {
        if (layer.layout?.['text-field']) {
          _map.setLayoutProperty(layer.id, 'text-field',
            ['coalesce', ['get', 'name:he'], ['get', 'name']]);
        }
      });
    } catch (_) { /* style may not support per-layer override */ }

    drawEventArc();
    // If spots already loaded before the map was ready, draw their markers now.
    if (_spots.length) updateMapMarkers(getFilteredSpots());
  });
}

function drawEventArc() {
  if (!_map || !_loc || !_mapStyleLoaded) return;
  const nextEvt = getNextEvent();
  const az = nextEvt.azimuth;
  const color = nextEvt.type === 'sunset' ? '#F0B84A' : '#E87830';
  const dist = 30;
  const main = destPoint(_loc.lat, _loc.lon, az, dist);
  const left = destPoint(_loc.lat, _loc.lon, az - 30, dist);
  const right = destPoint(_loc.lat, _loc.lon, az + 30, dist);
  const origin = [_loc.lon, _loc.lat];

  const geojson = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { w: 2, op: 0.7, dash: [8, 6] }, geometry: { type: 'LineString', coordinates: [origin, [main.lon, main.lat]] } },
      { type: 'Feature', properties: { w: 1.2, op: 0.25, dash: [4, 8] }, geometry: { type: 'LineString', coordinates: [origin, [left.lon, left.lat]] } },
      { type: 'Feature', properties: { w: 1.2, op: 0.25, dash: [4, 8] }, geometry: { type: 'LineString', coordinates: [origin, [right.lon, right.lat]] } }
    ]
  };

  if (_map.getSource('sunset-arc')) {
    _map.getSource('sunset-arc').setData(geojson);
    _map.setPaintProperty('sunset-arc-main', 'line-color', color);
    _map.setPaintProperty('sunset-arc-side', 'line-color', color);
  } else {
    _map.addSource('sunset-arc', { type: 'geojson', data: geojson });
    _map.addLayer({
      id: 'sunset-arc-main', type: 'line', source: 'sunset-arc',
      filter: ['==', ['get', 'op'], 0.7],
      paint: { 'line-color': color, 'line-width': 2, 'line-opacity': 0.7, 'line-dasharray': [8, 6] }
    });
    _map.addLayer({
      id: 'sunset-arc-side', type: 'line', source: 'sunset-arc',
      filter: ['==', ['get', 'op'], 0.25],
      paint: { 'line-color': color, 'line-width': 1.2, 'line-opacity': 0.25, 'line-dasharray': [4, 8] }
    });
  }
}

function updateMapMarkers(spots) {
  if (!_map) return;
  _markers.forEach(m => m.remove());
  _markers = [];
  _markerSpotMap = {};
  const nextEvt = getNextEvent();
  spots.slice(0, 30).forEach((s, idx) => {
    if (!s.lat || !s.lon) return;
    const sc = s._allScores?.[0]?.combined || 5;
    const eventScore = nextEvt.type === 'sunrise'
      ? (s._allScores?.[0]?.sr || 5)
      : (s._allScores?.[0]?.ss || 5);
    const markerColor = scoreToBarStyle(sc, _weekData?.[0]?.skyColors).scoreColor;
    const isFav = isFavorite(s.name, s.lat, s.lon);
    const isVis = isVisited(s.name, s.lat, s.lon);
    const size = isFav ? 18 : 14;
    const border = isVis ? '2px solid rgba(125,212,168,0.8)' : '2px solid rgba(255,255,255,0.6)';
    const num = idx + 1;
    const markerEl = document.createElement('div');
    markerEl.innerHTML = `<div class="spot-marker-num" style="width:${size}px;height:${size}px;background:${markerColor};border:${border};border-radius:50%;box-shadow:0 0 8px ${markerColor}88;display:flex;align-items:center;justify-content:center;font-size:${isFav ? 9 : 8}px;font-weight:800;color:#fff;font-family:Rubik,sans-serif;line-height:1">${num}</div>`;
    const eventLabel = nextEvt.type === 'sunrise' ? 'זריחה' : 'שקיעה';
    const popupContent = `<div dir="rtl" style="font-family:Rubik,sans-serif;font-size:13px"><b>${esc(s.name)}</b><br>${esc(s.type)} · ${fmtScore(sc)} · ${s.dist} ק"מ<br><span style="color:${scoreToBarStyle(eventScore, _weekData?.[0]?.skyColors).scoreColor}">${eventLabel}: ${fmtScore(eventScore)}</span><br><a href="#" class="spot-popup-link" data-spot-idx="${idx}" style="color:#F0B84A;font-size:11px;text-decoration:underline">הצג פרטים ↓</a></div>`;
    const popup = new maplibregl.Popup({ offset: 10, closeButton: true }).setHTML(popupContent);
    const m = new maplibregl.Marker({ element: markerEl, anchor: 'center' })
      .setLngLat([s.lon, s.lat])
      .setPopup(popup)
      .addTo(_map);
    m._spotIdx = idx;
    _markers.push(m);
    _markerSpotMap[spotKey(s.name, s.lat)] = idx;
  });
}

// ─── Map ↔ List sync ────────────────────
async function scrollToSpotCard(idx) {
  // If card not yet rendered (lazy load), expand visible count
  if (idx >= _visibleCount) {
    _visibleCount = idx + 5;
    renderSpotsList();
  }
  // Wait one tick for lazy render to land in the DOM.
  await new Promise(r => setTimeout(r, 0));
  const el = document.getElementById(`spot-expand-${idx}`);
  const card = el?.closest('.spot-card');
  if (!card) return;
  // Open the card (kicks off 0.4s max-height transition)
  if (el && !el.classList.contains('open')) window.toggleSpot(idx);
  // Wait for the expand transition to complete before measuring — otherwise
  // the scroll target is computed against a still-collapsed card height.
  await new Promise(r => setTimeout(r, 420));
  const screen = document.getElementById('screen-spots');
  if (screen) {
    const cardTop = card.getBoundingClientRect().top + screen.scrollTop;
    const target = Math.max(0, cardTop - 80);
    // Direct scrollTop assignment — CSS `scroll-behavior: smooth` on #screen-spots
    // makes this animate. scrollTo({behavior:'smooth'}) was unreliable inside an
    // async chain (animation got cancelled by subsequent DOM work).
    screen.scrollTop = target;
  } else {
    card.scrollIntoView({ block: 'start' });
  }
  card.classList.add('spot-card-highlight');
  setTimeout(() => card.classList.remove('spot-card-highlight'), 2500);
}

// ═════════════════════════════════════════
//  LOAD
// ═════════════════════════════════════════
async function loadSpots() {
  if (_loadingSpots) return;
  if (!_loc) {
    const el = document.getElementById('spots-list');
    if (el) el.innerHTML = buildEmptyState('לא נמצא מיקום', 'לחץ "מיקום נוכחי" לאיתור');
    return;
  }
  _loadingSpots = true;

  // ── Pre-load fast path ──────────────────────────────────
  const preloadValid =
    _preloadedSpots !== null &&
    _preloadedForLat      === _loc.lat &&
    _preloadedForLon      === _loc.lon &&
    _preloadedForRadius   === _radiusKm &&
    _preloadedForWeekData === _weekData;

  if (preloadValid) {
    _spots = _preloadedSpots;
    _preloadedSpots = null; // consume — next visit re-fetches (fetchSpots cache still warm)
    renderBestSpotHero();
    renderSpotsList();
    updateMapMarkers(getFilteredSpots());
    drawEventArc();
    // Preload may have dispatched the Worker batch without awaiting it. If any
    // spot is missing location quality, re-run (idempotent) and re-render.
    const needsQuality = _spots.some(s => s._locationQualitySunset == null);
    if (needsQuality) {
      computeLocationQualityBatch(_spots, getSunsetAzimuth()).then(() => {
        renderBestSpotHero();
        renderSpotsList();
        updateMapMarkers(getFilteredSpots());
        checkGeofenceAlert(_spots, _weekData?.[0]?.score ?? 0);
      }).catch(() => {
        checkGeofenceAlert(_spots, _weekData?.[0]?.score ?? 0);
      });
    } else {
      checkGeofenceAlert(_spots, _weekData?.[0]?.score ?? 0);
    }
    _loadingSpots = false;
    return;
  }

  // Clear stale results immediately
  const heroEl = document.getElementById('best-spot-hero');
  if (heroEl) heroEl.innerHTML = '';
  const listEl = document.getElementById('spots-list');
  if (listEl) listEl.innerHTML = '<div style="text-align:center;padding:24px;color:var(--cream-faint)">טוען נקודות...</div>';
  const countEl = document.getElementById('spots-count');
  if (countEl) countEl.textContent = '';

  try {
    // Default: 15 spots. Extended mode (user clicked "load more") fetches 30.
    const limit = _extendedMode ? 30 : 15;
    _spots = await fetchSpots(_loc.lat, _loc.lon, _radiusKm, limit);
    _spots.forEach(s => _prepSpot(s));

    // First paint: render with sync data (score/bearing/distance/horizon).
    // Location quality arrives from Worker asynchronously; we re-render then.
    renderBestSpotHero();
    renderSpotsList();
    updateMapMarkers(getFilteredSpots());
    drawEventArc();

    computeLocationQualityBatch(_spots, getSunsetAzimuth()).then(() => {
      renderBestSpotHero(); // hero may change once location quality lands
      renderSpotsList();
      updateMapMarkers(getFilteredSpots());
      checkGeofenceAlert(_spots, _weekData?.[0]?.score ?? 0);
    }).catch(() => {
      checkGeofenceAlert(_spots, _weekData?.[0]?.score ?? 0);
    });
  } catch (e) {
    console.error('[spots] loadSpots failed:', e);
    _spots = [];
    if (heroEl) heroEl.innerHTML = '';
    const el = document.getElementById('spots-list');
    if (el) el.innerHTML = buildEmptyState('שגיאה בטעינת נקודות', 'בדוק חיבור ונסה שוב');
  } finally {
    _loadingSpots = false;
  }
}

// ═════════════════════════════════════════
//  FILTER + SORT
// ═════════════════════════════════════════
function getFilteredSpots() {
  let filtered = [..._spots];
  if (_filterType === 'favorites') {
    filtered = filtered.filter(s => isFavorite(s.name, s.lat, s.lon));
  } else if (_filterType === 'visited') {
    filtered = filtered.filter(s => isVisited(s.name, s.lat, s.lon));
  } else if (_filterType !== 'all') {
    filtered = filtered.filter(s => s.type === _filterType);
  }

  if (_sortMode === 'smart') {
    // Sky quality is uniform across spots — location quality is the primary differentiator.
    // Blend: location quality 55%, sky quality 30%, distance 15%
    const evt = getNextEvent();
    filtered.sort((a, b) => {
      const aScore = a._allScores?.[0]?.combined || 0;
      const bScore = b._allScores?.[0]?.combined || 0;
      const aLoc = evt.type === 'sunrise'
        ? (a._locationQualitySunrise || 50) / 10
        : (a._locationQualitySunset  || 50) / 10;
      const bLoc = evt.type === 'sunrise'
        ? (b._locationQualitySunrise || 50) / 10
        : (b._locationQualitySunset  || 50) / 10;
      const aVal = aScore * 0.30 + aLoc * 0.55 - (a.dist / 50) * 2;
      const bVal = bScore * 0.30 + bLoc * 0.55 - (b.dist / 50) * 2;
      return bVal - aVal;
    });
  } else if (_sortMode === 'score') {
    // Sort by location quality for the current event (sky is uniform)
    const evt = getNextEvent();
    filtered.sort((a, b) => {
      const aLoc = evt.type === 'sunrise' ? (a._locationQualitySunrise || 0) : (a._locationQualitySunset || 0);
      const bLoc = evt.type === 'sunrise' ? (b._locationQualitySunrise || 0) : (b._locationQualitySunset || 0);
      return bLoc - aLoc;
    });
  } else {
    filtered.sort((a, b) => a.dist - b.dist);
  }

  // Favorites float to top
  filtered.sort((a, b) => {
    const af = isFavorite(a.name, a.lat, a.lon) ? 0 : 1;
    const bf = isFavorite(b.name, b.lat, b.lon) ? 0 : 1;
    return af - bf;
  });

  // Cap at 100 so rank numbering is stable and bounded
  return filtered.slice(0, 100);
}

// ═════════════════════════════════════════
//  HERO
// ═════════════════════════════════════════
function renderBestSpotHero() {
  const heroEl = document.getElementById('best-spot-hero');
  if (!heroEl || !_spots.length) { if (heroEl) heroEl.innerHTML = ''; return; }
  const nextEvt = getNextEvent();
  // Sort by location quality for the current event — sky quality is uniform
  const best = [..._spots].sort((a, b) => {
    const aLoc = nextEvt.type === 'sunrise' ? (a._locationQualitySunrise || 0) : (a._locationQualitySunset || 0);
    const bLoc = nextEvt.type === 'sunrise' ? (b._locationQualitySunrise || 0) : (b._locationQualitySunset || 0);
    return bLoc - aLoc;
  })[0];
  if (!best) return;
  const sc = best._allScores?.[0] || { combined: 5.0 };
  if (sc.combined < 4.5) { heroEl.innerHTML = ''; return; }
  const heroLoc = nextEvt.type === 'sunrise' ? best._locationQualitySunrise : best._locationQualitySunset;
  const heroBarStyle = scoreToBarStyle(sc.combined, _weekData?.[0]?.skyColors);
  const [hbr, hbg, hbb] = heroBarStyle.scoreColorRgb.split(',').map(Number);
  const heroBadgeBg  = `linear-gradient(to bottom,rgba(${hbr},${hbg},${hbb},0.40) 0%,rgba(${Math.round(hbr*0.55)},${Math.round(hbg*0.20)},0,0.55) 100%)`;
  const heroWcBg     = getWatercolorBg(sc.combined);
  const heroColor    = heroBarStyle.scoreColor; // kept for strip/strip usage below
  const today = _weekData?.[0];
  const heroEventTime = today ? (nextEvt.type === 'sunrise' ? today.sunrise : today.sunset) : null;
  const departure = heroEventTime ? calcDepartureTime(best._driveMin, heroEventTime, nextEvt.type) : null;
  const heroTitle = nextEvt.type === 'sunrise' ? 'הספוט הכי טוב לזריחה' : 'הספוט הכי טוב לשקיעה';

  heroEl.innerHTML = `
  <div class="glass-strong spot-hero" style="--spot-color:${heroColor}">
    <div class="spot-hero-strip" style="background:${scoreToBarStyle(sc.combined, _weekData?.[0]?.skyColors).scoreColor};--score-color-rgb:${scoreToBarStyle(sc.combined, _weekData?.[0]?.skyColors).scoreColorRgb}"></div>
    <div class="spot-hero-inner">
      <div class="spot-hero-top">
        <div style="font-size:10px;color:var(--gold);font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px">${heroTitle}</div>
        <div style="display:flex;align-items:center;gap:10px">
          <div style="display:flex;flex-direction:column;gap:4px;align-items:center">
            <div class="score-badge" style="background:${heroBadgeBg};border:1px solid ${heroBarStyle.scoreColor}55;border-top:1px solid rgba(255,255,255,0.30);color:${heroBarStyle.scoreColor};filter:saturate(1.45) brightness(1.18);position:relative;overflow:hidden;width:44px;height:44px;font-size:15px" ${sc.combined >= 7 ? 'data-shimmer' : ''}><div class="score-badge-wc" style="background-image:url(${heroWcBg})"></div><span style="position:relative;z-index:3;text-shadow:0 0 10px rgba(${hbr},${hbg},${hbb},0.70),0 1px 3px rgba(0,0,0,0.90)">${fmtScore(sc.combined)}</span>
            </div>
            <div style="font-size:9px;color:var(--gold-light);text-align:center">שמיים</div>
            <div class="score-badge score-badge-location" style="width:44px;height:36px;font-size:13px">${heroLoc ?? '—'}</div>
            <div style="font-size:9px;color:rgba(160,185,210,0.8);text-align:center">מיקום</div>
          </div>
          <div>
            <div style="font-size:16px;font-weight:800;color:var(--cream);line-height:1.2">${esc(best.name)}</div>
            <div style="font-size:11px;color:var(--cream-faint)">${esc(best.type)} · ${best.dist} ק"מ · ~${best._driveMin || 0} דק׳</div>
          </div>
        </div>
      </div>
      <div class="spot-hero-bottom">
        ${departure ? `<div class="spot-hero-depart">
          <svg width="14" height="14" fill="none" stroke="var(--gold-light)" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>צא עד <b>${departure}</b> ל${nextEvt.type === 'sunrise' ? 'זריחה' : 'שעת הזהב'}</span>
        </div>` : ''}
        <a href="https://www.waze.com/ul?ll=${best.lat},${best.lon}&navigate=yes&zoom=17"
           target="_blank" rel="noopener" class="spot-hero-nav-btn">
          <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
          נווט עכשיו
        </a>
      </div>
    </div>
  </div>`;
}

// ═════════════════════════════════════════
//  EMPTY STATE
// ═════════════════════════════════════════
function buildEmptyState(title, sub) {
  return `
  <div class="spot-empty-state">
    <div class="spot-empty-icon">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="var(--cream-faint)" stroke-width="1.5" stroke-linecap="round">
        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>
      </svg>
    </div>
    <div class="spot-empty-title">${title}</div>
    <div class="spot-empty-sub">${sub}</div>
  </div>`;
}

// ═════════════════════════════════════════
//  5-DAY STRIP
// ═════════════════════════════════════════
function renderMiniWeekStrip(allScores) {
  if (!allScores || allScores.length < 2) return '';
  const dayLabels = ['היום','מחר'];
  const days = ['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'];
  return `
  <div class="spot-week-strip">
    <div class="spot-conditions-label">תחזית 5 ימים</div>
    <div class="spot-week-bar-row">
      ${allScores.slice(0, 5).map((sc, i) => {
        const skyColors = _weekData?.[i]?.skyColors;
        const barStyle  = scoreToBarStyle(sc.combined, skyColors);
        const heightCalc = `calc(max(15%, ((${sc.combined.toFixed(2)} - 3) / 7) * 100%))`;
        let label = i < 2 ? dayLabels[i] : '';
        if (i >= 2) { const d = _weekData?.[i]?.date; if (d) label = days[new Date(d + 'T12:00:00').getDay()]; }
        return `
        <div class="spot-week-bar-item">
          <div class="spot-week-bar-track">
            <div class="spot-week-bar-outer">
              <div class="spot-week-bar-score" style="color:rgba(255,248,235,0.95)">${fmtScore(sc.combined)}</div>
              <div class="spot-week-bar-fill"
                   data-score="${sc.combined.toFixed(1)}"
                   style="--score-color:${barStyle.scoreColor};--score-color-rgb:${barStyle.scoreColorRgb};height:${heightCalc}"></div>
            </div>
          </div>
          <div class="spot-week-bar-label">${label}</div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

// ═════════════════════════════════════════
//  GEOFENCING ALERT (3b)
//  Push notification when near a high-quality spot on a good day
// ═════════════════════════════════════════
function checkGeofenceAlert(spots, todayScore) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (todayScore < 6.5) return; // only alert on genuinely good days

  const GEOFENCE_KM = 30;
  const MIN_SPOT_SCORE = 6.8;

  // Find closest high-scoring spot within range (sky quality + good location)
  const nextEvt = getNextEvent();
  const candidate = spots
    .filter(s => {
      const skyOk = (s._allScores?.[0]?.combined || 0) >= MIN_SPOT_SCORE;
      const loc = nextEvt.type === 'sunrise'
        ? (s._locationQualitySunrise || 0)
        : (s._locationQualitySunset  || 0);
      return s.dist <= GEOFENCE_KM && skyOk && loc >= 45;
    })
    .sort((a, b) => {
      const aLoc = nextEvt.type === 'sunrise' ? (a._locationQualitySunrise || 0) : (a._locationQualitySunset || 0);
      const bLoc = nextEvt.type === 'sunrise' ? (b._locationQualitySunrise || 0) : (b._locationQualitySunset || 0);
      return bLoc - aLoc;
    })[0];

  if (!candidate) return;

  // Alert at most once per calendar day
  const alertKey = 'twl_geo_' + new Date().toDateString();
  try { if (localStorage.getItem(alertKey)) return; } catch {}

  const skyScore = (candidate._allScores?.[0]?.combined || 0).toFixed(1);
  const locScore = nextEvt.type === 'sunrise'
    ? (candidate._locationQualitySunrise || 0)
    : (candidate._locationQualitySunset  || 0);
  const spotScore = `שמיים ${skyScore}/10 · מיקום ${locScore}/100`;
  const distLabel  = candidate.dist < 1 ? 'פחות מ-1 ק"מ' : `${candidate.dist} ק"מ`;

  const eventLabel = nextEvt.type === 'sunrise' ? 'זריחה מעולה מחר בבוקר 🌅' : 'שקיעה מעולה היום 🌅';

  navigator.serviceWorker.ready.then(reg => {
    reg.showNotification(`TWILIGHT · ${eventLabel}`, {
      body:    `${candidate.name} — ${spotScore} · ${distLabel} ממך`,
      icon:    './images/sunset.png',
      badge:   './images/icon-192.png',
      dir:     'rtl',
      lang:    'he',
      tag:     'geofence-alert',      // replaces previous if still visible
      renotify: false,
      data:    { url: './?screen=spots' }
    });
    try { localStorage.setItem(alertKey, '1'); } catch {}
  }).catch(() => {});
}

// ═════════════════════════════════════════
//  RENDER LIST
// ═════════════════════════════════════════
function renderSpotsList() {
  const listEl = document.getElementById('spots-list');
  if (!listEl) return;
  const sorted = getFilteredSpots();
  const countEl = document.getElementById('spots-count');

  if (!sorted.length) {
    if (countEl) countEl.textContent = '';
    listEl.innerHTML = buildEmptyState(
      _filterType === 'favorites' ? 'אין מועדפים עדיין' :
      _filterType === 'visited' ? 'עוד לא ביקרת בנקודות' :
      `לא נמצאו נקודות ב-${_radiusKm} ק"מ`,
      _filterType === 'favorites' ? 'לחץ ★ בכרטיס ספוט' :
      _filterType === 'visited' ? 'לחץ ✓ אחרי ביקור בספוט' :
      _filterType !== 'all' ? 'נסה סינון אחר או חפש מיקום' : 'נסה לחפש מיקום אחר'
    );
    return;
  }

  const today = _weekData?.[0];
  const nextEvt = getNextEvent();
  const eventTime = today ? (nextEvt.type === 'sunrise' ? today.sunrise : today.sunset) : null;

  const visible = sorted.slice(0, _visibleCount);
  const remaining = sorted.length - visible.length;
  if (countEl) countEl.textContent = remaining > 0
    ? `מציג ${visible.length} מתוך ${sorted.length} נקודות`
    : `${sorted.length} נקודות נמצאו`;

  listEl.innerHTML = visible.map((s, i) => {
    const scores = s._allScores || [{ ss: 5.0, sr: 5.0, tw: 5.0, combined: 5.0 }];
    const sc = scores[0];
    const cardBarStyle = scoreToBarStyle(sc.combined, _weekData?.[0]?.skyColors);
    const [cnr, cng, cnb] = cardBarStyle.scoreColorRgb.split(',').map(Number);
    const cardBadgeBg  = `linear-gradient(to bottom,rgba(${cnr},${cng},${cnb},0.40) 0%,rgba(${Math.round(cnr*0.55)},${Math.round(cng*0.20)},0,0.55) 100%)`;
    const cardWcBg     = getWatercolorBg(sc.combined);
    const cardColor    = cardBarStyle.scoreColor; // kept for strip usage
    const bearing = s._bearing || 0;
    const dirLabel = bearingToHeb(bearing);
    const driveMin = s._driveMin || 0;
    const fav = isFavorite(s.name, s.lat, s.lon);
    const vis = isVisited(s.name, s.lat, s.lon);
    const departure = eventTime ? calcDepartureTime(driveMin, eventTime, nextEvt.type) : null;
    const locationBadgeVal = nextEvt.type === 'sunrise'
      ? s._locationQualitySunrise
      : s._locationQualitySunset;
    const best = bestDayLabel(scores);

    const westOK = isWestFacing(bearing), eastOK = isEastFacing(bearing);
    let badge = '';
    if (westOK && eastOK) {
      badge = `<span class="spot-badge spot-badge-both">שקיעה + זריחה</span>`;
    } else if (westOK && nextEvt.type === 'sunset') {
      badge = `<span class="spot-badge spot-badge-sunset spot-badge-now">${logoImg('sunset', 12)} מומלץ עכשיו</span>`;
    } else if (eastOK && nextEvt.type === 'sunrise') {
      badge = `<span class="spot-badge spot-badge-sunrise spot-badge-now">${logoImg('sunrise', 12)} מומלץ עכשיו</span>`;
    } else if (westOK) {
      badge = `<span class="spot-badge spot-badge-sunset">${logoImg('sunset', 12)} מומלץ לשקיעה</span>`;
    } else if (eastOK) {
      badge = `<span class="spot-badge spot-badge-sunrise">${logoImg('sunrise', 12)} מומלץ לזריחה</span>`;
    }
    const horizonBadge = s._horizonWarning
      ? `<span class="spot-badge spot-badge-warn" title="${esc(s._horizonWarning)}">⚠ ${esc(s._horizonWarning)}</span>`
      : '';

    return `
    <div class="glass spot-card spot-card-anim" style="--spot-color:${cardColor};--anim-delay:${i * 60}ms">
      <div class="spot-color-strip" style="background:${scoreToBarStyle(sc.combined, _weekData?.[0]?.skyColors).scoreColor};--score-color-rgb:${scoreToBarStyle(sc.combined, _weekData?.[0]?.skyColors).scoreColorRgb}"></div>
      <div class="spot-card-inner">
        <div class="spot-header" onclick="toggleSpot(${i})">
          <div class="spot-header-right">
            <div style="display:flex;flex-direction:column;gap:4px;align-items:center;flex-shrink:0">
              <div>
                <div class="score-badge" style="background:${cardBadgeBg};border:1px solid ${cardBarStyle.scoreColor}55;border-top:1px solid rgba(255,255,255,0.30);color:${cardBarStyle.scoreColor};filter:saturate(1.45) brightness(1.18);position:relative;overflow:hidden" ${sc.combined >= 7 ? 'data-shimmer' : ''}><div class="score-badge-wc" style="background-image:url(${cardWcBg})"></div><span style="position:relative;z-index:3;font-size:14px;text-shadow:0 0 10px rgba(${cnr},${cng},${cnb},0.70),0 1px 3px rgba(0,0,0,0.90)">${fmtScore(sc.combined)}</span>
                </div>
                <div style="font-size:9px;text-align:center;color:var(--gold-light);margin-top:2px">שקיעה</div>
              </div>
              <div>
                <div class="score-badge score-badge-location">
                  <span style="font-size:12px;font-weight:700">${locationBadgeVal ?? '—'}</span>
                </div>
                <div style="font-size:9px;text-align:center;color:rgba(160,185,210,0.8);margin-top:2px">מיקום</div>
              </div>
            </div>
            <div class="spot-header-info">
              <div class="spot-name">
                <span class="spot-rank-badge" title="דירוג לפי איכות צפייה">${i + 1}</span>
                <span class="spot-type-icon" style="color:${cardColor}">${getTypeIcon(s.type)}</span>
                <span class="spot-name-text">${esc(s.name)}</span>
              </div>
              <div class="spot-meta">
                ${s.type} · ${dirLabel} ${compassArrow(bearing)}
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                ${buildSpotDecision(s, today)}
                ${badge}
                ${horizonBadge}
                ${vis ? '<span class="spot-badge spot-badge-visited">✓ ביקרתי</span>' : ''}
                ${best ? `<span class="spot-badge spot-badge-bestday">הכי טוב ${best.label} (${fmtScore(best.score)})</span>` : ''}
              </div>
            </div>
          </div>
          <div class="spot-header-left">
            <button class="spot-fav-btn ${fav ? 'active' : ''}" onclick="event.stopPropagation();window._toggleFav(${i})" title="${fav ? 'הסר ממועדפים' : 'הוסף למועדפים'}">
              ${fav ? '★' : '☆'}
            </button>
            <div class="spot-dist-col">
              <span class="spot-dist-val">${s.dist}</span>
              <span class="spot-dist-unit">ק"מ</span>
            </div>
            <div class="spot-drive-time">~${driveMin} דק׳</div>
            <div class="spot-chevron" id="spot-chevron-${i}">
              <svg width="14" height="14" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </div>
        </div>

        <div class="daily-expand" id="spot-expand-${i}">
          <div class="spot-expand-inner">
            <div class="spot-photo" id="spot-photo-${i}" data-spot-idx="${i}">
              <div class="spot-photo-skeleton">
                <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
                  <circle cx="12" cy="12" r="4"/>
                  <path d="M2 17l6-6 5 5 3-3 6 6"/>
                </svg>
              </div>
            </div>
            <div class="spot-scores-row">
              <div class="spot-score-cell">
                ${logoImg('sunset', 18)}
                <div class="spot-score-num" style="color:rgba(160,185,210,0.9)">${s._locationQualitySunset ?? '—'}<span>/100</span></div>
                <div class="spot-score-lbl">שקיעה מיקום</div>
              </div>
              <div class="spot-score-cell spot-score-cell-main">
                <svg width="18" height="18" fill="none" stroke="var(--gold-light)" stroke-width="1.5" viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
                <div class="spot-score-num" style="color:${scoreToBarStyle(sc.combined, _weekData?.[0]?.skyColors).scoreColor}">${fmtScore(sc.combined)}<span>/10</span></div>
                <div class="spot-score-lbl">שמיים</div>
              </div>
              <div class="spot-score-cell">
                ${logoImg('sunrise', 18)}
                <div class="spot-score-num" style="color:rgba(160,185,210,0.9)">${s._locationQualitySunrise ?? '—'}<span>/100</span></div>
                <div class="spot-score-lbl">זריחה מיקום</div>
              </div>
            </div>

            <div class="fx-grid spot-info-grid">
              <div class="fx-cell"><div class="fx-cell-lbl">כיוון</div><div class="fx-cell-val">${dirLabel}</div><div class="fx-cell-sub">${Math.round(bearing)}°</div></div>
              <div class="fx-cell"><div class="fx-cell-lbl">גובה</div><div class="fx-cell-val">${s.elevation || '—'}</div><div class="fx-cell-sub">${s.elevation ? 'מטר' : ''}</div></div>
              <div class="fx-cell"><div class="fx-cell-lbl">נסיעה</div><div class="fx-cell-val">~${driveMin}</div><div class="fx-cell-sub">דק׳</div></div>
            </div>

            ${s._horizonWarning ? `
            <div style="display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(255,160,30,0.08);border:1px solid rgba(255,160,30,0.25);border-radius:10px;margin-bottom:8px;font-size:11px;color:#E8A040;direction:rtl">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              ${esc(s._horizonWarning)} — יש לאמת ראות מערבית בשטח לפני נסיעה
            </div>` : ''}

            ${departure ? `
            <div class="spot-depart-row">
              <svg width="14" height="14" fill="none" stroke="var(--gold-light)" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              <span>צא עד <b style="color:var(--gold-light)">${departure}</b> כדי להגיע ל${nextEvt.type === 'sunrise' ? 'זריחה' : 'שעת הזהב'}</span>
            </div>` : ''}

            ${today ? `
            <div class="spot-conditions-label">תנאים היום</div>
            <div class="fx-grid spot-info-grid">
              <div class="fx-cell"><div class="fx-cell-lbl">עננות</div><div class="fx-cell-val">${today.cloud}</div></div>
              <div class="fx-cell"><div class="fx-cell-lbl">נראות</div><div class="fx-cell-val">${today.visibility}</div><div class="fx-cell-sub">ק"מ</div></div>
              <div class="fx-cell"><div class="fx-cell-lbl">רוח</div><div class="fx-cell-val">${today.wind}</div><div class="fx-cell-sub">${today.windDir}</div></div>
            </div>
            ` : ''}

            ${renderMiniWeekStrip(scores)}

            <div class="spot-nav-row">
              <a href="https://www.waze.com/ul?ll=${s.lat},${s.lon}&navigate=yes&zoom=17" target="_blank" rel="noopener" class="spot-nav-btn">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
                Waze
              </a>
              <a href="https://maps.google.com/?q=${s.lat},${s.lon}" target="_blank" rel="noopener" class="spot-nav-btn">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="10" r="3"/><path d="M12 2C7.6 2 4 5.6 4 10c0 5.3 7 12 8 12s8-6.7 8-12c0-4.4-3.6-8-8-8z"/></svg>
                מפות
              </a>
              <button class="spot-nav-btn" onclick="event.stopPropagation();window._shareSpot(${i})">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
                שתף
              </button>
              <a href="https://www.google.com/maps/search/?api=1&query=${s.lat},${s.lon}" target="_blank" rel="noopener" class="spot-nav-btn" title="פתח במפות גוגל — תמונות משתמשים במיקום זה">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                תמונות
              </a>
              <button class="spot-nav-btn ${vis ? 'spot-visited-active' : ''}" onclick="event.stopPropagation();window._toggleVisited(${i})">
                <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                ${vis ? 'ביקרתי ✓' : 'ביקרתי?'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
    `;
  }).join('');

  if (remaining > 0) {
    const nextBatch = Math.min(15, remaining);
    listEl.innerHTML += `
      <button class="search-filter-btn spot-load-more" id="spots-load-more" style="width:100%;margin-top:8px">
        הצג ${nextBatch} נוספים (${remaining} נותרו)
      </button>`;
    document.getElementById('spots-load-more')?.addEventListener('click', () => {
      haptic('light');
      _visibleCount += 15;
      renderSpotsList();
    });
  } else if (!_extendedMode && _filterType === 'all' && sorted.length >= 15) {
    // All 15 shown; offer to fetch another 15 from Overpass.
    listEl.innerHTML += `
      <button class="search-filter-btn spot-load-more" id="spots-load-more-fetch" style="width:100%;margin-top:8px" ${_loadingMore ? 'disabled' : ''}>
        ${_loadingMore ? 'טוען...' : 'הצג 15 נוספים'}
      </button>`;
    document.getElementById('spots-load-more-fetch')?.addEventListener('click', async () => {
      if (_loadingMore) return;
      haptic('light');
      _loadingMore = true;
      invalidatePreloadedSpots();
      _extendedMode = true;
      try {
        await loadSpots();
      } finally {
        _loadingMore = false;
      }
    });
  }

  // Preload image metadata for top 5 visible spots (URL cached, no img download)
  for (let k = 0; k < Math.min(5, sorted.length); k++) {
    fetchSpotImage(sorted[k]).catch(() => {});
  }
}

// ═════════════════════════════════════════
//  SEARCH
// ═════════════════════════════════════════
const TYPE_KEYWORDS = {
  'חוף':'חוף','חופים':'חוף','beach':'חוף',
  'פסגה':'פסגה','פסגות':'פסגה','הר':'פסגה','הרים':'פסגה','peak':'פסגה',
  'תצפית':'נקודת תצפית','מצפה':'נקודת תצפית','viewpoint':'נקודת תצפית',
  'מצוק':'מצוק','מצוקים':'מצוק','cliff':'מצוק',
};
function extractTypeFromQuery(q) {
  const lower = q.trim().toLowerCase();
  for (const [kw, type] of Object.entries(TYPE_KEYWORDS)) {
    if (lower.includes(kw)) return { type, cleaned: lower.replace(kw, '').trim() };
  }
  return { type: null, cleaned: q.trim() };
}

// (Old search/recent functions removed — now handled by locationSearch.js module)

// ═════════════════════════════════════════
//  EVENTS
// ═════════════════════════════════════════
function attachSpotsEvents() {
  // ─── Location search (autocomplete module) ───
  if (_searchCleanup) { _searchCleanup(); _searchCleanup = null; }
  const searchContainer = document.getElementById('spots-search-container');
  if (searchContainer) {
    _searchCleanup = initLocationSearch(searchContainer, {
      placeholder: _loc?.city || 'עיר, אזור או סוג (חוף, פסגה...)',
      showGpsButton: true,
      showCloseButton: false,
      extractType: extractTypeFromQuery,
      onSelect: (result) => {
        _loc = { lat: result.lat, lon: result.lon, city: result.city };
        saveLocation(result.lat, result.lon, result.city);
        if (_map) _map.jumpTo({ center: [result.lon, result.lat], zoom: 11 });
        if (_userMarker) _userMarker.setLngLat([result.lon, result.lat]);
        // Apply type filter if detected from original query
        if (result._detectedType) {
          _filterType = result._detectedType;
          document.querySelectorAll('.spot-filter-pill').forEach(b =>
            b.classList.toggle('active', b.dataset.filter === result._detectedType));
        }
        showToast(`מעדכן תחזית ל: ${result.city}`, 'info');
        window.dispatchEvent(new CustomEvent('twilight:setLocation', {
          detail: { lat: result.lat, lon: result.lon, city: result.city }
        }));
      },
      onGps: async () => {
        haptic('medium');
        const perm = await checkLocationPermission();
        if (perm === 'denied') {
          showToast('הגישה למיקום נחסמה — שנה בהגדרות הדפדפן', 'error');
          return;
        }
        showToast('מאתר מיקום...', 'info');
        try {
          const pos = await getGPS();
          if (pos.isFallback || pos.permDenied) {
            showToast('לא ניתן לאתר מיקום', 'error');
            return;
          }
          _loc = pos;
          const city = await fetchCityName(pos.lat, pos.lon);
          saveLocation(pos.lat, pos.lon, city);
          showToast(`מעדכן תחזית ל: ${city}`, 'info');
          if (_map) _map.jumpTo({ center: [pos.lon, pos.lat], zoom: 11 });
          if (_userMarker) _userMarker.setLngLat([pos.lon, pos.lat]);
          window.dispatchEvent(new CustomEvent('twilight:setLocation', {
            detail: { lat: pos.lat, lon: pos.lon, city }
          }));
        } catch { showToast('לא ניתן לאתר מיקום', 'error'); }
      }
    });
  }

  document.getElementById('map-expand-btn')?.addEventListener('click', () => {
    haptic('light');
    const wrap = document.getElementById('spot-map-wrap');
    const btn = document.getElementById('map-expand-btn');
    if (!wrap) return;
    const expanding = !wrap.classList.contains('map-fullscreen');
    wrap.classList.toggle('map-fullscreen');
    if (btn) btn.innerHTML = expanding
      ? '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>'
      : '<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    setTimeout(() => { if (_map) _map.resize(); }, 320);
  });

  document.getElementById('sort-smart')?.addEventListener('click', () => { haptic('light'); setSortMode('smart'); });
  document.getElementById('sort-score')?.addEventListener('click', () => { haptic('light'); setSortMode('score'); });
  document.getElementById('sort-dist')?.addEventListener('click', () => { haptic('light'); setSortMode('dist'); });

  document.querySelectorAll('.radius-pill').forEach(btn => {
    btn.addEventListener('click', async () => {
      haptic('light');
      const r = parseInt(btn.dataset.radius);
      if (r === _radiusKm) return;
      _radiusKm = r;
      document.querySelectorAll('.radius-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const sub = document.querySelector('.spot-main-sub');
      if (sub) sub.textContent = `נקודות תצפית לדמדומים · ${_radiusKm} ק"מ סביבך`;
      await loadSpots();
    });
  });

  document.querySelectorAll('.spot-filter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      haptic('light');
      _filterType = btn.dataset.filter;
      _visibleCount = 15;
      document.querySelectorAll('.spot-filter-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderSpotsList();
      updateMapMarkers(getFilteredSpots());
    });
  });

  // Drawer overlay close — removed
}

function setSortMode(mode) {
  _sortMode = mode;
  _visibleCount = 15;
  document.querySelectorAll('.sort-pill:not(.radius-pill)').forEach(b => b.classList.remove('active'));
  document.getElementById(`sort-${mode}`)?.classList.add('active');
  renderSpotsList();
}

// ═════════════════════════════════════════
//  GLOBALS
// ═════════════════════════════════════════
window.toggleSpot = function(i) {
  const el = document.getElementById(`spot-expand-${i}`);
  const ch = document.getElementById(`spot-chevron-${i}`);
  if (!el) return;
  const isOpen = el.classList.toggle('open');
  if (ch) ch.style.transform = isOpen ? 'rotate(180deg)' : '';
  if (isOpen) {
    _loadSpotPhoto(i);
  } else {
    // Unsubscribe SWR updates when card is collapsed — no point updating
    // a photo the user can't see.
    _photoUnsubs.get(i)?.();
    _photoUnsubs.delete(i);
  }
};

// Map of spot index → unsubscribe function for SWR background notifications.
const _photoUnsubs = new Map();

function _loadSpotPhoto(i) {
  const container = document.getElementById(`spot-photo-${i}`);
  if (!container || container.dataset.loaded) return;
  const sorted = getFilteredSpots();
  const spot = sorted[i];
  if (!spot) return;
  container.dataset.loaded = 'pending';

  // Subscribe to background revalidation: if SWR finds a fresher photo
  // while the card is open, silently swap it in.
  _photoUnsubs.get(i)?.(); // cancel any previous subscription first
  const unsub = subscribeSpotImage(spot, (fresh) => {
    const c = document.getElementById(`spot-photo-${i}`);
    if (!c || c.dataset.loaded !== 'ok') return;
    // Only upgrade — don't downgrade from a real photo to a generic one.
    const prev = c._spotPhotoResult;
    if (prev?._isGenericSunset || prev?._isStaticMap || !prev?.score || (fresh.score ?? 0) > (prev.score ?? 0)) {
      _renderSpotPhotoResult(c, spot, fresh, i);
    }
  });
  _photoUnsubs.set(i, unsub);

  fetchSpotImage(spot).then(result => {
    if (!result || !result.url) result = pickGenericSunset(spot);
    container.dataset.loaded = 'ok';
    _renderSpotPhotoResult(container, spot, result, i);
  }).catch(() => {
    const result = pickGenericSunset(spot);
    container.dataset.loaded = 'ok';
    _renderSpotPhotoResult(container, spot, result, i);
  });
}

function _renderSpotPhotoResult(container, spot, result, i) {
  // Stash the latest descriptor so global handlers (onerror, thumbs-down,
  // map toggle) can read fallback URLs without a closure.
  container._spotPhotoResult = result;
  container._spotPhotoSpot   = spot;

  const credit = result.credit ? esc(result.credit).slice(0, 60) : '';
  const page   = result.pageUrl || result.url;
  const label  = result.sourceLabel || '';
  const isStaticMap     = !!result._isStaticMap;
  const isFallback      = !!result._isFallback;
  const isGenericSunset = !!result._isGenericSunset;

  // Static map → render OSM tile mosaic + sunset-direction arrow + retry button.
  if (isStaticMap) {
    const ssAz = getSunsetAzimuth();
    const dirLabel = _azDirLabel(ssAz);
    const sunsetTime = _weekData?.[0]?.sunset || '';
    const grid = result._tileGrid;
    container.classList.add('spot-photo-staticmap');
    const tilesHtml = grid ? grid.tiles.map(t =>
      `<img class="spot-tile" src="${t.url}" alt="" loading="lazy" decoding="async"
            style="grid-column:${t.gridCol + 1};grid-row:${t.gridRow + 1}"
            onerror="this.style.background='rgba(40,28,18,0.8)';this.removeAttribute('src')">`
    ).join('') : '';
    // 3×3 grid → marker (and arrow) sit at the spot's actual position within the
    // grid, which is always within the central third (≈33%–67%). No shift needed.
    const markerLeft = grid ? (grid.markerX * 100).toFixed(2) : '50';
    const markerTop  = grid ? (grid.markerY * 100).toFixed(2) : '50';
    container.innerHTML = `
      <a href="${page}" target="_blank" rel="noopener" class="spot-photo-link">
        <div class="spot-tile-grid" style="grid-template-columns:repeat(${grid?.cols || 3},1fr);grid-template-rows:repeat(${grid?.rows || 3},1fr)">
          ${tilesHtml}
        </div>
        <div class="spot-photo-marker" style="left:${markerLeft}%;top:${markerTop}%" aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="6" fill="#E25A3A" stroke="#fff" stroke-width="2"/></svg>
        </div>
        <div class="spot-photo-arrow" style="left:${markerLeft}%;top:${markerTop}%;transform: translate(-50%, -50%) rotate(${ssAz}deg)" aria-hidden="true">
          <svg width="80" height="80" viewBox="0 0 80 80" fill="none">
            <circle cx="40" cy="40" r="30" fill="rgba(255,180,80,0.12)" stroke="rgba(255,200,120,0.55)" stroke-width="1.5" stroke-dasharray="3 3"/>
            <path d="M40 12 L50 32 L40 27 L30 32 Z" fill="#FFD088" stroke="#7A4818" stroke-width="1.2"/>
          </svg>
        </div>
        <div class="spot-photo-credit">
          מפת לוויין · השקיעה ${sunsetTime ? `ב־${sunsetTime} ` : ''}מכיוון ${dirLabel}
        </div>
      </a>
      <button class="spot-photo-retry" onclick="event.stopPropagation();window._retrySpotPhoto(${i})" title="חפש שוב תמונה">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
        חפש תמונה
      </button>`;
    return;
  }

  // Generic SVG fallback (offline) — non-clickable wrapper.
  if (isFallback) {
    container.innerHTML = `
      <div class="spot-photo-link spot-photo-fallback">
        <img src="${result.url}" alt="${esc(spot.name)}" loading="lazy" decoding="async" width="640" height="360">
        <div class="spot-photo-credit"></div>
      </div>`;
    return;
  }

  // Curated generic sunset from the local pool.
  if (isGenericSunset) {
    container.classList.add('spot-photo-generic');
    const creditTxt = credit ? `תמונת אווירה — ${credit}` : 'תמונת אווירה כללית';
    const wrapStart = page
      ? `<a href="${page}" target="_blank" rel="noopener" class="spot-photo-link">`
      : `<div class="spot-photo-link">`;
    const wrapEnd = page ? `</a>` : `</div>`;
    container.innerHTML = `
      ${wrapStart}
        <img src="${result.url}" alt="${esc(spot.name)}" loading="lazy" decoding="async" width="640" height="360"
          onerror="window._handleImgError(${i}, this)">
        <div class="spot-photo-credit">${creditTxt}</div>
      ${wrapEnd}
      <div class="spot-photo-actions">
        <button class="spot-photo-btn" onclick="event.stopPropagation();window._showSpotMap(${i})" title="הצג מפה">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
          מפה
        </button>
        <button class="spot-photo-btn" onclick="event.stopPropagation();window._retrySpotPhoto(${i})" title="חפש תמונה אחרת">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          חפש תמונה
        </button>
      </div>`;
    return;
  }

  // Real photo from Wikimedia/etc.
  // Honest UX: when the result came from a wide-area / lenient source,
  // tell the user it's a representative image of the area, not the spot itself.
  const isAreaPhoto = !!result._isAreaPhoto;
  const prefix = isAreaPhoto ? 'תמונה מהאזור' : 'צילום';
  container.innerHTML = `
    <a href="${page}" target="_blank" rel="noopener" class="spot-photo-link">
      <img src="${result.url}" alt="${esc(spot.name)}" loading="lazy" decoding="async" width="640" height="360"
        onload="window._checkImgDimensions(${i}, this)"
        onerror="window._handleImgError(${i}, this)">
      <div class="spot-photo-credit">${prefix}: ${label}${credit ? ' — ' + credit : ''}</div>
    </a>
    <button class="spot-photo-thumbs" onclick="event.stopPropagation();window._rejectSpotPhoto(${i})" title="התמונה לא טובה">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zM17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>
    </button>`;
}

function _azDirLabel(az) {
  const a = ((az % 360) + 360) % 360;
  if (a >= 247.5 && a < 292.5) return 'מערב';
  if (a >= 202.5 && a < 247.5) return 'דרום־מערב';
  if (a >= 292.5 && a < 337.5) return 'צפון־מערב';
  if (a >= 157.5 && a < 202.5) return 'דרום';
  if (a >= 337.5 || a < 22.5)  return 'צפון';
  if (a >= 22.5 && a < 67.5)   return 'צפון־מזרח';
  if (a >= 67.5 && a < 112.5)  return 'מזרח';
  return 'דרום־מזרח';
}

window._retrySpotPhoto = function(i) {
  const sorted = getFilteredSpots();
  const spot = sorted[i];
  if (!spot) return;
  invalidateSpotImage(spot);
  const container = document.getElementById(`spot-photo-${i}`);
  if (!container) return;
  // Reset and re-trigger load
  container.dataset.loaded = '';
  container.classList.remove('spot-photo-empty', 'spot-photo-staticmap', 'spot-photo-generic');
  container.innerHTML = `
    <div class="spot-photo-skeleton">
      <svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
        <circle cx="12" cy="12" r="4"/>
        <path d="M2 17l6-6 5 5 3-3 6 6"/>
      </svg>
    </div>`;
  haptic('light');
  _loadSpotPhoto(i);
};

// Preflight: called via onload on every real Wikimedia photo.
// Silently rejects portrait (h > w×1.1) or tiny (w < 200) images
// before the user even sees them, then falls back to generic sunset.
window._checkImgDimensions = function(i, imgEl) {
  if (!imgEl) return;
  const w = imgEl.naturalWidth;
  const h = imgEl.naturalHeight;
  if (!w || !h) return; // browser didn't expose dimensions yet — ignore
  const isPortrait = h > w * 1.1;
  const isTiny     = w < 200;
  if (isPortrait || isTiny) {
    window._handleImgError(i, imgEl); // rejects URL + swaps to generic
  }
};

// Hard-fail recovery: an <img> failed to load (404, CORS, network blip).
// Strategy:
//  1. If failing image was from the curated pool → walk its _poolFallbacks.
//  2. Otherwise → mark URL rejected so we don't pick it again, swap to a
//     generic sunset (instant, local, always works).
// Guarantees: never an empty container.
window._handleImgError = function(i, imgEl) {
  if (!imgEl) return;
  imgEl.onerror = null;
  const container = document.getElementById(`spot-photo-${i}`);
  if (!container) return;
  const result = container._spotPhotoResult;
  const spot   = container._spotPhotoSpot;

  // Walk through pool fallbacks in place — no re-render needed.
  if (result?._isGenericSunset && result._poolFallbacks?.length) {
    const next = result._poolFallbacks.shift();
    imgEl.onerror = () => window._handleImgError(i, imgEl);
    imgEl.src = next;
    return;
  }

  // Real-photo failure → blacklist URL and swap to generic sunset.
  if (spot && imgEl.src) {
    try { rejectSpotImageUrl(spot, imgEl.src); } catch (_) {}
  }
  if (spot) {
    const fallback = pickGenericSunset(spot);
    container.dataset.loaded = 'ok';
    _renderSpotPhotoResult(container, spot, fallback, i);
  } else {
    // No spot context (defensive) → just hide the broken image.
    imgEl.remove();
    container.classList.add('spot-photo-empty');
  }
};

// User said "this image isn't good" → blacklist + reload.
window._rejectSpotPhoto = function(i) {
  const sorted = getFilteredSpots();
  const spot = sorted[i];
  const container = document.getElementById(`spot-photo-${i}`);
  if (!spot || !container) return;
  const result = container._spotPhotoResult;
  if (result?.url) {
    try { rejectSpotImageUrl(spot, result.url); } catch (_) {}
  }
  haptic('light');
  // _retrySpotPhoto will call fetchSpotImage → which respects the rejected list.
  window._retrySpotPhoto(i);
};

// User wants to see where the spot is → swap card to static-map view.
window._showSpotMap = function(i) {
  const sorted = getFilteredSpots();
  const spot = sorted[i];
  const container = document.getElementById(`spot-photo-${i}`);
  if (!spot || !container) return;
  const map = getStaticMapForSpot(spot);
  if (!map) return;
  container.classList.remove('spot-photo-generic');
  haptic('light');
  _renderSpotPhotoResult(container, spot, map, i);
};
window._toggleFav = function(i) {
  const sorted = getFilteredSpots();
  const s = sorted[i];
  if (!s) return;
  toggleFavorite(s.name, s.lat, s.lon);
  renderSpotsList();
  updateMapMarkers(getFilteredSpots());
};
window._toggleVisited = function(i) {
  const sorted = getFilteredSpots();
  const s = sorted[i];
  if (!s) return;
  toggleVisited(s.name, s.lat, s.lon);
  haptic('light');
  renderSpotsList();
  updateMapMarkers(getFilteredSpots());
};
window._shareSpot = function(i) {
  const sorted = getFilteredSpots();
  const s = sorted[i];
  if (!s || !navigator.share) return;
  const sc = s._allScores?.[0]?.combined ?? 5;
  navigator.share({
    title: s.name,
    text: `${s.name}: ${fmtScore(sc)}/10`,
    url: `https://maps.google.com/?q=${s.lat},${s.lon}`
  }).catch(() => {});
};

// ✓ spots-screen.js v6 — MapLibre GL JS vector map
