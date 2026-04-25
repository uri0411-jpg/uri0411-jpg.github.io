// ═══════════════════════════════════════════
//  TWILIGHT — main-screen/rating.js
//  Multi-event rating UI: countdown timer, rating cards (sunrise/sunset/dusk).
//
//  Extracted from main-screen.js to keep that orchestrator under 1500 lines.
//  Owns module-level state for the countdown setInterval handle.
// ═══════════════════════════════════════════

import { logoImg } from '../ui.js';
import { recordUserRating, hasRatedEvent, getUserRating, clearUserRating } from '../calibration.js';
import { recordRatingForStreak } from '../streak.js';
import { haptic } from '../nav.js';
import { EVENT_LABELS_HE, EVENT_LABELS_HE_SHORT, RATING_WINDOWS_MIN, DUSK_OFFSET_MIN } from '../config.js';
import { getLearningStats, MIN_ACTIVE_SAMPLES } from '../engine/learningEngine.js';

let _countdownInterval = null;
let _activeMenuClickAway = null;  // document-level click handler while a menu is open

// ─────────────────────────────────────────
//  Countdown timer + multi-event rating UI
//
//  v2 logic:
//    - Compute event times for sunrise / sunset / dusk (= sunset + 25min)
//    - For each event, derive its rating window: [event + start, event + end]
//      from RATING_WINDOWS_MIN. While in-window AND not yet rated, show a
//      rating card for that event. Multiple windows can overlap (e.g. dusk
//      starts while sunset window is still open) → stack the cards.
//    - When no rating window is active and a future event exists, show the
//      countdown to that next event.
//    - Once all 3 events rated for the day, show a thank-you banner.
// ─────────────────────────────────────────
function _getEventTimes(today) {
  const todayDate = today.date;
  const [srH, srM] = today.sunrise.split(':').map(Number);
  const [ssH, ssM] = today.sunset.split(':').map(Number);
  const sunriseTime = new Date(todayDate + 'T12:00:00');
  sunriseTime.setHours(srH, srM, 0, 0);
  const sunsetTime = new Date(todayDate + 'T12:00:00');
  sunsetTime.setHours(ssH, ssM, 0, 0);
  const duskTime = new Date(sunsetTime.getTime() + DUSK_OFFSET_MIN * 60 * 1000);
  return { sunrise: sunriseTime, sunset: sunsetTime, dusk: duskTime };
}

function _isInRatingWindow(eventTime, eventType, now) {
  const w = RATING_WINDOWS_MIN[eventType];
  const start = eventTime.getTime() + w.start * 60 * 1000;
  const end   = eventTime.getTime() + w.end   * 60 * 1000;
  return now.getTime() >= start && now.getTime() <= end;
}

function _ratingGridHTML(eventType) {
  // 10 buttons in 2 rows of 5 (RTL: high → low). Color tier mapped via class.
  const tier = (n) => n <= 3 ? 'low' : n <= 6 ? 'mid' : n <= 8 ? 'high' : 'top';
  const row1 = [10, 9, 8, 7, 6];
  const row2 = [5, 4, 3, 2, 1];
  const btn = n => `<button class="rating-btn rating-tier-${tier(n)}" data-rating="${n}" data-event="${eventType}" type="button" aria-label="${n} מתוך 10">${n}</button>`;
  return `
    <div class="rating-grid" role="radiogroup" aria-label="דירוג ${EVENT_LABELS_HE[eventType]}">
      <div class="rating-row">${row1.map(btn).join('')}</div>
      <div class="rating-row">${row2.map(btn).join('')}</div>
    </div>`;
}

function _ratingCardHTML(eventType) {
  const label = EVENT_LABELS_HE[eventType];
  const cbId  = `rating-confidence-${eventType}`;
  return `
    <div class="rating-card" data-event="${eventType}">
      <div class="rating-prompt">
        <div class="logo-circle-sm">${logoImg(eventType === 'sunrise' ? 'sunrise' : eventType === 'sunset' ? 'sunset' : 'twilight', 16)}</div>
        <span>איך הייתה ${label}?</span>
      </div>
      ${_ratingGridHTML(eventType)}
      <label class="rating-confidence">
        <input type="checkbox" id="${cbId}" checked>
        <span>ראיתי את כל האירוע</span>
      </label>
    </div>`;
}

function _ratingDoneHTML(eventType, ratingValue, streakNote = '') {
  const evLabel = EVENT_LABELS_HE_SHORT[eventType] || eventType;
  return `
    <div class="rating-card rating-done" data-event="${eventType}">
      <span>דירגת את ${evLabel} ${ratingValue}/10 — תודה!${streakNote}</span>
      <button class="rating-menu-trigger" type="button" aria-label="אפשרויות דירוג ${evLabel}" data-event="${eventType}">⋯</button>
      <div class="rating-menu" data-event="${eventType}" hidden>
        <button class="rating-menu-item" type="button" data-action="delete" data-event="${eventType}">מחק דירוג</button>
      </div>
    </div>`;
}

function _closeAllRatingMenus() {
  document.querySelectorAll('.rating-menu').forEach(m => { m.hidden = true; });
  if (_activeMenuClickAway) {
    document.removeEventListener('click', _activeMenuClickAway);
    _activeMenuClickAway = null;
  }
}

function _openRatingMenu(menu) {
  document.querySelectorAll('.rating-menu').forEach(m => { if (m !== menu) m.hidden = true; });
  menu.hidden = false;
  if (_activeMenuClickAway) document.removeEventListener('click', _activeMenuClickAway);
  _activeMenuClickAway = (e) => {
    if (!menu.contains(e.target) && !e.target.closest('.rating-menu-trigger')) {
      _closeAllRatingMenus();
    }
  };
  // Defer attach so the click that opened the menu doesn't immediately close it
  setTimeout(() => {
    if (_activeMenuClickAway) document.addEventListener('click', _activeMenuClickAway);
  }, 0);
}

// Attach a 400 ms long-press handler to `el`, with cancel on movement,
// pointerup, pointerleave, pointercancel, and contextmenu.
function _attachLongPress(el, callback, ms = 400) {
  let timer = null;
  let startX = 0, startY = 0;
  const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } };
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.rating-menu-trigger') || e.target.closest('.rating-menu')) return;
    startX = e.clientX; startY = e.clientY;
    cancel();
    timer = setTimeout(() => { timer = null; callback(); }, ms);
  });
  el.addEventListener('pointerup',     cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave',  cancel);
  el.addEventListener('pointermove', (e) => {
    if (!timer) return;
    if (Math.abs(e.clientX - startX) > 5 || Math.abs(e.clientY - startY) > 5) cancel();
  });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); cancel(); });
}

// Wire the ⋯ trigger, the menu items, and the long-press shortcut on a
// single .rating-done card. `onMutated` is called after a successful delete
// so the caller can invalidate its render cache and force a re-render.
function _attachDoneCardHandlers(card, todayDate, onMutated) {
  const ev      = card.dataset.event;
  const trigger = card.querySelector('.rating-menu-trigger');
  const menu    = card.querySelector('.rating-menu');
  if (!trigger || !menu) return;

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.hidden) _openRatingMenu(menu);
    else _closeAllRatingMenus();
  });

  const deleteBtn = card.querySelector('[data-action="delete"]');
  if (deleteBtn) {
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      _closeAllRatingMenus();
      const ok = await clearUserRating(todayDate, ev);
      if (!ok) return;
      haptic?.();
      window.dispatchEvent(new CustomEvent('twilight:toast', {
        detail: { msg: 'הדירוג נמחק', type: 'info' },
      }));
      onMutated?.();
    });
  }

  _attachLongPress(card, () => {
    if (menu.hidden) _openRatingMenu(menu);
  });
}

export function startCountdown(today) {
  if (!today) return;
  const el = document.getElementById('countdown-timer');
  if (!el) return;

  let _lastSig = '';

  function update() {
    const now = new Date();
    const todayDate = today.date;
    const events = _getEventTimes(today);

    // Build per-event status: { time, inWindow, rated }
    const status = {};
    for (const ev of ['sunrise', 'sunset', 'dusk']) {
      status[ev] = {
        time:     events[ev],
        inWindow: _isInRatingWindow(events[ev], ev, now),
        rated:    hasRatedEvent(todayDate, ev),
      };
    }

    // Events currently inside their rating window (rated or not)
    const inWindow = ['sunrise', 'sunset', 'dusk'].filter(ev => status[ev].inWindow);

    // Signature for change detection (avoid re-rendering identical DOM each second)
    const sig = inWindow.length > 0
      ? `win:${inWindow.map(ev => `${ev}:${status[ev].rated ? `done${getUserRating(todayDate, ev) ?? '?'}` : 'rate'}`).join(',')}`
      : (() => {
          const next = ['sunrise', 'sunset', 'dusk'].find(ev => status[ev].time > now && !status[ev].rated);
          if (next) return `count:${next}:${Math.floor((status[next].time - now) / 1000)}`;
          const allRated = ['sunrise', 'sunset', 'dusk'].every(ev => status[ev].rated);
          return allRated ? 'all-rated' : 'idle';
        })();

    // The timer ticks the seconds digits within a "count:next:..." sig — so we
    // re-render every second while counting down, but skip rerender when we're
    // showing rating cards or the thanks panel (sig is stable).
    const reuseDom = sig === _lastSig && !sig.startsWith('count:');
    if (reuseDom) return;
    const isCountdownTick = sig.startsWith('count:') && _lastSig.startsWith('count:') &&
                            sig.split(':')[1] === _lastSig.split(':')[1];
    _lastSig = sig;

    // Re-rendering the rating stack invalidates any open menu — make sure the
    // document-level click-away listener is detached so it doesn't fire on a
    // dead menu node.
    _closeAllRatingMenus();

    // ─── Render: rating cards (in-window: rate or done) ──────────
    if (inWindow.length > 0) {
      const cardsHtml = inWindow.map(ev =>
        status[ev].rated
          ? _ratingDoneHTML(ev, getUserRating(todayDate, ev) ?? '?')
          : _ratingCardHTML(ev)
      ).join('');
      el.innerHTML = `<div class="rating-stack">${cardsHtml}</div>`;

      el.querySelectorAll('.rating-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const ev = btn.dataset.event;
          const r  = Number(btn.dataset.rating);
          const cb = el.querySelector(`#rating-confidence-${ev}`);
          const conf = cb ? (cb.checked ? 1 : 0) : 1;
          await recordUserRating(todayDate, ev, r, conf);
          haptic?.();
          const streak = recordRatingForStreak(todayDate);
          // Swap the just-rated card with the done state in place (the timer
          // will re-render with the same content on its next tick — the swap
          // is just for instant feedback)
          const card = el.querySelector(`.rating-card[data-event="${ev}"]:not(.rating-done)`);
          if (card) {
            const streakNote = streak.unlocked === 'streak3'  ? ' • רצף 3 ימים!'
                            : streak.unlocked === 'streak7'  ? ' • רצף שבועי!'
                            : streak.unlocked === 'streak30' ? ' • חודש שלם — צייד שמיים!'
                            : '';
            const tmp = document.createElement('div');
            tmp.innerHTML = _ratingDoneHTML(ev, r, streakNote);
            const newCard = tmp.firstElementChild;
            card.replaceWith(newCard);
            _attachDoneCardHandlers(newCard, todayDate, () => { _lastSig = ''; });
          }
          // Toast: how many more ratings until the per-event learning gate opens
          const evLabel = EVENT_LABELS_HE_SHORT[ev] || ev;
          const eventCount = getLearningStats().samplesByEvent?.[ev] ?? 0;
          const remaining  = MIN_ACTIVE_SAMPLES - eventCount;
          const msg = remaining <= 0
            ? 'דירוג נשמר'
            : remaining === 1
              ? `דירוג נשמר — עוד דירוג ${evLabel} אחד עד שהמערכת תתחיל ללמוד`
              : `דירוג נשמר — עוד ${remaining} דירוגי ${evLabel} עד שהמערכת תתחיל ללמוד`;
          window.dispatchEvent(new CustomEvent('twilight:toast', { detail: { msg, type: 'info' }}));
          _lastSig = ''; // force re-evaluate next tick (more events may still be open)
        });
      });

      // Wire menu (⋯ + long-press) for any rating-done cards in this render
      el.querySelectorAll('.rating-done').forEach(card => {
        _attachDoneCardHandlers(card, todayDate, () => { _lastSig = ''; });
      });
      return;
    }

    // ─── Render: all events rated ────────────────────────────────
    if (sig === 'all-rated') {
      el.innerHTML = `
        <div class="countdown-done">
          <div class="logo-circle-sm">${logoImg('twilight', 16)}</div>
          <span>תודה על הדירוגים! נתראה מחר</span>
        </div>`;
      return;
    }

    // ─── Render: countdown to next event ─────────────────────────
    const nextEv = ['sunrise', 'sunset', 'dusk'].find(ev => status[ev].time > now && !status[ev].rated);
    if (!nextEv) {
      // Nothing to count to (all events past + missed rating windows)
      el.innerHTML = `
        <div class="countdown-done">
          <div class="logo-circle-sm">${logoImg('twilight', 16)}</div>
          <span>נתראה מחר</span>
        </div>`;
      return;
    }
    const labelMap = { sunrise: 'זריחה בעוד', sunset: 'שקיעה בעוד', dusk: 'דמדומים בעוד' };
    const iconMap  = { sunrise: 'sunrise', sunset: 'sunset', dusk: 'twilight' };
    const target = status[nextEv].time;
    const diff = target - now;
    const hours = Math.floor(diff / 3600000);
    const mins  = Math.floor((diff % 3600000) / 60000);
    const secs  = Math.floor((diff % 60000) / 1000);
    el.innerHTML = `
      <div class="countdown-row">
        <div class="logo-circle-sm">${logoImg(iconMap[nextEv], 16)}</div>
        <span class="countdown-label">${labelMap[nextEv]}</span>
        <span class="countdown-digits">${String(hours).padStart(2,'0')}:${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}</span>
      </div>`;
    // suppress unused warning
    void isCountdownTick;
  }

  update();
  _countdownInterval = setInterval(update, 1000);
}

export function stopCountdown() {
  if (_countdownInterval) {
    clearInterval(_countdownInterval);
    _countdownInterval = null;
  }
}
