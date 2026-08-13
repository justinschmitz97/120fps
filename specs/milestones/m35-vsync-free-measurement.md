---
kind: milestone
status: done
tests:
  - test/unit/m35-frame-pump.test.ts
  - test/e2e/m35-driven-frames.test.ts
  - test/e2e/m35-harden.test.ts
---

# M35 — vsync-free lifecycle measurement

## Purpose

After M34, the dominant cost of every lifecycle sample is waiting for the
compositor, not measuring. Each traced window ends on a double-rAF fence, and
headless Chromium paces rAF at 60 Hz no matter what: a double-rAF costs
~33 ms wall (measured: median 33.3 ms), so one mount+unmount sample pays
~66 ms of vsync idle against ~5–10 ms of measured busy work, and every
untraced setup mount in `measureRerender` pays another ~33 ms. On badge.tsx
(matrix path, 64 cells × 10 samples) that is ~42 s of the 50 s mounts phase
and ~40 s of the 108 s rerenders phase — pure waiting.

The pacing flags (`--disable-frame-rate-limit`, `--disable-gpu-vsync`,
`--force-refresh-rate`) and virtual time do not change rAF pacing in headless
Chromium (measured: all ≥33 ms/double-rAF). Begin-frame control does: with
`--enable-begin-frame-control --run-all-compositor-stages-before-draw`, frames
are produced on demand via `HeadlessExperimental.beginFrame`, a double-rAF
costs ~1.9 ms, and Paint/Layout/PrePaint/Layerize events still appear in
traces (verified by spike). Frames still happen — they are driven instead of
scheduled, so every sample stays paint-inclusive at full sample count.

Coverage is invariant: same combos, same N, same warmups, same patterns.

## Contract

- Lifecycle measurement sessions (`measureMount`, `measureRerender`,
  `runHarnessSession` (isolation phases), and `analyze`'s
  calibration/wrapper-overhead session) MUST launch Chromium with
  `MEASUREMENT_BROWSER_ARGS` (`--enable-begin-frame-control
  --run-all-compositor-stages-before-draw`) and run a continuous begin-frame
  pump for the life of the session. This pacing is called `driven`.
- `explore` and `runReactAnalysis` sessions MUST keep default vsync pacing:
  their metrics (INP estimate, frame timing, jank) depend on real frame
  scheduling.
- MUST NOT change: sample counts, warmup counts, combo selection, stress
  patterns, trace categories, the double-rAF fence contents,
  `parseTraceDuration`, or the placement of per-sample GC (M6) and throttle
  windows (M2/M34). The fences keep their two rAF ticks; they additionally
  carry a 10 s watchdog (below).
- A combo whose first sample detects `hasAnimation` MUST be re-measured
  entirely under vsync pacing in a lazily-launched plain browser (fresh
  warmup, full N); its driven samples are discarded. Animation cost is
  time-based, so driving frames faster changes how much animation work lands
  inside the traced window — driven pacing is not a valid measurement of an
  animated mount.
- `measureRerender` accepts `animatedComboIndices`; those combos run under
  vsync pacing. `analyze` wires it from the mount results of the same combo
  list at every mount/rerender pairing (standard, curve, matrix, deltas,
  auto-scaling). `runIsolationPhases` derives it from its own mount pass and
  runs churn/memory/strictmode phase sessions with `pacing: "vsync"` when the
  measured combo animates; when the mount phase did not run, animation status
  is unknown and phases default to driven.
- `MountResult.pacing` and `RerenderResult.pacing` (`"driven" | "vsync"`,
  additive) record which pacing produced each combo's numbers.
- Begin-frame support is probed with a single `beginFrame` at session entry,
  before anything navigates: probe failure closes the driven browser and
  reopens a plain vsync one, so the whole pass measures under vsync pacing
  with `FRAME_PUMP_WARNING` in `Report.warnings`. A begin-frame-controlled
  browser produces no frames without the pump, so a pump that dies mid-run
  starves the fences; every rAF fence (and the style-settle fence) carries a
  10 s watchdog that converts that hang into a failed run — a machine that
  loses its compositor mid-pass is a broken environment (M30 philosophy),
  not a fallback case. Transient `beginFrame` errors (navigation, context
  churn) back off ~5 ms and only a long consecutive run of failures (120)
  disables the pump.
- The pump MUST survive `refreshCdpSession` (it reads the current session
  from the `CdpHolder` on every frame) and MUST stop before browser close.
- Calibration runs under driven pacing — the same pacing as the measurements
  it normalizes.
- Equivalence gate: interleaved driven-vs-vsync A/B on non-animated fixtures,
  n ≥ 30 per arm. If any of mount/unmount/rerender median ratios falls
  outside [0.95, 1.05], `METRICS_REVISION` bumps to 4 so pre-M35 baselines
  classify `incompatible` (M31/M34 precedent). CVs must not degrade by more
  than 5 points either way. Measured (large-dom @ 200, n=30, simultaneous
  interleaved sessions): mount ×1.030, rerender ×1.001 — inside the gate,
  CVs unchanged; unmount ×0.739 — outside it, because the ~33 ms vsync window
  absorbed ~0.65 ms of ambient frame work that the ~4 ms driven window does
  not. `METRICS_REVISION` is therefore 4.
- Report JSON schema additive-only.
- The `unstable` flag (`buildTimingWithCV`) requires BOTH `cv > 15` and
  absolute noise (stddev) above `UNSTABLE_NOISE_FLOOR_MS` (0.5 ms, M29's
  normalization floor). Driven pacing shrinks medians to their busy cost, so
  relative CV on a sub-millisecond metric explodes while absolute noise stays
  trivial — and an unstable flag silently skips that metric's baseline
  comparison (M22), which would have exempted every fast component from
  regression detection.

## Design

- `MEASUREMENT_BROWSER_ARGS` exported from `measure.ts`.
- `createFramePump(holder: CdpHolder)` in `measure.ts` returns
  `{ stop(): Promise<void>, disabled: boolean }`. The loop awaits
  `HeadlessExperimental.beginFrame` back-to-back — each call produces one
  frame through all compositor stages, so protocol round-trip time (~1–2 ms)
  is the new frame interval, and CPU throttle provides natural backpressure
  (a throttled main thread produces frames more slowly; nothing overlaps).
  Consecutive-error threshold disables the pump permanently; single errors
  back off ~5 ms. Fixed-session call sites (`runHarnessSession`, `analyze`)
  wrap their `CDPSession` in a single-entry holder.
- `measureMount`: per-combo loop unchanged; after the first sample, a combo
  with `hasAnimation` (or a pump-disable mid-combo) goes to `vsyncQueue` and
  its remaining driven samples are skipped. After the main loop, a plain
  vsync browser session re-runs the queued combos through the same per-combo
  code path (fresh warmup, full N) and replaces their results with
  `pacing: "vsync"`.
- `measureRerender`: same session args + pump; combos listed in
  `animatedComboIndices` run in the vsync session from the start (their
  animation status is already known when rerender runs).
- Isolation phases run inside `runHarnessSession`, which gains the args +
  pump; `runIsolationPhases` passes animated combos from its mount pass to
  its rerender/churn/strictmode phases as vsync combos.
- The double-rAF fences, `settleStyles`, `enterHarness`, and all trace
  handling are untouched — under the pump they simply resolve at frame
  production speed instead of 60 Hz.

## Open questions

- Whether `--run-all-compositor-stages-before-draw` (synchronous raster per
  frame) shifts Paint durations enough to trip the equivalence gate — decided
  by the A/B, expressed as the METRICS_REVISION outcome.
- Whether wrapper-overhead measurement of an *animated wrapper* needs the
  vsync fallback. Out of scope: wrapper overhead is informational (M26), and
  animated providers are not a pattern the dogfooding corpus contains.
