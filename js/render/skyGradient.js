/**
 * skyGradient.js — CSS variable renderer for physics-based sky colors.
 *
 * Receives the { skyTop, skyMid, horizon } zones from skyColor.js and
 * writes the three --dyn-bg-* CSS custom properties used by .home-content.
 */

/**
 * @param {{ skyTop:{r,g,b}, skyMid:{r,g,b}, horizon:{r,g,b} }} skyColors
 */
export function renderSkyGradient(skyColors) {
  const { skyTop, skyMid, horizon } = skyColors;
  document.documentElement.style.setProperty('--dyn-bg-top',
    `rgba(${skyTop.r},${skyTop.g},${skyTop.b},0.88)`);
  document.documentElement.style.setProperty('--dyn-bg-mid',
    `rgba(${skyMid.r},${skyMid.g},${skyMid.b},0.82)`);
  document.documentElement.style.setProperty('--dyn-bg-bottom',
    `rgba(${horizon.r},${horizon.g},${horizon.b},0.95)`);
}
