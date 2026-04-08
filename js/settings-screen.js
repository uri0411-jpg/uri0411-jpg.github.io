// ═══════════════════════════════════════════
//  TWILIGHT — settings-screen.js
//  Notification wizard + toggles
// ═══════════════════════════════════════════

import { showToast } from './ui.js';
import { showScreen } from './nav.js';
import { clearAll } from './cache.js';
import { clearLocation } from './location.js';
import { clearCalibration } from './calibration.js';
import { getLearningStats, clearLearningData, seedFromBacktest } from './engine/learningEngine.js';

const SETTINGS_KEY = 'twl_settings';

let _settings   = loadSettings();
let _wizardStep = 1;

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : defaultSettings();
  } catch { return defaultSettings(); }
}

function defaultSettings() {
  return {
    event:        'both',
    minScore:     6,
    activeDays:   [0,1,2,3,4,5,6],
    autoLocation: true,
    offlineMode:  false
  };
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

// ─────────────────────────────────────────
//  Main entry
// ─────────────────────────────────────────
export function initSettingsScreen() {
  _settings   = loadSettings();
  _wizardStep = 1;
  const container = document.getElementById('screen-settings');
  if (!container) return;
  container.innerHTML = buildSettingsHTML();
  attachSettingsEvents();
}

// ─────────────────────────────────────────
//  Learning entry button — opens dedicated learning screen
//  (replaces the old in-settings calibration + learning sections)
// ─────────────────────────────────────────
function buildLearningEntryButton() {
  const stats = getLearningStats();
  const acc   = stats.forecastAccuracy;
  const accStr = acc != null ? `${acc}% דיוק` : `${stats.sampleSize} דגימות`;
  const accColor = acc == null         ? 'var(--cream-faint)'
                 : acc >= 85           ? 'var(--gold)'
                 : acc >= 70           ? '#ffd580'
                 :                       '#ffaaaa';

  return `
  <div class="settings-section">
    <button class="learning-entry-btn" id="open-learning-btn">
      <div class="learning-entry-icon">
        <svg width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
          <path d="M3 3v18h18"/>
          <path d="M7 14l4-4 4 4 5-5"/>
        </svg>
      </div>
      <div class="learning-entry-text">
        <div class="learning-entry-title">מערכת הלמידה</div>
        <div class="learning-entry-sub" style="color:${accColor}">${accStr} · ${stats.sampleSize} שקיעות</div>
      </div>
      <svg class="learning-entry-arrow" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
    </button>
  </div>`;
}

// ─────────────────────────────────────────
//  Build HTML
//  FIX: step 4 shows denied-state message when Notification.permission === 'denied'
//  FIX: aria-label on min-score-slider
// ─────────────────────────────────────────
function buildSettingsHTML() {
  const days     = ['א','ב','ג','ד','ה','ו','ש'];
  const dayNames = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

  // FIX: detect denied permission state for step 4
  const notifDenied = ('Notification' in window) && Notification.permission === 'denied';

  return `
  <div class="settings-content">
    <div class="settings-title">הגדרות</div>

    <!-- ═══ NOTIFICATION WIZARD ═══ -->
    <div class="glass wizard-wrap">
      <div class="wizard-title">התראות חכמות</div>

      <div class="wizard-dots" style="margin-bottom:14px">
        ${[1,2,3,4].map(n => `
          <div class="wizard-dot${_wizardStep >= n ? ' active' : ''}" id="wdot-${n}"></div>
        `).join('')}
      </div>

      <!-- Step 1 -->
      <div class="wizard-step-panel" id="wstep-1" style="${_wizardStep===1?'':'display:none'}">
        <div style="font-size:13px;color:var(--cream-faint);margin-bottom:10px">שלב 1 — על מה להתריע?</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${[
            { val: 'sunrise', label: 'זריחה' },
            { val: 'sunset',  label: 'שקיעה' },
            { val: 'both',    label: 'שניהם' }
          ].map(opt => `
            <button class="cat-btn wizard-event-btn${_settings.event===opt.val?' active':''}" data-val="${opt.val}">
              ${opt.label}
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Step 2 -->
      <div class="wizard-step-panel" id="wstep-2" style="${_wizardStep===2?'':'display:none'}">
        <div style="font-size:13px;color:var(--cream-faint);margin-bottom:10px">שלב 2 — ציון מינימלי</div>
        <div style="display:flex;align-items:center;gap:12px">
          <input id="min-score-slider" type="range" min="1" max="10" step="1"
                 value="${_settings.minScore}"
                 class="range-slider" style="flex:1"
                 aria-label="ציון מינימלי להתראה" />
          <div id="min-score-val" style="font-size:22px;font-weight:900;color:var(--gold);min-width:24px">${_settings.minScore}</div>
        </div>
      </div>

      <!-- Step 3 -->
      <div class="wizard-step-panel" id="wstep-3" style="${_wizardStep===3?'':'display:none'}">
        <div style="font-size:13px;color:var(--cream-faint);margin-bottom:10px">שלב 3 — ימים פעילים</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${days.map((d, i) => `
            <button class="day-circle-btn${_settings.activeDays.includes(i)?' active':''}" data-day="${i}" title="${dayNames[i]}">
              ${d}
            </button>
          `).join('')}
        </div>
      </div>

      <!-- Step 4 — FIX: separate UI for denied permission state -->
      <div class="wizard-step-panel" id="wstep-4" style="${_wizardStep===4?'':'display:none'}">
        <div style="font-size:13px;color:var(--cream-faint);margin-bottom:14px">שלב 4 — אישור</div>
        <div style="font-size:12px;color:var(--cream-faint);line-height:1.7;margin-bottom:14px">
          <div>אירוע: <span style="color:var(--cream)">${_settings.event === 'both' ? 'זריחה ושקיעה' : _settings.event === 'sunrise' ? 'זריחה' : 'שקיעה'}</span></div>
          <div>ציון מינימלי: <span style="color:var(--gold)">${_settings.minScore}</span></div>
          <div>ימים: <span style="color:var(--cream)">${_settings.activeDays.length} ימים</span></div>
        </div>

        ${notifDenied
          ? `<div style="font-size:12px;color:#ffaaaa;line-height:1.7;padding:12px;background:rgba(200,60,60,0.12);border:1px solid rgba(200,60,60,0.25);border-radius:12px">
               ההרשאה להתראות נדחתה.<br>
               כדי להפעיל: פתח הגדרות דפדפן ← הגדרות אתר ← התראות ← הרשה.
             </div>`
          : `<button class="btn-pill" id="save-notif-btn" style="font-size:13px;padding:12px">
               <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
               שמור והפעל התראות
             </button>`
        }
      </div>

      <!-- Wizard navigation -->
      <div style="display:flex;justify-content:space-between;margin-top:14px">
        <button class="cat-btn" id="wizard-back" style="${_wizardStep===1?'opacity:0.3;pointer-events:none':''}">הקודם</button>
        <button class="cat-btn" id="wizard-next" style="${_wizardStep===4?'display:none':''}">הבא</button>
      </div>
    </div>

    <!-- ═══ TOGGLES ═══ -->
    <div class="settings-section">
      <div class="settings-section-label">כללי</div>
      <div class="glass">
        <div class="settings-row">
          <div class="settings-row-label">
            <svg width="18" height="18" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
            מיקום אוטומטי
          </div>
          <div class="toggle ${_settings.autoLocation ? 'on' : 'off'}" id="toggle-location" data-key="autoLocation">
            <div class="toggle-knob"></div>
          </div>
        </div>
        <div class="settings-row" style="border-top:1px solid rgba(245,220,180,0.1)">
          <div class="settings-row-label">
            <svg width="18" height="18" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16"/><path d="M16 6v16"/></svg>
            מצב לא מקוון
          </div>
          <div class="toggle ${_settings.offlineMode ? 'on' : 'off'}" id="toggle-offline" data-key="offlineMode">
            <div class="toggle-knob"></div>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ CACHE CLEAR ═══ -->
    <div class="settings-section">
      <div class="settings-section-label">מתקדם</div>
      <div class="glass">
        <div class="settings-row" id="clear-cache-btn" style="cursor:pointer">
          <div class="settings-row-label">
            <svg width="18" height="18" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
            נקה מטמון
          </div>
          <svg width="14" height="14" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        </div>
        <div class="settings-row" id="reset-location-btn" style="cursor:pointer;border-top:1px solid rgba(245,220,180,0.1)">
          <div class="settings-row-label">
            <svg width="18" height="18" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.02"/></svg>
            אפס מיקום
          </div>
          <svg width="14" height="14" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        </div>
        <div class="settings-row" id="clear-calibration-btn" style="cursor:pointer;border-top:1px solid rgba(245,220,180,0.1)">
          <div class="settings-row-label">
            <svg width="18" height="18" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
            מחק נתוני כיול
          </div>
          <svg width="14" height="14" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        </div>
        <div class="settings-row" id="clear-learning-btn" style="cursor:pointer;border-top:1px solid rgba(245,220,180,0.1)">
          <div class="settings-row-label">
            <svg width="18" height="18" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><path d="M2.5 2v6h6M2.66 15.57a10 10 0 1 0 .57-4.3"/></svg>
            אפס נתוני למידה
          </div>
          <svg width="14" height="14" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        </div>
        <div class="settings-row" id="import-backtest-btn" style="cursor:pointer;border-top:1px solid rgba(245,220,180,0.1)">
          <div class="settings-row-label">
            <svg width="18" height="18" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            ייבוא נתוני למידה (JSON)
          </div>
          <input type="file" id="backtest-file-input" accept=".json" style="display:none"/>
          <svg width="14" height="14" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>
        </div>
      </div>
    </div>

    <!-- ═══ LEARNING SYSTEM ENTRY ═══ -->
    ${buildLearningEntryButton()}

    <div style="text-align:center;padding:8px 0;font-size:11px;color:var(--cream-faint)">
      TWILIGHT v1.0 · דמדומים
    </div>
  </div>
  `;
}

// ─────────────────────────────────────────
//  Events
// ─────────────────────────────────────────
function attachSettingsEvents() {
  document.getElementById('wizard-next')?.addEventListener('click', () => {
    if (_wizardStep < 4) { _wizardStep++; updateWizardStep(); }
  });
  document.getElementById('wizard-back')?.addEventListener('click', () => {
    if (_wizardStep > 1) { _wizardStep--; updateWizardStep(); }
  });

  document.querySelectorAll('.wizard-event-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.wizard-event-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _settings.event = btn.dataset.val;
    });
  });

  document.getElementById('min-score-slider')?.addEventListener('input', (e) => {
    _settings.minScore = Number(e.target.value);
    const lbl = document.getElementById('min-score-val');
    if (lbl) lbl.textContent = _settings.minScore;
  });

  document.querySelectorAll('.day-circle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const day = Number(btn.dataset.day);
      const idx = _settings.activeDays.indexOf(day);
      if (idx >= 0) { _settings.activeDays.splice(idx, 1); btn.classList.remove('active'); }
      else           { _settings.activeDays.push(day);      btn.classList.add('active');    }
    });
  });

  document.getElementById('save-notif-btn')?.addEventListener('click', async () => {
    saveSettings(_settings);
    if ('Notification' in window) {
      const perm = await Notification.requestPermission();
      if (perm === 'granted') {
        showToast('ההתראה נשמרה', 'success');
      } else if (perm === 'denied') {
        showToast('יש לאפשר התראות בהגדרות הדפדפן', 'error');
        // Rebuild step 4 to show denied-state message
        updateWizardStep();
      } else {
        showToast('ההגדרות נשמרו', 'success');
      }
    } else {
      showToast('ההגדרות נשמרו', 'success');
    }
  });

  document.querySelectorAll('.toggle[data-key]').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const key = toggle.dataset.key;
      _settings[key] = !_settings[key];
      toggle.classList.toggle('on',  _settings[key]);
      toggle.classList.toggle('off', !_settings[key]);
      saveSettings(_settings);
    });
  });

  document.getElementById('clear-cache-btn')?.addEventListener('click', () => {
    clearAll();
    showToast('המטמון נוקה', 'success');
  });

  document.getElementById('reset-location-btn')?.addEventListener('click', () => {
    clearLocation();
    showToast('המיקום אופס', 'info');
  });

  document.getElementById('clear-calibration-btn')?.addEventListener('click', () => {
    clearCalibration();
    showToast('נתוני הכיול נמחקו', 'info');
  });

  document.getElementById('clear-learning-btn')?.addEventListener('click', () => {
    clearLearningData();
    showToast('נתוני הלמידה אופסו', 'info');
    initSettingsScreen(); // rebuild to show empty state
  });

  document.getElementById('open-learning-btn')?.addEventListener('click', () => {
    showScreen('learning');
  });

  document.getElementById('import-backtest-btn')?.addEventListener('click', () => {
    document.getElementById('backtest-file-input')?.click();
  });

  document.getElementById('backtest-file-input')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.entries) || data.entries.length === 0) {
        showToast('קובץ JSON לא תקין', 'error');
        return;
      }
      // Sort oldest-first before seeding so EMA converges correctly
      const sorted = [...data.entries].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
      const result = seedFromBacktest(sorted);
      showToast(`יובאו ${result.added} ערכים היסטוריים (סה"כ: ${result.total})`, 'success');
      initSettingsScreen(); // rebuild to show updated learning stats
    } catch (err) {
      console.error('[import-backtest]', err);
      showToast('שגיאה בייבוא הקובץ', 'error');
    }
    // Reset input so the same file can be re-imported if needed
    e.target.value = '';
  });
}

function updateWizardStep() {
  for (let i = 1; i <= 4; i++) {
    const panel = document.getElementById(`wstep-${i}`);
    if (panel) panel.style.display = i === _wizardStep ? '' : 'none';
    const dot = document.getElementById(`wdot-${i}`);
    if (dot) dot.classList.toggle('active', _wizardStep >= i);
  }

  const backBtn = document.getElementById('wizard-back');
  const nextBtn = document.getElementById('wizard-next');
  if (backBtn) { backBtn.style.opacity = _wizardStep === 1 ? '0.3' : ''; backBtn.style.pointerEvents = _wizardStep === 1 ? 'none' : ''; }
  if (nextBtn) nextBtn.style.display = _wizardStep === 4 ? 'none' : '';

  if (_wizardStep === 4) {
    const panel = document.getElementById('wstep-4');
    if (panel) {
      const eventLabel = _settings.event === 'both' ? 'זריחה ושקיעה' : _settings.event === 'sunrise' ? 'זריחה' : 'שקיעה';
      const lines = panel.querySelectorAll('span');
      if (lines[0]) lines[0].textContent = eventLabel;
      if (lines[1]) lines[1].textContent = String(_settings.minScore);
      if (lines[2]) lines[2].textContent = `${_settings.activeDays.length} ימים`;
    }
  }
}

// ✎ fixed: step 4 — shows denied-state explanation when Notification.permission === 'denied'
// ✎ fixed: save-notif-btn handler — rebuilds step 4 after denial
// ✎ fixed: min-score-slider — aria-label added
// ✓ settings-screen.js — complete
