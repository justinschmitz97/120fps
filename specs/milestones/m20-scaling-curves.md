---
kind: milestone
status: done
tests:
  - test/unit/curve-cli.test.ts
  - test/unit/curve-report.test.ts
  - test/unit/curve-build.test.ts
  - test/unit/curve-harden.test.ts
---

## Purpose

M12 auto-detects a single scaling prop and measures mount/rerender at 4 fixed points. Real bench suites measure multiple dimensions simultaneously — e.g. a carousel bench varies slide count AND measures mount, rerender, unmount, interaction cost, and memory at each point. M20 upgrades scaling into a first-class **curve mode** that sweeps a scaling prop across N points and captures all measurement dimensions at each point, producing a rich multi-axis scaling report. This replaces the need for hand-authored parametric bench suites.

## Builds on

M12 (auto-scaling prop detection: `detectScalingProps`, `generateScalingCombos`). M8 (rerender measurement). M5 (`computeScalingCurve`, growth classification). M4 (exploration loop for interaction discovery). M16 (cost attribution).

## Contract

### MUST

- Add `--curve` CLI flag. When passed, 120fps enters **curve mode**: measures all dimensions at each scale point instead of running the normal combo pipeline.
- Auto-activate curve mode when `detectScalingProps` finds a match AND `--curve` is not explicitly disabled via `--no-curve`. Users can force it on for components without auto-detected scaling props via `--curve <propName>:<type>` where type is `array` or `number`.
- **Scale points**: default `[1, 3, 5, 10, 20, 50]` in curve mode (6 points for better regression fitting). Override via `--scale 1,5,10,25,50,100`.
- At each scale point, measure:
  - Mount timing (existing)
  - Rerender timing — stable and prop-change (existing)
  - Unmount timing (existing)
  - DOM node count (existing)
  - Interaction discovery + timing (existing explore loop)
  - Heap delta (existing)
  - Cost attribution (existing, unless `--no-attribution`)
- Add `ScalingCurveReport` type:
  ```ts
  interface ScalingCurveReport {
    propName: string;
    propKind: "array" | "number";
    reason: string;
    points: ScalingPoint[];
    mountCurve: ScalingCurve;
    rerenderCurve: ScalingCurve;
    unmountCurve: ScalingCurve;
    interactionCurves: Record<string, ScalingCurve>; // keyed by interaction label
    domGrowth: ScalingCurve;
    heapGrowth: ScalingCurve;
  }

  interface ScalingPoint {
    n: number;
    mount: TimingWithCV;
    rerender: TimingWithCV;
    unmount: TimingWithCV;
    domNodeCount: number;
    heapDelta: number;
    interactions: InteractionReport[];
    costAttribution?: CostAttribution;
  }
  ```
- Add `scalingCurveReport?: ScalingCurveReport` to `Report`.
- Growth classification for each curve: `"constant"`, `"linear"`, `"super-linear"`. Use existing `computeScalingCurve` logic.
- Terminal output in curve mode: table with scale points as rows, timing columns:
  ```
  Scaling: items (array, auto-detected)
  
  N     Mount     Rerender   Unmount    DOM    Heap     Growth
  ---   -------   --------   -------    ----   ------   ------
  1     0.8ms     0.3ms      0.1ms      8      +12KB    
  3     1.2ms     0.4ms      0.2ms      22     +18KB    
  5     1.9ms     0.6ms      0.3ms      36     +24KB    
  10    3.5ms     1.1ms      0.5ms      71     +48KB    
  20    7.2ms     2.3ms      1.0ms      141    +96KB    linear
  50    18.1ms    5.8ms      2.5ms      351    +240KB   linear
  ```
- Verdict in curve mode: FAIL if any point exceeds its tier budget OR if growth is `"super-linear"`. WARN if highest-N point approaches budget (>75% of threshold).
- Curve mode skips delta analysis (`--no-deltas` implied) — the curve itself IS the scaling analysis.
- `--no-curve` CLI flag to disable auto-activation of curve mode. Falls back to M12 behavior (single scaling curve on the combo report).
- `CliArgs.curve?: boolean | string` (true = auto-detect, string = `propName:type`).
- `CliArgs.noCurve?: boolean`.
- `AnalyzeOptions.curveMode?: boolean | { propName: string; propKind: "array" | "number" }`.

### MUST NOT

- Remove or change M12 auto-scaling behavior when curve mode is NOT active. M12 remains the default in normal mode.
- Measure interactions at every scale point if `--no-interactions` future flag is passed.
- Run curve mode when no scaling prop is detected and `--curve` is not explicitly passed.
- Break existing report JSON. `scalingCurveReport` is additive.

### Invariants

- Same CDP tracing, calibration, warmup, sample count used at each scale point.
- Scale points are always sorted ascending.
- A component with no scaling props and no explicit `--curve` flag skips curve mode entirely.
- Curve mode produces `ScalingCurveReport` on the report. Normal combos are NOT produced in curve mode (the scaling points replace them).
- All existing tests pass unchanged.

## Design

### Activation logic

```
if (options.curveMode === false || args.noCurve):
  // M12 behavior: auto-scale on main combos
elif (options.curveMode is explicit string):
  // forced curve mode on named prop
elif (detectScalingProps returns matches):
  // auto-activate curve mode on first match
else:
  // no scaling prop found, normal mode
```

### Measurement loop

```
for each n in scalePoints:
  combo = generateScalingCombos(schemas, match, [n])[0]
  mount = measureMount(harness, [combo], options)
  rerender = measureRerender(harness, [combo], options)
  explore = explore(harness, [combo])
  // collect into ScalingPoint
```

### Growth detection

Reuse `computeScalingCurve` for each dimension:
- Mount samples → mountCurve
- Rerender samples → rerenderCurve
- Unmount samples → unmountCurve
- DOM node counts → domGrowth
- Heap deltas → heapGrowth
- Per unique interaction label → interactionCurves

### Interaction stability across scale points

Interactions may appear or disappear at different N values (e.g. carousel shows nav buttons only when >1 slide). Only interactions present at ≥2 scale points get a curve. Those present at only 1 point are reported but not curve-analyzed.

## Open questions

1. Should curve mode produce a separate JSON file (`120fps-curve.json`) or stay in the main report? Decision: main report, `scalingCurveReport` field — single source of truth.
2. Memory measurement: heap delta at each point may be noisy. Consider using mount/unmount cycle count (like bench file §12) for memory stability. Decision: defer to M23 (isolated modes). M20 uses existing `heapDelta`.

## Test count

56 tests across 4 files: CLI parsing (13), report types/formatting (16), buildCurveReport + computeCurveVerdict (8), hardening (19).
