---
kind: milestone
status: implemented
tests:
  - test/unit/m46-noise-sentinel.test.ts
  - test/e2e/m46-noise-sentinel.test.ts
---

# M46 — noise sentinel

## Purpose

On a contended machine samples disperse, `unstable` flags appear, and verdicts
flip run to run — and the user cannot distinguish "my component regressed" from
"my machine was busy". The CV floor (M35/M37) keeps noise from silently skipping
comparisons; nothing told the user *the run itself* was untrustworthy. Perf CI
dies the day a team gets its second false alarm.

## Contract

- Every run computes `Report.noise: { level, signals }` (additive).
- Signals:
  - `probeCv`, `probeMedianMs` — dispersion of `NOISE_PROBE_SAMPLES` (7) runs of
    a fixed arithmetic loop, run once per run, unthrottled, outside every traced
    window;
  - `unstableFraction` — share of mount/rerender/unmount metrics the CV rule
    already flagged;
  - `contextRetries` — page reloads survived mid-measurement (M30), counted
    before warning dedup.
- Levels:
  - `noisy`: `probeCv > NOISE_CV_PERCENT` (15), or `unstableFraction >= 0.25`,
    or any context retry;
  - `hostile`: `probeCv > HOSTILE_CV_PERCENT` (30), or
    `unstableFraction >= 0.5`;
  - `quiet`: otherwise.
- Consequences:
  - `noisy`: `NOISY_RUN_WARNING` in `Report.warnings`; baseline **regressions**
    are still reported but no longer set `pass = false`. Budget verdicts are
    untouched — they are absolute, not comparative.
  - `hostile`: `HOSTILE_RUN_WARNING`; baseline comparison is not performed at
    all and `BaselineComparison.skippedNoisy` is set.
  - `quiet`: no output change.
- MUST NOT: alter any measured value, add traced-window overhead, gate
  fingerprint reuse (a cached verdict measured nothing, so noise cannot apply to
  it), or auto-retry — rerun policy belongs to CI config, not to a hidden retry
  inside a run.

## Design

- Thresholds are **derived, not invented**. `NOISE_CV_PERCENT` is the same 15%
  bar `buildTimingWithCV` already uses to stop trusting a metric: a machine that
  cannot repeat a fixed busy loop more consistently than that is, by the
  project's own existing standard, not quiet. `HOSTILE_CV_PERCENT` is twice it.
- The probe is deliberately **not** calibration. Calibration measures a DOM
  insert plus forced layout and feeds normalization, and one sample of it swings
  20–40% (M39). The probe asks a narrower question — can this machine repeat
  identical work identically right now — and takes enough samples to answer it.
- The downgrade-on-noise rule mirrors M22's unstable-metric downgrade in
  `compareBaseline`: same philosophy, run-scoped instead of metric-scoped.
- Signals are aggregated in `attachHarnessContext`, from data the pipeline
  already holds. The probe is the only new page work.

## Deferred

- **Threshold calibration against measured distributions.** The thresholds above
  are principled but not empirically fitted; doing that honestly needs paired
  quiet/loaded runs on at least two machines, interleaved in one window (never
  cross-day). Until that exists, the constants are documented as derived from
  the existing CV bar rather than presented as measured.
- rAF-fence dispersion and per-sample GC spread as additional signals. Both
  would need per-sample bookkeeping inside the measurement loop, which the
  contract's own "no traced-window overhead" rule makes delicate; the three
  signals implemented are free.
- A distinct non-zero exit code for `hostile` under `--ci` (a runner that flags
  hostile every run is misprovisioned and someone should know). Wants a
  CI-owner's perspective before it becomes a gate.
- Per-combo noise localization rather than run-level.
