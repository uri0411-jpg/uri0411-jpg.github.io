// forecast.js - תחזית: גרף שבועי + 3 כרטיסי ימים בסגנון גרסה 1
(() => {
  const DAYS_HE   = ['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'];
  const MONTHS_HE = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];

  function fmtTime(date) {
    if (!date || isNaN(date.getTime())) return '--:--';
    return date.toLocaleTimeString('he-IL', { hour:'2-digit', minute:'2-digit' });
  }

  function goldenWindow(date) {
    if (!date || isNaN(date.getTime())) return '';
    return fmtTime(new Date(date.getTime() - 20 * 60 * 1000));
  }

  function weatherCodeEmoji(code) {
    if (code === 0)  return '☀️';
    if (code <= 2)   return '⛅';
    if (code <= 3)   return '☁️';
    if (code <= 49)  return '🌫️';
    if (code <= 67)  return '🌧️';
    if (code <= 77)  return '❄️';
    if (code <= 82)  return '🌦️';
    return '⛈️';
  }

  function weatherCodeText(code) {
    if (code === 0)  return 'שמיים בהירים';
    if (code <= 2)   return 'מעונן חלקית';
    if (code <= 3)   return 'מעונן';
    if (code <= 49)  return 'ערפל';
    if (code <= 67)  return 'גשם';
    if (code <= 77)  return 'שלג';
    if (code <= 82)  return 'ממטרים';
    return 'סופת ברקים';
  }

  /**
   * calcScore — ציון צבעוניות 1-10
   *
   * משתנים ומשקלות:
   *
   * ענן (לפי גובה שכבה) — הכי משפיע
   *   ענן גבוה (סירוס)    = נפלא לצבע, מפזר אור לאדום/כתום
   *   ענן בינוני           = טוב
   *   ענן נמוך (שכבתי)    = פחות טוב, יוצר אפרפר
   *   עננות כוללת: עקומת פעמון, פסגה ב-35-55%
   *
   * חלקיקים (אבק/AOD/PM) — משפיעים חיובית עד רמה מסוימת!
   *   אבק סהרה בינוני      = שקיעות אדומות מהממות (+bonus)
   *   אבק קיצוני / PM גבוה = מפחית נראות (-penalty)
   *
   * נראות — ערפל ≈ גרוע, נראות טובה ≈ ניטרלי
   * רוח    — ניקוי אוויר = קל חיובי
   * לחות   — גבוה = ערפיליות = קל שלילי
   * גשם    — שלילי חד
   */
  function calcScore(cloud, cloudHigh, cloudMid, cloudLow, rain, humid, visKm, windMs, dust, aod, pm25, wcode) {
    // ── ענן כולל: עקומת פעמון ───────────────────────────────────
    let cloudScore;
    if      (cloud < 10)  cloudScore = 3.0;
    else if (cloud < 20)  cloudScore = 3.0 + (cloud - 10) * 0.4;  // 3→7
    else if (cloud < 35)  cloudScore = 7.0 + (cloud - 20) * 0.2;  // 7→10
    else if (cloud < 55)  cloudScore = 10.0;
    else if (cloud < 75)  cloudScore = 10.0 - (cloud - 55) * 0.25; // 10→5
    else if (cloud < 90)  cloudScore = 5.0  - (cloud - 75) * 0.13; // 5→3
    else                  cloudScore = 1.0  + (100 - cloud) * 0.1;

    // ── גובה שכבת הענן: ענן גבוה מעלה ציון, ענן נמוך מוריד ────
    // cloudHigh/Mid/Low הם % כיסוי נפרד
    const highBonus = (cloudHigh ?? 0) > 20 ? Math.min(1.5, (cloudHigh - 20) * 0.03) : 0;
    const lowPenalty = (cloudLow ?? 0) > 40 ? Math.min(1.5, (cloudLow - 40) * 0.03) : 0;
    cloudScore = cloudScore + highBonus - lowPenalty;

    // ── אבק/חלקיקי אוויר ────────────────────────────────────────
    // אבק בינוני (dust 20-100 µg/m³) = bonus (שקיעות אדומות מהממות)
    // אבק קיצוני (>300) = penalty (חוסם אור)
    // AOD 0.2-0.6 = bonus קל
    const dustVal = dust ?? 0;
    let dustEffect = 0;
    if      (dustVal < 20)   dustEffect =  0;
    else if (dustVal < 100)  dustEffect =  (dustVal - 20) * 0.015;  // 0→+1.2
    else if (dustVal < 300)  dustEffect =  1.2 - (dustVal - 100) * 0.004; // +1.2→+0.4
    else                     dustEffect = -Math.min(2, (dustVal - 300) * 0.005);

    const aodVal = aod ?? 0;
    const aodBonus = aodVal > 0.1 && aodVal < 0.8 ? Math.min(0.8, (aodVal - 0.1) * 1.1) : 0;

    // PM2.5 גבוה = ערפל עירוני = מפחית
    const pm25Penalty = (pm25 ?? 0) > 50  ? Math.min(1.5, ((pm25 ?? 0) - 50) * 0.02) : 0;

    // ── נראות ──────────────────────────────────────────────────
    // <5 ק"מ = ערפל, penalty
    // >20 ק"מ = נקי, ניטרלי
    const visPenalty = (visKm ?? 20) < 5  ? Math.min(2, (5 - visKm) * 0.4)
                     : (visKm ?? 20) < 10 ? (10 - visKm) * 0.1
                     : 0;

    // ── רוח: ניקוי אוויר ───────────────────────────────────────
    // רוח 5-15 מ"ש = אוויר נקי = +0.5
    // רוח >20 מ"ש = עננים עפים מהר = -0.3
    const windBonus = (windMs ?? 5) >= 5 && (windMs ?? 5) <= 15 ? 0.5
                    : (windMs ?? 5) > 20 ? -0.3
                    : 0;

    // ── לחות ───────────────────────────────────────────────────
    const humidPenalty = (humid ?? 60) > 90 ? 1.0
                       : (humid ?? 60) > 80 ? 0.5
                       : 0;

    // ── גשם ────────────────────────────────────────────────────
    const rainPenalty = (rain ?? 0) > 80 ? 4.0
                      : (rain ?? 0) > 60 ? 2.5
                      : (rain ?? 0) > 40 ? 1.5
                      : (rain ?? 0) > 20 ? 0.5
                      : 0;

    // ── קוד מזג אוויר ──────────────────────────────────────────
    const wcodePenalty = wcode >= 95 ? 4.0
                       : wcode >= 80 ? 3.0
                       : wcode >= 70 ? 2.0
                       : wcode >= 60 ? 2.0
                       : wcode >= 50 ? 1.5
                       : wcode >= 40 ? 0.8
                       : 0;

    const raw = cloudScore
              + dustEffect + aodBonus
              - pm25Penalty - visPenalty
              + windBonus   - humidPenalty
              - rainPenalty - wcodePenalty;

    return Math.round(Math.max(1, Math.min(10, raw)));
  }

  function qualityInfo(score) {
    if (score >= 8.5) return { label:'🔥 מהמם!',       cls:'spectacular', barCls:'bar-spectacular' };
    if (score >= 7)   return { label:'🌟 תוסס ועשיר',  cls:'vivid',       barCls:'bar-vivid'       };
    if (score >= 5.5) return { label:'✨ יפה',           cls:'nice',        barCls:'bar-nice'        };
    if (score >= 4)   return { label:'🌤️ עדין',          cls:'mild',        barCls:'bar-mild'        };
    return                   { label:'☁️ חלש',           cls:'poor',        barCls:'bar-poor'        };
  }

  function palette(score, isSunset) {
    if (score >= 8.5) return isSunset ? ['#ff2d00','#ff6b2b','#ff9a44','#ffc96e','#ffe8a8'] : ['#ff4e6a','#ff8c69','#ffb347','#ffd700','#87ceeb'];
    if (score >= 7)   return isSunset ? ['#e8390e','#f5712d','#f9a825','#fdd835','#fff3b0'] : ['#c0392b','#e67e22','#f39c12','#f1c40f','#aed6f1'];
    if (score >= 5.5) return isSunset ? ['#c0392b','#e07030','#e8a040','#f5d080','#ffe0a0'] : ['#8e44ad','#d35400','#e67e22','#f39c12','#d4e6f1'];
    if (score >= 4)   return ['#5b7a9d','#7ea8c4','#a8c4d8','#c8dce8','#e0eaf2'];
    return ['#4a5568','#6b7280','#9ca3af','#d1d5db','#e5e7eb'];
  }

  function barColor(score) {
    if (score >= 8) return '#ff9a44';
    if (score >= 6) return '#ffaa38';
    return '#5b7a9d';
  }

  async function fetchForecast(lat, lon) {
    const url = `https://api.open-meteo.com/v1/forecast`
      + `?latitude=${lat}&longitude=${lon}`
      + `&daily=weathercode,cloud_cover_mean,precipitation_probability_max,temperature_2m_max,temperature_2m_min`
      + `&hourly=cloud_cover,cloud_cover_high,cloud_cover_mid,cloud_cover_low,precipitation_probability,relative_humidity_2m,visibility,wind_speed_10m,precipitation`
      + `&timezone=auto&forecast_days=7`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Forecast fetch failed');
    return res.json();
  }

  async function fetchAirQuality(lat, lon) {
    try {
      const url = `https://air-quality-api.open-meteo.com/v1/air-quality`
        + `?latitude=${lat}&longitude=${lon}`
        + `&hourly=pm2_5,pm10,dust,aerosol_optical_depth`
        + `&timezone=auto&forecast_days=7`;
      const res = await fetch(url);
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  }

  // מוצא index שעה קרובה ביותר לאירוע
  function findClosestHourIdx(eventDate, hourlyTimes) {
    const target = eventDate.getTime();
    let closest = 0, minDiff = Infinity;
    hourlyTimes.forEach((t, i) => {
      const diff = Math.abs(new Date(t).getTime() - target);
      if (diff < minDiff) { minDiff = diff; closest = i; }
    });
    return closest;
  }

  function avgWindow(arr, center, n) {
    if (!arr) return null;
    const idxs = [];
    for (let i = center - 1; i <= center + 1; i++) {
      if (i >= 0 && i < arr.length) idxs.push(i);
    }
    return idxs.reduce((s, i) => s + (arr[i] ?? n), 0) / idxs.length;
  }

  // מחשב ציון לאירוע ספציפי לפי כל נתוני השעה הרלוונטיים
  function scoreForEvent(eventDate, fData, aqData, wcode) {
    if (!eventDate || !fData?.hourly?.time) return null;
    const ci = findClosestHourIdx(eventDate, fData.hourly.time);

    // נתוני מזג אוויר
    const cloud     = avgWindow(fData.hourly.cloud_cover,           ci, 50);
    const cloudHigh = avgWindow(fData.hourly.cloud_cover_high,      ci, 30);
    const cloudMid  = avgWindow(fData.hourly.cloud_cover_mid,       ci, 20);
    const cloudLow  = avgWindow(fData.hourly.cloud_cover_low,       ci, 20);
    const rain      = avgWindow(fData.hourly.precipitation_probability, ci, 0);
    const humid     = avgWindow(fData.hourly.relative_humidity_2m,  ci, 60);
    const visKm     = avgWindow(fData.hourly.visibility,            ci, 20000) / 1000; // מטר → ק"מ
    const windMs    = avgWindow(fData.hourly.wind_speed_10m,        ci, 10);

    // נתוני איכות אוויר (אופציונלי)
    let dust = 0, aod = 0, pm25 = 0, pm10 = 0;
    if (aqData?.hourly?.time) {
      // Air Quality API עשוי להיות ב-resolution שונה — מצא index קרוב
      const aqci = findClosestHourIdx(eventDate, aqData.hourly.time);
      dust = avgWindow(aqData.hourly.dust,                   aqci, 0)  ?? 0;
      aod  = avgWindow(aqData.hourly.aerosol_optical_depth,  aqci, 0)  ?? 0;
      pm25 = avgWindow(aqData.hourly.pm2_5,                  aqci, 0)  ?? 0;
      pm10 = avgWindow(aqData.hourly.pm10,                   aqci, 0)  ?? 0;
    }

    return calcScore(cloud, cloudHigh, cloudMid, cloudLow, rain, humid, visKm, windMs, dust, aod, pm25, wcode);
  }

  function updateDynBg(score) {
    const root = document.documentElement;
    if (score >= 8.5) {
      root.style.setProperty('--dyn1','rgba(255,80,30,0.22)');
      root.style.setProperty('--dyn2','rgba(255,150,30,0.18)');
      root.style.setProperty('--dyn3','rgba(200,60,100,0.12)');
    } else if (score >= 7) {
      root.style.setProperty('--dyn1','rgba(220,80,60,0.18)');
      root.style.setProperty('--dyn2','rgba(240,140,40,0.14)');
      root.style.setProperty('--dyn3','rgba(100,60,200,0.09)');
    } else if (score >= 5) {
      root.style.setProperty('--dyn1','rgba(180,80,100,0.14)');
      root.style.setProperty('--dyn2','rgba(200,130,50,0.10)');
      root.style.setProperty('--dyn3','rgba(60,100,200,0.08)');
    } else {
      root.style.setProperty('--dyn1','rgba(80,80,120,0.12)');
      root.style.setProperty('--dyn2','rgba(100,100,150,0.08)');
      root.style.setProperty('--dyn3','rgba(60,80,160,0.07)');
    }
  }

  function toggleAccordion(id) {
    const detail = document.getElementById('detail-' + id);
    const arrow  = document.getElementById('arrow-'  + id);
    if (!detail) return;
    detail.classList.toggle('open');
    arrow.classList.toggle('open');
  }
  window.toggleAccordion = toggleAccordion;

  function render(data, aqData, loc) {
    const container = document.getElementById('mainContent');
    if (!container) return;

    const clouds  = data.daily.cloud_cover_mean;
    const rains   = data.daily.precipitation_probability_max;
    const wcodes  = data.daily.weathercode;
    const tempMax = data.daily.temperature_2m_max;
    const tempMin = data.daily.temperature_2m_min;

    const today = new Date();
    let html = '';

    // ── Weekly bar chart (SVG — guaranteed height) ──
    const CHART_W = 280, CHART_H = 80, BAR_W = 28, GAP = 12;
    // hourly data accessed directly via data.hourly in scoreForEvent

    const scores7 = [];
    const labels7 = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(today); d.setDate(today.getDate() + i);
      const wcode = wcodes[i] ?? 0;

      let ssScore = null, srScore = null;
      if (window.SunCalc && loc && data.hourly?.time) {
        const sun = window.SunCalc.calc(loc.lat, loc.lon, d);
        ssScore = scoreForEvent(sun.sunset,  data, aqData, wcode);
        srScore = scoreForEvent(sun.sunrise, data, aqData, wcode);
      }

      // ממוצע שקיעה+זריחה, fallback לציון כללי (signature חדש)
      const score = (ssScore !== null && srScore !== null)
        ? Math.round((ssScore + srScore) / 2)
        : calcScore(clouds[i] ?? 40, 30, 20, 20, rains[i] ?? 0, 60, 20, 5, 0, 0, 0, wcode);

      scores7.push(score);
      labels7.push(i === 0 ? 'היום' : i === 1 ? 'מחר' : DAYS_HE[d.getDay()]);
    }

    // היפוך: היום בימין (RTL)
    scores7.reverse();
    labels7.reverse();

    // בנה SVG
    const totalW = 7 * BAR_W + 6 * GAP; // 7*28 + 6*12 = 268
    let svgBars = '';
    scores7.forEach((score, i) => {
      const q      = qualityInfo(score);
      const color  = barColor(score);
      const x      = i * (BAR_W + GAP);
      const barH   = Math.round((score / 10) * CHART_H);
      const y      = CHART_H - barH;
      svgBars += `
        <rect x="${x}" y="${y}" width="${BAR_W}" height="${barH}"
              rx="5" fill="${color}" opacity="0.9"
              class="svg-bar" data-final-y="${y}" data-final-h="${barH}"/>
        <text x="${x + BAR_W/2}" y="${CHART_H + 14}" text-anchor="middle"
              font-size="9" fill="rgba(244,232,212,0.45)">${labels7[i]}</text>
        <text x="${x + BAR_W/2}" y="${y - 4}" text-anchor="middle"
              font-size="9" font-weight="700" fill="${color}">${score}</text>`;
    });

    const svgMarkup = `
      <svg id="weekSvg" viewBox="0 0 ${totalW} ${CHART_H + 20}"
           width="100%" style="overflow:visible;display:block">
        <!-- bg tracks -->
        ${scores7.map((_,i) => `<rect x="${i*(BAR_W+GAP)}" y="0" width="${BAR_W}" height="${CHART_H}" rx="5" fill="rgba(255,255,255,0.04)"/>`).join('')}
        ${svgBars}
      </svg>`;

    html += `
      <div class="week-chart-section">
        <div class="week-chart-title">📊 תחזית שבועית</div>
        <div class="week-chart-sub">ציון ממוצע שקיעה/זריחה — 7 ימים קדימה</div>
        <div style="padding:8px 4px 18px">${svgMarkup}</div>
      </div>`;

    updateDynBg(calcScore(clouds[0] ?? 40, rains[0] ?? 0, wcodes[0] ?? 0));

    // ── 3 day cards ──
    for (let i = 0; i < 3; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      const dayName     = i === 0 ? 'היום' : i === 1 ? 'מחר' : DAYS_HE[d.getDay()];
      const dateDisplay = `${d.getDate()} ב${MONTHS_HE[d.getMonth()]}`;
      const wcode       = wcodes[i] ?? 0;
      const score       = calcScore(clouds[i] ?? 40, rains[i] ?? 0, wcode);
      const tMax        = tempMax?.[i] != null ? Math.round(tempMax[i]) + '°' : '--';
      const tMin        = tempMin?.[i] != null ? Math.round(tempMin[i]) + '°' : '--';
      const rainPct     = rains[i] ?? 0;
      const cloudPct    = Math.round(clouds[i] ?? 0);

      let srTime = '--:--', ssTime = '--:--', goldenSS = '', goldenSR = '';
      let srScore = score, ssScore = score;
      if (window.SunCalc) {
        const sun = window.SunCalc.calc(loc.lat, loc.lon, d);
        srTime   = fmtTime(sun.sunrise);
        ssTime   = fmtTime(sun.sunset);
        goldenSS = goldenWindow(sun.sunset);
        goldenSR = goldenWindow(sun.sunrise);
      }

      const ssQ   = qualityInfo(ssScore);
      const srQ   = qualityInfo(srScore);
      const ssPal = palette(ssScore, true).map(c  => `<div class="palette-swatch" style="background:${c}"></div>`).join('');
      const srPal = palette(srScore, false).map(c => `<div class="palette-swatch" style="background:${c}"></div>`).join('');
      const cardId = `day-${i}`;

      html += `
        <div class="day-card${i === 0 ? ' day-card--today' : ''}" style="animation-delay:${i * 0.12}s">
          <div class="day-header">
            <div>
              <div class="day-name">${dayName}</div>
              <div class="day-date">${dateDisplay}</div>
            </div>
            <div class="weather-summary">
              <span>${weatherCodeEmoji(wcode)}</span>
              <span>${weatherCodeText(wcode)}</span>
            </div>
          </div>

          <div class="sun-events">
            <div class="sun-event">
              <div class="sun-event-title">🌇 שקיעה</div>
              <div class="sun-event-time">${ssTime}</div>
              ${goldenSS ? `<div class="golden-window">⭐ זמן זהוב: ${goldenSS}</div>` : ''}
              <div class="score-label">
                <span>צבעוניות</span>
                <span class="score-value quality-${ssQ.cls}">${ssScore}/10</span>
              </div>
              <div class="score-bar-track">
                <div class="score-bar-fill ${ssQ.barCls}" style="width:${ssScore * 10}%"></div>
              </div>
              <div class="score-description quality-${ssQ.cls}">${ssQ.label}</div>
              <div class="color-palette">${ssPal}</div>
              <button class="notif-day-btn" id="notif-sunset-${i}"
                data-type="sunset" data-day="${i}"
                onclick="window.toggleDayNotif(this)">
                🔔 התראה לשקיעה
              </button>
            </div>
            <div class="sun-event">
              <div class="sun-event-title">🌄 זריחה</div>
              <div class="sun-event-time">${srTime}</div>
              ${goldenSR ? `<div class="golden-window">⭐ זמן זהוב: ${goldenSR}</div>` : ''}
              <div class="score-label">
                <span>צבעוניות</span>
                <span class="score-value quality-${srQ.cls}">${srScore}/10</span>
              </div>
              <div class="score-bar-track">
                <div class="score-bar-fill ${srQ.barCls}" style="width:${srScore * 10}%"></div>
              </div>
              <div class="score-description quality-${srQ.cls}">${srQ.label}</div>
              <div class="color-palette">${srPal}</div>
              <button class="notif-day-btn" id="notif-sunrise-${i}"
                data-type="sunrise" data-day="${i}"
                onclick="window.toggleDayNotif(this)">
                🔔 התראה לזריחה
              </button>
            </div>
          </div>

          <button class="accordion-btn" onclick="toggleAccordion('${cardId}')">
            <span>🌤️ פרטי מזג אוויר</span>
            <span class="accordion-arrow" id="arrow-${cardId}">▼</span>
          </button>
          <div class="weather-detail" id="detail-${cardId}">
            <div class="weather-grid">
              <div class="weather-item">
                <span class="weather-item-icon">🌡️</span>
                <div class="weather-item-text"><strong>${tMax} / ${tMin}</strong>טמפרטורה</div>
              </div>
              <div class="weather-item">
                <span class="weather-item-icon">💧</span>
                <div class="weather-item-text"><strong>${rainPct}%</strong>סיכוי גשם</div>
              </div>
              <div class="weather-item">
                <span class="weather-item-icon">☁️</span>
                <div class="weather-item-text"><strong>${cloudPct}%</strong>כיסוי ענן</div>
              </div>
              <div class="weather-item">
                <span class="weather-item-icon">⏱</span>
                <div class="weather-item-text"><strong>${window.SunCalc ? window.SunCalc.fmtDuration(window.SunCalc.calc(loc.lat, loc.lon, d).dayLengthMin) : '--'}</strong>אורך יום</div>
              </div>
            </div>
          </div>

          <div class="rating-row">
            <div>
              <div class="rating-label">דרג את השקיעה האמיתית 👇</div>
              <div class="rating-saved muted" id="saved-${cardId}" style="font-size:11px"></div>
            </div>
            <div class="rating-stars" id="stars-${cardId}">
              ${[1,2,3,4,5].map(s =>
                `<span class="rating-star" data-val="${s}" onclick="window._rateDay && window._rateDay('${cardId}','${dateDisplay}',${s},${srScore},${ssScore})">☆</span>`
              ).join('')}
            </div>
          </div>
        </div>`;
    }

    container.innerHTML = html;
    setTimeout(restoreNotifButtons, 200);

    // אנימציית ברים SVG — transform-origin bottom
    setTimeout(() => {
      const CHART_BOTTOM = 80; // CHART_H
      document.querySelectorAll('#weekSvg .svg-bar').forEach(bar => {
        const finalY = Number(bar.dataset.finalY);
        const finalH = Number(bar.dataset.finalH);
        // origin of transform at bottom of bar
        const originY = CHART_BOTTOM;
        bar.style.transformOrigin = `0px ${originY}px`;
        bar.style.transform = 'scaleY(0)';
        bar.style.transition = 'none';
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            bar.style.transition = 'transform 0.8s cubic-bezier(.22,1,.36,1)';
            bar.style.transform = 'scaleY(1)';
          });
        });
      });
    }, 150);
  }

  window._rateDay = function(cardId, dateDisplay, stars, srScore, ssScore) {
    const starsEl = document.getElementById('stars-' + cardId);
    if (starsEl) starsEl.querySelectorAll('.rating-star').forEach((el, i) => {
      el.textContent = i < stars ? '★' : '☆';
      el.classList.toggle('active', i < stars);
    });
    const saved = document.getElementById('saved-' + cardId);
    if (saved) { saved.textContent = `✓ דירגת ${stars}★`; saved.style.display = 'block'; }
  };

  async function loadForecast(loc) {
    const container = document.getElementById('mainContent');
    if (container) container.innerHTML = '<div class="loading-state"><span>🌤️</span><p>טוען תחזית...</p></div>';
    try {
      // קריאות מקבילות — forecast + air quality
      const [data, aqData] = await Promise.all([
        fetchForecast(loc.lat, loc.lon),
        fetchAirQuality(loc.lat, loc.lon),
      ]);
      render(data, aqData, loc);
    } catch (e) {
      console.error('Forecast load error:', e);
      if (container) container.innerHTML = `<div class="loading-state"><span>⚠️</span><p>שגיאה בטעינת תחזית<br><small style="font-size:10px;opacity:0.6">${e.message}</small></p></div>`;
    }
  }

  // ─── Per-day notification toggle ─────────────────────────────────
  const NOTIF_STEPS = [10, 20, 30, 60];

  window.toggleDayNotif = function(btn) {
    const type    = btn.dataset.type;
    const dayIdx  = parseInt(btn.dataset.day);
    const activeKey = `notif_active_${type}_${dayIdx}`;
    const minKey    = `notif_min_${type}_${dayIdx}`;

    if (btn.classList.contains('active')) {
      btn.classList.remove('active');
      btn.innerHTML = type === 'sunset' ? '🔔 התראה לשקיעה' : '🔔 התראה לזריחה';
      localStorage.removeItem(activeKey);
      return;
    }

    const proceed = () => {
      const savedMin = parseInt(localStorage.getItem(minKey)) || 30;
      activateNotif(btn, type, dayIdx, savedMin);
    };

    if (!('Notification' in window)) { alert('התראות לא נתמכות בדפדפן זה'); return; }
    if (Notification.permission === 'granted') { proceed(); }
    else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(p => { if (p === 'granted') proceed(); });
    } else {
      alert('התראות חסומות — שחרר בהגדרות הדפדפן');
    }
  };

  function activateNotif(btn, type, dayIdx, minBefore) {
    const activeKey = `notif_active_${type}_${dayIdx}`;
    const minKey    = `notif_min_${type}_${dayIdx}`;
    localStorage.setItem(minKey, minBefore);
    localStorage.setItem(activeKey, '1');

    if (!window.SunCalc || !window.__twilightLoc) return;
    const d = new Date();
    d.setDate(d.getDate() + dayIdx);
    const sun = window.SunCalc.calc(window.__twilightLoc.lat, window.__twilightLoc.lon, d);
    const eventTime = type === 'sunset' ? sun.sunset : sun.sunrise;
    if (!eventTime) return;

    const delay = eventTime.getTime() - minBefore * 60000 - Date.now();
    const label = type === 'sunset' ? 'שקיעה' : 'זריחה';
    const stepIdx  = NOTIF_STEPS.indexOf(minBefore);
    const nextStep = NOTIF_STEPS[(stepIdx + 1) % NOTIF_STEPS.length];

    btn.classList.add('active');
    btn.innerHTML = `✓ ${label} — ${minBefore} דק' לפני &nbsp;<span class="notif-change" onclick="event.stopPropagation();window.cycleNotifTime(this)" data-type="${type}" data-day="${dayIdx}">↺ ${nextStep} דק'</span>`;

    if (delay > 0) {
      setTimeout(() => {
        navigator.serviceWorker?.ready.then(reg => {
          reg.showNotification(`דמדומים — ${label} בעוד ${minBefore} דקות`, {
            body: 'הגיע הזמן לצאת החוצה!',
            icon: './icons/icon-192.png',
            tag: `${type}-${dayIdx}`,
            vibrate: [200, 100, 200],
          });
        });
      }, delay);
    }
  }

  window.cycleNotifTime = function(span) {
    const type   = span.dataset.type;
    const dayIdx = parseInt(span.dataset.day);
    const minKey = `notif_min_${type}_${dayIdx}`;
    const cur    = parseInt(localStorage.getItem(minKey)) || 30;
    const next   = NOTIF_STEPS[(NOTIF_STEPS.indexOf(cur) + 1) % NOTIF_STEPS.length];
    activateNotif(span.closest('.notif-day-btn'), type, dayIdx, next);
  };

  function restoreNotifButtons() {
    for (let i = 0; i < 3; i++) {
      ['sunset','sunrise'].forEach(type => {
        const btn = document.getElementById(`notif-${type}-${i}`);
        if (!btn) return;
        if (localStorage.getItem(`notif_active_${type}_${i}`)) {
          const min = parseInt(localStorage.getItem(`notif_min_${type}_${i}`)) || 30;
          activateNotif(btn, type, i, min);
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    if (window.__twilightLoc) loadForecast(window.__twilightLoc);
  });
  window.addEventListener('twilight:loc', (e) => loadForecast(e.detail));
  window.Forecast = { load: loadForecast };
})();
