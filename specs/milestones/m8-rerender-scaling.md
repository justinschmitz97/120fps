---
kind: milestone
status: done
tests: [test/unit/rerender.test.ts, test/unit/rerender-harden.test.ts, test/e2e/rerender.test.ts, test/e2e/rerender-harden.test.ts]
---

## Purpose

Production bench suites spend 60%+ of their test surface on rerender cost — prop changes, controlled value cycling, stable-prop rerenders. 120fps currently only measures mount/unmount. M8 adds rerender measurement and parameterized scaling so the tool covers the dominant performance dimension.

## Builds on

M7 (fixture pipeline). The Control API already exposes `rerender(props)`. M8 uses it to capture CDP traces during prop-change rerenders.

## Contract

### MUST

- Add `measureRerender(harness, fromProps, toProps, options?)` that captures CDP trace during `__120fps.rerender(newProps)` and returns `TimingResult` (N samples, median, P95).
- Measure two rerender scenarios per combo: (1) stable rerender (same props), (2) prop-change rerender (different props — next combo's props, or `{}` for fixtures).
- Add `rerender: TimingWithCV` to `ComboReport`. Contains stable-rerender timing. Prop-change rerender stored as `rerenderChange: TimingWithCV` when applicable.
- Parameterized fixtures: when a fixture default-exports a component AND exports a named `scale` function `(n: number) => JSX.Element`, the pipeline calls `scale` at each scale point to produce multiple combos.
- Default scale points: `[1, 5, 20, 50]`. Override via `--scale 1,10,100` CLI flag.
- Scaling curves computed for mount AND rerender across parameterized combos.
- `--threshold-rerender <ms>` CLI flag (default: 16ms). Rerender exceeding threshold → verdict `fail`.
- `Report.thresholds.rerenderMs` added to thresholds (default 16, calibrated for 4x CPU throttle).
- Backward compatible: components without `scale` export and non-fixture paths work unchanged. `rerender` field is always present (measured for all components).

### MUST NOT

- Change the fixture authoring contract from M7. `scale` is optional — fixtures without it produce 1 combo as before.
- Break existing report JSON consumers. `rerender` is additive.
- Rerender with arbitrary state mutations — only prop-driven rerenders via the Control API.

### Invariants

- Rerender timing uses the same CDP tracing, calibration, warmup, and sample count as mount timing.
- Scale points produce combos ordered by N. Scaling curve requires ≥2 distinct DOM sizes.
- All existing tests pass unchanged.

## Design

### Rerender measurement

`measureRerender(harness, options?)` in `src/measure.ts`. Opens its own browser, iterates combos:

1. Warmup: mount combo[0], rerender N times (discard results).
2. Per combo — stable rerender: for each sample, mount(props) → trace(rerender(props)) → collect duration.
3. Per combo — prop-change rerender (when >1 combo): for each sample, mount(currentProps) → trace(rerender(nextComboProps)) → collect duration. Last combo rerenders to first combo's props.
4. Returns `RerenderResult[]` with `stable: TimingResult` and optional `change: TimingResult`.

### Parameterized fixture contract

```tsx
// accordion.fixture.tsx
export default function AccordionScene() {
  return <Accordion><Item /><Item /></Accordion>;
}

// Optional: scaling function
export function scale(n: number) {
  return (
    <Accordion>
      {Array.from({ length: n }, (_, i) => <Item key={i} />)}
    </Accordion>
  );
}
```

Detection: `hasScaleExport(source)` regex `/export\s+(?:function|const)\s+scale\b/` (word boundary prevents false matches on `scaleItems`, `rescale`, etc.).

Harness integration: `detectScaleExport(filePath)` reads the fixture file. When detected, the harness entry.tsx imports `scale` and dispatches mount/rerender to `scale(n)` when props contain `__120fps_scaleN`. Scale combos are `[{__120fps_scaleN: 1}, {__120fps_scaleN: 5}, ...]`.

### CLI changes

- `--scale <points>` — comma-separated positive integers (e.g. `--scale 1,10,100`). Rejects floats, zero, negatives.
- `--threshold-rerender <ms>` — rerender time threshold (positive number).
- Help text updated.

### Report changes

- `ComboReport.rerender: TimingWithCV` — stable rerender timing (always present).
- `ComboReport.rerenderChange?: TimingWithCV` — prop-change rerender timing (absent for single-combo fixtures).
- `ComboReport.rerenderScalingCurve?: ScalingCurve | null` — rerender scaling curve (set when ≥2 distinct DOM sizes).
- `Thresholds.rerenderMs: number` (default 16).
- `computeVerdict` checks `rerender.median > rerenderMs` and `rerenderChange.median > rerenderMs` for fail; `rerender.unstable` / `rerenderChange.unstable` for warn.
- `formatTable` includes Rerender column between Mount and Unmount.

## Acceptance criteria

- `120fps ./Button.tsx` measures mount AND rerender for each prop combo, report includes `rerender` field.
- `120fps ./accordion.fixture.tsx` with `scale` export produces combos at [1,5,20,50], scaling curves for mount and rerender.
- `120fps ./accordion.fixture.tsx` without `scale` export produces 1 combo with rerender timing.
- `--scale 1,10,100` overrides default scale points.
- `--threshold-rerender 4` fails combos with stable rerender median >4ms.
- Scaling curve `growthClass` computed for rerender timing across scale points.
- All existing tests pass unchanged.
