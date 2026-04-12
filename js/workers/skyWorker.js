/**
 * skyWorker.js — Physics sky gradient computation stub (v46 Worker-Ready)
 *
 * STATUS: Stub only — NOT wired up yet. This file prepares the architecture
 * for moving sky rendering off the main thread in a future version (v47+).
 *
 * When activated, replace the renderSkyCanvas() call in startLiveGradient()
 * with a postMessage to this worker, receive the ImageBitmap, and blit it
 * onto the DOM canvas via drawImage().
 *
 * Why this is safe to do:
 *   • computeAtmosphere() and spectrumToRGB() are pure functions — no DOM deps.
 *   • The only DOM-touching code is canvas drawing, which OffscreenCanvas handles.
 *   • skyMask must be pre-fetched and transfered as ImageBitmap before first tick.
 *
 * Activation checklist (v47):
 *   1. In main-screen.js: const skyW = new Worker('./js/workers/skyWorker.js');
 *   2. Transfer the sky mask ImageBitmap to the worker on init.
 *   3. Each gradient tick: skyW.postMessage({ sunAngle_rad, turbidity, ozoneDU, w, h }, []);
 *   4. skyW.onmessage = ({ data: { bitmap } }) => ctx.drawImage(bitmap, 0, 0);
 *
 * @module workers/skyWorker
 */

// Uncomment and wire up when ready to activate:
//
// import { computeAtmosphere } from '../engine/atmosphere.js';
// import { spectrumToRGB, applyPerceptualTuning } from '../engine/color.js';
//
// let _skyMask = null; // ImageBitmap received from main thread
//
// self.onmessage = ({ data }) => {
//   if (data.type === 'init-mask') {
//     _skyMask = data.mask; // ImageBitmap
//     return;
//   }
//   if (data.type === 'render') {
//     const { sunAngle_rad, turbidity, ozoneDU, width, height } = data;
//     const canvas = new OffscreenCanvas(width, height);
//     const ctx    = canvas.getContext('2d');
//     // ... compute gradient using computeAtmosphere + spectrumToRGB ...
//     // ... apply sky mask via destination-in if _skyMask is ready ...
//     const bitmap = canvas.transferToImageBitmap();
//     self.postMessage({ bitmap }, [bitmap]);
//   }
// };

// Placeholder — worker must have at least one statement to be valid
self.onmessage = () => {};
