// ═══════════════════════════════════════════
//  TWILIGHT — config.js v3
// ═══════════════════════════════════════════

export const OPEN_METEO_URL         = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_AQ_URL      = 'https://air-quality-api.open-meteo.com/v1/air-quality';
export const OPEN_METEO_HIST_URL    = 'https://archive-api.open-meteo.com/v1/archive';
export const NOMINATIM_URL          = 'https://nominatim.openstreetmap.org/reverse';
export const OVERPASS_URL           = 'https://overpass-api.de/api/interpreter';
export const OVERPASS_FALLBACK_URL  = 'https://overpass.kumi.systems/api/interpreter';

export const CACHE_TTL = {
  weather: 60,
  airq:    120,
  sun:     360,
  spots:   30
};

export const LOGO_SUNRISE  = 'images/sunrise.png';
export const LOGO_SUNSET   = 'images/sunset.png';
export const LOGO_TWILIGHT = 'images/twilight.png';

export const DAYS_HE = ['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'];

export const WEATHER_CODES = {
  0:'שמיים בהירים',1:'בהיר בעיקר',2:'ענני חלקית',3:'מעונן',
  45:'ערפל',48:'ערפל קפוא',
  51:'טפטוף קל',53:'טפטוף מתון',55:'טפטוף כבד',
  61:'גשם קל',63:'גשם מתון',65:'גשם כבד',
  71:'שלג קל',73:'שלג מתון',75:'שלג כבד',
  80:'מקלחות קלות',81:'מקלחות מתונות',82:'מקלחות כבדות',
  95:'סופת רעמים',96:'סופת רעמים עם ברד',99:'סופת רעמים עם ברד כבד'
};

export const WIND_DIRS = ['צפון','צפון-מזרח','מזרח','דרום-מזרח','דרום','דרום-מערב','מערב','צפון-מערב'];

// Fog/storm weather codes that kill sunsets
export const OVERRIDE_CODES = new Set([45, 48, 65, 75, 82, 95, 96, 99]);

export const SEASONAL_BASELINE = {
  1:  { clouds: 45, humidity: 65, visibility: 15, wind: 18, dust: 20 },
  2:  { clouds: 40, humidity: 60, visibility: 16, wind: 17, dust: 22 },
  3:  { clouds: 32, humidity: 50, visibility: 18, wind: 16, dust: 35 },
  4:  { clouds: 20, humidity: 40, visibility: 20, wind: 14, dust: 45 },
  5:  { clouds: 10, humidity: 35, visibility: 22, wind: 12, dust: 50 },
  6:  { clouds: 5,  humidity: 45, visibility: 20, wind: 10, dust: 35 },
  7:  { clouds: 3,  humidity: 50, visibility: 18, wind: 10, dust: 30 },
  8:  { clouds: 3,  humidity: 55, visibility: 17, wind: 9,  dust: 28 },
  9:  { clouds: 5,  humidity: 50, visibility: 19, wind: 10, dust: 32 },
  10: { clouds: 15, humidity: 45, visibility: 20, wind: 12, dust: 25 },
  11: { clouds: 30, humidity: 55, visibility: 18, wind: 15, dust: 18 },
  12: { clouds: 42, humidity: 62, visibility: 16, wind: 17, dust: 16 },
};

export const COAST_LON = 34.65; // backward-compat alias

/**
 * Climate profile for the current deployment region.
 *
 * Centralises all geography- and climate-specific constants so that a future
 * global version can swap this object (or auto-detect it from the user's
 * latitude) without touching scoring or physics code.
 *
 * Fields:
 *   coastLon       — longitude of the western coastline; used for the
 *                    western-horizon cloud penalty and sea-breeze bonuses.
 *   ozoneDU        — stratospheric ozone column in Dobson Units (annual
 *                    mean for Israel ~300 DU from TOMS/OMI climatology).
 *                    Passed to atmosphere.js:chappuisAbsorption().
 *   dustPeak       — µg/m³ at which dust maximises drama (bell curve centre).
 *   humidityPeak   — % RH at which humidity maximises drama (bell centre).
 *   seaSaltWindPeak — km/h wind speed at which coastal sea-salt haze peaks.
 *   timezone       — IANA timezone string for local-time formatting.
 */
export const LOCATION_CLIMATE = {
  coastLon:        34.65,
  ozoneDU:         300,
  dustPeak:        25,
  humidityPeak:    60,
  seaSaltWindPeak: 25,
  timezone:        'Asia/Jerusalem',
};

/**
 * Climate profiles for different deployment regions.
 *
 * Each profile defines the bell-curve peaks and geographic constants that
 * tune the scoring and physics engine for a specific climate type.
 *
 * Profile fields (all override the corresponding LOCATION_CLIMATE fields):
 *   dustPeak        — µg/m³ at which dust produces best sunset drama
 *   humidityPeak    — % RH that maximises Rayleigh scatter drama
 *   seaSaltWindPeak — km/h wind speed for sea-salt haze peak
 *   coastLon        — longitude of the western coastline (null = landlocked)
 *   ozoneDU         — static fallback ozone if seasonal lookup unavailable
 *   timezone        — IANA timezone (not used directly, for reference)
 *
 * Usage: import { detectClimateProfile } from './config.js'
 *        const profile = detectClimateProfile(lat, lon);
 *        // merge into LOCATION_CLIMATE at startup for global support
 */
export const CLIMATE_PROFILES = {
  mediterranean: {
    label:           'Mediterranean',
    dustPeak:        25,
    humidityPeak:    60,
    seaSaltWindPeak: 25,
    coastLon:        34.65,
    ozoneDU:         300,
    timezone:        'Asia/Jerusalem',
  },
  desert: {
    label:           'Desert / Arid',
    dustPeak:        60,   // higher dust optimum — Saharan/Arabian dust events
    humidityPeak:    20,   // low humidity = crisp atmosphere
    seaSaltWindPeak: 25,
    coastLon:        null, // typically landlocked
    ozoneDU:         275,  // lower ozone near equator
    timezone:        'UTC',
  },
  temperate: {
    label:           'Temperate / Continental',
    dustPeak:        10,   // low dust — clean European / mid-lat air
    humidityPeak:    70,   // higher humidity typical
    seaSaltWindPeak: 30,
    coastLon:        null,
    ozoneDU:         320,
    timezone:        'UTC',
  },
  tropical: {
    label:           'Tropical / Subtropical',
    dustPeak:        20,
    humidityPeak:    75,   // very humid
    seaSaltWindPeak: 20,
    coastLon:        null,
    ozoneDU:         260,
    timezone:        'UTC',
  },
};

/**
 * Auto-detect a climate profile from a user's latitude.
 *
 * This is a simple latitude-band heuristic — a future version could also use
 * longitude (to distinguish Mediterranean from desert at the same latitude)
 * or rely on an explicit user override stored in settings.
 *
 * @param {number} lat  Geographic latitude in degrees (−90 to +90)
 * @returns {string}  Profile key from CLIMATE_PROFILES
 */
export function detectClimateProfile(lat) {
  const absLat = Math.abs(lat);
  if (absLat <= 23.5)  return 'tropical';      // tropics
  if (absLat <= 35)    return 'mediterranean';  // Mediterranean / subtropical
  if (absLat <= 55)    return 'temperate';      // temperate zone
  return 'temperate';                           // polar/sub-polar → temperate fallback
}

export const ELEV_BONUS_THRESHOLD = 400;
export const CALIBRATION_MIN_DAYS = 14;
export const CALIBRATION_KEY = 'twl_calibration';
export const LEARNING_KEY    = 'twl_learning';

// ✓ config.js v4
