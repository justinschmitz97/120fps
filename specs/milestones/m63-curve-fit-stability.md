---
kind: milestone
status: implemented
tests:
  - test/unit/m63-curve-fit-stability.test.ts
  - test/unit/m63-harden.test.ts
---

# M63 — curve-fit stability & curve diagnostics

## Purpose

Curve mode answered "does it scale with its data?" with three defects, all
observed in the 2026-08-18 dogfood run.

`computeScalingCurve` promoted whichever of linear/quadratic/exponential carried
the highest raw-y R², with no margin. Two back-to-back runs over an unchanged
component classified the same component `linear`/PASS and then `quadratic`/FAIL.
A rerender series whose medians grew 3.7× while N grew 50× — sub-linear growth —
was labelled `exponential`, and the resulting "superlinear-growth" hint printed
on the same screen as a `linear` growth column.

A curve FAIL stated no reason: the reader had to diff each N row against the
threshold by hand to find where the budget was crossed.

`--curve` requested on a component with no array or list prop fell back to
prop-combo mode and printed `Mode: prop combos`, indistinguishable from a
successful curve run.

## Contract

### 1 — superlinear promotion needs evidence

- `linear` is the null class. `computeScalingCurve` returns it unless a
  superlinear candidate clears both gates below. The existing
  `inconclusive` (≤1 point, <3 distinct N) and `constant` (slope ≤ 0,
  linear R² < 0.5) gates run first and are unchanged.
- **Magnitude gate.** `growthExponent(points)` is
  `log(yLast / yFirst) / log(nLast / nFirst)` over the points with `n > 0` and
  finite `metric > 0`, sorted by `n`; it is 0 when fewer than two such points
  remain or `nLast ≤ nFirst`. A superlinear class requires
  `growthExponent >= SUPERLINEAR_MIN_EXPONENT` (1). Growth that is sub-linear in
  N over the measured sweep cannot be reported as super-linear in N.
- **Fit gate.** A candidate is admissible only when it explains at least half of
  the variance the linear fit leaves:
  `(1 - candidate.r2) <= SUPERLINEAR_RESIDUAL_SHARE * (1 - linear.r2)` with
  `SUPERLINEAR_RESIDUAL_SHARE = 0.5`. A linear fit with no leftover variance
  (`1 - r2 <= 1e-9`) admits nothing.
- Among admissible candidates the higher raw-y R² wins — M53's ranking rule,
  unchanged, including the exponential candidate's back-transformed scoring and
  its score of 0 on non-finite predictions. No admissible candidate → `linear`.
- `slope`, `intercept` and `r2` keep meaning the linear fit's values.

### 2 — stability under noise

- Classification is a pure function of the points. No `Date`, no `Math.random`,
  no run-order dependence in `computeScalingCurve` or its helpers.
- A near-linear series jittered up to ±15% (the CV bar at which a run is already
  flagged unstable) classifies `linear` across fixed seeds.

### 3 — `--curve` that does not activate says so

- When curve mode was requested explicitly (`--curve`, with or without
  `prop:type`) and no curve run happens, the run MUST push
  `CURVE_NOT_ACTIVATED_WARNING(reason)` into `report.warnings`, naming the
  reason: no array or list prop in the extracted schema, a fixture run, or a
  composed run.
- The run still proceeds in its fallback mode and its exit code still comes from
  the verdict. `--no-curve` and auto-detection that finds nothing stay silent —
  neither asked for a curve.

### 4 — a curve FAIL names what it violated

- `evaluateCurve(points, mountCurve, thresholds)` returns the verdict plus the
  `CurveViolation` behind a `fail`, and `computeCurveVerdict` delegates to it.
  Verdict values are unchanged: superlinear mount growth fails; a mount or
  rerender median over its budget fails; the last point above 75% of a budget
  warns.
- `buildCurveReport` stores that violation on `ScalingCurveReport.violation`, so
  the JSON carries it. It is present exactly when the verdict is `fail`.
- A budget violation records the violated metric, its budget, the first N at or
  above it (`crossingN`), the measured median there, and the largest N still
  under it (`lastPassingN`, absent when the smallest measured N already
  exceeds).
- The terminal prints `formatCurveViolation(violation)` under `Result: FAIL`.

### 5 — one classification per screen

- `isSuperlinearGrowth(curve)` is the single predicate. `hints.ts` derives the
  `superlinearGrowth` hint from it; nothing else decides superlinearity.
- Curve output prints a `Growth:` line naming the class of every curve that
  predicate is applied to in curve mode — mount and rerender — so a hint can
  never cite a class the screen does not show. The per-row `Growth` column keeps
  showing the mount class.

### Not done

- No threshold moved: `mountMs`, `rerenderMs`, the 0.75 warn fraction and the
  superlinear-fails-outright rule are untouched.
- `computeCurveVerdict` reads only `mountCurve` for growth. The `Growth:` line
  discloses the rerender class; it does not make it fail the run.
- No JSON field renamed or removed.

## Design

- **Why a margin and not an information criterion.** All three candidates are
  two-parameter fits (`a·n + b`, `a·n² + b`, `log y = a·n + b`), so AIC/BIC
  penalties are identical across them and reduce to ranking by residual sum of
  squares — exactly the rule that produced the flip. The candidates are not
  nested either, so an F-test does not apply. What is left is an explicit
  margin, and the margin has to be relative: on the default sweep
  `[1, 3, 5, 10, 20, 50]` a *perfect* quadratic only beats its linear fit by
  0.052 of R², so any absolute margin large enough to survive noise would also
  reject genuine quadratics.
- **Why the magnitude gate exists at all.** Fit quality alone cannot separate
  `1.2·e^0.0267n` from a line over N ∈ [1, 50]: the model is a genuine
  exponential and it fits, but it grows 3.7× while N grows 50×. Labelling that
  "exponential" is true of the model and false of the component. The exponent of
  the measured endpoints answers the question the label implies — does cost grow
  faster than the data? — in units the reader can check against the printed
  table.
- **Simulated behaviour** (500 seeded jitters per row, default sweep):

  | series | ±5% jitter | ±15% jitter |
  | --- | --- | --- |
  | `0.2n + 4` | 500 linear | 500 linear |
  | `10n` | 500 linear | 500 linear |
  | `4.27 + 2·log₂n` | — | 500 linear |
  | `1.2·e^0.0267n` (3.7× over 50×) | 500 linear | 500 linear |
  | `0.05n² + 2` | 500 quadratic | 482 quadratic |
  | `n²` | — | 500 quadratic |
  | `e^0.1n` | — | 500 exponential |

- **Deliberate false negatives.** A quadratic whose measured growth stays
  sub-linear over the sweep (`0.005n² + 5`: 3.5× for 50× N) reports `linear`.
  Over the range actually measured that is what the numbers show, and the
  per-N budget checks still fail it if it is slow. Widening the sweep is the
  way to surface it, not loosening the gate.
- **Violation as data.** The verdict function already walked the points in the
  order that decides the verdict; returning what it found costs one object and
  removes the reader's manual diff. Terminal and JSON then quote the same
  numbers because they read the same field.
- **Warning at the resolution seam.** `resolveCurveMatch` is the only place that
  knows both that curve mode was asked for and that it will not run, so the
  diagnostic is pushed there into `runWarnings`, which every mode's
  `attachHarnessContext` already folds into `report.warnings`.

## Deferred

- `rerenderCurve`'s growth class is printed but never fails a run. Making it
  fail changes verdict semantics and needs a product decision.
- `interactionCurves` and `domGrowth`/`heapGrowth` classes are neither printed
  as a `Growth:` entry nor read by hints; they stay JSON-only.
- The magnitude gate uses the endpoint medians. A trimmed or fitted endpoint
  would be steadier at very small N, and matters only for sweeps whose first
  point is itself unstable.
- `--curve prop:type` naming a prop absent from the schema still synthesises a
  schema entry and runs; only the "no curveable prop at all" case warns.
