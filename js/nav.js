// ═══════════════════════════════════════════
//  TWILIGHT — nav.js v2
//  Screen navigation with slide transitions + haptic
// ═══════════════════════════════════════════

const SCREENS     = ['main', 'spots', 'settings', 'learning'];
const callbacks   = [];
let currentScreen = 'main';

// Screen order for determining slide direction.
// 'learning' is a sub-screen of 'settings' (no bottom-nav entry); we place it
// after settings so the slide-in animation feels like opening a deeper page.
const SCREEN_ORDER = { main: 0, spots: 1, settings: 2, learning: 3 };

/**
 * Haptic feedback helper — vibrates if available
 */
function haptic(style = 'light') {
  if (!navigator.vibrate) return;
  switch (style) {
    case 'light':  navigator.vibrate(8);  break;
    case 'medium': navigator.vibrate(15); break;
    case 'heavy':  navigator.vibrate([10, 30, 10]); break;
    default:       navigator.vibrate(8);
  }
}

/**
 * Initialize bottom nav click handlers
 */
export function initNav() {
  const navItems = document.querySelectorAll('.nav-item[data-screen]');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const id = item.dataset.screen;
      showScreen(id);
    });
  });
}

/**
 * Show a specific screen with slide animation + haptic
 * @param {string} id - 'main' | 'spots' | 'settings'
 */
export function showScreen(id) {
  if (!SCREENS.includes(id)) return;
  if (id === currentScreen) return;

  haptic('light');

  const prevOrder = SCREEN_ORDER[currentScreen] ?? 0;
  const nextOrder = SCREEN_ORDER[id] ?? 0;
  const slideForward = nextOrder > prevOrder;

  // Hide all screens
  SCREENS.forEach(s => {
    const el = document.getElementById(`screen-${s}`);
    if (el) {
      el.classList.remove('active', 'anim-slide-in', 'anim-slide-in-reverse', 'anim-fade');
    }
  });

  // Show target with directional animation
  const target = document.getElementById(`screen-${id}`);
  if (target) {
    target.classList.add('active');
    // RTL: directions are mirrored visually
    target.classList.add(slideForward ? 'anim-slide-in' : 'anim-slide-in-reverse');
    target.scrollTop = 0;
  }

  // Update bottom nav
  document.querySelectorAll('.nav-item[data-screen]').forEach(item => {
    const isActive = item.dataset.screen === id;
    item.classList.toggle('active', isActive);
  });

  const prev = currentScreen;
  currentScreen = id;

  // Fire callbacks
  callbacks.forEach(cb => cb(id, prev));
}

/**
 * Register callback for screen change events
 * @param {function} cb - called with (newId, prevId)
 */
export function onScreenChange(cb) {
  callbacks.push(cb);
}

/**
 * Get current active screen id
 */
export function getCurrentScreen() {
  return currentScreen;
}

/**
 * Trigger haptic from external modules
 */
export { haptic };

// ✓ nav.js v2 — slide transitions + haptic
