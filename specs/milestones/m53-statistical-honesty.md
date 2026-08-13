---
kind: milestone
status: implemented
tests:
  - test/unit/m53-statistical-honesty.test.ts
  - test/unit/m53-statistical-honesty-harden.test.ts
---

# M53 — statistical honesty

## Purpose

A tool whose differentiator is honest disclosure cannot print numbers whose
labels overstate them. Five printed values did not mean what their labels said:
a nearest-rank "P95" that returned the sample maximum at N=10 and, for every
combo but the first, measured a cold start; a CV computed with population
variance, biasing toward "stable" at small N; a fingerprint recording the
requested sample count while the run measured as few as 3, so baselines
estimated from different real N compared as `identical`; a churn degradation
ratio comparing B,A,B against A,B,A — prop composition, not degradation; and a
curve classifier ranking the exponential candidate's R² on log y against its
rivals' R² on raw y.

## Contract

- `computeP95` returns the type-7 quantile (`h = (n−1)·0.95`, interpolated
  between the `⌊h⌋`-th and `⌈h⌉`-th order statistics); n=1 returns the sample,
  n=0 returns 0. The glossary states that below n≈20 the estimate is dominated
  by the slowest sample.
- Every measured combo receives at least one untraced, unrecorded warmup render
  on its own props before its sampled measurements (`warmupsForPosition`). The
  first combo of a pass keeps the full `warmupRuns`; `warmupRuns: 0` disables
  warmup entirely. Warmup output never enters `samples`.
- `computeCV` uses the sample standard deviation (`n−1`). n ≤ 1 yields 0 — no
  dispersion evidence, not "stable" evidence. The `unstable` rule is unchanged.
- The environment fingerprint records the effective per-combo sample count.
  When it is below the requested count, `Report.warnings` names both once per
  run. Missing-combo re-measurement uses the sweep's effective count.
- Churn: the degradation ratio compares early against late samples within one
  alternation parity and reports the worse of the two; churn `cv`/`unstable`
  come from the worse parity, never from the A/B mix. Median, P95 and the
  sample array still describe the whole alternation.
- `computeScalingCurve` ranks every candidate by R² on the raw metric; the
  exponential candidate is scored on its back-transformed predictions and
  scores 0 when they are non-finite.
- Not done: no JSON field renamed (`p95`, `cv` keep their names), no budget
  threshold changed, no work added inside a traced window.

## Design

- Type-7 is the default of R and numpy, so a reader checking the number against
  any standard tool reproduces it. At n=10 it still sits between the two
  slowest samples; the fix is honesty at the margin plus the glossary
  disclosure, not a pretense that 10 samples estimate a tail.
- Per-combo warmup costs ≤1 extra render per combo — bounded, and it removes
  the cold-start artifact that made the previous "P95" a JIT measurement.
- Recording effective samples changes fingerprint semantics: a baseline saved
  before this change on a >20-combo component recorded `samples: 10` while
  measuring fewer; against a new run it classifies as a samples mismatch. That
  is correct — those comparisons were never like-for-like. Runs with ≤20 combos
  (the common case) recorded the true count and are unaffected. The check-mode
  reuse probe still fingerprints the requested count because combos are not
  extracted at that point: a throttled entry therefore fails the reuse gate and
  the run measures, which errs towards measuring rather than towards a
  mismatched verdict.
- Churn keeps its sequence and its report fields; only the aggregation respects
  parity. Splitting one bimodal array into two unimodal series is arithmetic,
  not new measurement. With `CHURN_CYCLES = 10` each parity carries 10 samples,
  so the first-3-vs-last-3 comparison survives intact.
- The parity split is also why the old ratio never crossed the 2.0 verdict
  limit on a pure A/B gap ((2A+B)/(2B+A) → 2): the defect was a wrong printed
  number, not a wrong verdict.

## Deferred

- `classifyTier` treats portal/animation as an override rather than a floor
  (a 2000-node animated table gets T3's 60ms rather than T4's 80ms budget,
  src/report.ts:52). Changing it alters documented tier semantics in README —
  needs a product decision, not a bugfix slot here.
- rAF-driven JS animation (react-spring style) likely escapes
  `detectAnimations` and stays on driven pacing; `hasAnimation` is read on
  sample 0 only. Real, but a detection feature, not a statistics fix.
- An honest tail estimate (bootstrap CI on the median, or N raised for tail
  reporting) — needs a cost decision.
- `computeCvPercent` (noise probe, src/noise.ts) still uses population
  variance. It shares the 15% bar with `buildTimingWithCV`, so switching it
  moves run-level quiet/noisy/hostile classification and wants its own
  threshold review.
- `linearRegression` overflows to a NaN `r2` for metrics above ~1e154. The
  growth class stays valid (non-finite candidates score 0), but the printed r²
  does not.
