
(() => {
  const DAYS_HE = ['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'];

  function fmtTime(date) {
    return (!date || isNaN(date.getTime())) ? '--:--'
      : date.toLocaleTimeString('he-IL', {hour:'2-digit', minute:'2-digit'});
  }

  function weatherCodeText(code) {
    if (code === 0) return 'בהיר';
    if (code <= 2) return 'מעונן חלקית';
    if (code <= 3) return 'מעונן';
    if (code <= 49) return 'אובך / ערפל';
    if (code <= 67) return 'גשם';
    if (code <= 82) return 'ממטרים';
    return 'סוער';
  }

  function calcScore(cloud, cloudHigh, cloudMid, cloudLow, rain, humid, visKm, windMs, dust, aod, pm25, wcode) {
    const midCloudIdeal = 35 - Math.min(35, Math.abs((cloudMid ?? 25) - 35));
    const highBonus = (cloudHigh ?? 0) > 20 ? Math.min(1.5, (cloudHigh - 20) * 0.03) : 0;
    const lowPenalty = (cloudLow ?? 0) > 40 ? Math.min(1.5, (cloudLow - 40) * 0.03) : 0;
    const cloudScore = Math.max(0, Math.min(4, (midCloudIdeal / 35) * 4 + highBonus - lowPenalty));
    const aodBonus = (aod ?? 0) > 0.1 && (aod ?? 0) < 0.8 ? Math.min(0.8, ((aod ?? 0) - 0.1) * 1.1) : 0;
    const pm25Penalty = (pm25 ?? 0) > 50  ? Math.min(1.5, ((pm25 ?? 0) - 50) * 0.02) : 0;
    const visPenalty = (visKm ?? 20) < 5  ? Math.min(2, (5 - visKm) * 0.4) : 0;
    const windBonus = (windMs ?? 5) >= 5 && (windMs ?? 5) <= 15 ? 0.5 : 0;
    const humidPenalty = (humid ?? 60) > 90 ? 1.0 : 0;
    const rainPenalty = (rain ?? 0) > 80 ? 4.0 : (rain ?? 0) > 40 ? 2.0 : (rain ?? 0) > 15 ? 1.0 : 0;
    const wcodePenalty = wcode >= 95 ? 4.0 : wcode >= 80 ? 2.5 : wcode >= 61 ? 1.8 : wcode >= 45 ? 0.8 : 0;
    const raw = cloudScore + 2 + aodBonus + windBonus - pm25Penalty - visPenalty - humidPenalty - rainPenalty - wcodePenalty;
    return Math.max(1, Math.min(10, Math.round(raw * 10) / 10));
  }

  function qualityInfo(score) {
    if (score >= 8.2) return { label:'מצוין לצפייה', cls:'excellent', barCls:'bar-excellent' };
    if (score >= 6.8) return { label:'טוב מאוד לצפייה', cls:'good', barCls:'bar-good' };
    if (score >= 5.2) return { label:'סביר לצפייה', cls:'fair', barCls:'bar-fair' };
    return { label:'חלש יחסית', cls:'poor', barCls:'bar-poor' };
  }

  async function fetchForecast(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,relative_humidity_2m,visibility,wind_speed_10m,weathercode&daily=weathercode,temperature_2m_max,temperature_2m_min,sunset,sunrise,precipitation_probability_max,cloud_cover_mean&timezone=auto&forecast_days=7`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('שגיאה בנתוני מזג האוויר');
    return res.json();
  }

  async function fetchAirQuality(lat, lon) {
    try {
      const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lat}&longitude=${lon}&hourly=aerosol_optical_depth,dust,pm2_5&timezone=auto&forecast_days=7`;
      const res = await fetch(url);
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  function findClosestHourIdx(eventDate, hourlyTimes) {
    const target = eventDate.getTime();
    let idx = 0, best = Infinity;
    hourlyTimes.forEach((t, i) => {
      const diff = Math.abs(new Date(t).getTime() - target);
      if (diff < best) { best = diff; idx = i; }
    });
    return idx;
  }

  function avgWindow(arr, center, fallback = 0) {
    if (!Array.isArray(arr) || !arr.length) return fallback;
    return arr[Math.max(0, Math.min(arr.length - 1, center))] ?? fallback;
  }

  function scoreForEvent(eventDate, fData, aqData, wcode) {
    const ci = findClosestHourIdx(eventDate, fData.hourly.time);
    const cloud     = avgWindow(fData.hourly.cloud_cover, ci, 40);
    const cloudHigh = avgWindow(fData.hourly.cloud_cover_high, ci, 30);
    const cloudMid  = avgWindow(fData.hourly.cloud_cover_mid, ci, 20);
    const cloudLow  = avgWindow(fData.hourly.cloud_cover_low, ci, 20);
    const rain      = avgWindow(fData.hourly.precipitation_probability, ci, 0);
    const humid     = avgWindow(fData.hourly.relative_humidity_2m, ci, 60);
    const visKm     = avgWindow(fData.hourly.visibility, ci, 18000) / 1000;
    const windMs    = avgWindow(fData.hourly.wind_speed_10m, ci, 8);
    let dust = 0, aod = 0, pm25 = 0;
    if (aqData?.hourly?.time) {
      const aqci = findClosestHourIdx(eventDate, aqData.hourly.time);
      dust = avgWindow(aqData.hourly.dust, aqci, 0);
      aod  = avgWindow(aqData.hourly.aerosol_optical_depth, aqci, 0);
      pm25 = avgWindow(aqData.hourly.pm2_5, aqci, 0);
    }
    return {
      score: calcScore(cloud, cloudHigh, cloudMid, cloudLow, rain, humid, visKm, windMs, dust, aod, pm25, wcode),
      cloud, humid, visKm, windMs, dust,
      weather: weatherCodeText(wcode),
    };
  }

  function pickRecommendations(todayScore, cloud, visKm) {
    const cards = [
      {
        key:'coast',
        title:'חוף',
        copy: visKm >= 12 ? 'צבעים פתוחים והחזר אור חזק על המים.' : 'יכול לעבוד אם הראות עדיין נפתחת בערב.',
        img:'./assets/spots/spot-coast.png',
        weight: visKm >= 12 ? 3 : 1
      },
      {
        key:'mountain',
        title:'הר',
        copy: cloud <= 55 ? 'ראות רחבה וקווי רכס נקיים לשקיעה.' : 'מתאים כשהשמיים חלקית מעוננים.',
        img:'./assets/spots/spot-mountain.png',
        weight: cloud <= 55 ? 3 : 2
      },
      {
        key:'desert',
        title:'מדבר',
        copy: todayScore >= 7 ? 'אופק דרמטי וצבעוניות עמוקה.' : 'עדיף רק אם האוויר נקי יחסית.',
        img:'./assets/spots/spot-desert.png',
        weight: todayScore >= 7 ? 3 : 1
      },
      {
        key:'forest',
        title:'יער',
        copy: 'מתאים למי שמחפש אווירה רכה ומוגנת יותר מרוח.',
        img:'./assets/spots/spot-forest.png',
        weight: 1
      }
    ];
    return cards.sort((a,b)=>b.weight-a.weight).slice(0,3);
  }

  function buildWeekly(data, aqData, loc) {
    const today = new Date();
    const weekly = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      const sun = window.SunCalc?.calc(loc.lat, loc.lon, d);
      const wcode = data.daily.weathercode[i] ?? 0;
      const sunset = sun?.sunset ? scoreForEvent(sun.sunset, data, aqData, wcode) : { score: 5 };
      weekly.push({
        name: i === 0 ? 'היום' : i === 1 ? 'מחר' : DAYS_HE[d.getDay()],
        time: fmtTime(new Date(data.daily.sunset[i])),
        score: sunset.score,
        label: qualityInfo(sunset.score).label
      });
    }
    return weekly;
  }

  function buildDetailCards(data, aqData, loc) {
    const today = new Date();
    const cards = [];
    for (let i = 0; i < 3; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      const cardId = 'd'+i;
      const wcode = data.daily.weathercode[i] ?? 0;
      const sun = window.SunCalc?.calc(loc.lat, loc.lon, d);
      const sunset = scoreForEvent(sun.sunset, data, aqData, wcode);
      const sunrise = scoreForEvent(sun.sunrise, data, aqData, wcode);
      const ssQ = qualityInfo(sunset.score);
      const srQ = qualityInfo(sunrise.score);
      cards.push(`
      <article class="day-card${i===0 ? ' day-card--today':''}">
        <div class="day-header">
          <div>
            <div class="day-name">${i===0?'היום':i===1?'מחר':DAYS_HE[d.getDay()]}</div>
            <div class="day-date">${d.toLocaleDateString('he-IL')}</div>
          </div>
          <div class="weather-summary">${weatherCodeText(wcode)}</div>
        </div>
        <div class="sun-events">
          <div class="sun-event">
            <div class="sun-event-title">זריחה</div>
            <div class="sun-event-time">${fmtTime(sun.sunrise)}</div>
            <div class="score-label"><span>צבעוניות</span><span class="score-value quality-${srQ.cls}">${sunrise.score}/10</span></div>
            <div class="score-bar-track"><div class="score-bar-fill ${srQ.barCls}" style="width:${sunrise.score*10}%"></div></div>
            <div class="score-description quality-${srQ.cls}">${srQ.label}</div>
            <button class="notif-day-btn" id="notif-sunrise-${i}" data-type="sunrise" data-day="${i}" onclick="window.toggleDayNotif(this)">התראה לזריחה</button>
          </div>
          <div class="sun-event">
            <div class="sun-event-title">שקיעה</div>
            <div class="sun-event-time">${fmtTime(sun.sunset)}</div>
            <div class="score-label"><span>צבעוניות</span><span class="score-value quality-${ssQ.cls}">${sunset.score}/10</span></div>
            <div class="score-bar-track"><div class="score-bar-fill ${ssQ.barCls}" style="width:${sunset.score*10}%"></div></div>
            <div class="score-description quality-${ssQ.cls}">${ssQ.label}</div>
            <button class="notif-day-btn" id="notif-sunset-${i}" data-type="sunset" data-day="${i}" onclick="window.toggleDayNotif(this)">התראה לשקיעה</button>
          </div>
        </div>
        <button class="accordion-btn" onclick="toggleAccordion('${cardId}')"><span>פרטי תנאים</span><span class="accordion-arrow" id="arrow-${cardId}">▼</span></button>
        <div class="weather-detail" id="detail-${cardId}">
          <div class="weather-grid">
            <div class="weather-item"><div class="weather-item-icon">☁️</div><div class="weather-item-text">עננות ${Math.round(sunset.cloud)}%</div></div>
            <div class="weather-item"><div class="weather-item-icon">👁</div><div class="weather-item-text">ראות ${sunset.visKm.toFixed(1)} ק"מ</div></div>
            <div class="weather-item"><div class="weather-item-icon">💧</div><div class="weather-item-text">לחות ${Math.round(sunset.humid)}%</div></div>
            <div class="weather-item"><div class="weather-item-icon">🌬</div><div class="weather-item-text">רוח ${sunset.windMs.toFixed(1)} מ'/ש</div></div>
          </div>
        </div>
      </article>`);
    }
    return cards.join('');
  }

  function toggleAccordion(id) {
    document.getElementById('detail-' + id)?.classList.toggle('open');
  }
  window.toggleAccordion = toggleAccordion;

  function render(data, aqData, loc) {
    const container = document.getElementById('mainContent');
    if (!container) return;

    const sunsetTime = new Date(data.daily.sunset[0]);
    const todaySun = window.SunCalc?.calc(loc.lat, loc.lon, new Date()) || null;
    const todayEval = todaySun ? scoreForEvent(todaySun.sunset, data, aqData, data.daily.weathercode[0] ?? 0) : { score:5, cloud:40, visKm:12, weather:'בהיר' };
    const q = qualityInfo(todayEval.score);
    const weekly = buildWeekly(data, aqData, loc);
    const recommendations = pickRecommendations(todayEval.score, todayEval.cloud, todayEval.visKm);

    const html = `
      <section class="forecast-shell">
        <article class="score-card">
          <div class="score-card__top">
            <div class="score-card__label">תחזית שקיעה להיום</div>
            <div class="score-card__score">${todayEval.score}<span style="font-size:.55em">/10</span></div>
            <div class="score-card__desc quality-${q.cls}">${q.label}</div>
          </div>
          <div style="padding:10px 8px 0">
            <div class="score-card__time">${fmtTime(sunsetTime)}</div>
            <div class="conditions">
              <div class="condition">
                <div class="condition__icon">☁️</div>
                <div class="condition__text">עננות ${Math.round(todayEval.cloud)}%</div>
              </div>
              <div class="condition">
                <div class="condition__icon">👁</div>
                <div class="condition__text">ראות ${todayEval.visKm.toFixed(1)} ק"מ</div>
              </div>
              <div class="condition">
                <div class="condition__icon">🌫</div>
                <div class="condition__text">${todayEval.weather}</div>
              </div>
            </div>
          </div>
        </article>

        <section>
          <div class="section-title">תחזית קצרה</div>
          <div class="section-sub">היום בראש, ואחריו הימים הקרובים.</div>
          <div class="weekly-strip" style="margin-top:12px">
            ${weekly.map(day => `
              <div class="mini-day ${day.name==='היום' ? 'mini-day--today':''}">
                <div class="mini-day__name">${day.name}</div>
                <div class="mini-day__score">${day.score}</div>
                <div class="mini-day__time">${day.time}</div>
                <div class="mini-day__hint">${day.label}</div>
              </div>
            `).join('')}
          </div>
        </section>

        <section>
          <div class="section-title">היום כדאי ללכת</div>
          <div class="section-sub">המלצה חכמה לסוג הלוקיישן שמתאים לערב הקרוב.</div>
          <div class="reco-grid" style="margin-top:12px">
            ${recommendations.map(item => `
              <article class="reco-card">
                <img src="${item.img}" alt="${item.title}">
                <div class="reco-card__body">
                  <div class="reco-card__title">${item.title}</div>
                  <div class="reco-card__copy">${item.copy}</div>
                </div>
              </article>
            `).join('')}
          </div>
        </section>

        <section class="week-chart-section">
          <div class="week-chart-title">פירוט לשלושה ימים</div>
          <div class="week-chart-sub">שקיעה, זריחה והתראות לפי היום.</div>
        </section>

        ${buildDetailCards(data, aqData, loc)}
      </section>`;
    container.innerHTML = html;
    restoreNotifButtons();
  }

  async function loadForecast(loc) {
    const container = document.getElementById('mainContent');
    if (container) container.innerHTML = '<div class="loading-state"><span>🌤️</span><p>טוען תחזית...</p></div>';
    try {
      const [data, aqData] = await Promise.all([fetchForecast(loc.lat, loc.lon), fetchAirQuality(loc.lat, loc.lon)]);
      render(data, aqData, loc);
    } catch (e) {
      console.error(e);
      if (container) container.innerHTML = `<div class="loading-state"><span>⚠️</span><p>שגיאה בטעינת התחזית</p></div>`;
    }
  }

  const NOTIF_STEPS = [10,20,30,60];
  window.toggleDayNotif = function(btn){
    const type = btn.dataset.type;
    const dayIdx = parseInt(btn.dataset.day,10);
    const activeKey = `notif_active_${type}_${dayIdx}`;
    const minKey = `notif_min_${type}_${dayIdx}`;
    if (btn.classList.contains('active')) {
      btn.classList.remove('active');
      btn.textContent = type === 'sunset' ? 'התראה לשקיעה' : 'התראה לזריחה';
      localStorage.removeItem(activeKey);
      return;
    }
    const proceed = () => {
      const minBefore = parseInt(localStorage.getItem(minKey)) || 30;
      activateNotif(btn, type, dayIdx, minBefore);
    };
    if (!('Notification' in window)) return;
    if (Notification.permission === 'granted') proceed();
    else if (Notification.permission !== 'denied') Notification.requestPermission().then(p => p === 'granted' && proceed());
  };

  function activateNotif(btn, type, dayIdx, minBefore) {
    const activeKey = `notif_active_${type}_${dayIdx}`;
    const minKey = `notif_min_${type}_${dayIdx}`;
    localStorage.setItem(activeKey, '1');
    localStorage.setItem(minKey, String(minBefore));
    btn.classList.add('active');
    btn.textContent = `✓ ${type === 'sunset' ? 'שקיעה' : 'זריחה'} — ${minBefore} דק׳ לפני`;
  }

  function restoreNotifButtons() {
    for (let i = 0; i < 3; i++) {
      ['sunset','sunrise'].forEach(type => {
        const btn = document.getElementById(`notif-${type}-${i}`);
        if (btn && localStorage.getItem(`notif_active_${type}_${i}`)) {
          const min = parseInt(localStorage.getItem(`notif_min_${type}_${i}`)) || 30;
          activateNotif(btn, type, i, min);
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (window.__twilightLoc) loadForecast(window.__twilightLoc);
  });
  window.addEventListener('twilight:loc', e => loadForecast(e.detail));
  window.Forecast = { load: loadForecast };
})();
