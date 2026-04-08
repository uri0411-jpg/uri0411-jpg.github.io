/**
 * skyGradient.js — CSS variable renderer for physics-based sky colours.
 *
 * Receives the { skyTop, skyMid, horizon } zones from skyColor.js and writes
 * five --dyn-bg-* CSS custom properties used by .home-content in app.css:
 *
 *   --dyn-bg-top    0%   zenith zone    (Rayleigh dominant, blue/violet)
 *   --dyn-bg-mid   25%   mid sky        (warm transition, pink/amber)
 *   --dyn-bg-belt  55%   Belt of Venus  (anti-twilight arch, pink-purple)
 *   --dyn-bg-earth 80%   earth shadow   (dark band just above horizon)
 *   --dyn-bg-bottom 100% ground level   (deep dark)
 *
 * Alpha values scale with physical sky brightness so that a vivid clear-sky
 * sunset dominates the background photo while a dim overcast day stays subtle.
 *
 * @param {{ skyTop:{r,g,b}, skyMid:{r,g,b}, horizon:{r,g,b} }} skyColors
 * @param {number} [beltOfVenus=0]  0–1 visibility probability from goldenWindow.js
 */
export function renderSkyGradient(skyColors, beltOfVenus = 0) {
  const { skyTop, skyMid, horizon } = skyColors;

  // Alpha scales with perceived brightness: brighter sky → stronger overlay.
  // Wider range (0.30-0.92) vs old (0.65-0.95) so dim twilight skies stay subtle.
  const topBright = (skyTop.r + skyTop.g + skyTop.b) / 765;
  const topAlpha  = (0.30 + topBright * 0.62).toFixed(2);
  const midAlpha  = (0.25 + topBright * 0.58).toFixed(2);

  // Belt of Venus: physics-derived pink-mauve — 55% warm horizon + 45% Rayleigh skyTop.
  // This replaces the hardcoded (180,60,160) magenta preset with condition-responsive color.
  // Guard against NaN — ?? doesn't filter NaN, so check explicitly
  const bov  = Number.isFinite(beltOfVenus) ? Math.max(0, Math.min(1, beltOfVenus)) : 0;
  const beltA = (bov * 0.55).toFixed(2);
  const bovTarget_r = Math.round(horizon.r * 0.55 + skyTop.r * 0.45);
  const bovTarget_g = Math.round(horizon.g * 0.45 + skyTop.g * 0.30);
  const bovTarget_b = Math.round(horizon.b * 0.40 + skyTop.b * 0.65);
  const beltR = Math.round(_lerp(horizon.r, bovTarget_r, bov));
  const beltG = Math.round(_lerp(horizon.g, bovTarget_g, bov));
  const beltB = Math.round(_lerp(horizon.b, bovTarget_b, bov));

  // Earth shadow: depth scales with horizon luminance — bright horizon casts visible shadow band.
  const horizLum   = (horizon.r * 0.299 + horizon.g * 0.587 + horizon.b * 0.114) / 255;
  const earthDepth = 0.15 + horizLum * 0.12; // 0.15-0.27: dim sky → shallow shadow, vivid sky → deep
  const earthR = Math.round(horizon.r * earthDepth);
  const earthG = Math.round(horizon.g * earthDepth * 0.70);  // green suppressed (desaturates warm)
  const earthB = Math.round(horizon.b * earthDepth * 1.45);  // blue preserved (cooler shadow band)

  const root = document.documentElement.style;
  root.setProperty('--dyn-bg-top',
    `rgba(${skyTop.r},${skyTop.g},${skyTop.b},${topAlpha})`);
  root.setProperty('--dyn-bg-mid',
    `rgba(${skyMid.r},${skyMid.g},${skyMid.b},${midAlpha})`);
  root.setProperty('--dyn-bg-belt',
    `rgba(${beltR},${beltG},${beltB},${beltA})`);
  root.setProperty('--dyn-bg-earth',
    `rgba(${earthR},${earthG},${earthB},0.65)`);
  root.setProperty('--dyn-bg-bottom',
    `rgba(${horizon.r},${horizon.g},${horizon.b},0.97)`);
}

function _lerp(a, b, t) {
  return a + (b - a) * t;
}
