---
kind: milestone
status: implemented
tests:
  - test/unit/m61-scale-probe-transparency.test.ts
  - test/unit/m61-harden.test.ts
---

# M61 — scale-probe transparency + matrix combo cap

## Purpose

The always-on auto-scale probe (4 synthetic combos mounting N=1/5/20/50
sibling copies via `__120fps_scaleN`) was presented as an ordinary combo:
a bare numeric index in the same table as real prop variations,
`__120fps_scaleN` leaking verbatim into JSON `combos[].props`, and a
scaling curve fitted across *every* combo's `domNodeCount` — mixing the
probe's own N-copies growth with whatever incidental DOM differences real
prop combos happened to have — then stamped onto all of them, including
combos that never varied anything (GameControls: two function props, zero
list props, r²=0.9999 "linear" scaling from a curve that was 100% probe
artifact). Combo-count headers counted the probe in the numerator
("measured") but not the denominator ("generated"), contradicting the
footer's drop warning. `--max-combos` did nothing once matrix mode
auto-activated — a 4-prop badge ran all 64 cells regardless. And probe
cost was unbounded: a single N=50 combo cost 46.9s with no disclosure.

## Contract

### 1 — scale-probe identity

- `ComboReport.scaleProbe?: number` carries the probe's N. Present only on
  combos produced by the sibling-copies mechanism (`fixtureHasScale`'s
  combos, and the 4 combos `runComboMode` appends after the capped prop
  combos).
- `ComboReport.props` MUST NOT contain `__120fps_scaleN` — `buildReport`
  strips it before the combo enters the report; `scaleProbe` is where that
  information now lives.
- Baselines and fingerprints (`src/budget.ts`) never read `combo.props` —
  a baseline slot keys on component path and environment, and
  `comboMetrics` (analyze.ts) is built from `mount`/`rerender`/
  `domNodeCount`/`tier`/`measuredState`, never from `props`. Stripping the
  marker and adding `scaleProbe` changes no serialized baseline identity.
- Terminal: the main table's `#` column prints `×N copies` for a
  scale-probe row instead of the bare index. Sub-section headers
  ("Combo #N:" in cost breakdown / React Optimizations / page errors)
  keep the numeric index unchanged — the main table is where a reader
  first meets the row, and cross-referencing a number back to it is
  unambiguous.

### 2 — one curve per mechanism, never crossed

- `buildReport` fits a scaling curve from the scale-probe combos alone —
  `{ n: combo.scaleProbe, metric: combo.mount.median }` across combos
  where `scaleProbe !== undefined` — and attaches it only to those
  combos. Real prop combos never receive it. This replaces the previous
  fit over every combo's `domNodeCount`, which conflated the probe's
  N-copies growth with incidental DOM differences between unrelated real
  combos (the GameControls fabrication).
- `applyAutoScalingCurves` (the real detected-prop mechanism, e.g. a
  `saves` array) attaches its curve only to combos where
  `scaleProbe === undefined`. Previously it overwrote every combo
  including the scale probes, silently replacing their synthetic-copies
  curve with the real-prop curve under the same field — same bug, other
  direction.
- Terminal `Scaling` column: a scale-probe combo's curve prints
  `<growthClass> (synthetic copies)`; a real detected-prop combo's curve
  keeps its existing `<growthClass> (auto: <prop>)` label. The two never
  appear on the same combo.
- A component with no scale-probe combos and no detected scaling prop
  (fixture/composed mode) shows `-` in Scaling, as before.

### 3 — headers reconcile

- `describeMode`'s prop-combo count (`measured`, and `generated` parsed
  from the cap warning) counts only combos where `scaleProbe ===
  undefined`. Scale probes are named separately: `+K scale probes`
  appended when `K > 0`.
- When every combo is a scale probe (manual `scale()` fixture export, or
  a zero-prop component under `--no-auto-compose`), the mode line reads
  `Mode: scale probe (K points, no prop combos)` instead of
  `0 measured`.
- The footer drop warning (`COMBO_CAP_WARNING`) already counts prop
  combos pre-scale-probe-append (`kept`/`total` from before the 4 probes
  are added), so once the header excludes probes from its own count the
  two already agree — no footer change needed.

### 4 — `--max-combos` bounds matrix cells

- `runMatrixMode` caps `matrixCombos` to `options.maxCombos ??
  DEFAULT_MEASURED_COMBOS` (8) after generation (cartesian or
  pairwise-cover) and before measurement, via
  `selectMatrixCombos(combos, axes, max)` (prop-gen-values.ts).
- Selection order: the all-anchor base cell first (every eligible axis at
  its first/anchor value — `axes[i].values[0]`), then cells at
  Hamming distance 1 from it (single-axis deviations — the same
  one-prop-at-a-time story `--max-combos` already tells in plain-combo
  mode via M21's stratification), then distance 2, etc. Ties keep
  generation order. This is a selection over already-generated cells; it
  does not change `generatePropMatrix`'s cartesian/pairwise-cover
  generation or its cell ordering (M21).
- `MATRIX_CELL_CAP_WARNING(kept, total)` names both counts and points at
  `--max-combos <n>`, mirroring `COMBO_CAP_WARNING`'s wording.
- `MATRIX_AUTO_ACTIVATED_NOTICE` and `computeEffectiveSamples` both read
  the post-cap `matrixCombos.length`, so the "measures all Nx" notice and
  the sample throttle both describe what actually gets measured.
- `--help`'s "Combo caps" section is rewritten: `--max-combos` now bounds
  both prop-combo mode and matrix mode, default 8 either way.

### 5 — probe cost is bounded and disclosed

- Before committing to the full scale-point sweep, `runComboMode` (and
  the `fixtureHasScale` path) measures the cheapest requested point alone
  (`Math.min(...scalePoints)`, 3 samples) and checks its mount median
  against `SCALE_PROBE_GATE_MS` = `TIER_BUDGETS.T4.mountMs` (80ms) — the
  most lenient tier budget the tool has. A component whose single
  instance already costs this much will not cost *less* per copy at
  N=5/20/50; quadrupling the instance count is exactly the shape of the
  46.9s dogfood reproduction.
- Over the gate: only the probed point is kept, the rest are skipped, and
  `SCALE_PROBE_COST_WARNING` states the measured cost, the gate, and
  which points were skipped, once, as a run warning (one line in the
  terminal, one entry in `report.warnings`).
- At or under the gate: the full requested scale-point set is measured as
  before (the probe's own cheap measurement is not reused — see Design).
- The decision (`boundScalePointsByProbeCost`) is a pure function of the
  probed median and the requested points, independent of the
  measurement call, so it is unit-testable without a browser.
- Scope: this gates only the sibling-copies probe. `applyAutoScalingCurves`
  (the real detected-prop sweep) is not gated by this milestone — its N
  points measure a real prop's growth (e.g. a `saves` array), not N whole
  additional component trees, and dogfooding's cost complaint was
  specifically about the sibling-copies mechanism.

## MUST NOT

- No change to how scale-probe combos are *generated* or *rendered* —
  `__120fps_scaleN` remains the harness trigger key end to end
  (measure.ts, harness.ts, isolation.ts untouched). Only how
  `buildReport` shapes the *output* changes.
- No change to `generatePropMatrix`'s generation algorithm, its 256-cell
  ceiling, or the 64-cell auto-activation threshold — capping is a
  selection over the generated set, applied once, after generation.
- No change to `applyAutoScalingCurves`'s own measurement (points,
  sample count, or gating) beyond which combos its result is written
  onto.
- `--no-auto-scale` keeps its documented scope (disables the
  `applyAutoScalingCurves` real-prop pass only); this milestone does not
  extend it to the sibling-copies probe.

## Design

**Why the gate re-measures instead of splicing.** `measureMount` assigns
`comboIndex` by position in the array it is handed, and every downstream
pass (`measureRerender`, `explore`, `runReactAnalysis`) re-uses that same
array positionally. Splicing a separately-measured N=1 result into the
main batch would mean either faking a `comboIndex` or reshuffling the
main array after the fact. Re-measuring the cheapest point with 3 samples
costs one extra small mount — bounded, since it is by construction the
cheapest of the requested points — and keeps every downstream pass
working over one array it fully owns.

**Why distance-from-anchor, not a fixed prefix.** `matrixCartesian`'s
lexicographic order already front-loads single-axis deviations of the
*last* axis (odometer carry), but a deviation in the *first* axis only
appears once every full cycle of the other axes — a literal `slice(0,
max)` would starve that axis under a small cap. Ranking by Hamming
distance from the anchor treats every axis symmetrically regardless of
generation order, then breaks ties by original index so selection stays
deterministic and cheap (`O(cells × axes)`).

**Why scale-probe curves use N, not domNodeCount.** The removed
`distinctDomSizes` mechanism used `domNodeCount` as a proxy for scale
because it had no better signal available across arbitrary combos. A
scale-probe combo already carries its true independent variable
(`scaleProbe`), which is exact where `domNodeCount` was only
approximately proportional to it (canvas/portal/conditional content can
change node count for reasons unrelated to N).

## Deferred

- CI serializers (`ci-report.ts`) do not label scale-probe rows distinctly
  in markdown/JUnit output — they never printed `props` and were not part
  of the dogfood reproduction; a future milestone can extend the same
  `scaleProbe` field there.
- Sub-section headers ("Combo #N:" in cost breakdown, React
  Optimizations, page errors) stay numeric-only rather than also
  growing a `(×N copies)` suffix — lower value than the main table fix,
  deferred to keep this milestone's diff scoped to what dogfooding
  actually flagged.
- `applyAutoScalingCurves`'s own probe cost is not gated (see Contract
  §5's scope note). A list-prop sweep that is itself expensive (e.g. 50
  heavy list items) is a real but different cost surface from N whole
  sibling component trees.
- `classifyTier`'s `hasScaling` parameter is computed in `buildReport`'s
  tier loop but not read by `classifyTier` (M64 redefined the floor as
  portal-or-animation only). Observed, not fixed here — out of this
  milestone's contract and orthogonal to scale-probe transparency.
