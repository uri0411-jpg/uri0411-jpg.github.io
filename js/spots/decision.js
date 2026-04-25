// ═══════════════════════════════════════════
//  TWILIGHT — spots/decision.js
//  Per-spot decision badge + best-day label.
//
//  Extracted from spots-screen.js. Both functions take weekData/loc as
//  explicit parameters (previously read via closure from spots-screen.js
//  module state), so this module stays stateless.
// ═══════════════════════════════════════════

import { decide } from '../engine/decisionEngine.js';

// ─── Best day label ──────────────────────
export function bestDayLabel(allScores, weekData) {
  if (!allScores || allScores.length < 2) return null;
  const dayNames = ['היום','מחר'];
  const days = ['א׳','ב׳','ג׳','ד׳','ה׳','ו׳','ש׳'];
  let bestIdx = 0, bestVal = allScores[0].combined;
  for (let i = 1; i < allScores.length; i++) {
    if (allScores[i].combined > bestVal) { bestVal = allScores[i].combined; bestIdx = i; }
  }
  if (bestIdx === 0) return null; // today is already best — no need for badge
  let label;
  if (bestIdx < 2) label = dayNames[bestIdx];
  else {
    const d = weekData?.[bestIdx]?.date;
    label = d ? 'יום ' + days[new Date(d + 'T12:00:00').getDay()] : '';
  }
  return { label, score: bestVal };
}

// ─── Per-spot decision badge (Pulse 3→Spot Finder) ──
// Bridges legacy dayData → decisionEngine format, adds travel time per spot.
export function buildSpotDecision(spot, today, loc) {
  if (!today) return '';
  const driveMin = spot._driveMin || 0;

  // Build weatherData in engine format
  const weatherData = {
    clouds:              (today._cloudRaw ?? 50) / 100,
    cloudHeightCategory: today._cloudHighRaw > 40 ? 'high' : today._cloudLowRaw > 40 ? 'low' : 'mid',
    horizonClearance:    Math.max(0, (100 - (today._cloudLowRaw ?? 50)) / 100),
    dust:                today._dustRaw ?? 0,
    humidity:            today._humidityRaw ?? 50,
    visibility:          today._visibilityRaw ?? 10,
    aqi:                 null,
    solarElevation:      3,
    sunsetTime:          today.sunset ? (() => {
      const [h, m] = today.sunset.split(':').map(Number);
      const d = new Date(today.date + 'T12:00:00');
      d.setHours(h, m, 0, 0);
      return d;
    })() : new Date(),
  };

  let result;
  try {
    result = decide({
      weatherData,
      travelTimeMinutes: driveMin,
      bufferMinutes: 10,
      latitude: loc?.lat ?? 32,
    });
  } catch {
    return '';
  }

  const d = result.decision; // 'YES' | 'MAYBE' | 'NO'
  const tier = d === 'YES' ? 'go' : d === 'MAYBE' ? 'maybe' : 'no';

  let text;
  if (d === 'YES') {
    text = 'שווה לנסוע';
  } else if (d === 'MAYBE') {
    text = driveMin > 20 ? 'רק אם קרוב' : 'אפשרי';
  } else {
    text = driveMin > 0 ? 'לא שווה' : 'שקיעה חלשה';
  }

  return `<span class="spot-badge spot-decision-${tier}">${text}</span>`;
}
