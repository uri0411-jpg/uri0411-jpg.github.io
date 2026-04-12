/**
 * bump_sw.mjs — Auto-update BUILD_DATE in sw.js to today's date (YYYYMMDD).
 * Run before every deploy: node scripts/bump_sw.mjs
 */
import { readFileSync, writeFileSync } from 'fs';

const swPath = new URL('../sw.js', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
const now    = new Date();
const today  = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`; // local date YYYYMMDD

const content = readFileSync(swPath, 'utf8');
const updated = content.replace(/BUILD_DATE\s*=\s*'\d{8}'/, `BUILD_DATE  = '${today}'`);

if (content === updated) {
  console.log(`sw.js BUILD_DATE already up to date: ${today}`);
} else {
  writeFileSync(swPath, updated, 'utf8');
  console.log(`✓ sw.js BUILD_DATE bumped → ${today}`);
}
