// ═══════════════════════════════════════════
//  TWILIGHT — locationSearch.js v2
//  Unified location search: local cities + Nominatim fallback
//  Class-based with WeakMap auto-cleanup for mobile reliability
// ═══════════════════════════════════════════

import { esc } from './ui.js';

// ─── Israeli cities data ───────────────────
const ISRAEL_CITIES = [
  // ── Major cities ─────────────────────────────────────────────────────
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

  // ── Northern cities ──────────────────────────────────────────────────
  { name: 'נהריה', aliases: ['nahariya'], lat: 33.0060, lon: 35.0946 },
  { name: 'עכו', aliases: ['acre', 'akko'], lat: 32.9261, lon: 35.0764 },
  { name: 'טבריה', aliases: ['tiberias'], lat: 32.7940, lon: 35.5312 },
  { name: 'נצרת', aliases: ['nazareth'], lat: 32.6996, lon: 35.3035 },
  { name: 'חדרה', aliases: ['hadera'], lat: 32.4340, lon: 34.9196 },
  { name: 'קריית שמונה', aliases: ['kiryat shmona'], lat: 33.2073, lon: 35.5710 },
  { name: 'צפת', aliases: ['safed', 'zfat'], lat: 32.9646, lon: 35.4960 },
  { name: 'קיסריה', aliases: ['caesarea'], lat: 32.4996, lon: 34.8903 },
  { name: 'זכרון יעקב', aliases: ['zichron yaakov'], lat: 32.5714, lon: 34.9528 },
  { name: 'נוף הגליל', aliases: ['nof hagalil', 'נצרת עילית'], lat: 32.7196, lon: 35.3296 },
  { name: 'יקנעם', aliases: ['yokneam'], lat: 32.6590, lon: 35.1080 },
  { name: 'עפולה', aliases: ['afula'], lat: 32.6079, lon: 35.2889 },
  { name: 'כרמיאל', aliases: ['carmiel'], lat: 32.9136, lon: 35.3016 },
  { name: 'קריית ים', aliases: ['kiryat yam'], lat: 32.8414, lon: 35.0699 },
  { name: 'קריית אתא', aliases: ['kiryat ata'], lat: 32.8100, lon: 35.1065 },
  { name: 'קריית ביאליק', aliases: ['kiryat bialik'], lat: 32.8300, lon: 35.0850 },
  { name: 'קריית מוצקין', aliases: ['kiryat motzkin'], lat: 32.8400, lon: 35.0750 },
  { name: 'טירת כרמל', aliases: ['tirat carmel'], lat: 32.7600, lon: 34.9700 },
  { name: 'נשר', aliases: ['nesher'], lat: 32.7700, lon: 35.0400 },
  { name: 'מגדל העמק', aliases: ['migdal haemek'], lat: 32.6750, lon: 35.2400 },
  { name: 'בית שאן', aliases: ['beit shean', 'בית-שאן'], lat: 32.4974, lon: 35.4974 },
  { name: 'מעלות תרשיחא', aliases: ['maalot tarshiha', 'מעלות'], lat: 33.0167, lon: 35.2750 },
  { name: 'שלומי', aliases: ['shlomi'], lat: 33.0750, lon: 35.1450 },

  // ── Center / Sharon / Shephelah ──────────────────────────────────────
  { name: 'גבעתיים', aliases: ['givatayim'], lat: 32.0717, lon: 34.8118 },
  { name: 'יבנה', aliases: ['yavne'], lat: 31.8764, lon: 34.7394 },
  { name: 'יפו', aliases: ['jaffa', 'jaffo'], lat: 32.0503, lon: 34.7500 },
  { name: 'הרצליה פיתוח', aliases: ['herzliya pituach'], lat: 32.1639, lon: 34.7752 },
  { name: 'נס ציונה', aliases: ['ness ziona'], lat: 31.9314, lon: 34.7958 },
  { name: 'ראש העין', aliases: ['rosh haayin'], lat: 32.0956, lon: 34.9567 },
  { name: 'גדרה', aliases: ['gedera'], lat: 31.8125, lon: 34.7789 },
  { name: 'גן יבנה', aliases: ['gan yavne'], lat: 31.7903, lon: 34.7072 },
  { name: 'אור יהודה', aliases: ['or yehuda'], lat: 32.0286, lon: 34.8555 },
  { name: 'קריית אונו', aliases: ['kiryat ono'], lat: 32.0633, lon: 34.8553 },
  { name: 'אזור', aliases: ['azor'], lat: 32.0247, lon: 34.7986 },
  { name: 'בית דגן', aliases: ['beit dagan'], lat: 32.0008, lon: 34.8361 },
  { name: 'שוהם', aliases: ['shoham'], lat: 31.9500, lon: 34.9467 },
  { name: 'אלעד', aliases: ['elad'], lat: 32.0525, lon: 34.9511 },
  { name: 'גבעת שמואל', aliases: ['givat shmuel'], lat: 32.0753, lon: 34.8478 },
  { name: 'כפר יונה', aliases: ['kfar yona'], lat: 32.3164, lon: 34.9364 },
  { name: 'פרדס חנה כרכור', aliases: ['pardes hanna karkur', 'פרדס חנה'], lat: 32.4722, lon: 34.9667 },
  { name: 'בנימינה', aliases: ['binyamina'], lat: 32.5211, lon: 34.9444 },
  { name: 'אור עקיבא', aliases: ['or akiva'], lat: 32.5083, lon: 34.9200 },
  { name: 'עתלית', aliases: ['atlit'], lat: 32.6867, lon: 34.9383 },

  // ── South / Negev ────────────────────────────────────────────────────
  { name: 'בית שמש', aliases: ['beit shemesh'], lat: 31.7468, lon: 34.9885 },
  { name: 'ערד', aliases: ['arad'], lat: 31.2588, lon: 35.2126 },
  { name: 'מצפה רמון', aliases: ['mitzpe ramon'], lat: 30.6100, lon: 34.8015 },
  { name: 'דימונה', aliases: ['dimona'], lat: 31.0696, lon: 35.0338 },
  { name: 'קריית גת', aliases: ['kiryat gat'], lat: 31.6061, lon: 34.7648 },
  { name: 'שדרות', aliases: ['sderot'], lat: 31.5227, lon: 34.5962 },
  { name: 'נתיבות', aliases: ['netivot'], lat: 31.4219, lon: 34.5889 },
  { name: 'אופקים', aliases: ['ofakim'], lat: 31.3133, lon: 34.6200 },
  { name: 'ירוחם', aliases: ['yeruham'], lat: 30.9875, lon: 34.9297 },
  { name: 'מיתר', aliases: ['meitar'], lat: 31.3258, lon: 34.9333 },
  { name: 'להבים', aliases: ['lehavim'], lat: 31.3750, lon: 34.8167 },
  { name: 'עומר', aliases: ['omer'], lat: 31.2639, lon: 34.8500 },
  { name: 'קריית מלאכי', aliases: ['kiryat malachi'], lat: 31.7286, lon: 34.7475 },
  { name: 'שדה בועז', aliases: ['sde boaz', 'sdeh boaz'], lat: 31.2400, lon: 35.1500 },
  { name: 'שדה בוקר', aliases: ['sde boker'], lat: 30.8717, lon: 34.7917 },
  { name: 'טללים', aliases: ['tlalim'], lat: 30.9650, lon: 34.7570 },
  { name: 'רתמים', aliases: ['retamim'], lat: 31.0200, lon: 34.6200 },
  { name: 'כסיפה', aliases: ['kseife', 'כסייפה'], lat: 31.2300, lon: 34.9800 },
  { name: 'רהט', aliases: ['rahat'], lat: 31.3925, lon: 34.7536 },
  { name: 'ניר עם', aliases: ['nir am'], lat: 31.4833, lon: 34.5500 },

  // ── Judea & Samaria settlements ──────────────────────────────────────
  { name: 'מעלה אדומים', aliases: ['maale adumim'], lat: 31.7781, lon: 35.3084 },
  { name: 'אריאל', aliases: ['ariel'], lat: 32.1050, lon: 35.1741 },
  { name: 'אפרת', aliases: ['efrat'], lat: 31.6558, lon: 35.1592 },
  { name: 'ביתר עילית', aliases: ['beitar illit', 'ביתר'], lat: 31.6948, lon: 35.1183 },
  { name: 'קרית ארבע', aliases: ['kiryat arba'], lat: 31.5266, lon: 35.1184 },
  { name: 'גבעת זאב', aliases: ['givat zeev'], lat: 31.8614, lon: 35.1741 },
  { name: 'בית אל', aliases: ['beit el'], lat: 31.9424, lon: 35.2277 },
  { name: 'עלי', aliases: ['eli'], lat: 32.0773, lon: 35.2645 },
  { name: 'שילה', aliases: ['shilo'], lat: 32.0551, lon: 35.2901 },
  { name: 'עופרה', aliases: ['ofra'], lat: 31.9519, lon: 35.2596 },
  { name: 'קדומים', aliases: ['kedumim'], lat: 32.1713, lon: 35.1612 },
  { name: 'אלקנה', aliases: ['elkana'], lat: 32.1114, lon: 35.0328 },
  { name: 'עמנואל', aliases: ['immanuel'], lat: 32.1499, lon: 35.1583 },
  { name: 'קרני שומרון', aliases: ['karnei shomron'], lat: 32.1731, lon: 35.0935 },
  { name: 'גוש עציון', aliases: ['gush etzion'], lat: 31.6469, lon: 35.1182 },
  { name: 'ברקן', aliases: ['barkan'], lat: 32.1234, lon: 35.0907 },
  { name: 'בית אריה', aliases: ['beit aryeh'], lat: 32.0408, lon: 35.0449 },
  { name: 'גבע בנימין', aliases: ['geva binyamin', 'adam', 'אדם'], lat: 31.8864, lon: 35.2498 },
  { name: 'תקוע', aliases: ['tekoa'], lat: 31.6383, lon: 35.2109 },
  { name: 'חשמונאים', aliases: ['hashmonaim'], lat: 31.9268, lon: 35.0197 },
  { name: 'כוכב יעקב', aliases: ['kochav yaakov'], lat: 31.8833, lon: 35.2542 },
  { name: 'נוקדים', aliases: ['nokdim'], lat: 31.6250, lon: 35.2000 },
  { name: 'מגדל עוז', aliases: ['migdal oz'], lat: 31.6600, lon: 35.1250 },
  { name: 'כפר עציון', aliases: ['kfar etzion'], lat: 31.6519, lon: 35.1100 },
  { name: 'אלון שבות', aliases: ['alon shvut'], lat: 31.6567, lon: 35.1317 },
  { name: 'נווה דניאל', aliases: ['neve daniel'], lat: 31.6700, lon: 35.1350 },
  { name: 'שדה בועז', aliases: ['sdeh boaz', 'sde boaz'], lat: 31.6926, lon: 35.1467 },
  { name: 'כרמי צור', aliases: ['karmei tzur'], lat: 31.5850, lon: 35.1050 },
  { name: 'פסגות', aliases: ['psagot'], lat: 31.9100, lon: 35.2350 },
  { name: 'רבבה', aliases: ['revava'], lat: 32.1550, lon: 35.1200 },
  { name: 'יצהר', aliases: ['yitzhar'], lat: 32.1550, lon: 35.2500 },
  { name: 'איתמר', aliases: ['itamar'], lat: 32.1700, lon: 35.2950 },
  { name: 'ברכה', aliases: ['bracha'], lat: 32.1850, lon: 35.2800 },

  // ── Kibbutzim & Moshavim (popular/notable) ───────────────────────────
  { name: 'דגניה', aliases: ['degania'], lat: 32.7100, lon: 35.5700 },
  { name: 'עין גב', aliases: ['ein gev'], lat: 32.7700, lon: 35.6400 },
  { name: 'גינוסר', aliases: ['ginosar'], lat: 32.8400, lon: 35.5200 },
  { name: 'חצור הגלילית', aliases: ['hazor haglilit'], lat: 32.9800, lon: 35.5400 },
  { name: 'ראש פינה', aliases: ['rosh pina'], lat: 32.9694, lon: 35.5417 },
  { name: 'מטולה', aliases: ['metula'], lat: 33.2800, lon: 35.5800 },
  { name: 'יסוד המעלה', aliases: ['yesod hamaala'], lat: 33.0600, lon: 35.6000 },
  { name: 'משמר הירדן', aliases: ['mishmar hayarden'], lat: 32.9300, lon: 35.6200 },
  { name: 'כפר בלום', aliases: ['kfar blum'], lat: 33.1750, lon: 35.6200 },
  { name: 'שדה אליהו', aliases: ['sde eliyahu'], lat: 32.4200, lon: 35.5100 },
  { name: 'גשר', aliases: ['gesher'], lat: 32.6200, lon: 35.5600 },
  { name: 'מרום גולן', aliases: ['merom golan'], lat: 33.1300, lon: 35.7700 },
  { name: 'קצרין', aliases: ['katzrin'], lat: 32.9950, lon: 35.6900 },
  { name: 'אל רום', aliases: ['el rom'], lat: 33.2000, lon: 35.8000 },
  { name: 'נווה אטי"ב', aliases: ['neve ativ', 'נווה אטיב'], lat: 33.2500, lon: 35.7700 },
  { name: 'מנרה', aliases: ['manara'], lat: 33.2300, lon: 35.5500 },
  { name: 'כפר גלעדי', aliases: ['kfar giladi'], lat: 33.2400, lon: 35.5700 },
  { name: 'מעיין ברוך', aliases: ['maayan baruch'], lat: 33.2200, lon: 35.6100 },

  // ── Coastal communities ──────────────────────────────────────────────
  { name: 'עין הוד', aliases: ['ein hod'], lat: 32.7000, lon: 34.9800 },
  { name: 'חוף הכרמל', aliases: ['hof hacarmel'], lat: 32.6800, lon: 34.9600 },
  { name: 'דור', aliases: ['dor'], lat: 32.6100, lon: 34.9200 },
  { name: 'חוף דור', aliases: ['hof dor'], lat: 32.6083, lon: 34.9150 },
  { name: 'מכמורת', aliases: ['michmoret'], lat: 32.4017, lon: 34.8633 },
  { name: 'ג\'סר א-זרקא', aliases: ['jisr az zarqa'], lat: 32.5367, lon: 34.9050 },

  // ── Jordan Valley / Dead Sea / Arava ─────────────────────────────────
  { name: 'כנרת', aliases: ['kinneret', 'כינרת'], lat: 32.7160, lon: 35.5460 },
  { name: 'עין גדי', aliases: ['ein gedi'], lat: 31.4611, lon: 35.3870 },
  { name: 'ים המלח', aliases: ['dead sea'], lat: 31.5000, lon: 35.5000 },
  { name: 'רמת הגולן', aliases: ['golan heights'], lat: 33.0000, lon: 35.7500 },
  { name: 'מכתש רמון', aliases: ['ramon crater'], lat: 30.5978, lon: 34.8086 },
  { name: 'יריחו', aliases: ['jericho'], lat: 31.8667, lon: 35.4500 },
  { name: 'בקעת הירדן', aliases: ['jordan valley'], lat: 32.2800, lon: 35.5200 },
  { name: 'מצדה', aliases: ['masada'], lat: 31.3150, lon: 35.3533 },
  { name: 'עין בוקק', aliases: ['ein bokek'], lat: 31.2000, lon: 35.3600 },
  { name: 'נאות הכיכר', aliases: ['neot hakikar'], lat: 30.9350, lon: 35.3700 },
  { name: 'יטבתה', aliases: ['yotvata'], lat: 29.8917, lon: 35.0633 },
  { name: 'פארן', aliases: ['paran'], lat: 30.1600, lon: 35.1400 },
  { name: 'ספיר', aliases: ['sapir'], lat: 30.0300, lon: 35.1600 },
  { name: 'קטורה', aliases: ['ketura'], lat: 29.9700, lon: 35.0700 },
  { name: 'באר אורה', aliases: ['beer ora'], lat: 29.7200, lon: 35.0000 },

  // ── Druze & Arab towns ───────────────────────────────────────────────
  { name: 'דלית אל כרמל', aliases: ['daliyat al karmel'], lat: 32.6917, lon: 35.0500 },
  { name: 'עספיא', aliases: ['isfiya', 'עוספיה'], lat: 32.7100, lon: 35.0650 },
  { name: 'מג\'דל שמס', aliases: ['majdal shams'], lat: 33.2700, lon: 35.7700 },
  { name: 'פקיעין', aliases: ['pekiin'], lat: 32.9700, lon: 35.3300 },
  { name: 'בועיינה-נוג\'ידאת', aliases: ['bueine nujeidat'], lat: 32.8250, lon: 35.3350 },
  { name: 'סח\'נין', aliases: ['sakhnin'], lat: 32.8633, lon: 35.2983 },
  { name: 'אום אל פחם', aliases: ['umm al fahm'], lat: 32.5167, lon: 35.1500 },
  { name: 'טמרה', aliases: ['tamra'], lat: 32.8500, lon: 35.2000 },
  { name: 'שפרעם', aliases: ['shfaram'], lat: 32.8050, lon: 35.1700 },
  { name: 'אבו גוש', aliases: ['abu ghosh'], lat: 31.8067, lon: 35.1133 },
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
  const timeoutCtrl = new AbortController();
  const timer = setTimeout(() => timeoutCtrl.abort(), 5000);

  // Chain abort: if outer signal fires, abort our inner controller too
  const onOuterAbort = () => timeoutCtrl.abort();
  signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&countrycodes=il&viewbox=34.0,33.5,35.9,29.4&bounded=1&accept-language=he`,
      { headers: { 'User-Agent': 'TWILIGHT-PWA/1.0' }, signal: timeoutCtrl.signal }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data
      .map(d => ({
        name: d.display_name?.split(',')[0] || query,
        lat: parseFloat(d.lat),
        lon: parseFloat(d.lon),
        _source: 'nominatim'
      }))
      .filter(d => !isNaN(d.lat) && !isNaN(d.lon));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}

// ─── Dropdown item builder ─────────────────
function buildDropdownItem(item, idx, opts = {}) {
  const icon = opts.isRecent
    ? '<svg width="12" height="12" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
    : '<svg width="12" height="12" fill="var(--gold-light)" viewBox="0 0 24 24" style="flex-shrink:0"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>';
  return `<button class="location-dropdown-item" data-idx="${idx}" type="button">${icon}<span>${esc(item.name)}</span></button>`;
}

// ═══════════════════════════════════════════
//  LocationSearch class — lifecycle-managed
// ═══════════════════════════════════════════

const _instances = new WeakMap();

class LocationSearch {
  constructor(containerEl, options) {
    this._container = containerEl;
    this._options = options;
    this._ac = new AbortController();    // master signal for all DOM listeners
    this._fetchCtrl = null;              // Nominatim abort controller
    this._debounceTimer = null;
    this._currentItems = [];
    this._highlightIdx = -1;
    this._destroyed = false;

    this._buildDOM();
    this._attachEvents();
  }

  // ─── DOM construction ───
  _buildDOM() {
    const {
      placeholder = 'הקלד שם עיר...',
      showGpsButton = true,
      showCloseButton = true,
    } = this._options;

    this._container.innerHTML = `
      <div class="loc-search-row1">
        <div class="search-input-wrap" style="flex:1">
          <svg width="14" height="14" fill="none" stroke="var(--cream-faint)" stroke-width="2" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input class="search-input loc-search-input" type="text" placeholder="${esc(placeholder)}" dir="rtl" autocomplete="off" inputmode="search" enterkeyhint="search" />
        </div>
        <button class="search-filter-btn loc-search-submit" type="button" title="חפש" style="display:none">
          <svg width="16" height="16" fill="none" stroke="var(--cream)" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        </button>
        ${showCloseButton ? '<button class="search-filter-btn loc-search-close" type="button" title="סגור">✕</button>' : ''}
      </div>
      <div class="loc-search-row2">
        <button class="search-filter-btn loc-search-btn-wide loc-search-manual" type="button">
          <svg width="14" height="14" fill="none" stroke="var(--gold-light)" stroke-width="2.5" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          חפש מיקום
        </button>
        ${showGpsButton ? `
        <button class="search-filter-btn loc-search-btn-wide loc-search-gps" type="button">
          <svg width="14" height="14" fill="var(--gold-light)" viewBox="0 0 24 24"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/></svg>
          מיקום נוכחי
        </button>` : ''}
      </div>
      <div class="location-dropdown"></div>
    `;

    this._input      = this._container.querySelector('.loc-search-input');
    this._dropdown   = this._container.querySelector('.location-dropdown');
    this._closeBtn   = this._container.querySelector('.loc-search-close');
    this._gpsBtn     = this._container.querySelector('.loc-search-gps');
    this._submitBtn  = this._container.querySelector('.loc-search-submit');
    this._manualBtn  = this._container.querySelector('.loc-search-manual');
  }

  // ─── Event binding ───
  _attachEvents() {
    const sig = { signal: this._ac.signal };

    // Input — debounced search + toggle submit button visibility
    this._input?.addEventListener('input', () => {
      clearTimeout(this._debounceTimer);
      if (this._submitBtn) {
        this._submitBtn.style.display = this._input.value.trim().length >= 2 ? 'flex' : 'none';
      }
      this._debounceTimer = setTimeout(() => this._handleSearch(), 250);
    }, sig);

    // Focus — show initial suggestions
    this._input?.addEventListener('focus', () => {
      if (!this._input.value.trim()) this._showInitialSuggestions();
    }, sig);

    // Keyboard navigation
    this._input?.addEventListener('keydown', (e) => this._handleKeydown(e), sig);

    // Dropdown item selection — use pointerdown (fires BEFORE blur on mobile)
    this._dropdown.addEventListener('pointerdown', (e) => {
      const btn = e.target.closest('.location-dropdown-item');
      if (!btn) return;
      e.preventDefault(); // prevent input blur
      const idx = parseInt(btn.dataset.idx);
      if (this._currentItems[idx]) this._selectItem(this._currentItems[idx]);
    }, sig);

    // Close button
    this._closeBtn?.addEventListener('click', () => {
      this._closeDropdown();
      this._container.classList.remove('open');
      this._options.onClose?.();
    }, sig);

    // GPS button
    if (this._gpsBtn && this._options.onGps) {
      this._gpsBtn.addEventListener('click', () => {
        this._closeDropdown();
        this._options.onGps();
      }, sig);
    }

    // Search submit button (icon in row1) — immediate search, no debounce
    this._submitBtn?.addEventListener('click', () => {
      clearTimeout(this._debounceTimer);
      this._handleSearch();
    }, sig);

    // Manual search button (wide, in row2) — focuses input and triggers search
    this._manualBtn?.addEventListener('click', () => {
      this._input?.focus();
      clearTimeout(this._debounceTimer);
      if (this._input?.value.trim().length >= 2) {
        this._handleSearch();
      }
    }, sig);

    // Outside close — focusout with rAF guard
    this._container.addEventListener('focusout', () => {
      requestAnimationFrame(() => {
        if (this._destroyed) return;
        if (!this._container.contains(document.activeElement)) {
          this._closeDropdown();
        }
      });
    }, sig);

    // Backup: close dropdown on outside pointerdown (catches taps on non-focusable areas)
    document.addEventListener('pointerdown', (e) => {
      if (!this._container.contains(e.target)) this._closeDropdown();
    }, sig);
  }

  // ─── Keyboard navigation ───
  _handleKeydown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      this._highlightIdx = Math.min(this._highlightIdx + 1, this._currentItems.length - 1);
      this._updateHighlight();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      this._highlightIdx = Math.max(this._highlightIdx - 1, 0);
      this._updateHighlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (this._currentItems.length > 0) {
        const idx = this._highlightIdx >= 0 ? this._highlightIdx : 0;
        this._selectItem(this._currentItems[idx]);
      } else if (this._input?.value.trim().length >= 2) {
        clearTimeout(this._debounceTimer);
        this._handleSearch();
      }
    } else if (e.key === 'Escape') {
      this._closeDropdown();
      this._options.onClose?.();
    }
  }

  _updateHighlight() {
    const items = this._dropdown.querySelectorAll('.location-dropdown-item');
    items.forEach((el, i) => {
      el.classList.toggle('highlighted', i === this._highlightIdx);
    });
    // Scroll highlighted item into view
    items[this._highlightIdx]?.scrollIntoView({ block: 'nearest' });
  }

  // ─── Search handler ───
  async _handleSearch() {
    if (this._destroyed) return;
    const raw = this._input?.value.trim() || '';

    // Extract type if spots mode
    let query = raw;
    if (this._options.extractType && raw) {
      const { cleaned } = this._options.extractType(raw);
      query = cleaned || raw;
    }

    if (query.length < 2) {
      if (query.length === 0) this._showInitialSuggestions();
      else this._closeDropdown();
      return;
    }

    // Local search first (instant)
    const local = searchLocal(query);
    if (local.length) this._renderDropdown(local);

    // Nominatim fallback only if very few local results (local DB is comprehensive)
    if (local.length < 2) {
      if (this._fetchCtrl) this._fetchCtrl.abort();
      this._fetchCtrl = new AbortController();
      // Show loading indicator while fetching remote
      if (!local.length) this._showLoading();
      const remote = await searchNominatim(query, this._fetchCtrl.signal);
      if (this._destroyed) return;
      // Only update if input hasn't changed while we waited
      if (this._input?.value.trim() === raw) {
        const localNames = new Set(local.map(l => normalize(l.name)));
        const merged = [...local, ...remote.filter(r => !localNames.has(normalize(r.name)))].slice(0, 6);
        this._renderDropdown(merged);
      }
    }
  }

  // ─── Loading indicator ───
  _showLoading() {
    this._dropdown.innerHTML = '<div class="loc-search-loading">מחפש...</div>';
    this._dropdown.classList.add('open');
  }

  // ─── Initial suggestions ───
  _showInitialSuggestions() {
    const recent = loadRecent();
    const popular = ISRAEL_CITIES.slice(0, 5).filter(c => !recent.some(r => r.name === c.name));
    const combined = [...recent, ...popular].slice(0, 6);
    if (combined.length) this._renderDropdown(combined, { isRecent: true, recentCount: recent.length });
  }

  // ─── Dropdown rendering ───
  _renderDropdown(items, opts = {}) {
    this._currentItems = items;
    this._highlightIdx = -1;
    if (!items.length) { this._closeDropdown(); return; }
    this._dropdown.innerHTML = items.map((item, i) =>
      buildDropdownItem(item, i, { isRecent: opts.isRecent && i < (opts.recentCount || 0) })
    ).join('');
    this._dropdown.classList.add('open');
  }

  _closeDropdown() {
    this._dropdown.classList.remove('open');
    this._dropdown.innerHTML = '';
    this._currentItems = [];
    this._highlightIdx = -1;
  }

  // ─── Item selection ───
  _selectItem(item) {
    saveRecent(item);
    this._closeDropdown();
    if (this._input) this._input.value = '';
    this._options.onSelect?.({ lat: item.lat, lon: item.lon, city: item.name });
  }

  // ─── Cleanup ───
  destroy() {
    if (this._destroyed) return;
    this._destroyed = true;
    this._ac.abort();
    clearTimeout(this._debounceTimer);
    if (this._fetchCtrl) this._fetchCtrl.abort();
    this._container.innerHTML = '';
  }
}

// ═══════════════════════════════════════════
//  Public API — same contract as v1
// ═══════════════════════════════════════════

/**
 * Initialize location search autocomplete.
 * Auto-cleans up any previous instance on the same container (WeakMap guard).
 *
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
  // Auto-cleanup previous instance on same container — prevents duplicate listeners
  if (_instances.has(containerEl)) {
    _instances.get(containerEl).destroy();
  }

  const instance = new LocationSearch(containerEl, options);
  _instances.set(containerEl, instance);

  return function cleanup() {
    instance.destroy();
    _instances.delete(containerEl);
  };
}
