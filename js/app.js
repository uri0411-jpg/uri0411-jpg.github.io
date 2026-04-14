// ═══════════════════════════════════════════
//  TWILIGHT — app.js
//  Entry point: boot sequence, navigation wiring
// ═══════════════════════════════════════════

import { initNav, showScreen, onScreenChange } from './nav.js';
import { getGPS, saveLocation, loadLocation }  from './location.js';
import { fetchWeek, fetchWeekFast, fetchWeekEnsemble, fetchCityName, fetchAirQuality, fetchWesternHorizon } from './api.js';
import { calcWeekData }                        from './score.js';
import { initMainScreen, showMainSkeleton, repaintScoreColors, refreshMainScores } from './main-screen.js';
import { initSpotsScreen, calcNearbyAvgScore, preloadSpotsData, invalidatePreloadedSpots, prefetchAreaTiles } from './spots-screen.js';
import { initSettingsScreen }                  from './settings-screen.js';
import { initLearningScreen }                  from './learning-screen.js';
import { showToast, showLoading }              from './ui.js';
import { registerSW }                          from './sw-register.js';
import { clearExpired, getCacheAge, getStaleCacheWithAge, subscribe as subscribeCache, isZoneCacheFresh } from './cache.js';
import { recordPrediction, fetchActualForDate, getUnfilledDates, processLearningForEntry } from './calibration.js';
import { seedFromBacktest, getLearningStats, pinLearningSnapshot }  from './engine/learningEngine.js';
import { initInstallPrompt }                   from './install-prompt.js';
import { rearmSavedAlerts }                    from './notifications.js';
import { initOnboarding }                      from './onboarding.js';
import { scoreToLabel, distKm, deepFreeze } from './utils.js';
import { getZoneForCoord } from './zones.js';
import { getState, setState, bumpLocGen, bumpDataGen, isStale, isDataStale } from './store.js';

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
    const zone = getZoneForCoord(loc.lat, loc.lon);
    const pinKey = `${_SCORE_PIN_KEY}_z_${zone.zoneId}`;
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
  const run = () => {
    preloadSpotsData(weekData, loc).catch(e => console.warn('[spots] preload failed:', e.message));
    // Also prefetch map tiles for the user's area so the Spot Finder map loads instantly
    prefetchAreaTiles(loc.lat, loc.lon);
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(run, { timeout: 8000 });
  } else {
    setTimeout(run, 4000);
  }
}

// ── Observability (Contract 6) ──────────────────────────────────────────
window.__twl_debug = window.__twl_debug || {
  staleDrops:      0,  // isStale blocked a state write
  renderFails:     0,  // render stage threw an exception
  cacheMisses:     0,  // cache key not found
  cacheRejects:    0,  // cache entry deleted due to version mismatch
  locChangeFails:  0,  // handleSetLocation catch — location change failure
};

// ─────────────────────────────────────────
//  State — centralised in store.js
//  Convenience accessors for readability in this file.
// ─────────────────────────────────────────

// ─────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────
async function boot() {
  const _bootTime = Date.now();

  registerSW();
  window.addEventListener('twilight:updateReady', () => {
    // During the first few seconds of boot, data fetches are still in-flight.
    // A reload now would interrupt them and show an error.  Show a manual
    // reload banner instead; auto-reload only after boot has settled.
    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.style.cssText = [
      'position:fixed;top:0;left:0;right:0;z-index:9999',
      'background:var(--amber);color:#fff;text-align:center',
      'padding:10px 16px;font-size:14px;font-weight:600',
      'box-shadow:0 2px 8px rgba(0,0,0,0.3);direction:rtl',
    ].join(';');

    if (Date.now() - _bootTime < 5000) {
      banner.textContent = 'גרסה חדשה זמינה — לחץ לעדכן';
      banner.style.cursor = 'pointer';
      banner.addEventListener('click', () => location.reload());
      document.body.appendChild(banner);
    } else {
      banner.textContent = 'גרסה חדשה — מעדכן…';
      document.body.appendChild(banner);
      setTimeout(() => location.reload(), 800);
    }
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
    setTimeout(() => {
      setState({ bootAborted: true }); // Contract 1: abort stale promises after timeout
      reject(new Error('Boot timeout (30s) — בדוק חיבור לאינטרנט'));
    }, 30000)
  );

  // FIX: register setLocation listener *before* loadAppData so GPS events
  // fired during boot (e.g. during autoSeedIfNeeded or fetchWeek awaits)
  // are not silently dropped before the handler is attached.
  window.addEventListener('twilight:setLocation', handleSetLocation);

  try {
    await Promise.race([loadAppData(), bootTimeout]);
  } catch (err) {
    console.error('[boot] Failed:', err);
    const isTimeout = err?.message?.includes('timeout') || err?.message?.includes('Boot timeout');
    const isNetwork = err?.name === 'TypeError' || err?.message?.includes('fetch');
    const userMsg = isTimeout ? 'הזמן הקצוב חלף — בדוק חיבור לאינטרנט'
                  : isNetwork ? 'שגיאת רשת — בדוק חיבור לאינטרנט'
                  : 'שגיאה בטעינת נתונים — לחץ לנסות שוב';
    showToast(userMsg, 'error');
    const errMsg = ((err && (err.message || err.toString())) || 'unknown')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  // Contract 1: skip after boot timeout to avoid stale state drift
  if (!getState().bootAborted) await syncLocationFromState();

  // ─── Screen change handler ───
  onScreenChange(async (id) => {
    if (id === 'spots' && !getState().weekData) {
      showToast('תחזית עדיין נטענת, המתן רגע...', 'info');
      return;
    }
    if (id === 'spots') {
      setState({ spotsInitialized: true });
      await initSpotsScreen(getState().weekData);
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
  const _loc = getState().loc;
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
    const seedCtrl = new AbortController();
    const seedTimer = setTimeout(() => seedCtrl.abort(), 5000); // 5s max — don't block boot
    const res = await fetch('./learning-seed.json', { signal: seedCtrl.signal });
    clearTimeout(seedTimer);
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

// ── Zone stability state (Contract 4) ───────────────────────────────────────
let _currentZoneId = null;
let _lastZoneRefreshMs = 0;
let _lastZoneRefreshLat = null;
let _lastZoneRefreshLon = null;
const ZONE_DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const ZONE_MIN_DIST_KM = 2;             // 2 km Haversine

/**
 * Rewire the SWR zone subscription when location changes.
 * Unsubscribes from the old zone and subscribes to the new one.
 * Called from loadAppData, handleSetLocation, and handleRefresh.
 */
function _rewireZoneSubscription(lat, lon, gen) {
  if (_unsubWeather) _unsubWeather();
  const zone = getZoneForCoord(lat, lon);
  _currentZoneId = zone.zoneId;
  _unsubWeather = subscribeCache(`weather_zone_${zone.zoneId}`, (freshWeather) => {
    if (isStale(gen)) return;
    const locSnap = deepFreeze({ lat, lon });
    const weekData = _applyScoreEMA(
      calcWeekData(freshWeather, getState().airQuality, locSnap.lat, locSnap.lon, null),
      locSnap
    );
    setState({ weekData });
    refreshMainScores(weekData, calcNearbyAvgScore(null, weekData));
    console.log('[swr] background revalidation → UI updated');
  });
}

async function loadAppData() {
  setState({ isRefreshing: true }); // prevent concurrent handleSetLocation during boot
  try {
  // ── Location resolution (separated from data fetch for clear error messages) ──
  const saved = loadLocation();
  if (saved) {
    setState({ loc: saved, city: saved.city || 'מיקומך', locationResolved: true });
  } else {
    // Non-blocking GPS: boot immediately with Tel Aviv placeholder (not saved),
    // then refresh automatically when GPS resolves in the background.
    setState({ loc: { lat: 32.0853, lon: 34.7818, isFallback: true }, city: 'מאתר מיקום...' });
    getGPS().then(async pos => {
      if (pos.permDenied) {
        showToast('הגישה למיקום נחסמה — ניתן לחפש מיקום ידנית', 'info');
        setState({ city: 'תל אביב', locationResolved: true });
        return;
      }
      if (pos.isFallback) {
        showToast('לא ניתן לאתר מיקום — מציג תחזית לתל אביב', 'info');
        setState({ locationResolved: true });
        return;
      }
      if (isStale(gen)) return; // Contract 2: GPS resolved after location changed
      const city = await fetchCityName(pos.lat, pos.lon);
      if (isStale(gen)) return; // Contract 2: revalidate after async fetch
      saveLocation(pos.lat, pos.lon, city);
      window.dispatchEvent(new CustomEvent('twilight:setLocation', {
        detail: { lat: pos.lat, lon: pos.lon, city }
      }));
    }).catch(() => {
      showToast('לא ניתן לאתר מיקום — מציג תחזית לתל אביב', 'info');
      setState({ locationResolved: true });
    });
    // Mark resolved for fallback — GPS will trigger setLocation event when ready
    setState({ locationResolved: true });
  }

  // Capture location generation + immutable coordinate snapshot.
  // All awaits below may yield to handleSetLocation which mutates loc,
  // so we must use locSnap for all calculations, not the live state reference.
  const gen = bumpLocGen();
  const dg  = bumpDataGen();
  const { loc } = getState();
  const locSnap = deepFreeze({ lat: loc.lat, lon: loc.lon });

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
  if (isStale(gen)) return; // location changed during await — abort
  if (isDataStale(dg)) return; // newer data fetch started — abort
  if (!weather?.daily?.time?.length || !weather?.hourly?.time?.length) {
    throw new Error('נתוני מזג אוויר ריקים — נסה שוב');
  }
  let weekData = calcWeekData(weather, null, locSnap.lat, locSnap.lon, null);
  setState({ weekData });
  await initMainScreen({ lat: locSnap.lat, lon: locSnap.lon }, getState().city, weekData, null);

  // Stale-data / offline banner
  if (weather._isStale) {
    showToast('אין חיבור לאינטרנט — מציג נתונים שמורים', 'warn');
  }

  // ── Phase 2: Enrich with non-critical data (AQ, horizon) ──
  const [airQ, westData] = await Promise.all([aqPromise, westPromise]);
  if (isStale(gen)) return; // location changed during boot — abort stale writes
  setState({ airQuality: airQ });

  // Recalculate only if we got additional data
  if (airQ || westData) {
    weekData = calcWeekData(weather, airQ, locSnap.lat, locSnap.lon, westData);
    setState({ weekData });
  }
  const spotAvgScores = calcNearbyAvgScore(null, weekData);

  // ── Phase 3: Background ensemble refinement ──
  // Only runs if weather was actually fetched fresh (not from cache).
  // The SWR subscription above handles the case where stale data was served
  // and fresh data arrives later.
  const wasFreshFetch = !weather._isStale && weather._modelCount === 1;
  if (wasFreshFetch) {
    fetchWeekEnsemble(locSnap.lat, locSnap.lon, weather, true).then(async refined => {
      if (!refined || isStale(gen)) return;
      const ensembleData = _applyScoreEMA(
        calcWeekData(refined, airQ, locSnap.lat, locSnap.lon, westData),
        locSnap
      );
      setState({ weekData: ensembleData });
      const freshSpotScores = calcNearbyAvgScore(null, ensembleData);
      refreshMainScores(ensembleData, freshSpotScores);
      console.log(`[boot] ensemble refinement applied (${refined._modelCount} models)`);
    }).catch(err => console.warn('[boot] ensemble refinement failed:', err.message));
  } else if (weather._isStale) {
    // Offline — apply EMA to whatever we have
    weekData = _applyScoreEMA(weekData, locSnap);
    setState({ weekData });
  }

  if (isStale(gen)) return;
  refreshMainScores(weekData, spotAvgScores);

  _scheduleSpotPreload(weekData, { lat: locSnap.lat, lon: locSnap.lon });
  updateThemeColor(weekData);

  if (weekData[0]) {
    recordPrediction(weekData[0].date, weekData[0].score, weekData[0], locSnap.lat, locSnap.lon);
  }

  if (isStale(gen)) return;
  const unfilled = getUnfilledDates();
  if (unfilled.length > 0) {
    const ssHour = parseInt(weekData[0]?.sunset?.split(':')[0] || '18', 10);
    Promise.allSettled(
      unfilled.slice(0, 3).map(dt =>
        fetchActualForDate(dt, locSnap.lat, locSnap.lon, ssHour)
          .then(() => {
            if (isStale(gen)) return; // Contract 2: revalidate before learning write
            processLearningForEntry(dt);
          })
      )
    ).then(results => {
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) console.warn(`[calibration] ${failed} backfill(s) failed`);
    });
  }

  if (saved && !saved.city) {
    fetchCityName(locSnap.lat, locSnap.lon).then(city => {
      if (isStale(gen)) return; // Contract 2: revalidate before state write
      setState({ city });
      saveLocation(locSnap.lat, locSnap.lon, city);
    }).catch(e => console.warn('[boot] city name fetch failed:', e.message));
  }

  } finally {
    setState({ isRefreshing: false });
    // Drain queued location if GPS resolved during boot
    // Contract 1: skip drain after boot timeout to avoid cascading stale loads
    if (_pendingLocation && !getState().bootAborted) {
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
  if (getState().isRefreshing) return;
  setState({ isRefreshing: true, bootAborted: false }); // Contract 1: reset abort flag
  showLoading(true);
  try {
    // Re-detect GPS only when explicitly requested (GPS button).
    // Normal refresh uses the saved location to avoid coordinate drift
    // that would create a stale EMA pin at a slightly different lat/lon key.
    if (e?.detail?.gps) {
      const freshLoc = await getGPS();
      if (freshLoc.permDenied) {
        showToast('הגישה למיקום נחסמה — שנה בהגדרות הדפדפן', 'error');
        // Continue refresh with existing loc
      } else if (!freshLoc.isFallback) {
        const city = await fetchCityName(freshLoc.lat, freshLoc.lon);
        setState({ loc: freshLoc, city });
        saveLocation(freshLoc.lat, freshLoc.lon, city);
      } else {
        setState({ city: 'תל אביב' });
        showToast('לא ניתן לאתר מיקום — מציג תחזית לתל אביב', 'info');
      }
    }

    const gen = bumpLocGen();
    const { loc } = getState();
    const lat = loc.lat, lon = loc.lon;

    // Rewire SWR subscription to the (possibly new) zone
    _rewireZoneSubscription(lat, lon, gen);

    // Clear the EMA score pin so a forced refresh always shows fresh scores
    // without smoothing from a previous session.
    const pinZone = getZoneForCoord(lat, lon);
    const pinKey = `${_SCORE_PIN_KEY}_z_${pinZone.zoneId}`;
    localStorage.removeItem(pinKey);

    // Start all fetches concurrently
    const weatherPromise = fetchWeekFast(lat, lon, true);
    const aqPromise      = fetchAirQuality(lat, lon, true).catch(() => null);
    const westPromise    = fetchWesternHorizon(lat, lon, true).catch(() => null);

    // Render as soon as primary weather arrives
    const weather = await weatherPromise;
    if (!weather?.daily?.time?.length || !weather?.hourly?.time?.length) {
      throw new Error('EMPTY_WEATHER_DATA');
    }
    let weekData = calcWeekData(weather, null, lat, lon, null);
    setState({ weekData });
    await initMainScreen(getState().loc, getState().city, weekData, calcNearbyAvgScore(null, weekData));
    showLoading(false);

    // Enrich with non-critical data
    const [airQ, westData] = await Promise.all([aqPromise, westPromise]);
    if (isStale(gen)) return;
    setState({ airQuality: airQ });
    if (airQ || westData) {
      weekData = _applyScoreEMA(
        calcWeekData(weather, airQ, lat, lon, westData),
        { lat, lon }
      );
      setState({ weekData });
      refreshMainScores(weekData, calcNearbyAvgScore(null, weekData));
    }

    // Background ensemble refinement (force=true → always a fresh fetch)
    fetchWeekEnsemble(lat, lon, weather, true).then(refined => {
      if (!refined || isStale(gen)) return;
      const ensembleData = _applyScoreEMA(
        calcWeekData(refined, airQ, lat, lon, westData),
        { lat, lon }
      );
      setState({ weekData: ensembleData });
      refreshMainScores(ensembleData, calcNearbyAvgScore(null, ensembleData));
    }).catch(err => console.warn('[refresh] ensemble failed:', err.message));

    showToast('נתונים עודכנו', 'success');

    setState({ spotsInitialized: false });
    invalidatePreloadedSpots();
    _scheduleSpotPreload(weekData, getState().loc);
  } catch (err) {
    console.error('[refresh]', err);
    const msg = err?.message === 'EMPTY_WEATHER_DATA'
      ? 'אין נתונים זמינים כרגע'
      : err?.name === 'TypeError' || err?.message?.includes('fetch')
        ? 'שגיאת רשת — נסה שוב'
        : 'עדכון נכשל';
    showToast(msg, 'error');
  } finally {
    showLoading(false);
    setState({ isRefreshing: false });
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
  setState({ bootAborted: false }); // Contract 1: reset abort flag on intentional location change
  if (getState().isRefreshing) {
    // Queue — will be processed when current refresh completes (see finally block)
    _pendingLocation = e.detail;
    return;
  }
  setState({ isRefreshing: true });
  showLoading(true);
  const prevLoc = getState().loc, prevCity = getState().city;
  try {
    const gen = bumpLocGen();
    setState({ loc: { lat, lon }, city: city || 'מיקום מותאם', locationResolved: true });

    // Rewire SWR subscription to the new zone
    _rewireZoneSubscription(lat, lon, gen);

    // Clear EMA pin for the new location so scores aren't smoothed against
    // a previous session's data at a different spot.
    const pinZone = getZoneForCoord(lat, lon);
    const pinKey = `${_SCORE_PIN_KEY}_z_${pinZone.zoneId}`;
    localStorage.removeItem(pinKey);

    // Zone-aware SWR: serve from cache if zone already has fresh data (0 API calls).
    // force=true is reserved for handleRefresh (manual pull-to-refresh).
    const weatherPromise = fetchWeekFast(lat, lon);
    const aqPromise      = fetchAirQuality(lat, lon).catch(() => null);
    const westPromise    = fetchWesternHorizon(lat, lon).catch(() => null);

    // Render as soon as primary weather arrives
    const weather = await weatherPromise;
    if (isStale(gen)) return; // location changed while waiting — discard
    if (!weather?.daily?.time?.length || !weather?.hourly?.time?.length) {
      throw new Error('EMPTY_WEATHER_DATA');
    }
    let weekData = calcWeekData(weather, null, lat, lon, null);
    setState({ weekData });
    const st = getState();
    await initMainScreen(st.loc, st.city, weekData, calcNearbyAvgScore(null, weekData));
    saveLocation(lat, lon, st.city); // persist only after successful render
    showLoading(false);

    // Enrich with non-critical data
    const [airQ, westData] = await Promise.all([aqPromise, westPromise]);
    if (isStale(gen)) return;
    setState({ airQuality: airQ });
    if (airQ || westData) {
      weekData = _applyScoreEMA(
        calcWeekData(weather, airQ, lat, lon, westData),
        { lat, lon }
      );
      setState({ weekData });
      refreshMainScores(weekData, calcNearbyAvgScore(null, weekData));
    }

    // Background ensemble refinement — only if weather was actually fetched (not from cache)
    const wasFresh = !weather._isStale && weather._modelCount === 1;
    wasFresh && fetchWeekEnsemble(lat, lon, weather, true).then(refined => {
      if (!refined || isStale(gen)) return;
      const ensembleData = _applyScoreEMA(
        calcWeekData(refined, airQ, lat, lon, westData),
        { lat, lon }
      );
      setState({ weekData: ensembleData });
      refreshMainScores(ensembleData, calcNearbyAvgScore(null, ensembleData));
    }).catch(err => console.warn('[setLocation] ensemble failed:', err.message));

    updateThemeColor(weekData);
    showToast(`מיקום עודכן: ${getState().city}`, 'success');

    invalidatePreloadedSpots();
    _scheduleSpotPreload(weekData, getState().loc);

    // If spots screen is currently active, re-init it with fresh forecast.
    // Reset flag first to prevent double-init on next tab switch.
    const wasActive = getState().spotsInitialized;
    setState({ spotsInitialized: false });
    if (wasActive) {
      setState({ spotsInitialized: true });
      await initSpotsScreen(weekData);
    }
  } catch (err) {
    console.error('[setLocation]', err?.message || err);
    // Restore previous state so the app isn't stuck pointing at a failed location
    setState({ loc: prevLoc, city: prevCity });
    if (typeof window !== 'undefined' && window.__twl_debug) window.__twl_debug.locChangeFails++;
    const msg = err?.message === 'EMPTY_WEATHER_DATA'
      ? 'אין נתונים זמינים כרגע'
      : err?.name === 'TypeError' || err?.message?.includes('fetch')
        ? 'שגיאת רשת — נסה שוב'
        : 'עדכון מיקום נכשל';
    showToast(msg, 'error');
  } finally {
    showLoading(false);
    setState({ isRefreshing: false });
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
    const { loc } = getState();
    const zone = loc ? getZoneForCoord(loc.lat, loc.lon) : null;

    // Contract 4: Zone transition requires debounce + distance
    let zoneChanged = false;
    if (zone && _currentZoneId && zone.zoneId !== _currentZoneId) {
      const timeSince = Date.now() - _lastZoneRefreshMs;
      const dist = (_lastZoneRefreshLat != null)
        ? distKm(loc.lat, loc.lon, _lastZoneRefreshLat, _lastZoneRefreshLon)
        : Infinity;

      zoneChanged = timeSince >= ZONE_DEBOUNCE_MS && dist >= ZONE_MIN_DIST_KM;

      if (!zoneChanged) {
        console.log(`[zone] suppressed: dt=${(timeSince / 1000).toFixed(0)}s, dist=${dist.toFixed(1)}km`);
      }
    }

    if (zoneChanged || (zone && !isZoneCacheFresh(zone.zoneId))) {
      if (zoneChanged) {
        _lastZoneRefreshMs = Date.now();
        _lastZoneRefreshLat = loc.lat;
        _lastZoneRefreshLon = loc.lon;
      }
      handleRefresh();
    } else {
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
