---
kind: milestone
status: done
tests:
  - test/unit/matrix-cli.test.ts
  - test/unit/matrix-gen.test.ts
  - test/unit/matrix-report.test.ts
  - test/unit/matrix-build.test.ts
  - test/unit/matrix-harden.test.ts
  - test/e2e/analyze.test.ts
---

# M21 — matrix mode

Full variant matrix catches compound effects M11 deltas can't. Auto: ≥2 variant props (union/bool, ≤8 values each) AND cartesian ≤64; cap 256 via greedy all-pairs covering array (every value pair tested at least once). Non-matrix props at anchor. Cell order lexicographic.

Traps (each was a real bug class):
- Cells ARE combos. buildMatrixReport is a pure PROJECTION of finished combos — verdict/tier/timings copied verbatim, never recomputed. Two verdict computations drift (earlier one ignored interactions, scale-combo exemption, explicit thresholds) → run FAIL printed above an all-PASS table.
- Only 5 hottest cells (by mount median) get explore(); MUST restoreComboIndices(results, hotIndices) — explore numbers by array position, else interactions attach to cells 0..4.
- Printed set = hotCells + any failing cell not among them: a cheap-mount cell can fail on an interaction.
- explicitThresholds must flow into the matrix report (user-typed threshold overrides tier, same as standard pipeline).
- Build order: measure all cells → pick hot 5 → explore + restore indices → buildReport → project matrix from report.combos.

Compound effects: actual mount vs anchor + sum of M11 deltas; >1.5× expected = high, >1.2× = medium. Needs delta data (--no-deltas → omitted); empty when ≤1 axis. No heap in matrix (variant comparison, not memory).

Baselines: the matrix path returns before `applyBaselineWorkflow`, so a matrix run neither saves nor compares a baseline. A run that was given a baseline flag (`baselineWorkflowRequested`: `--save-baseline`, or `--check`/`--budget` without `--no-baseline`) pushes `MATRIX_BASELINE_WARNING` naming `--no-matrix` as the workaround — auto-activation means this reaches users who never typed `--matrix` (M54). `--curve` + `--matrix` is a CLI usage error, not silent curve-wins.
