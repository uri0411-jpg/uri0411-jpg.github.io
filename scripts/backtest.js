#!/usr/bin/env node
// ═══════════════════════════════════════════
//  backtest.js — Historical backtest pipeline orchestrator
//
//  Usage:
//    node scripts/backtest.js [options]
//
//  Options:
//    --days=365          How many days back to fetch (default: 365)
//    --locations=a,b,c   Comma-separated location keys (default: all 6)
//    --skip-photos       Skip all photo evidence fetching
//    --skip-vision       Skip Claude vision rating (use count proxy only)
//
//  Location keys: tlv, herzliya, haifa, jer, beer, tiberias
//
//  Output:
//    scripts/data/results-{location}.json   per-location raw data
//    scripts/data/learning-seed.json        ready to import in browser settings
//
//  API keys (all optional — set in scripts/.env):
//    ANTHROPIC_API_KEY  — Claude Haiku vision rating  (~$1.30 / 365 days)
//    FLICKR_API_KEY     — Flickr geo+time photo search
//    WINDY_API_KEY      — Windy webcam discovery
// ═══════════════════════════════════════════

import 'dotenv/config';
import { fetchArchiveBatched }              from './lib/archive-fetch.js';
import { scoreActualConditions }            from './lib/score-calc.js';
import { discoverWebcams, fetchWebcamFrame, flickrSearch } from './lib/webcam-fetch.js';
import { rateWebcamFrames, rateFlickrPhotos }              from './lib/photo-rate.js';
import { exportSeed, exportRawResults }     from './lib/seed-export.js';
import { fileURLToPath }                    from 'url';
import { join, dirname }                    from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, 'data');

// ─── Pre-defined locations ────────────────────────────────────────
const LOCATION_PRESETS = {
  tlv:      { lat: 32.087, lon: 34.767, name: 'Tel Aviv Gordon Beach', locBucket: 'coast'   },
  herzliya: { lat: 32.165, lon: 34.795, name: 'Herzliya Marina',       locBucket: 'coast'   },
  haifa:    { lat: 32.820, lon: 35.015, name: 'Haifa Port',            locBucket: 'north'   },
  jer:      { lat: 31.770, lon: 35.220, name: 'Jerusalem',             locBucket: 'central' },
  beer:     { lat: 31.250, lon: 34.790, name: "Be'er Sheva",           locBucket: 'central' },
  tiberias: { lat: 32.790, lon: 35.530, name: 'Tiberias',              locBucket: 'east'    },
};

// ─── CLI parsing ──────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    days:       365,
    locations:  Object.keys(LOCATION_PRESETS),
    skipPhotos: false,
    skipVision: false,
  };
  for (const arg of args) {
    if (arg.startsWith('--days='))      opts.days      = parseInt(arg.split('=')[1], 10);
    if (arg.startsWith('--locations=')) opts.locations = arg.split('=')[1].split(',').map(s => s.trim());
    if (arg === '--skip-photos')        opts.skipPhotos = true;
    if (arg === '--skip-vision')        opts.skipVision = true;
  }
  return opts;
}

// ─── Date helpers ─────────────────────────────────────────────────
function getDateRange(days) {
  const end   = new Date();
  end.setDate(end.getDate() - 1);  // yesterday (today's archive incomplete)
  const start = new Date(end);
  start.setDate(start.getDate() - (days - 1));
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate:   end.toISOString().slice(0, 10),
  };
}

// ─── Per-location backtest ────────────────────────────────────────
async function backtestLocation(locKey, opts) {
  const loc = LOCATION_PRESETS[locKey];
  if (!loc) { console.warn(`[backtest] Unknown location key: ${locKey} — skipping`); return []; }

  const { lat, lon, name, locBucket } = loc;
  const { startDate, endDate }        = getDateRange(opts.days);

  console.log(`\n── ${name} (${lat}, ${lon})`);

  // Step 1: Fetch archive weather data
  console.log(`   Fetching archive ${startDate} → ${endDate}...`);
  let archiveData;
  try {
    archiveData = await fetchArchiveBatched(lat, lon, startDate, endDate);
  } catch (e) {
    console.error(`   Archive fetch failed: ${e.message}`);
    return [];
  }
  console.log(`   Got ${archiveData.length} days`);

  // Step 2: Discover webcams (once per location)
  let webcams = [];
  if (!opts.skipPhotos && process.env.WINDY_API_KEY) {
    console.log(`   Discovering webcams...`);
    webcams = await discoverWebcams(lat, lon, process.env.WINDY_API_KEY);
    if (webcams.length > 0) {
      console.log(`   Webcams: ${webcams.map(w => w.title).join(', ')}`);
    } else {
      console.log(`   No webcams found — will use Flickr fallback`);
    }
  }

  const results = [];

  for (const day of archiveData) {
    // Step 3: Score actual conditions
    const scoreResult = scoreActualConditions(day.actual);
    let photoRating   = null;

    // Step 4: Photo evidence (optional)
    if (!opts.skipPhotos) {
      // Try webcam frames: -10min, 0min, +15min relative to sunset
      if (webcams.length > 0) {
        const webcam = webcams[0];
        const frames = [];
        for (const offset of [-10, 0, 15]) {
          const h      = day.sunsetHour + Math.floor(offset / 60);
          const base64 = await fetchWebcamFrame(webcam.id, day.date, h);
          frames.push({ base64, minutesFromSunset: offset });
        }
        const hasFrames = frames.some(f => f.base64 != null);
        if (hasFrames && process.env.ANTHROPIC_API_KEY && !opts.skipVision) {
          photoRating = await rateWebcamFrames(frames, { locationName: name, lat, lon, date: day.date }, process.env.ANTHROPIC_API_KEY);
        }
      }

      // Fallback: Flickr geo+time search
      if (photoRating == null && process.env.FLICKR_API_KEY) {
        const photos = await flickrSearch(lat, lon, day.date, day.sunsetHour ?? 18, process.env.FLICKR_API_KEY);
        if (photos.length > 0) {
          const visionKey = !opts.skipVision ? (process.env.ANTHROPIC_API_KEY ?? null) : null;
          photoRating = await rateFlickrPhotos(photos, {
            locationName: name, lat, lon,
            date: day.date, sunsetHour: day.sunsetHour,
          }, visionKey);
        }
      }
    }

    results.push({
      date:               day.date,
      locationName:       name,
      lat,
      lon,
      locBucket,
      sunsetHour:         day.sunsetHour,
      actual:             day.actual,
      paramRatios:        day.paramRatios ?? {},
      reconstructedScore: scoreResult.score,
      model:              scoreResult.model,
      blendWeights:       scoreResult.blendWeights,
      photoRating,
    });

    // Progress indicator
    const n = results.length;
    if (n % 30 === 0 || n === archiveData.length) {
      const rated = results.filter(r => r.photoRating != null).length;
      process.stdout.write(`\r   ${n}/${archiveData.length} days (${rated} rated)   `);
    }
  }

  process.stdout.write('\n');
  console.log(`   Done: ${results.length} days`);
  exportRawResults(locKey, results, DATA_DIR);
  return results;
}

// ─── Main ─────────────────────────────────────────────────────────
async function main() {
  const opts = parseArgs();

  console.log('═══════════════════════════════════════════');
  console.log('  TWILIGHT Historical Backtest Pipeline');
  console.log('═══════════════════════════════════════════');
  console.log(`Days:      ${opts.days}`);
  console.log(`Locations: ${opts.locations.join(', ')}`);
  console.log(`Photos:    ${opts.skipPhotos ? 'skipped' : 'enabled'}`);
  console.log(`Vision:    ${opts.skipVision ? 'skipped' : (process.env.ANTHROPIC_API_KEY ? 'Claude Haiku' : 'no key — skip')}`);
  console.log(`Flickr:    ${process.env.FLICKR_API_KEY ? 'enabled' : 'no key'}`);
  console.log(`Windy:     ${process.env.WINDY_API_KEY  ? 'enabled' : 'no key'}`);
  console.log('');

  const allResults = [];

  for (const locKey of opts.locations) {
    const results = await backtestLocation(locKey, opts);
    allResults.push(...results);
  }

  // Export combined seed file
  const seedPath = exportSeed(allResults, DATA_DIR);

  const total  = allResults.length;
  const rated  = allResults.filter(r => r.photoRating != null).length;

  console.log('');
  console.log('═══════════════════════════════════════════');
  console.log(`  Done! ${total} days / ${rated} with photo rating`);
  console.log(`  Seed → ${seedPath}`);
  console.log('  Import: Settings → Advanced → ייבוא נתוני למידה');
  console.log('═══════════════════════════════════════════');
}

main().catch(err => {
  console.error('[backtest] Fatal:', err);
  process.exit(1);
});
