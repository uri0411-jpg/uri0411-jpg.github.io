import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'FULLCODE.TXT');

const INCLUDE_EXTS = new Set(['.js', '.mjs', '.html', '.css', '.json']);

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'android', '.claude', 'images',
]);

const EXCLUDE_FILES = new Set([
  'package-lock.json',
  'learning-seed.json',
  'scripts.zip',
  'FULLCODE.TXT',
]);

function* walk(dir, rel = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const fullPath = path.join(dir, name);
    const relPath = rel ? `${rel}/${name}` : name;

    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue;
      yield* walk(fullPath, relPath);
    } else if (entry.isFile()) {
      if (EXCLUDE_FILES.has(name)) continue;
      if (!INCLUDE_EXTS.has(path.extname(name))) continue;
      // Skip very large JSON files (>500KB)
      const stat = fs.statSync(fullPath);
      if (path.extname(name) === '.json' && stat.size > 500_000) continue;
      yield { fullPath, relPath };
    }
  }
}

const SEP = '='.repeat(80);
const out = fs.createWriteStream(OUTPUT, { encoding: 'utf8' });

let count = 0;
for (const { fullPath, relPath } of walk(ROOT)) {
  out.write(`${SEP}\nFILE: ${relPath}\n${SEP}\n`);
  out.write(fs.readFileSync(fullPath, 'utf8'));
  out.write('\n\n');
  count++;
}

out.end(() => {
  const size = fs.statSync(OUTPUT).size;
  console.log(`Done. ${count} files written to FULLCODE.TXT (${(size / 1024 / 1024).toFixed(2)} MB)`);
});
