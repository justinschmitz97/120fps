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

## Purpose

M11 (pairwise delta) isolates the cost of flipping one prop against an anchor. Real bench suites test full variant matrices — every combination of `variant × size × boolean` — to catch compound interactions (e.g. "iconMedium + spotlight is 2× slower than either alone"). M21 adds a **matrix mode** that enumerates all meaningful prop cells, measures each, and surfaces the expensive combinations automatically. This replaces hand-authored variant-matrix bench sections.

## Builds on

M11 (pairwise delta: `generateDeltaPairs`, `PropDelta`). M1 (prop extraction: `PropSchema`). M8 (rerender measurement). M13 (tiered budgets for verdict).

## Contract

### MUST

- Add `--matrix` CLI flag. When passed, 120fps runs **matrix mode**: measures every cell in the prop variation matrix.
- Auto-activate matrix mode when the component has ≥2 variant-like props (union/enum/boolean) AND total cell count ≤ 64. Override: `--matrix` forces it on, `--no-matrix` forces it off.
- **Cell generation** — `generatePropMatrix(schemas: PropSchema[]): PropCombination[]`:
  - Include all props with `kind === "union"` or `kind === "boolean"` that have ≤8 values.
  - Compute cartesian product of all included props' value sets.
  - Non-matrix props (number, array, string, function, reactnode, object) held at anchor value (first value).
  - Cap at 256 cells. If cartesian product exceeds 256, apply pairwise covering array (all-pairs) to reduce to ≤256 cells while guaranteeing every pair of prop values is tested at least once.
- At each cell, measure:
  - Mount timing
  - Rerender timing (stable)
  - Unmount timing
  - DOM node count
- Add `MatrixReport` type:
  ```ts
  interface MatrixReport {
    axes: MatrixAxis[];
    cells: MatrixCell[];
    hotCells: MatrixCell[]; // top 5 by mount.median, descending
    coldCells: MatrixCell[]; // bottom 3 by mount.median (fastest baseline)
    failingCells: MatrixCell[]; // every cell with verdict "fail", any mount cost
    compoundEffects: CompoundEffect[];
  }

  interface MatrixAxis {
    propName: string;
    values: unknown[];
  }

  interface MatrixCell {
    comboIndex: number;
    props: Record<string, unknown>;
    mount: TimingWithCV;
    rerender: TimingWithCV;
    unmount: TimingWithCV;
    domNodeCount: number;
    tier: ComponentTier;
    verdict: "pass" | "warn" | "fail";
    worstInteractionMs: number | null; // null = interactions not explored here
  }

  interface CompoundEffect {
    props: Record<string, unknown>; // the combination
    expectedMount: number; // sum of individual prop deltas
    actualMount: number; // measured mount
    compoundDelta: number; // actual - expected (positive = super-additive)
    significance: "high" | "medium" | "low";
  }
  ```
- Add `matrixReport?: MatrixReport` to `Report`.
- **Compound effect detection**: for each cell in `hotCells`, compute expected mount as sum of individual prop deltas (from M11 `PropDelta`). If `actualMount > expectedMount * 1.5`, flag as `"high"` significance compound effect. Between 1.2× and 1.5× → `"medium"`. Below 1.2× → `"low"`.
- Terminal output in matrix mode:
  ```
  Prop Matrix (variant × size × spotlight)
  24 cells measured, 5 hottest + 1 failing shown:

  variant     size        spotlight   Mount     Rerender   Interact   DOM    Verdict
  --------    --------    ---------   -------   --------   --------   ----   -------
  primary     iconMedium  true        2.1ms     0.8ms      41.2ms     15     PASS (T2)
  secondary   large       true        1.9ms     0.7ms      38.9ms     14     PASS (T2)
  primary     medium      true        1.8ms     0.6ms      -          13     PASS (T2)
  ghost       iconLarge   true        1.7ms     0.6ms      -          12     PASS (T1)
  outline     small       false       0.4ms     0.2ms      -          6      PASS (T1)
  ghost       small       true        0.4ms     0.2ms      717.3ms    6      FAIL (T1)

  Compound effects:
    spotlight=true + size=iconMedium: +0.8ms above additive expectation (high)
  ```
  The `Interact` column shows the cell's slowest interaction, or `-` when interactions were not explored for it. The printed set is `hotCells` plus any failing cell not already among them; the count line names both parts, or reads `N hottest shown` when nothing extra was added. A cell can mount cheaply and still fail on an interaction, so showing only the hottest cells would print an all-PASS table above a `Result: FAIL`.
- Matrix mode produces `matrixReport` on the report AND still produces normal `combos[]` (the matrix cells ARE the combos). `buildMatrixReport({axes, combos, propDeltas})` **projects** the combos onto the axes: `verdict`, `tier`, and all timings are taken from the combo verbatim, never recomputed. The run-level `report.pass` derives from the same combos, so a cell verdict and the run result cannot disagree.
- `--no-matrix` CLI flag to disable auto-activation.
- `CliArgs.matrix?: boolean`.
- `CliArgs.noMatrix?: boolean`.
- `AnalyzeOptions.matrixMode?: boolean`.

### MUST NOT

- Compute a cell verdict independently of its combo. Two verdict computations over the same cell drift: the earlier one ignored interactions, the scale-combo exemption, and explicit thresholds, so a run could report `FAIL` above a table with no failing cell.
- Hand `explore()` a filtered subset of combos without restoring the indices afterwards. `explore()` numbers results by position in the array it receives, so the hot-cell subset returns 0..4 and those interactions attach to cells 0..4 rather than the cells actually measured. Matrix mode maps through `restoreComboIndices(results, hotIndices)`.
- Drop `explicitThresholds` when building the matrix report. Tiered budgets are the default, and a threshold the user typed must override the tier's in matrix mode exactly as it does in the standard pipeline.
- Run matrix mode on components with 0 or 1 variant-like props (unless `--matrix` is explicit).
- Exceed 256 cells. The pairwise covering array ensures bounded measurement time.
- Skip non-matrix props entirely — they are present at anchor value in every cell.
- Break existing delta analysis. Matrix mode and delta analysis can coexist (deltas computed from the anchor cell against each single-prop-flip cell in the matrix).
- Change combo generation for normal mode. Matrix mode replaces the combo pipeline only when active.

### Invariants

- All cells use the same CDP tracing, calibration, warmup, sample count.
- Cell order is deterministic (sorted by prop values lexicographically).
- `hotCells` is always the top 5 by `mount.median` descending. `coldCells` is the bottom 3. Neither is filtered by verdict.
- `cell.verdict === combos[cell.comboIndex].verdict` for every cell.
- `failingCells` contains exactly the cells whose verdict is `"fail"`, in cell order.
- `report.pass === false` implies `failingCells.length > 0`, and every failing cell is printed.
- A cell's `worstInteractionMs` is the max interaction median on its combo, or `null` when that combo has no interactions.
- Interactions attach to the combos that were explored — the 5 hottest by mount — not to combo indices 0..4.
- `compoundEffects` is empty when there are ≤1 matrix axis.
- Compound effects require M11 delta data. If `--no-deltas` is passed AND `--matrix` is active, compound effects are omitted (individual deltas unavailable).
- All existing tests pass unchanged.

## Design

### Auto-activation heuristic

```
matrixProps = schemas.filter(s => 
  (s.kind === "union" || s.kind === "boolean") && s.values.length <= 8
)
totalCells = product(matrixProps.map(p => p.values.length))
autoActivate = matrixProps.length >= 2 && totalCells <= 64
```

### Pairwise covering array

When cartesian product > 256, use a greedy pairwise algorithm:
1. Generate all pairs (propA=valueX, propB=valueY) for all axis combinations.
2. Greedily select rows that cover the most uncovered pairs.
3. Stop when all pairs covered or 256 rows reached.

This guarantees every 2-prop interaction is tested even at reduced cell count.

### Compound effect calculation

```
for each hotCell:
  expectedMount = anchorCell.mount.median
  for each prop P where hotCell[P] != anchor[P]:
    delta = propDeltas.find(d => d.propName === P && d.flipValue === hotCell[P])
    expectedMount += delta.mountDelta
  compoundDelta = hotCell.mount.median - expectedMount
  significance = compoundDelta > expectedMount * 0.5 ? "high"
               : compoundDelta > expectedMount * 0.2 ? "medium" : "low"
```

### Integration with normal pipeline

Matrix mode replaces `generateCombinations()` with `generatePropMatrix()`. The resulting combos feed into the same `measureMount`, `measureRerender`, `explore` pipeline. Interactions are explored only for the 5 hottest cells by mount, to keep runtime bounded.

Order of construction matters:

1. Measure mounts and rerenders for every cell.
2. Pick the 5 hottest by mount median; keep their combo indices.
3. `explore()` those 5, then `restoreComboIndices(results, hotIndices)` — `explore()` numbers results by position in the array it was given, so without this step interactions attach to cells 0..4.
4. `buildReport(...)` with those explores and `explicitThresholds`, producing `combos[]` with verdicts that account for interactions.
5. `buildMatrixReport({axes, combos: report.combos, propDeltas})` — a pure projection, assigned onto `report.matrixReport`.

The matrix report is built from the finished combos, not alongside them, which is what keeps cell verdicts and `report.pass` in agreement.

## Open questions

1. Should interactions be explored for all cells or only hot cells? Decision: only `hotCells` (top 5) get interaction exploration. Others get mount/rerender/unmount only. This caps runtime at 5× explore cost regardless of matrix size.
2. Memory per cell: should heap be measured? Decision: no — matrix is about variant cost comparison, not memory. Heap measurement is in M20 (curve) and M23 (isolated).

## Test count

86 unit tests: matrix-cli (8), matrix-gen (26), matrix-report (16), matrix-build (17), matrix-harden (19). Plus 4 e2e tests in `test/e2e/analyze.test.ts` covering interaction attribution, cell/combo verdict agreement, explicit thresholds under tiered budgets, and failing-cell reachability.
