---
kind: milestone
status: done
tests:
  - test/unit/metrics.test.ts
  - test/unit/metrics-harden.test.ts
  - test/e2e/metrics.test.ts
  - test/e2e/metrics-harden.test.ts
---

## Purpose
Parse raw CDP traces into a complete metric taxonomy. Fix trace duration double-counting. Add frame analysis, long task detection, INP estimation, layout shift scoring, and scaling curve analysis.

## Contract
### MUST
- `parseMetrics(events, options?) → CdpMetrics`: pure function extracting all metrics from trace events
- `CdpMetrics` fields: paintCount/Duration, layoutCount/Duration, styleRecalcCount/Duration, scriptDuration, totalDuration (top-level only), longTasks (>50ms scripting), frames (BeginFrame/DrawFrame), jankFrameCount (>16.67ms), droppedFrameCount, layoutShiftScore, domNodeCount, heapDelta
- `computeINP(traces) → number`: max input-to-next-paint latency across trace sets
- `computeScalingCurve(points) → ScalingCurve`: least-squares regression, classifies as constant (R²<0.5) / linear / quadratic / exponential (best R² wins among linear, quadratic n², exponential log(y))
- `createCalibrationTrace(page, cdp) → CdpMetrics`: 1000-element DOM insert + forced layout, cleans up after
- `linearRegression(points) → { slope, intercept, r2 }`
- Fixed `parseTraceDuration`: nesting stack excludes child event durations from `totalDuration`; fallback for events without `ts`
- `filterToMarks` option scopes metrics to `__120fps_start`/`__120fps_end` performance.mark window
- `TraceEvent` extended with optional `ts`, `args`

### MUST NOT
- Produce formatted reports (M6)
- Change exploration or discovery logic
- Break existing return types (additive only)

### Invariants
- Empty events → all-zero metrics
- Fixed `totalDuration` ≤ old `totalDuration`
- Perfect linear data → R² ≈ 1.0, growthClass = "linear"
- No input events → INP = 0

## Design

### Metric extraction
Single-pass over timestamp-sorted events. Nesting stack tracks enclosing X-phase events; only top-level events contribute to `totalDuration`. Event categorization by `name`: Paint, Layout, UpdateLayoutTree/RecalcStyles, scripting events, BeginFrame/DrawFrame, LayoutShift.

### INP estimation
Scan sorted events for EventDispatch with input-type args (click, keydown, etc.), then find next Paint. Max gap across all trace sets.

### Scaling curve
Fit (n, metric) for linear, (n², metric) for quadratic, (n, log(metric)) for exponential. R² < 0.5 → constant. Best R² among the three wins. Exponential requires all metrics > 0.

### Calibration
Insert div with 1000 styled spans, force layout via `offsetHeight`, capture trace, parse metrics, remove div.

## Open
- LayoutShift events may be absent in some Chromium versions; returns 0
- Heap deltas can be negative (GC reclaiming)
- DrawFrame events absent when no rendering occurs; frames array empty

## Resolved
- GC between samples: `tryCollectGarbage(cdp)` wired into `measureMount()` and `exploreCombo()` sample loops.
- Heap delta: `Runtime.getHeapUsage` before/after sample loop per combo in `measureMount()`, stored as `MountResult.heapDelta`.
