// ═══════════════════════════════════════════
//  TWILIGHT — spots/storage.js
//  Favorites + visited localStorage I/O. Owns in-memory caches.
//
//  Extracted from spots-screen.js to keep that orchestrator under 1500 lines.
//  Holds module-level state for the in-memory favorites/visited arrays;
//  loadFavorites()/loadVisited() refresh the caches from localStorage.
// ═══════════════════════════════════════════

const FAV_KEY = 'twl_fav_spots';
const VIS_KEY = 'twl_visited_spots';

let _favorites = _readKey(FAV_KEY);
let _visited   = _readKey(VIS_KEY);

function _readKey(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; } catch { return []; }
}
function _writeKey(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

export function loadFavorites() { _favorites = _readKey(FAV_KEY); return _favorites; }
export function isFavorite(name, lat, lon) {
  return _favorites.some(f => f.name === name && Math.abs(f.lat - lat) < 0.001);
}
export function toggleFavorite(name, lat, lon) {
  const idx = _favorites.findIndex(f => f.name === name && Math.abs(f.lat - lat) < 0.001);
  if (idx >= 0) _favorites.splice(idx, 1); else _favorites.push({ name, lat, lon });
  _writeKey(FAV_KEY, _favorites);
}

export function loadVisited() { _visited = _readKey(VIS_KEY); return _visited; }
export function isVisited(name, lat, lon) {
  return _visited.some(v => v.name === name && Math.abs(v.lat - lat) < 0.001);
}
export function toggleVisited(name, lat, lon) {
  const idx = _visited.findIndex(v => v.name === name && Math.abs(v.lat - lat) < 0.001);
  if (idx >= 0) _visited.splice(idx, 1);
  else _visited.push({ name, lat, lon, date: new Date().toISOString().slice(0, 10) });
  _writeKey(VIS_KEY, _visited);
}
