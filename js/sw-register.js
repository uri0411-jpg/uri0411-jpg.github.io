// ═══════════════════════════════════════════
//  TWILIGHT — sw-register.js v2
//  Service Worker registration — relative paths
// ═══════════════════════════════════════════

export function registerSW() {
  if (!('serviceWorker' in navigator)) return;

  // On first install there is no existing controller — skip the reload so we
  // don't interrupt the initial boot.  Only notify on genuine *updates*.
  const hadController = !!navigator.serviceWorker.controller;
  let _reloaded = false;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      console.log('[SW] First install complete — no reload needed');
      return;
    }
    if (_reloaded) return;
    _reloaded = true;
    console.log('[SW] New controller — notifying user');
    window.dispatchEvent(new CustomEvent('twilight:updateReady'));
  });

  window.addEventListener('load', async () => {
    try {
      const swPath = new URL('sw.js', window.location.href).href;
      const scopePath = new URL('./', window.location.href).href;
      const reg = await navigator.serviceWorker.register(swPath, { scope: scopePath });
      console.log('[SW] Registered, scope:', reg.scope);
    } catch (e) {
      console.warn('[SW] Registration failed:', e);
    }
  });
}

// ✓ sw-register.js v2 — relative paths
