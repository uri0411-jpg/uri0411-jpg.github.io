// ═══════════════════════════════════════════
//  TWILIGHT — locationSearch.js
//  Unified location search: local cities + Nominatim fallback
//  Autocomplete dropdown with recent locations
// ═══════════════════════════════════════════

import { esc } from './ui.js';

// ─── Israeli cities data ───────────────────
const ISRAEL_CITIES = [
  { name: 'תל אביב', aliases: ['תל-אביב-יפו', 'תל אביב יפו', 'tel aviv'], lat: 32.0853, lon: 34.7818 },
  { name: 'ירושלים', aliases: ['jerusalem'], lat: 31.7683, lon: 35.2137 },
  { name: 'חיפה', aliases: ['haifa'], lat: 32.7940, lon: 34.9896 },
  { name: 'באר שבע', aliases: ['beer sheva', 'באר-שבע'], lat: 31.2530, lon: 34.7915 },
  { name: 'אילת', aliases: ['eilat'], lat: 29.5577, lon: 34.9519 },
  { name: 'נתניה', aliases: ['netanya'], lat: 32.3215, lon: 34.8532 },
  { name: 'הרצליה', aliases: ['herzliya'], lat: 32.1629, lon: 34.7915 },
  { name: 'אשדוד', aliases: ['ashdod'], lat: 31.8044, lon: 34.6553 },
  { name: 'אשקלון', aliases: ['ashkelon'], lat: 31.6688, lon: 34.5743 },
  { name: 'ראשון לציון', aliases: ['rishon lezion', 'ראשל"צ'], lat: 31.9730, lon: 34.7925 },
  { name: 'פתח תקווה', aliases: ['petah tikva', 'פ"ת'], lat: 32.0841, lon: 34.8878 },
  { name: 'חולון', aliases: ['holon'], lat: 32.0158, lon: 34.7795 },
  { name: 'בני ברק', aliases: ['bnei brak'], lat: 32.0834, lon: 34.8344 },
  { name: 'רמת גן', aliases: ['ramat gan'], lat: 32.0700, lon: 34.8242 },
  { name: 'בת ים', aliases: ['bat yam'], lat: 32.0171, lon: 34.7455 },
  { name: 'כפר סבא', aliases: ['kfar saba'], lat: 32.1751, lon: 34.9066 },
  { name: 'רעננה', aliases: ['raanana'], lat: 32.1849, lon: 34.8708 },
  { name: 'הוד השרון', aliases: ['hod hasharon'], lat: 32.1527, lon: 34.8932 },
  { name: 'מודיעין', aliases: ['modiin', 'מודיעין-מכבים-רעות'], lat: 31.8969, lon: 35.0104 },
  { name: 'רחובות', aliases: ['rehovot'], lat: 31.8928, lon: 34.8113 },
  { name: 'לוד', aliases: ['lod'], lat: 31.9515, lon: 34.8952 },
  { name: 'רמלה', aliases: ['ramla'], lat: 31.9275, lon: 34.8625 },
  { name: 'נהריה', aliases: ['nahariya'], lat: 33.0060, lon: 35.0946 },
  { name: 'עכו', aliases: ['acre', 'akko'], lat: 32.9261, lon: 35.0764 },
  { name: 'טבריה', aliases: ['tiberias'], lat: 32.7940, lon: 35.5312 },
  { name: 'נצרת', aliases: ['nazareth'], lat: 32.6996, lon: 35.3035 },
  { name: 'חדרה', aliases: ['hadera'], lat: 32.4340, lon: 34.9196 },
  { name: 'קריית שמונה', aliases: ['kiryat shmona'], lat: 33.2073, lon: 35.5710 },
  { name: 'צפת', aliases: ['safed', 'zfat'], lat: 32.9646, lon: 35.4960 },
  { name: 'קיסריה', aliases: ['caesarea'], lat: 32.4996, lon: 34.8903 },
  { name: 'זכרון יעקב', aliases: ['zichron yaakov'], lat: 32.5714, lon: 34.9528 },
  { name: 'בית שמש', aliases: ['beit shemesh'], lat: 31.7468, lon: 34.9885 },
  { name: 'ערד', aliases: ['arad'], lat: 31.2588, lon: 35.2126 },
  { name: 'מצפה רמון', aliases: ['mitzpe ramon'], lat: 30.6100, lon: 34.8015 },
  { name: 'דימונה', aliases: ['dimona'], lat: 31.0696, lon: 35.0338 },
  { name: 'קריית גת', aliases: ['kiryat gat'], lat: 31.6061, lon: 34.7648 },
  { name: 'קריית ים', aliases: ['kiryat yam'], lat: 32.8414, lon: 35.0699 },
  { name: 'קריית אתא', aliases: ['kiryat ata'], lat: 32.8100, lon: 35.1065 },
  { name: 'נוף הגליל', aliases: ['nof hagalil', 'נצרת עילית'], lat: 32.7196, lon: 35.3296 },
  { name: 'יקנעם', aliases: ['yokneam'], lat: 32.6590, lon: 35.1080 },
  { name: 'עפולה', aliases: ['afula'], lat: 32.6079, lon: 35.2889 },
  { name: 'כרמיאל', aliases: ['carmiel'], lat: 32.9136, lon: 35.3016 },
  { name: 'גבעתיים', aliases: ['givatayim'], lat: 32.0717, lon: 34.8118 },
  { name: 'יבנה', aliases: ['yavne'], lat: 31.8764, lon: 34.7394 },
  { name: 'שדרות', aliases: ['sderot'], lat: 31.5227, lon: 34.5962 },
  { name: 'מעלה אדומים', aliases: ['maale adumim'], lat: 31.7781, lon: 35.3084 },
  { name: 'אריאל', aliases: ['ariel'], lat: 32.1050, lon: 35.1741 },
  { name: 'יפו', aliases: ['jaffa', 'jaffo'], lat: 32.0503, lon: 34.7500 },
  { name: 'הרצליה פיתוח', aliases: ['herzliya pituach'], lat: 32.1639, lon: 34.7752 },
  { name: 'נס ציונה', aliases: ['ness ziona'], lat: 31.9314, lon: 34.7958 },
  { name: 'כנרת', aliases: ['kinneret', 'כינרת'], lat: 32.7160, lon: 35.5460 },
  { name: 'עין גדי', aliases: ['ein gedi'], lat: 31.4611, lon: 35.3870 },
  { name: 'ים המלח', aliases: ['dead sea'], lat: 31.5000, lon: 35.5000 },
  { name: 'רמת הגולן', aliases: ['golan heights'], lat: 33.0000, lon: 35.7500 },
  { name: 'מכתש רמון', aliases: ['ramon crater'], lat: 30.5978, lon: 34.8086 },
];

// ─── Recent locations storage ──────────────
const RECENT_KEY = 'twl_recent_locations';
const MAX_RECENT = 5;

function loadRecent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; }
  catch { return []; }
}

function saveRecent(loc) {
  const arr = loadRecent().filter(r => r.name !== loc.name);
  arr.unshift({ name: loc.name, lat: loc.lat, lon: loc.lon });
  if (arr.length > MAX_RECENT) arr.length = MAX_RECENT;
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(arr)); } catch {}
}

// ─── Hebrew text normalization ─────────────
function normalize(str) {
  return str
    .replace(/[\u0591-\u05C7]/g, '')    // strip niqqud/cantillation
    .replace(/[-–—]/g, ' ')             // dashes to spaces
    .replace(/"/g, '')                   // remove gershayim
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim()
    .toLowerCase();
}

// ─── Fuzzy matching ────────────────────────
function scoreMatch(query, city) {
  const q = normalize(query);
  const n = normalize(city.name);
  if (!q) return 0;

  // Exact prefix match (highest priority)
  if (n.startsWith(q)) return 1.0;

  // Check aliases
  for (const alias of city.aliases) {
    const a = normalize(alias);
    if (a.startsWith(q)) return 0.95;
    if (a.includes(q)) return 0.55;
  }

  // Substring match in name
  if (n.includes(q)) return 0.6;

  // Character-level: every char of q found in order in n
  let pos = 0;
  let matched = 0;
  for (const ch of q) {
    const idx = n.indexOf(ch, pos);
    if (idx >= 0) { matched++; pos = idx + 1; }
  }
  const ratio = matched / q.length;
  if (ratio >= 0.8) return 0.3 * ratio;

  return 0;
}

function searchLocal(query) {
  if (!query || query.length < 1) return [];
  const scored = ISRAEL_CITIES
    .map(c => ({ ...c, _score: scoreMatch(query, c) }))
    .filter(c => c._score > 0.2)
    .sort((a, b) => b._score - a._score);
  return scored.slice(0, 5);
}

// ─── Nominatim fallback ────────────────────
async function searchNominatim(query, signal) {
  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&countrycodes=il&accept-language=he`,
    { headers: { 'User-Agent': 'TWILIGHT-PWA/1.0' }, signal }
  );
  const data = await res.json();
  return data.map(d => ({
    name: d.display_name?.split(',')[0] || query,
    lat: parseFloat(d.lat),
    lon: parseFloat(d.lon),
    _source: 'nominatim'
  }));
}

// ─── Dropdown UI builder ───────────────────
function buildDropdownItem(item, idx, opts = {}) {
  const icon = opts.isRecent
    ? '<svg width="12" height="12" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
    : '<svg width="12" height="12" fill="var(--gold-light)" viewBox="0 0 24 24" style="flex-shrink:0"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>';
  return `<button class="location-dropdown-item" data-idx="${idx}" type="button">${icon}<span>${esc(item.name)}</span></button>`;
}

// ═══════════════════════════════════════════
//  Public API
// ═══════════════════════════════════════════

/**
 * Initialize location search autocomplete.
 * @param {HTMLElement} containerEl - Container for the search bar
 * @param {Object} options
 * @param {Function} options.onSelect - Callback: ({lat, lon, city}) => void
 * @param {string}  [options.placeholder] - Input placeholder text
 * @param {boolean} [options.showGpsButton] - Show GPS button (default: true)
 * @param {Function} [options.onGps] - GPS button handler
 * @param {Function} [options.extractType] - Optional type extractor for spots: (query) => {type, cleaned}
 * @param {boolean} [options.showCloseButton] - Show close button (default: true)
 * @param {Function} [options.onClose] - Close button handler
 * @returns {Function} cleanup function
 */
export function initLocationSearch(containerEl, options = {}) {
  const {
    onSelect,
    placeholder = 'הקלד שם עיר...',
    showGpsButton = true,
    showCloseButton = true,
    onGps,
    onClose,
    extractType
  } = options;

  // Build HTML
  const html = `
    <div class="loc-search-row1">
      <div class="search-input-wrap" style="flex:1">
        <svg width="14" height="14" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input class="search-input loc-search-input" type="text" placeholder="${esc(placeholder)}" dir="rtl" autocomplete="off" />
      </div>
      ${showCloseButton ? '<button class="search-filter-btn loc-search-close" type="button" title="סגור">✕</button>' : ''}
    </div>
    ${showGpsButton ? `
    <div class="loc-search-row2">
      <button class="search-filter-btn loc-search-btn-wide loc-search-gps" type="button">
        <svg width="14" height="14" fill="var(--gold-light)" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
        מיקום נוכחי
      </button>
    </div>` : ''}
    <div class="location-dropdown"></div>
  `;
  containerEl.innerHTML = html;

  const input = containerEl.querySelector('.loc-search-input');
  const dropdown = containerEl.querySelector('.location-dropdown');
  const closeBtn = containerEl.querySelector('.loc-search-close');
  const gpsBtn = containerEl.querySelector('.loc-search-gps');

  let debounceTimer = null;
  let abortCtrl = null;
  let currentItems = [];
  const ac = new AbortController();

  // ─── Render dropdown ───
  function renderDropdown(items, opts = {}) {
    currentItems = items;
    if (!items.length) { dropdown.classList.remove('open'); dropdown.innerHTML = ''; return; }
    dropdown.innerHTML = items.map((item, i) => buildDropdownItem(item, i, { isRecent: opts.isRecent && i < (opts.recentCount || 0) })).join('');
    dropdown.classList.add('open');
  }

  function closeDropdown() {
    dropdown.classList.remove('open');
    dropdown.innerHTML = '';
    currentItems = [];
  }

  function selectItem(item) {
    saveRecent(item);
    closeDropdown();
    if (input) input.value = '';
    onSelect?.({ lat: item.lat, lon: item.lon, city: item.name });
  }

  // ─── Show recent + popular on focus ───
  function showInitialSuggestions() {
    const recent = loadRecent();
    const popular = ISRAEL_CITIES.slice(0, 5).filter(c => !recent.some(r => r.name === c.name));
    const combined = [...recent, ...popular].slice(0, 6);
    if (combined.length) renderDropdown(combined, { isRecent: true, recentCount: recent.length });
  }

  // ─── Search handler (debounced) ───
  async function handleInput() {
    const raw = input?.value.trim() || '';

    // Extract type if spots mode
    let query = raw;
    if (extractType && raw) {
      const { cleaned } = extractType(raw);
      query = cleaned || raw;
    }

    if (query.length < 2) {
      if (query.length === 0) showInitialSuggestions();
      else closeDropdown();
      return;
    }

    // Local search first (instant)
    const local = searchLocal(query);
    if (local.length) renderDropdown(local);

    // Nominatim fallback if fewer than 3 local results
    if (local.length < 3) {
      if (abortCtrl) abortCtrl.abort();
      abortCtrl = new AbortController();
      try {
        const remote = await searchNominatim(query, abortCtrl.signal);
        // Merge: local first, then remote that don't duplicate
        const localNames = new Set(local.map(l => normalize(l.name)));
        const merged = [...local, ...remote.filter(r => !localNames.has(normalize(r.name)))].slice(0, 6);
        if (input?.value.trim() === raw) renderDropdown(merged);
      } catch {
        // Abort or network error — keep local results
      }
    }
  }

  // ─── Event listeners ───
  input?.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(handleInput, 300);
  }, { signal: ac.signal });

  input?.addEventListener('focus', () => {
    if (!input.value.trim()) showInitialSuggestions();
  }, { signal: ac.signal });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (currentItems.length) selectItem(currentItems[0]);
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  }, { signal: ac.signal });

  dropdown.addEventListener('click', (e) => {
    const btn = e.target.closest('.location-dropdown-item');
    if (!btn) return;
    const idx = parseInt(btn.dataset.idx);
    if (currentItems[idx]) selectItem(currentItems[idx]);
  }, { signal: ac.signal });

  closeBtn?.addEventListener('click', () => {
    closeDropdown();
    containerEl.classList.remove('open');
    onClose?.();
  }, { signal: ac.signal });

  if (gpsBtn && onGps) {
    gpsBtn.addEventListener('click', () => {
      closeDropdown();
      onGps();
    }, { signal: ac.signal });
  }

  // Close dropdown on outside click
  function handleOutsideClick(e) {
    if (!containerEl.contains(e.target)) closeDropdown();
  }
  document.addEventListener('click', handleOutsideClick, { signal: ac.signal });

  // ─── Cleanup ───
  return function cleanup() {
    ac.abort();
    clearTimeout(debounceTimer);
    if (abortCtrl) abortCtrl.abort();
  };
}
