---
kind: milestone
status: approved
tests: test/unit/m31-combo-cap.test.ts, test/unit/m31-baseline-shape.test.ts, test/e2e/m31-dom-count.test.ts
---

# M31 — measurement semantics

## Purpose

Two numbers the whole report rests on are wrong in ways that cancel nobody's error. `domNodeCount` counts the browser chrome as if it were the component, which shifts tier classification and therefore every budget verdict. The standard pipeline silently truncates prop combos at 16 and then spends ~80s on each of them, which is why a 27-combo component never finished. Both changes invalidate saved baselines, so they ship together behind one shape bump rather than twice.

## Non-goals

- Reducing per-combo cost. Sample count dominates it, and changing the sampling plan is a separate question with its own accuracy argument.
- Retuning tier node-count boundaries. The boundaries stay 10/40; what changes is that they now count component nodes instead of component nodes plus eight chrome nodes. That is the correction, not a new calibration.
- Retuning interaction budgets. M33.

## Contracts

### C1 — `domNodeCount` counts the component, not the document

`document.querySelectorAll("*")` (`src/measure.ts:521`, `src/metrics.ts:538`, `src/measure.ts:256`) includes `html`, `head`, `body`, `#root`, and Vite's injected scripts. Measured: a scene that rendered nothing reported 9.

- `countComponentNodes(page)` MUST count elements inside `#root` plus the elements of every body child outside `#root` that is not a framework internal (`SCRIPT`, `STYLE`, `LINK`, `NOSCRIPT`, `TEMPLATE`, and Vite overlay elements).
- Portal content MUST be counted. It is component DOM that happens to live on `document.body`, and excluding it would undercount every dialog, popover and select.
- The same function MUST serve all three call sites, so mount, calibration and wrapper-overhead counts stay comparable.
- An empty scene MUST count 0.
- Tier boundaries stay `≤10` T1, `≤40` T2, `>40` T4. Consequence, stated because it changes verdicts: a component rendering 10 elements was 18 nodes and T2 with a 44ms budget, and is now 10 nodes and T1 with a 14ms budget.

### C2 — measured combos are capped and the cap is disclosed

`src/analyze.ts:949` does `combos.slice(0, 16)` with no warning, which the project's own no-silent-caps rule forbids.

- The cap MUST default to 8 and MUST be overridable with `--max-combos <n>` → `AnalyzeOptions.maxCombos`.
- Selection MUST be representative, not the first N. `selectRepresentativeCombos(count, max)` in `prop-gen-values.ts` picks first, last and evenly spaced interior indices; `selectExploreCombos` MUST delegate to it so one algorithm serves both.
- Reason: `generateCombinations` stratifies its sample across the value space, and taking a prefix discards that work.
- Dropping combos MUST append `COMBO_CAP_WARNING` naming kept and dropped counts.
- The cap MUST apply only to the standard pipeline. Curve, matrix and scaling combos are purpose-built lists whose length is the measurement.
- Scale combos appended after the cap are not subject to it.
- Evidence: one combo costs ~80s at default samples, so the old 16 plus 4 scale points is ~27 minutes, matching the observed >35 minute runs.

### C3 — baselines record which semantics produced them

- `EnvFingerprint` gains `metrics?: number`, set to `METRICS_REVISION` (now 3 — M34). Absent means pre-M31.
- `shape` MUST keep its M29 meaning and stay `1`. Overloading it was tried and reverted: M29 contracts that a differing `shape` still compares on shared fields (`test/unit/m29-baseline-env-harden.test.ts:72`), which is the opposite of what a semantics change needs. Two concerns, two fields.
- `classifyEnv` MUST treat a `metrics` mismatch as `incompatible`, which already skips comparison without failing the run, and `describeEnvDiff` MUST name it so the user knows to re-save.
- A pre-M31 baseline MUST NOT silently compare against post-M31 numbers: node counts fall by ~8 and tiers shift, so every comparison would read as a large improvement.

## Open questions

- Per-combo cost is dominated by sample count, not by anything M31 touches. A run that is fast enough to sit in a pre-commit hook needs a cheaper sampling plan.
