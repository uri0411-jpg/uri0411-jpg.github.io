# TWILIGHT — Perf Baseline (B.0)

Baseline measurement before deciding whether Track B (`calcWeekDataAsync`)
is worth implementing. Captured by temporary instrumentation in
`js/perf-overlay.js` (commit `6c12e1a`, reverted in the next commit).

## Capture environment

- **Date:** 2026-04-26
- **Device:** Android, mid-range
- **Browser:** Chrome 147.0.0.0
- **CPU cores:** 8
- **deviceMemory:** unreported (Android Chrome privacy-protected)
- **DPR:** 2.75
- **Viewport:** 392×735
- **Service worker:** `sw:off` in both runs (cache-clear + first install
  flow means the SW had not yet claimed the page — see "Caveats" below)
- **Method:** Visit `http://10.11.59.8:3000` from real device on local
  Wi-Fi. Cold = "Clear browsing data → All time" then load. Warm =
  close tab, reopen.

## Measurements

| Metric                          | Cold (1st load) | Warm (cached) |
|---------------------------------|-----------------|---------------|
| `fetchWeekFast` resolve         | 638.8 ms        | 25.3 ms       |
| `calcWeekData` phase1           | 8.7 ms          | 19.7 ms       |
| `calcWeekData` phase2 (enrich)  | 8.0 ms          | 9.5 ms        |
| `calcWeekData` ensemble         | 9.8 ms          | (no run)¹     |
| **calcWeekData total**          | **26.5 ms**     | **29.2 ms**   |
| `fetch → gauge paint`           | 466.9 ms        | 823.9 ms      |
| `boot total` (T0 → gauge paint) | 1105.7 ms       | 849.2 ms      |

¹ Ensemble path only runs when `wasFreshFetch` ([app.js:439](../js/app.js))
— a cache hit on warm boot does not trigger it.

## Findings

### 1. `calcWeekData` is **not** the bottleneck

The master plan ([synthetic-sprouting-planet.md](../../.claude/plans/synthetic-sprouting-planet.md))
hypothesized `calcWeekData` runs ~350 ms synchronously. **Actual: ~10–20 ms
per call.** Total per boot is ~26–29 ms across 2–3 calls — under 3 % of
boot time on this device.

Conclusion: the original Track B premise (yield days 1–6 to
`requestIdleCallback`) would save **~7 ms** out of an 824 ms warm-paint
window. Less than 1 % improvement. The engineering risk (boot path
restructure + cancellation plumbing) is not justified by the gain.

### 2. The real bottleneck is post-fetch initialization

In **warm boot**, where `fetchWeekFast` is essentially free (25 ms cache
hit), the gap from fetch resolve to gauge paint is **824 ms**. That is
the time spent inside the boot path between `await fetchWeekFast` and the
gauge being drawn.

Of those ~824 ms, only ~30 ms is `calcWeekData`. The remaining ~790 ms
is in `initMainScreen`'s render barrier:
- `await Promise.all([ensureBackgroundReady(), _maskReady])` — likely
  the dominant wait (background.jpg decode + sky mask preload)
- `buildMainHTML(...)` (synchronous; size unknown without further
  instrumentation)
- 2× `requestAnimationFrame` for gauge animation kickoff (~32 ms)

In **cold boot**, network dominates (638 ms) and the post-fetch wait is
shorter (467 ms). Hypothesis: the 638 ms network round-trip overlaps
with `_maskReady` and image decode, so by the time the fetch resolves,
those are already done — making them invisible on the critical path.

### 3. Caveats

- `sw:off` in both runs because clearing site data also unregisters the
  service worker. With SW active (typical returning user), warm boot
  would be **further** improved by SW-cache-served assets — likely
  bringing total boot under 500 ms.
- Single-device, single-run measurement. No CPU throttle. Results are
  directional, not statistical.
- DPR 2.75 + deviceMemory unreported suggests a mid-range Android — a
  reasonable representative device.

## Decision

**Track B (`calcWeekDataAsync`) is deferred indefinitely.** The premise
is invalidated by measurement: `calcWeekData` is fast on real hardware.

If post-fetch perceived latency becomes a user complaint, the next
investigation should target `initMainScreen`'s render barrier, not
`calcWeekData`. A "B-prime" task could measure individually:
- `ensureBackgroundReady` resolve time (image decode)
- `_maskReady` resolve time (loadSkyMask)
- `buildMainHTML` synchronous cost
- The 2× rAF gap

…and then optimize whichever is dominant. But that is a separate
proposal, not what was scoped in the original master plan.

## What still applies from the master plan

- The `isStale(gen)` cancellation pattern is mature and used elsewhere —
  no need to extend.
- The original goal "day 0 paint < 100 ms from fetchWeekFast resolve" is
  unreachable while the post-fetch barrier is ~800 ms. Reframing the
  target as "boot total < 500 ms with SW active" would be more honest.
