#!/usr/bin/env node
/**
 * build_tokens.mjs — generates css/tokens.css from tokens/*.json
 *
 * Zero-dependency build: reads the DTCG-format token files and emits
 * CSS custom properties under :root (sunset) and body.night-vision.
 *
 * Usage:  node scripts/build_tokens.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TOKENS = join(ROOT, 'tokens');
const OUT    = join(ROOT, 'css', 'tokens.css');

const PREFIX = 'twl';

/* ── helpers ── */

function readJSON(name) {
  return JSON.parse(readFileSync(join(TOKENS, name), 'utf-8'));
}

/**
 * Flatten a nested token object into [path, value] pairs.
 * Only leaf nodes with $value are emitted.
 */
function flatten(obj, path = []) {
  const entries = [];
  for (const [key, val] of Object.entries(obj)) {
    if (key.startsWith('$')) continue;            // skip $type, $description etc.
    if (val && typeof val === 'object' && '$value' in val) {
      entries.push([path.concat(key), val.$value]);
    } else if (val && typeof val === 'object') {
      entries.push(...flatten(val, path.concat(key)));
    }
  }
  return entries;
}

/** Convert token path array to CSS variable name */
function toVar(segments) {
  return `--${PREFIX}-${segments.join('-')}`;
}

/** Format a single CSS variable declaration */
function decl(segments, value) {
  const name = toVar(segments);
  const v = typeof value === 'number' ? String(value) : value;
  return `  ${name}: ${v};`;
}

/**
 * Extract RGB components from hex colors for rgba() usage.
 * e.g. #F5E6C8 → "245, 230, 200"
 */
function hexToRGB(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

/** Check if value is a plain hex color */
function isHex(v) {
  return typeof v === 'string' && /^#[0-9A-Fa-f]{6}$/.test(v);
}

/* ── build ── */

const primitives = readJSON('primitives.json');
const semantic   = readJSON('semantic.json');
const night      = readJSON('semantic-night.json');

const primEntries = flatten(primitives);
const semEntries  = flatten(semantic);
const nightEntries = flatten(night);

// Build RGB companion tokens for hex colors (useful for rgba() patterns)
const rgbEntries = [];
for (const [path, value] of [...primEntries, ...semEntries]) {
  if (isHex(value)) {
    rgbEntries.push([path.concat('rgb'), hexToRGB(value)]);
  }
}

const lines = [];

lines.push('/* ═══════════════════════════════════════════');
lines.push('   TWILIGHT — Design Tokens (auto-generated)');
lines.push('   Source: tokens/*.json');
lines.push('   Build:  node scripts/build_tokens.mjs');
lines.push('   DO NOT EDIT — regenerate with: npm run build:tokens');
lines.push('═══════════════════════════════════════════ */');
lines.push('');

// :root — primitives + semantic
lines.push(':root {');
lines.push('  /* ── Primitives ── */');
for (const [path, value] of primEntries) {
  lines.push(decl(path, value));
}
lines.push('');
lines.push('  /* ── RGB companions (for rgba() usage) ── */');
for (const [path, value] of rgbEntries) {
  lines.push(decl(path, value));
}
lines.push('');
lines.push('  /* ── Semantic ── */');
for (const [path, value] of semEntries) {
  lines.push(decl(path, value));
}
lines.push('');
lines.push('  /* ── Dynamic (JS-driven, defaults only) ── */');
lines.push('  --twl-dynamic-glass-blur: 8px;');
lines.push('  --twl-dynamic-glass-alpha: 0.57;');
lines.push('  --twl-dynamic-glass-saturate: 120%;');
lines.push('  --twl-dynamic-sky-luma: 0.5;');
lines.push('  --twl-dynamic-ui-sky-t: 0.5;');
lines.push('  --twl-dynamic-text-glow: rgba(255, 255, 255, 0.9);');
lines.push('}');
lines.push('');

// body.night-vision — overrides
lines.push('/* ── Night Vision overrides ── */');
lines.push('body.night-vision {');
for (const [path, value] of nightEntries) {
  // Map night tokens to the same semantic variable names
  lines.push(decl(path, value));
}
lines.push('}');
lines.push('');

const css = lines.join('\n');
writeFileSync(OUT, css, 'utf-8');

console.log(`✓ Generated ${OUT} (${primEntries.length} primitives + ${semEntries.length} semantic + ${nightEntries.length} night overrides + ${rgbEntries.length} RGB companions)`);
