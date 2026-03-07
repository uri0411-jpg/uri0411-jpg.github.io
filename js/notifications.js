// notifications.js - התראות זריחה ושקיעה (4 סוגים)
(() => {
  const STORAGE_KEY = "twilight_notif_v2";

  function load() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch { return {}; } }
  function save(s) { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }

  function getTodayScore() {
    const el = document.getElementById("sunset-score");
    if (!el) return null;
    const v = parseInt(el.textContent);
    return isNaN(v) ? null : v;
  }

  function fire(tag, fireAt, title, body) {
    const delay = fireAt - Date.now();
    if (delay < 0) return;
    setTimeout(() => {
      navigator.serviceWorker?.ready.then(reg => {
        reg.showNotification("דמדומים — " + title, {
          body, icon: "./icons/icon-192.png", badge: "./icons/icon-192.png",
          tag, renotify: true, vibrate: [200, 100, 200],
        });
      });
    }, delay);
  }

  function scheduleAll(loc) {
    if (!window.SunCalc || !loc) return;
    const s = load();
    const sun = window.SunCalc.calc(loc.lat, loc.lon);

    if (s.notifSunsetOn && sun.sunset)
      fire("sunset-reminder", sun.sunset.getTime() - (s.sunsetMin||30)*60000,
        `שקיעה בעוד ${s.sunsetMin||30} דקות 🌇`, "הגיע הזמן לצאת החוצה!");

    if (s.notifSunriseOn && sun.sunrise)
      fire("sunrise-reminder", sun.sunrise.getTime() - (s.sunriseMin||30)*60000,
        `זריחה בעוד ${s.sunriseMin||30} דקות 🌄`, "הגיע הזמן לצאת החוצה!");

    if (s.notifSunsetScoreOn && sun.sunset) {
      const score = getTodayScore();
      if (score !== null && score >= (s.sunsetScoreThreshold||7))
        fire("sunset-quality", sun.sunset.getTime() - (s.sunsetScoreMin||60)*60000,
          `שקיעה מיוחדת בעוד ${s.sunsetScoreMin||60} דקות 🌇⭐`, `ציון ${score}/10 — כדאי לצאת!`);
    }

    if (s.notifSunriseScoreOn && sun.sunrise) {
      const score = getTodayScore();
      if (score !== null && score >= (s.sunriseScoreThreshold||7))
        fire("sunrise-quality", sun.sunrise.getTime() - (s.sunriseScoreMin||60)*60000,
          `זריחה מיוחדת בעוד ${s.sunriseScoreMin||60} דקות 🌄⭐`, `ציון ${score}/10 — כדאי לצאת!`);
    }
  }

  function updateStatus() {
    const el  = document.getElementById("notifStatus");
    const btn = document.getElementById("notifPermBtn");
    if (!el) return;
    if (!("Notification" in window)) {
      el.textContent = "התראות אינן נתמכות בדפדפן זה";
      el.className = "notif-status notif-status--warn";
      if (btn) btn.style.display = "none"; return;
    }
    const p = Notification.permission;
    if (p === "granted") {
      el.textContent = "✓ התראות מופעלות";
      el.className = "notif-status notif-status--ok";
      if (btn) btn.style.display = "none";
    } else if (p === "denied") {
      el.textContent = "⚠️ חסומות — שחרר בהגדרות הדפדפן";
      el.className = "notif-status notif-status--warn";
      if (btn) btn.style.display = "none";
    } else {
      el.textContent = "";
      if (btn) btn.style.display = "block";
    }
  }

  async function requestPerm() {
    await Notification.requestPermission();
    updateStatus();
    if (Notification.permission === "granted" && window.__twilightLoc)
      scheduleAll(window.__twilightLoc);
  }

  function wireToggle(id, rowId, key) {
    const chk = document.getElementById(id);
    const row = document.getElementById(rowId);
    if (!chk || !row) return;
    chk.checked = !!load()[key];
    row.style.display = chk.checked ? "block" : "none";
    chk.addEventListener("change", () => {
      row.style.display = chk.checked ? "block" : "none";
      const s = load(); s[key] = chk.checked; save(s);
      if (chk.checked && Notification.permission !== "granted") requestPerm();
      else if (window.__twilightLoc) scheduleAll(window.__twilightLoc);
    });
  }

  function wireRange(rangeId, valId, key) {
    const range = document.getElementById(rangeId);
    const val   = document.getElementById(valId);
    if (!range || !val) return;
    range.value = load()[key] || range.value;
    val.textContent = range.value;
    range.addEventListener("input", () => {
      val.textContent = range.value;
      const s = load(); s[key] = Number(range.value); save(s);
      if (window.__twilightLoc) scheduleAll(window.__twilightLoc);
    });
  }

  function wireUI() {
    const section = document.getElementById("notifSection");
    if (!section) return;
    section.style.display = "block";
    updateStatus();

    document.getElementById("btnRequestNotif")?.addEventListener("click", requestPerm);

    wireToggle("notifSunsetOn",      "sunsetTimingRow",  "notifSunsetOn");
    wireRange ("sunsetMin",          "sunsetMinVal",      "sunsetMin");

    wireToggle("notifSunriseOn",     "sunriseTimingRow", "notifSunriseOn");
    wireRange ("sunriseMin",         "sunriseMinVal",     "sunriseMin");

    wireToggle("notifSunsetScoreOn", "sunsetScoreRow",   "notifSunsetScoreOn");
    wireRange ("sunsetScore",        "sunsetScoreVal",    "sunsetScoreThreshold");
    wireRange ("sunsetScoreMin",     "sunsetScoreTimeVal","sunsetScoreMin");

    wireToggle("notifSunriseScoreOn","sunriseScoreRow",  "notifSunriseScoreOn");
    wireRange ("sunriseScore",       "sunriseScoreVal",   "sunriseScoreThreshold");
    wireRange ("sunriseScoreMin",    "sunriseScoreTimeVal","sunriseScoreMin");
  }

  document.addEventListener("DOMContentLoaded", wireUI);
  window.addEventListener("twilight:loc", (e) => {
    if (Notification.permission === "granted") scheduleAll(e.detail);
  });
  window.Notifications = { schedule: scheduleAll };
})();
