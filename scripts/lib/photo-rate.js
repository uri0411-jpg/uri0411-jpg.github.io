// ═══════════════════════════════════════════
//  photo-rate.js
//  Rates sunset sky quality from webcam frames or Flickr photos
//  using Claude Haiku vision.
//  Falls back to photo-count proxy if no API key.
// ═══════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk';

let _client = null;

function getClient(apiKey) {
  if (!_client) _client = new Anthropic({ apiKey });
  return _client;
}

/**
 * Rate a single image (base64 or URL) using Claude Haiku vision.
 * @param {string}  imageData    base64 string or URL
 * @param {boolean} isBase64
 * @param {object}  context      { locationName, lat, lon, date, minutesFromSunset }
 * @param {string}  apiKey
 * @returns {number|null}  1-10 rating or null on failure
 */
async function rateSingleImage(imageData, isBase64, context, apiKey) {
  const client = getClient(apiKey);

  const source = isBase64
    ? { type: 'base64', media_type: 'image/jpeg', data: imageData }
    : { type: 'url',    url: imageData };

  const absMin   = Math.round(Math.abs(context.minutesFromSunset ?? 0));
  const direction = (context.minutesFromSunset ?? 0) < 0 ? 'after' : 'before';

  try {
    const response = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 16,
      messages: [{
        role:    'user',
        content: [
          { type: 'image', source },
          { type: 'text', text:
            `Fixed westward-facing camera at ${context.locationName}, Israel ` +
            `(${Number(context.lat).toFixed(3)},${Number(context.lon).toFixed(3)}). ` +
            `Captured ${absMin} min ${direction} sunset on ${context.date}. ` +
            `Rate SKY QUALITY ONLY (ignore foreground, buildings, water): ` +
            `1=uniform grey/white, 3=faint colour, 5=mild orange, 7=vivid warm colours, 10=spectacular fire/purple. ` +
            `Reply with ONLY a single integer 1-10.`
          }
        ]
      }]
    });

    const text   = response.content?.[0]?.text?.trim() ?? '';
    const rating = parseInt(text, 10);
    return (isNaN(rating) || rating < 1 || rating > 10) ? null : rating;
  } catch (e) {
    console.warn('[photo-rate] Claude call failed:', e.message);
    return null;
  }
}

/**
 * Rate sunset quality from webcam frames (-10min, 0min, +15min).
 * Averages ratings from all frames that have data.
 * @param {Array<{base64: string|null, minutesFromSunset: number}>} frames
 * @param {object} context  { locationName, lat, lon, date }
 * @param {string} apiKey
 * @returns {number|null}
 */
export async function rateWebcamFrames(frames, context, apiKey) {
  if (!apiKey) return null;

  const ratings = [];
  for (const frame of frames) {
    if (!frame.base64) continue;
    const rating = await rateSingleImage(frame.base64, true, {
      ...context,
      minutesFromSunset: frame.minutesFromSunset,
    }, apiKey);
    if (rating != null) ratings.push(rating);
  }

  if (ratings.length === 0) return null;
  return Math.round(ratings.reduce((s, v) => s + v, 0) / ratings.length * 10) / 10;
}

/**
 * Rate sunset quality from Flickr photos (up to 3).
 * Falls back to photo-count proxy when no API key.
 * @param {Array<{url, dateTaken}>} photos
 * @param {object} context  { locationName, lat, lon, date, sunsetHour }
 * @param {string|null} apiKey
 * @returns {number|null}
 */
export async function rateFlickrPhotos(photos, context, apiKey) {
  if (!photos || photos.length === 0) return null;

  // No API key: rough proxy based on how many photos were taken (interest signal)
  if (!apiKey) {
    if (photos.length >= 7) return 7;
    if (photos.length >= 4) return 5;
    return 3;
  }

  const selected = photos.slice(0, 3);
  const ratings  = [];

  for (const photo of selected) {
    // Estimate minutes from sunset for this photo
    let minutesFromSunset = 0;
    if (photo.dateTaken && context.sunsetHour != null) {
      const takenTime  = new Date(photo.dateTaken.replace(' ', 'T') + '+03:00').getTime();
      const sunsetTime = new Date(
        `${context.date}T${String(context.sunsetHour).padStart(2, '0')}:00:00+03:00`
      ).getTime();
      minutesFromSunset = Math.round((takenTime - sunsetTime) / 60000);
    }

    const rating = await rateSingleImage(photo.url, false, {
      ...context,
      minutesFromSunset,
    }, apiKey);

    if (rating != null) ratings.push(rating);
  }

  if (ratings.length === 0) return null;
  return Math.round(ratings.reduce((s, v) => s + v, 0) / ratings.length * 10) / 10;
}
