// ═══════════════════════════════════════════
//  TWILIGHT — app.js
//  Entry point: boot sequence, navigation wiring
// ═══════════════════════════════════════════

import { initNav, showScreen, onScreenChange } from './nav.js';
import { getGPS, saveLocation, loadLocation }  from './location.js';
import { fetchWeek, fetchWeekFast, fetchWeekEnsemble, fetchCityName, fetchAirQuality, fetchWesternHorizon } from './api.js';
import { calcWeekData }                        from './score.js';
import { initMainScreen, showMainSkeleton, repaintScoreColors, refreshMainScores } from './main-screen.js';
import { initSpotsScreen, calcNearbyAvgScore, preloadSpotsData, invalidatePreloadedSpots } from './spots-screen.js';
import { initSettingsScreen }                  from './settings-screen.js';
import { initLearningScreen }                  from './learning-screen.js';
import { showToast, showLoading }              from './ui.js';
import { registerSW }                          from './sw-register.js';
import { clearExpired, getCacheAge, getStaleCacheWithAge, subscribe, isZoneCacheFresh } from './cache.js';
import { recordPrediction, fetchActualForDate, getUnfilledDates, processLearningForEntry } from './calibration.js';
import { seedFromBacktest, getLearningStats, pinLearningSnapshot }  from './engine/learningEngine.js';
import { initInstallPrompt }                   from './install-prompt.js';
import { rearmSavedAlerts }                    from './notifications.js';
import { initOnboarding }                      from './onboarding.js';
import { scoreToLabel } from './utils.js';
import { getZoneForCoord } from './zones.js';

// ─────────────────────────────────────────
//  Score EMA — smooth scores across page loads to reduce noise from
//  model-availability variance and minor API fluctuations.
//  α=0.35: new data contributes 35%, cached 65%.
//  Bypass if |delta| > 1.5 (genuine weather change — accept immediately).
// ─────────────────────────────────────────
const _SCORE_EMA_ALPHA  = 0.35;
const _SCORE_EMA_BYPASS = 1.5;
const _SCORE_PIN_KEY    = 'twl_score_pin';

function _scoreWeatherHash(day) {
  // Fingerprint of the key weather inputs — hash change triggers pin reset
  return `${Math.round(day._cloudRaw)}_${Math.round(day._humidityRaw)}_${Math.round(day._visibilityRaw)}_${day.date}`;
}

function _applyScoreEMA(weekData, loc) {
  if (!weekData?.length) return weekData;
  try {
    const pinKey = `${_SCORE_PIN_KEY}_${loc.lat.toFixed(2)}_${loc.lon.toFixed(2)}`;
    const cached = JSON.parse(localStorage.getItem(pinKey) || '{}');
    const updated = {};

    const smoothed = weekData.map(day => {
      const hash   = _scoreWeatherHash(day);
      const pinned = cached[day.date];
      let finalScore = day.score;

      if (pinned && pinned.hash === hash && Math.abs(pinned.score - day.score) < _SCORE_EMA_BYPASS) {
        // Same weather fingerprint + small delta → apply EMA smoothing
        finalScore = Math.round(
          (pinned.score * (1 - _SCORE_EMA_ALPHA) + day.score * _SCORE_EMA_ALPHA) * 10
        ) / 10;
      }

      updated[day.date] = { hash, score: finalScore };
      return {
        ...day,
        score:      finalScore,
        scoreLabel: scoreToLabel(finalScore),
      };
    });

    localStorage.setItem(pinKey, JSON.stringify(updated));
    return smoothed;
  } catch (_) {
    return weekData; // localStorage unavailable — silently skip
  }
}

// ─────────────────────────────────────────
//  Idle spot preload — deferred until browser is idle so it never
//  competes with the critical render path. Falls back to setTimeout
//  on browsers that don't support requestIdleCallback (e.g. Safari < 16).
// ─────────────────────────────────────────
function _scheduleSpotPreload(weekData, loc) {
  const run = () => preloadSpotsData(weekData, loc).catch(e => console.warn('[spots] preload failed:', e.message));
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 8000 });
  } else {
    setTimeout(run, 4000);
  }
}

// ─────────────────────────────────────────
//  State
// ─────────────────────────────────────────
let _weekData = null;
let _loc      = null;
let _city     = '';
let _airQuality      = null;
let _spotsInitialized    = false;
let _isRefreshing        = false; // FIX: debounce guard for refresh
let _locGen              = 0;    // monotonic counter — guards stale async callbacks

// ─────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────
async function boot() {
  // SWR handles data freshness — no need for session-based forced refresh.
  // Zone-aware cache with dynamic TTL ensures data is revalidated at the
  // right frequency (2-4h, shorter near sunrise/sunset).

  registerSW();
  window.addEventListener('twilight:updateReady', () => {
    // Auto-reload when a new SW takes control. A brief banner shows
    // what's happening so users aren't surprised by the refresh.
    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.style.cssText = [
      'position:fixed;top:0;left:0;right:0;z-index:9999',
      'background:var(--amber);color:#fff;text-align:center',
      'padding:10px 16px;font-size:14px;font-weight:600',
      'box-shadow:0 2px 8px rgba(0,0,0,0.3);direction:rtl',
    ].join(';');
    banner.textContent = 'גרסה חדשה — מעדכן…';
    document.body.appendChild(banner);
    setTimeout(() => location.reload(), 800);
  });
  clearExpired();
  rearmSavedAlerts();
  initNav();
  initInstallPrompt();
  initOnboarding();

  showMainSkeleton();
  showLoading(true);

  // Hard timeout safety net — if anything hangs (geolocation popup, slow network),
  // force an error after 30s instead of infinite loading
  const bootTimeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Boot timeout (30s) — בדוק חיבור לאינטרנט')), 30000)
  );

  // FIX: register setLocation listener *before* loadAppData so GPS events
  // fired during boot (e.g. during autoSeedIfNeeded or fetchWeek awaits)
  // are not silently dropped before the handler is attached.
  window.addEventListener('twilight:setLocation', handleSetLocation);

  try {
    await Promise.race([loadAppData(), bootTimeout]);
  } catch (err) {
    console.error('[boot] Failed:', err);
    showToast('שגיאה בטעינת נתונים — לחץ לנסות שוב', 'error');
    const errMsg = (err && (err.message || err.toString())) || 'unknown';
    document.querySelector('#screen-main').innerHTML =
      `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:60vh;gap:1rem;padding:1rem;text-align:center">
         <p style="color:var(--cream);font-size:1.1rem">שגיאה בטעינת נתונים</p>
         <p style="color:var(--cream);font-size:.75rem;opacity:.6;direction:ltr;max-width:90%;word-break:break-word">${errMsg}</p>
         <button onclick="location.reload()" style="padding:.6rem 1.4rem;background:var(--amber);border:none;border-radius:8px;color:#fff;font-size:1rem;cursor:pointer">נסה שוב</button>
         <button onclick="navigator.serviceWorker?.getRegistrations().then(rs=>Promise.all(rs.map(r=>r.unregister()))).then(()=>caches.keys().then(ks=>Promise.all(ks.map(k=>caches.delete(k))))).then(()=>location.reload())" style="padding:.5rem 1rem;background:transparent;border:1px solid var(--cream);border-radius:8px;color:var(--cream);font-size:.85rem;cursor:pointer">נקה מטמון ונסה שוב</button>
       </div>`;
  } finally {
    showLoading(false);
  }

  // Post-boot reconciliation: if GPS saved a location to localStorage while
  // loadAppData was running (and the event was queued/dropped), sync now.
  // Uses coordinate mismatch — not isFallback — to detect any state divergence.
  await syncLocationFromState();

  // ─── Screen change handler ───
  onScreenChange(async (id) => {
    if (id === 'spots' && !_weekData) {
      showToast('תחזית עדיין נטענת, המתן רגע...', 'info');
      return;
    }
    if (id === 'spots') {
      _spotsInitialized = true;
      await initSpotsScreen(_weekData);
      repaintScoreColors(); // immediate live sky colors on spots screen
    }
    if (id === 'settings') {
      initSettingsScreen();
    }
    if (id === 'learning') {
      initLearningScreen();
    }
  });

  window.addEventListener('twilight:refresh', handleRefresh);
  window.addEventListener('twilight:toast', (e) => {
    showToast(e.detail?.msg || '', e.detail?.type || 'info');
  });
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

// ─────────────────────────────────────────
//  Post-boot / post-resume location reconciliation
//  Compares localStorage against the currently rendered _loc.
//  If there is a coordinate mismatch, triggers a full re-fetch for the
//  stored location. This is the authoritative sync path — it does not
//  depend on event delivery timing.
// ─────────────────────────────────────────
async function syncLocationFromState() {
  const stored = loadLocation();
  if (!stored) return;
  if (!_loc || _loc.lat !== stored.lat || _loc.lon !== stored.lon) {
    await handleSetLocation({ detail: stored });
  }
}

// ─────────────────────────────────────────
//  Auto-seed learning engine on first launch
//  Runs only if sampleSize < 50 (new install or after clear)
//  learning-seed.json is precached by the SW → works offline too
// ─────────────────────────────────────────
async function autoSeedIfNeeded() {
  try {
    if (getLearningStats().sampleSize >= 50) return; // already trained
    const res = await fetch('./learning-seed.json');
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data.entries)) return;
    // Already sorted oldest-first in the file — no re-sort needed
    const result = seedFromBacktest(data.entries);
    console.log(`[boot] auto-seed: +${result.added} entries, total ${result.total}`);
  } catch (e) {
    console.warn('[boot] auto-seed skipped:', e.message);
  }
}

let _unsubWeather = null; // cleanup for SWR weather subscription

/**
 * Rewire the SWR zone subscription when location changes.
 * Unsubscribes from the old zone and subscribes to the new one.
 * Called from loadAppData, handleSetLocation, and handleRefresh.
 */
function _rewireZoneSubscription(lat, lon, gen) {
  if (_unsubWeather) _unsubWeather();
  const zone = getZoneForCoord(lat, lon);
  _unsubWeather = subscribe(`weather_zone_${zone.zoneId}`, (freshWeather) => {
    if (gen !== _locGen) return;
    const locSnap = { lat, lon };
    _weekData = _applyScoreEMA(
      calcWeekData(freshWeather, _airQuality, locSnap.lat, locSnap.lon, null),
      locSnap
    );
    refreshMainScores(_weekData, calcNearbyAvgScore(null, _weekData));
    console.log('[swr] background revalidation → UI updated');
  });
}

async function loadAppData() {
  _isRefreshing = true; // prevent concurrent handleSetLocation during boot
  try {
  const saved = loadLocation();
  if (saved) {
    _loc  = saved;
    _city = saved.city || 'מיקומך';
  } else {
    // Non-blocking GPS: boot immediately with Tel Aviv placeholder (not saved),
    // then refresh automatically when GPS resolves in the background.
    _loc  = { lat: 32.0853, lon: 34.7818, isFallback: true };
    _city = 'מאתר מיקום...';
    getGPS().then(async pos => {
      if (pos.permDenied) {
        showToast('הגישה למיקום נחסמה — ניתן לחפש מיקום ידנית', 'info');
        _city = 'תל אביב';
        return;
      }
      if (pos.isFallback) {
        showToast('לא ניתן לאתר מיקום — מציג תחזית לתל אביב', 'info');
        return;
      }
      const city = await fetchCityName(pos.lat, pos.lon);
      saveLocation(pos.lat, pos.lon, city);
      window.dispatchEvent(new CustomEvent('twilight:setLocation', {
        detail: { lat: pos.lat, lon: pos.lon, city }
      }));
    }).catch(() => {
      showToast('לא ניתן לאתר מיקום — מציג תחזית לתל אביב', 'info');
    });
  }

  // Capture location generation + immutable coordinate snapshot.
  // All awaits below may yield to handleSetLocation which mutates _loc,
  // so we must use locSnap for all calculations, not the live _loc reference.
  _locGen++;
  const gen = _locGen;
  const locSnap = { lat: _loc.lat, lon: _loc.lon };

  // ── Subscribe to SWR background revalidation ──
  _rewireZoneSubscription(locSnap.lat, locSnap.lon, gen);

  // ── Start seed + all fetches concurrently ──
  // fetchWeekFast uses zone-aware SWR: returns cache instantly if available,
  // revalidates in background if stale (subscribers notified automatically).
  const seedPromise    = autoSeedIfNeeded();
  const weatherPromise = fetchWeekFast(locSnap.lat, locSnap.lon);
  const aqPromise      = fetchAirQuality(locSnap.lat, locSnap.lon).catch(() => null);
  const westPromise    = fetchWesternHorizon(locSnap.lat, locSnap.lon).catch(() => null);

  // Wait for seed before pinning learning snapshot
  await seedPromise;
  pinLearningSnapshot();

  // ── Phase 1: Render with primary weather model ──
  const weather = await weatherPromise;
  if (gen !== _locGen) return; // location changed during await — abort
  _weekData = calcWeekData(weather, null, locSnap.lat, locSnap.lon, null);
  await initMainScreen({ lat: locSnap.lat, lon: locSnap.lon }, _city, _weekData, null);

  // Stale-data / offline banner
  if (weather._isStale) {
    showToast('אין חיבור לאינטרנט — מציג נתונים שמורים', 'warn');
  }

  // ── Phase 2: Enrich with non-critical data (AQ, horizon) ──
  const [airQ, westData] = await Promise.all([aqPromise, westPromise]);
  if (gen !== _locGen) return; // location changed during boot — abort stale writes
  _airQuality = airQ;

  // Recalculate only if we got additional data
  if (airQ || westData) {
    _weekData = calcWeekData(weather, airQ, locSnap.lat, locSnap.lon, westData);
  }
  const spotAvgScores = calcNearbyAvgScore(null, _weekData);

  // ── Phase 3: Background ensemble refinement ──
  // Only runs if weather was actually fetched fresh (not from cache).
  // The SWR subscription above handles the case where stale data was served
  // and fresh data arrives later.
  const wasFreshFetch = !weather._isStale && weather._modelCount === 1;
  if (wasFreshFetch) {
    fetchWeekEnsemble(locSnap.lat, locSnap.lon, weather, true).then(async refined => {
      if (!refined || gen !== _locGen) return;
      _weekData = _applyScoreEMA(
        calcWeekData(refined, airQ, locSnap.lat, locSnap.lon, westData),
        locSnap
      );
      const freshSpotScores = calcNearbyAvgScore(null, _weekData);
      refreshMainScores(_weekData, freshSpotScores);
      console.log(`[boot] ensemble refinement applied (${refined._modelCount} models)`);
    }).catch(err => console.warn('[boot] ensemble refinement failed:', err.message));
  } else if (weather._isStale) {
    // Offline — apply EMA to whatever we have
    _weekData = _applyScoreEMA(_weekData, locSnap);
  }

  if (gen !== _locGen) return;
  refreshMainScores(_weekData, spotAvgScores);

  _scheduleSpotPreload(_weekData, { lat: locSnap.lat, lon: locSnap.lon });
  updateThemeColor(_weekData);

  if (_weekData[0]) {
    recordPrediction(_weekData[0].date, _weekData[0].score, _weekData[0], locSnap.lat, locSnap.lon);
  }

  if (gen !== _locGen) return;
  const unfilled = getUnfilledDates();
  if (unfilled.length > 0) {
    const ssHour = parseInt(_weekData[0]?.sunset?.split(':')[0] || '18', 10);
    Promise.allSettled(
      unfilled.slice(0, 3).map(dt =>
        fetchActualForDate(dt, locSnap.lat, locSnap.lon, ssHour)
          .then(() => processLearningForEntry(dt))
      )
    ).then(results => {
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) console.warn(`[calibration] ${failed} backfill(s) failed`);
    });
  }

  if (saved && !saved.city) {
    fetchCityName(locSnap.lat, locSnap.lon).then(city => {
      _city = city;
      saveLocation(locSnap.lat, locSnap.lon, city);
    }).catch(e => console.warn('[boot] city name fetch failed:', e.message));
  }

  } finally {
    _isRefreshing = false;
    // Drain queued location if GPS resolved during boot
    if (_pendingLocation) {
      const pending = _pendingLocation;
      _pendingLocation = null;
      handleSetLocation({ detail: pending });
    }
  }
}

// ─────────────────────────────────────────
//  Refresh handler
//  Refreshes weather data for the current saved location.
//  Only re-detects GPS when event carries { detail: { gps: true } }
//  (GPS button in location search bar).
// ─────────────────────────────────────────
async function handleRefresh(e) {
  if (_isRefreshing) return;
  _isRefreshing = true;
  showLoading(true);
  try {
    // Re-detect GPS only when explicitly requested (GPS button).
    // Normal refresh uses the saved location to avoid coordinate drift
    // that would create a stale EMA pin at a slightly different lat/lon key.
    if (e?.detail?.gps) {
      const freshLoc = await getGPS();
      if (freshLoc.permDenied) {
        showToast('הגישה למיקום נחסמה — שנה בהגדרות הדפדפן', 'error');
        // Continue refresh with existing _loc
      } else if (!freshLoc.isFallback) {
        _loc  = freshLoc;
        _city = await fetchCityName(freshLoc.lat, freshLoc.lon);
        saveLocation(freshLoc.lat, freshLoc.lon, _city);
      } else {
        _city = 'תל אביב';
        showToast('לא ניתן לאתר מיקום — מציג תחזית לתל אביב', 'info');
      }
    }

    _locGen++;
    const gen = _locGen;
    const lat = _loc.lat, lon = _loc.lon;

    // Rewire SWR subscription to the (possibly new) zone
    _rewireZoneSubscription(lat, lon, gen);

    // Clear the EMA score pin so a forced refresh always shows fresh scores
    // without smoothing from a previous session.
    const pinKey = `${_SCORE_PIN_KEY}_${lat.toFixed(2)}_${lon.toFixed(2)}`;
    localStorage.removeItem(pinKey);

    // Start all fetches concurrently
    const weatherPromise = fetchWeekFast(lat, lon, true);
    const aqPromise      = fetchAirQuality(lat, lon, true).catch(() => null);
    const westPromise    = fetchWesternHorizon(lat, lon, true).catch(() => null);

    // Render as soon as primary weather arrives
    const weather = await weatherPromise;
    _weekData = calcWeekData(weather, null, lat, lon, null);
    await initMainScreen(_loc, _city, _weekData, calcNearbyAvgScore(null, _weekData));
    showLoading(false);

    // Enrich with non-critical data
    const [airQ, westData] = await Promise.all([aqPromise, westPromise]);
    if (gen !== _locGen) return;
    _airQuality = airQ;
    if (airQ || westData) {
      _weekData = _applyScoreEMA(
        calcWeekData(weather, airQ, lat, lon, westData),
        { lat, lon }
      );
      refreshMainScores(_weekData, calcNearbyAvgScore(null, _weekData));
    }

    // Background ensemble refinement (force=true → always a fresh fetch)
    fetchWeekEnsemble(lat, lon, weather, true).then(refined => {
      if (!refined || gen !== _locGen) return;
      _weekData = _applyScoreEMA(
        calcWeekData(refined, airQ, lat, lon, westData),
        { lat, lon }
      );
      refreshMainScores(_weekData, calcNearbyAvgScore(null, _weekData));
    }).catch(err => console.warn('[refresh] ensemble failed:', err.message));

    showToast('נתונים עודכנו', 'success');

    _spotsInitialized = false;
    invalidatePreloadedSpots();
    _scheduleSpotPreload(_weekData, _loc);
  } catch (err) {
    console.error('[refresh]', err);
    showToast('עדכון נכשל', 'error');
  } finally {
    showLoading(false);
    _isRefreshing = false;
    // Drain queued location if one arrived while we were refreshing
    if (_pendingLocation) {
      const pending = _pendingLocation;
      _pendingLocation = null;
      handleSetLocation({ detail: pending });
    }
  }
}


// ─────────────────────────────────────────
//  Manual location handler
//  Triggered by twilight:setLocation custom event
// ─────────────────────────────────────────
let _pendingLocation = null; // queued location while refresh is in progress

async function handleSetLocation(e) {
  const { lat, lon, city } = e.detail || {};
  if (!lat || !lon) return;
  if (_isRefreshing) {
    // Queue — will be processed when current refresh completes (see finally block)
    _pendingLocation = e.detail;
    return;
  }
  _isRefreshing = true;
  showLoading(true);
  try {
    _loc  = { lat, lon };
    _city = city || 'מיקום מותאם';
    saveLocation(lat, lon, _city);

    _locGen++;
    const gen = _locGen;

    // Rewire SWR subscription to the new zone
    _rewireZoneSubscription(lat, lon, gen);

    // Clear EMA pin for the new location so scores aren't smoothed against
    // a previous session's data at a different spot.
    const pinKey = `${_SCORE_PIN_KEY}_${lat.toFixed(2)}_${lon.toFixed(2)}`;
    localStorage.removeItem(pinKey);

    // Start all fetches concurrently
    const weatherPromise = fetchWeekFast(lat, lon, true);
    const aqPromise      = fetchAirQuality(lat, lon, true).catch(() => null);
    const westPromise    = fetchWesternHorizon(lat, lon, true).catch(() => null);

    // Render as soon as primary weather arrives
    const weather = await weatherPromise;
    _weekData = calcWeekData(weather, null, lat, lon, null);
    await initMainScreen(_loc, _city, _weekData, calcNearbyAvgScore(null, _weekData));
    showLoading(false);

    // Enrich with non-critical data
    const [airQ, westData] = await Promise.all([aqPromise, westPromise]);
    if (gen !== _locGen) return;
    _airQuality = airQ;
    if (airQ || westData) {
      _weekData = _applyScoreEMA(
        calcWeekData(weather, airQ, lat, lon, westData),
        { lat, lon }
      );
      refreshMainScores(_weekData, calcNearbyAvgScore(null, _weekData));
    }

    // Background ensemble refinement (location change → always a fresh fetch)
    fetchWeekEnsemble(lat, lon, weather, true).then(refined => {
      if (!refined || gen !== _locGen) return;
      _weekData = _applyScoreEMA(
        calcWeekData(refined, airQ, lat, lon, westData),
        { lat, lon }
      );
      refreshMainScores(_weekData, calcNearbyAvgScore(null, _weekData));
    }).catch(err => console.warn('[setLocation] ensemble failed:', err.message));

    updateThemeColor(_weekData);
    showToast(`מיקום עודכן: ${_city}`, 'success');

    invalidatePreloadedSpots();
    _scheduleSpotPreload(_weekData, _loc);

    // If spots screen is currently active, re-init it with fresh forecast
    if (_spotsInitialized) {
      await initSpotsScreen(_weekData);
    }
    _spotsInitialized = false;
  } catch (err) {
    console.error('[setLocation]', err);
    showToast('עדכון מיקום נכשל', 'error');
  } finally {
    showLoading(false);
    _isRefreshing = false;
    // Drain queued location if one arrived while we were refreshing
    if (_pendingLocation) {
      const pending = _pendingLocation;
      _pendingLocation = null;
      handleSetLocation({ detail: pending });
    }
  }
}

// ─────────────────────────────────────────
//  Visibility handler — zone-aware
//  Only refreshes if the zone's cached weather data has actually expired.
//  Eliminates unnecessary API calls when returning from background.
// ─────────────────────────────────────────
let _lastVisible = Date.now();

function handleVisibilityChange() {
  if (document.hidden) {
    _lastVisible = Date.now();
  } else {
    const zone = _loc ? getZoneForCoord(_loc.lat, _loc.lon) : null;
    if (zone && !isZoneCacheFresh(zone.zoneId)) {
      // Zone data expired — refresh
      handleRefresh();
    } else {
      // Zone data still fresh — just sync location state
      syncLocationFromState();
    }
  }
}

// ─────────────────────────────────────────
//  Start
// ─────────────────────────────────────────
boot();

// ─────────────────────────────────────────
//  Dynamic theme-color (4a)
//  Updates <meta name="theme-color"> based on score + time of day
// ─────────────────────────────────────────
let _themeInterval = null;

export function updateThemeColor(weekData) {
  if (_themeInterval) clearInterval(_themeInterval);

  const apply = () => {
    const today = weekData?.[0];
    if (!today) return;

    const score = today.score || 5;
    const now   = new Date();
    const [ssH, ssM] = (today.sunset || '19:00').split(':').map(Number);
    const sunset = new Date();
    sunset.setHours(ssH, ssM, 0, 0);
    const diffMin = (sunset - now) / 60000; // positive = before sunset

    let color;
    if (diffMin > 0 && diffMin <= 60) {
      // Golden hour approaching — score-driven warm tones
      if (score >= 8)      color = '#B84A00'; // deep amber-red
      else if (score >= 6) color = '#8B3A0E'; // warm brown-orange
      else                 color = '#4A2208'; // muted — clouds expected
    } else if (diffMin < 0 && diffMin >= -40) {
      // Post-sunset civil twilight — shift to blue-purple
      if (score >= 7)      color = '#2A1060'; // dramatic purple
      else                 color = '#1A0840'; // deep blue
    } else if (now.getHours() >= 22 || now.getHours() < 5) {
      color = '#0D0608';                       // near-black for night
    } else {
      // Daytime — score tints the default brown
      if (score >= 8)      color = '#5A2A0C';
      else if (score >= 6) color = '#4A2008';
      else                 color = '#3B1F08'; // default
    }

    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
  };

  apply();
  _themeInterval = setInterval(apply, 60000); // re-check every minute
}

// ✎ fixed: single visibilitychange listener (removed duplicate)
// ✎ fixed: _isRefreshing flag — prevents parallel refresh on rapid clicks
// ✎ fixed: onScreenChange — guard toast when _weekData not yet ready
// ✎ fixed: spots always re-initialised on every visit (removed stale init flag logic)
// ✎ added: stale data warning (>6h cache age)
// ✎ added: dynamic theme-color based on score + time of day
// ✓ app.js — complete
