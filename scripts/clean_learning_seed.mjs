/**
 * clean_learning_seed.mjs — v46 data hygiene
 *
 * 1. Caps all paramRatio values at 1.0 (values > 1 are physically invalid)
 * 2. Removes exact duplicate date+locBucket pairs (keeps first occurrence)
 * 3. Updates metadata: version → 3, generated timestamp, entryCount
 *
 * Usage: node scripts/clean_learning_seed.mjs
 */
import { readFileSync, writeFileSync } from 'fs';

const PATH = new URL('../learning-seed.json', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

const data = JSON.parse(readFileSync(PATH, 'utf8'));
let cappedCount = 0;

// 1. Cap ratio values > 1
data.entries = data.entries.map(e => {
  if (!e.paramRatios) return e;
  const pr = { ...e.paramRatios };
  for (const key of Object.keys(pr)) {
    if (typeof pr[key] === 'number' && pr[key] > 1) {
      pr[key] = 1;
      cappedCount++;
    }
  }
  return { ...e, paramRatios: pr };
});

// 2. Remove exact date+locBucket duplicates (keep first)
const seen = new Set();
const before = data.entries.length;
data.entries = data.entries.filter(e => {
  const k = `${e.date}|${e.locBucket}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
const removedDupes = before - data.entries.length;

// 3. Update metadata
data.version    = 3;
data.entryCount = data.entries.length;
data.generated  = new Date().toISOString();

writeFileSync(PATH, JSON.stringify(data, null, 2), 'utf8');

console.log(`✓ learning-seed.json cleaned (v3)`);
console.log(`  ratio values capped:     ${cappedCount}`);
console.log(`  duplicates removed:      ${removedDupes}`);
console.log(`  final entry count:       ${data.entryCount}`);
