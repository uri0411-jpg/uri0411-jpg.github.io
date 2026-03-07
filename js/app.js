// app.js - shared utilities + PWA install + geocode
(() => {
  const $ = (id) => document.getElementById(id);

  // ---------- Splash screen
  window.addEventListener("load", () => {
    const splash = $("splash");
    if (!splash) return;
    setTimeout(() => {
      splash.classList.add("hidden");
      setTimeout(() => splash.remove(), 800);
    }, 1800);
  });

  // ---------- PWA install handling
  let deferredPrompt = null;

  function wireInstallButton() {
    const installBtn = $("installBtn");
    if (!installBtn) return;

    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      installBtn.hidden = false;
    });

    installBtn.addEventListener("click", async () => {
      if (!deferredPrompt) {
        alert('כרגע ההתקנה לא זמינה. נסה שוב אחרי רענון או דרך תפריט הדפדפן: Add to Home screen.');
        return;
      }
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      installBtn.hidden = true;
    });

    window.addEventListener("appinstalled", () => {
      installBtn.hidden = true;
      deferredPrompt = null;
    });
  }

  async function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    try {
      await navigator.serviceWorker.register("./sw.js", { scope: "./" });
      await navigator.serviceWorker.ready;
    } catch (e) {
      console.error("SW register failed", e);
    }
  }

  function fmtCoord(n) { return (Math.round(n * 10000) / 10000).toFixed(4); }

  async function getGPS() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("Geolocation לא זמין"));
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy }),
        (err) => reject(new Error(err.message || "שגיאת GPS")),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 }
      );
    });
  }

  async function geocode(q) {
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + encodeURIComponent(q);
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error("Geocode נכשל (" + res.status + ")");
    const data = await res.json();
    if (!data?.length) throw new Error("לא נמצאה תוצאה");
    return { lat: Number(data[0].lat), lon: Number(data[0].lon), name: data[0].display_name };
  }

  function setLocUI(loc) {
    const locInfo   = $("locInfo");
    const locCoords = $("locCoords");
    if (!locInfo) return;
    if (!loc) { locInfo.textContent = "לא נבחר מיקום"; return; }
    locInfo.textContent = loc.name || "מיקום";
    if (locCoords) locCoords.textContent =
      `${fmtCoord(loc.lat)}, ${fmtCoord(loc.lon)}${loc.acc ? " • ±" + Math.round(loc.acc) + "m" : ""}`;
  }

  const STORAGE_KEY = "twilight_loc_v2";
  function loadLoc() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch { return null; } }
  function saveLoc(loc) { localStorage.setItem(STORAGE_KEY, JSON.stringify(loc)); }

  function dispatchLoc(loc) {
    window.__twilightLoc = loc;
    window.dispatchEvent(new CustomEvent("twilight:loc", { detail: loc }));
  }

  async function initCommon() {
    wireInstallButton();
    await registerSW();

    let loc = loadLoc();
    setLocUI(loc);

    if (loc) {
      dispatchLoc(loc);
    } else {
      autoGPS();
    }

    // רענון GPS שקט ברקע
    silentGPSRefresh();

    const btnGps = $("btnGps");
    if (btnGps) {
      btnGps.addEventListener("click", async () => {
        btnGps.disabled = true;
        btnGps.textContent = "טוען...";
        try {
          const g = await getGPS();
          const newLoc = { lat: g.lat, lon: g.lon, acc: g.acc, name: "מיקום נוכחי" };
          saveLoc(newLoc);
          setLocUI(newLoc);
          dispatchLoc(newLoc);
        } catch (e) { alert(e.message || String(e)); }
        finally { btnGps.disabled = false; btnGps.textContent = "📍"; }
      });
    }

    const btnSearch  = $("btnSearch");
    const placeInput = $("placeInput");
    if (btnSearch && placeInput) {
      const origText = btnSearch.textContent;
      btnSearch.addEventListener("click", async () => {
        const q = (placeInput.value || "").trim();
        if (!q) return;
        btnSearch.disabled = true;
        btnSearch.textContent = "מחפש...";
        try {
          const g = await geocode(q);
          const newLoc = { lat: g.lat, lon: g.lon, name: q };
          saveLoc(newLoc);
          setLocUI(newLoc);
          dispatchLoc(newLoc);
        } catch (e) { alert(e.message || String(e)); }
        finally { btnSearch.disabled = false; btnSearch.textContent = origText; }
      });
    }

    window.__twilightLoc = loc;
  }

  async function autoGPS() {
    const el = $("mainContent");
    if (el) el.innerHTML = '<div class="loading-state"><span>📍</span><p>מאתר מיקום…</p></div>';
    try {
      const g = await getGPS();
      const loc = { lat: g.lat, lon: g.lon, acc: g.acc, name: "מיקום נוכחי" };
      saveLoc(loc);
      setLocUI(loc);
      dispatchLoc(loc);
    } catch {
      if (el) el.innerHTML = '<div class="loading-state"><span>🌍</span><p>חפש עיר כדי להתחיל</p></div>';
    }
  }

  async function silentGPSRefresh() {
    try {
      const g = await getGPS();
      const loc = { lat: g.lat, lon: g.lon, acc: g.acc, name: "מיקום נוכחי" };
      saveLoc(loc);
      window.__twilightLoc = loc;
      window.dispatchEvent(new CustomEvent("twilight:loc", { detail: loc }));
    } catch { /* שקט */ }
  }

  // ── שיתוף האפליקציה
  window.shareApp = async function() {
    const url = 'https://uri0411-jpg.github.io/twilight/';
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'דמדומים — תחזית שקיעות וזריחות',
          text: 'אפליקציה לתחזית צבעוניות שקיעות וזריחות 🌅',
          url
        });
      } catch {}
    } else {
      await navigator.clipboard.writeText(url).catch(() => {});
      const btn = $('btnShareApp');
      if (btn) { btn.textContent = '✓ הועתק'; setTimeout(() => { btn.textContent = '📤 שתף'; }, 2000); }
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    initCommon();
  });
})();
