---
kind: milestone
status: approved
tests:
  - test/unit/matrix-axis-coverage.test.ts
  - test/unit/mode-prediction-parity.test.ts
  - test/unit/matrix-cell-selection.test.ts
  - test/unit/scale-probes-are-not-prop-combos.test.ts
  - test/unit/curve-empty-render-point.test.ts
  - test/unit/render-attribution-across-modes.test.ts
---

# M104: modes measure what they say they measure

## Purpose

Lane C (+ I10 in Lane B, I11 in Lane A). Closes: twenty-F3, dub-F1, dub-F5, dub-F7 (with M103),
commerce-F1, commerce-F2, commerce-F3 (I11), material-ui-F3 (I11).

Each mode prints a header that describes what it measured. Four of those descriptions were wrong in
a way the reader cannot detect from the output alone:

- **twenty-F3.** `Modal.tsx --matrix --max-combos 2` printed `Prop Matrix (isOpen × …)` and measured
  two cells that both carried `isOpen: false`, the state the tool itself then reported as rendering
  nothing — `Result: PASS` over zero informative renders. The header names an axis that was never
  crossed.
- **dub-F5.** A Badge combo run's footer said `2 of 12 combos warned` two lines above its own
  `measured 8 of 64 prop combos`. Twelve is eight prop combos plus four sibling-copies scale probes,
  which are not prop combos and are already excluded from the mode line (`report.ts:1596`).
- **commerce-F1.** Gallery and VariantSelector auto-activated curve mode, and curve mode never runs
  the React analysis pass at all, so the 3-level `Gallery → GridTileImage → Label → Price` fan-out
  that combo-mode siblings disclose in full was absent from console and JSON alike, with no note that
  the pass had been skipped. `--no-react-analysis` exists and defaults to off, so its silence reads
  as "nothing found".
- **commerce-F2.** VariantSelector's curve `N=1` row measured a `return null` (the component's own
  `hasNoOptionsOrJustOneOption` short-circuit) and was fitted as an ordinary point under
  `Growth: mount linear, rerender linear`, with only a raw `DOM 0` cell to give it away.

## Contract

### MUST

- Matrix: the anchor cell is kept under every `--max-combos` (I10); non-axis props sit at their
  declared default or are absent (dub Switch's `disabledTooltip` is not held truthy); the report
  header says which axes were actually crossed and which were held at one value.
- `combos[]` holds prop combos only; scale probes carry `scaleProbe: N` and are excluded from every
  "N of M combos" count; the footer and the `--max-combos` warning agree.
- Render attribution prints in curve and matrix modes whenever a React profiler snapshot exists,
  with the same section as combo mode.
- A curve point with `domNodeCount === 0` is tagged `renders nothing at N=…` and excluded from the
  fit (disclosed), never fitted as an ordinary point.

### MUST NOT

- Change which cells or points are *measured* in order to make a header true (the selection MUSTs
  above are I10's, implemented in Lane B's `src/prop-gen-values.ts`); the report states what the
  selection did.
- Drop a zero-DOM point from the report, from JSON, or from the verdict — only from the fit.

### Invariants

- A count printed anywhere in a run agrees with every other count in the same run: one derivation
  ("prop combos" = `combos.filter(c => c.scaleProbe === undefined)`), read by the mode line, the
  warn rollup, and the cap warning alike.
- A curve whose every point renders nothing keeps every point in the fit, because excluding all of
  them would leave nothing to fit. **Superseded in part by M106 C3**, which is the later decision and
  the one the code follows: such a run now fails, carries
  `CURVE_ALL_POINTS_EMPTY_WARNING`, and gets the `curveRenderedNothing` hint instead of `domFlat`
  (whose remedy names the scaling prop, the wrong thing when nothing rendered at any N). Exit code is
  1, matching a combo-mode run whose every combo failed.
- A single curve point with `domNodeCount === 0` mirrors combo mode's zero-DOM rule: nothing rendered
  and nothing threw is `empty` and legal, so the point is tagged and excluded from the fit but does
  not fail the run on its own; nothing rendered while the page reported something is a broken point
  and fails it, exactly as `renderHealth: "error"` does on a combo.

## Where matrix cell selection lives (I10 finding)

`selectMatrixCombos`, `generatePropMatrix`, `pairwiseCover` and `shouldAutoActivateMatrix` are all in
**`src/prop-gen-values.ts`** (`:520`, `:367`, `:418`, `:355`) — a **Lane B** file. `runMatrixMode`
(`analyze.ts:1260`) only calls them. Lane C therefore implements the report half and states the rest
as an interface request (see `## open` in the run report). Two of I10's three MUSTs were checked
directly against the code:

- **Anchor kept: already true.** `selectMatrixCombos` (`prop-gen-values.ts:520-541`) ranks cells by
  Hamming distance from the all-first-value anchor and takes the first `max`, so the distance-0 cell
  survives every cap down to `--max-combos 1`.
- **twenty-F3's real defect is which cell the anchor is, and which deviation is kept next.** For a
  required `isOpen: boolean` with no default, `matrixValues` (`prop-gen-values.ts:361`) returns
  `[false, true]` and the anchor is therefore `isOpen: false`. With two axes and `--max-combos 2`,
  the one kept deviation is cartesian index 1, which varies the *last* axis (`matrixCartesian`
  increments the last axis fastest), so the first axis is never crossed at that cap. Both facts are
  Lane B's to change; what Lane C can make true is that the header stops claiming the axis was
  crossed.
- **Non-axis props held truthy (dub-F1): Lane B.** `generatePropMatrix` (`prop-gen-values.ts:371-375`)
  assigns `resolveAnchorValue(s)` to every non-eligible schema, which is what fixes
  `disabledTooltip: "120fps-placeholder"` into every cell of dub's Switch matrix and guarantees the
  `TooltipProvider` crash in all of them.

## Lane B: cell selection (I10)

Implemented in `src/prop-gen-values.ts`; the report half above states what this selection did.

### MUST

- The anchor cell is present in the generated cell set under every generation path, including
  `pairwiseCover`, and is kept under every `--max-combos` value down to 1.
- A prop the matrix does not vary holds the default the component declares, or is absent from the
  cell. "Absent" is for a **synthesized stand-in** only — the `placeholder`/`heuristic`/`contract`
  value dub-F1 named. Four classes stay present: a *required* prop (an absent required prop is a
  guaranteed crash, M86), a prop with a declared default, a prop whose value came from
  `<stem>.props.tsx` (`provenance: "preset"` — the user named that value, and M98 exists to make it
  measurable), and a content slot (`children`, `label`, or any `reactnode`/`string` prop whose value
  is `provenance: "declared"`). Dropping content made matrix mode measure a component with no
  content while combo mode still measured it, so the two modes disagreed about the same component.
- The non-axis props that *were* held absent are published as `matrixHeldAbsentProps(schemas):
  string[]`, so the matrix header can name them. A cell that silently lost a prop reads as a cell the
  component rendered without it.
- A cover seed is skipped when the axis has fewer than two values, or when its second value is
  literally `undefined` — that is the prop's own absence, not a deviation worth a cell of the budget.
- Deviation order at a given `--max-combos`: after the anchor, cells that flip a boolean axis whose
  anchor is falsy and whose name reads as a reveal (`/^(is|has|show|open|visible|expanded|active|enabled)/i`)
  come first, then cells that deviate on the earliest-declared axis. Cartesian order alone
  incremented the *last* axis fastest, so the first axis was never crossed at a small cap
  (twenty-F3) and dub Badge's `variant` — its only own prop, and axis 0 after M103's ranking — was
  never the kept deviation (dub-F7).
- `matrixValues` is exported, so `runMatrixMode` derives its declared axis values from the same
  function that generates the cells instead of a second inline copy of the predicate.
- A literal union is matrix-eligible whatever its arity. dub's Badge declares `variant` with twelve
  values, and the old 1..8 window excluded the component's only own prop while thirteen inherited
  `<span>` attributes were crossed (dub-F7). An over-wide union is crossed over a truncated value
  set: the anchor (the declared default when the component names one, else the first declared value)
  plus the next declared values in declaration order, up to `MAX_MATRIX_AXIS_VALUES` (8). The
  cell-count bound is unchanged, because `matrixValueCount` caps at 8 as well.
- The truncation is disclosable per axis rather than presented as the whole contract:
  `matrixAxesFor(schemas): MatrixAxisValues[]` returns `{ propName, values, declaredValues,
  measuredValues }`, where `values === measuredValues` (so it satisfies `MatrixAxisLike`) and
  `declaredValues` is every value the schema declares.
- The cover path guarantees the same deviations the cartesian path does: `pairwiseCover` is seeded
  with the anchor plus one single-axis deviation per axis before greedy pair filling, so a
  distance-1 cell exists for every axis however wide the matrix is.
- Breadth before depth at a small cap: one cell per axis is kept before a second cell of any axis
  already crossed. A 3-value union axis contributes two single-axis deviations, and taking both
  ahead of every other axis would spend the whole cap on one prop.

### MUST NOT

- Change `resolveAnchorValue`, which the delta-pair pass also uses. The non-axis rule is a separate
  function used only by `generatePropMatrix`.
- Drop an axis. Every matrix-eligible schema is still an axis; only the *order* of the kept cells
  changes.

### Why dub-F7's axis exclusion is closed by M103, not here

`variant` was never excluded by axis selection: every eligible schema becomes an axis. It was
excluded by the 32-prop cap upstream — `--explain-props` on `packages/ui/src/badge.tsx` did not list
it either. M103's rank table puts it second in the schema, so it is now axis 0, and the deviation
rule above makes it the kept deviation at `--max-combos 2`.

### Lane B evidence

**Why the first I10 attempt did not close twenty-F3.** Modal has ten eligible axes, so the cell
count passes `MAX_MATRIX_CELLS` and `generatePropMatrix` builds the set through `pairwiseCover`.
Greedy pair-covering rows differ from the anchor on many axes at once, so the set contained no
distance-1 cell at all and the `(distance, reveal, …)` ordering had no candidate to promote — both
kept cells still carried `isOpen: false`. Seeding the cover with the anchor plus one single-axis
deviation per axis makes the two generation paths equivalent for this purpose. A second defect
surfaced while testing the seeded cover: `size` is a 3-value union, so it owns two distance-1 cells,
and a pure sort by `(reveal, axisIndex)` kept both of them ahead of every later axis. Selection is
now one cell per axis first, remainder after.

Real: `cd /e/repositories/dub && node .../cli.js packages/ui/src/badge.tsx --matrix --samples 3
--max-combos 4 --explore-budget 20` (`logs/fix-b-dub-badge-matrix.log`, exit 0). Before: thirteen
inherited `<span>` axes and no `variant`. Now:

    Prop Matrix (variant x defaultChecked x suppressContentEditableWarning x ...)
    Axes crossed: variant: 2 of 12 values crossed, defaultChecked, suppressContentEditableWarning.

`pnpm vitest run test/unit/matrix-cell-selection.test.ts` — 38 passed, including the review's B-1
cases (a preset value, `children`, a declared `label` and a declared `reactnode` prop all survive in
every cell; a `placeholder`-provenance `disabledTooltip` still does not) and B-12 (the seed skips an
axis whose second value is `undefined`). The Modal-shaped case
(`size`, `overlay`, `isOpen`, `padding`; `isOpen` required boolean, no default) keeps
`[anchor, isOpen=true]` at `--max-combos 2`. The dub-Switch-shaped case (`checked`, `loading`,
`disabled` as axes; `disabledTooltip` an optional `reactnode` with no declared default) produces
cells with no `disabledTooltip` key at all, where every cell previously carried
`"120fps-placeholder"`. The wide Modal-shaped case (ten eligible axes, product 6144 > 256, so the
cover path) asserts the anchor is present, a single-axis deviation exists for every axis, no cell is
duplicated, `--max-combos 2` keeps `[anchor, isOpen=true]`, and every per-axis deviation survives
once the cap allows them.

Real: `cd /e/repositories/twenty && node /c/Projekte/120fps/dist/cli.js
packages/twenty-ui/src/surfaces/Modal/Modal.tsx --matrix --max-combos 2 --samples 3
--explore-budget 20` (`logs/fix-b-twenty-modal.log`). Before: two cells that both carried
`isOpen: false` and `Result: PASS` over zero informative renders. Now:

```
Prop Matrix (isOpen × size × padding × overlay × isMobile × isInContainer × smallBorderRadius × narrowWidth × autoHeight × preventClickOutside)
2 cells measured, 2 hottest shown:
Axes crossed: isOpen. Held at one value (not crossed at this cell cap): size=small, padding=small,
overlay=light, isMobile=false, isInContainer=false, smallBorderRadius=false, narrowWidth=false, …
```

JSON: `combos[0].props.isOpen === false` (`domNodeCount 0`), `combos[1].props.isOpen === true`
(`domNodeCount 8`) — the modal is actually opened and measured. `Result: FAIL` is a real budget
crossing on the cell that renders, not the empty-render `PASS` the finding reported. Cleanup:
`120fps-report.json` removed, no `.120fps-harness-*`, `git status --porcelain` empty.

## Design

### Matrix axis coverage (report.ts)

`buildMatrixReport` derives, per declared axis, the distinct values actually present across the
measured cells, and publishes `MatrixReport.axisCoverage: Array<{ propName; declaredValues;
measuredValues; heldValue? }>`. `formatMatrixOutput` prints one extra line whenever some axis was not
crossed:

```
Prop Matrix (isOpen × size)
2 cells measured, 2 hottest shown:
Axes crossed: size. Held at one value (not crossed at this cell cap): isOpen=false.
```

The line is absent when every declared axis varies, so a full matrix's output is unchanged.

### One derivation for "prop combos"

- `appendWarnRollup` (`report.ts:978`) counted `report.combos.length`, scale probes included, which
  is what produced dub-F5's `2 of 12`. It now counts prop combos only, the same filter
  `describeMode` (`report.ts:1596`) already applies. Matrix mode's `cells` call site is unaffected
  (a cell is never a scale probe).
- `buildReport`'s tier pass tested `"__120fps_scaleN" in combo.props` (`analyze.ts:638`) to find
  scale probes, but `combo.props` has had that key stripped since M61 (`analyze.ts:564`), so the
  test was dead and M59's documented exemption ("the synthetic scale probe is exempt from budgets,
  never from rendering") had silently stopped applying: every scale probe was being judged against a
  prop-combo tier budget. It reads `combo.scaleProbe !== undefined`, the field M61 introduced for
  exactly this identity.

### React analysis in curve and matrix modes

The React Optimizations block was written inline inside `formatTable` (`report.ts:772-810`), reachable
only from combo mode. It is extracted into `appendReactSection(lines, entries)` where an entry is
`{ label, opts }` — no wording change, same order, same three-item cap on render attribution — and
called from all three formatters.

- **Matrix**: `runMatrixMode` runs the same `runReactAnalysis` pass `runComboMode` runs, over the
  matrix cells, and attaches the results to `report.combos` (matrix cells *are* combos, M21).
  `formatMatrixOutput` calls `appendReactSection`.
- **Curve**: `runCurveMode` runs the pass over its scale combos, and each result is attached to its
  own point (`ScalingPoint.reactOptimizations`). `formatCurveOutput` prints the section for the
  points that have a finding, labelled `N=…` instead of `Combo #…`.

Both are gated exactly as combo mode's is (`!options.skipReactAnalysis && framework === "react"`), so
`--no-react-analysis` still skips it and a Vue run still never runs it.

### A curve point that renders nothing

`buildCurveReport` marks `ScalingPoint.rendersNothing = true` for `domNodeCount === 0` and fits the
five curves (`mount`, `rerender`, `unmount`, `domGrowth`, `heapGrowth`) over the rendering points
only, publishing the excluded N values as `ScalingCurveReport.fitExcludedPoints: number[]`. Fewer
than two rendering points means no fit is possible, so all points are kept and the report is exactly
what it is today (the `domFlat` and `renderErrorPoints` disclosures already cover that run).

The curve table tags the row (`renders nothing at N=1`) and the growth line names the exclusion in
one sentence, so "mount linear" is never printed over a fit whose composition the reader cannot see.

## Open questions

None.

## Verification

**Unit.** `test/unit/matrix-axis-coverage.test.ts` (7), `test/unit/scale-probes-are-not-prop-combos.test.ts`
(5), `test/unit/curve-empty-render-point.test.ts` (8), `test/unit/render-attribution-across-modes.test.ts`
(4) all pass. `test/unit/scale-probe-edge-cases.test.ts` H10's warn-rollup case was rewritten against
the new contract: it hand-built a report whose only `warn` sat on a scale probe, a state
`buildReport` can no longer produce (a probe is `pass` or `fail`), and asserted the rollup counted
it. `pnpm lint` clean.

**dub Badge, unbounded zero-config run (dub-F5).**

```
cd /e/repositories/dub && node /c/Projekte/120fps/dist/cli.js packages/ui/src/badge.tsx --json ...
```

```
Mode: prop combos (8 measured of 64 generated, +4 scale probes)
Result: PASS
7 of 8 combos warned; warnings do not fail the run.
⚠ measured 8 of 64 prop combos; 56 were dropped to bound the run. Raise it with --max-combos <n>.
```

The rollup denominator was `12` (8 prop combos + 4 scale probes) against the same run's own
"8 of 64"; the three counts now agree.

**twenty Modal, matrix at the protocol's cap (twenty-F3).**

```
cd /e/repositories/twenty && node /c/Projekte/120fps/dist/cli.js \
  packages/twenty-ui/src/surfaces/Modal/Modal.tsx --matrix --samples 3 --max-combos 2 \
  --explore-budget 30 --json ...                                            # EXIT=0
```

```
Prop Matrix (isOpen × size × padding × overlay × isMobile × isInContainer × smallBorderRadius × narrowWidth × autoHeight × preventClickOutside)
2 cells measured, 2 hottest shown:
Axes crossed: size, overlay. Held at one value (not crossed at this cell cap): isOpen=false,
padding=small, isMobile=false, isInContainer=false, smallBorderRadius=false, narrowWidth=false,
autoHeight=false, preventClickOutside=false.
```

The header claimed ten crossed axes over two cells. It now names the two that varied and the eight
that did not, `isOpen=false` among them — the fact the reader had to derive from the JSON before.

Re-run after Lane B landed I10 (`selectMatrixCombos` ordering `(distance, reveal,
firstDeviatingAxisIndex, index)`, meant to cross a reveal-shaped boolean like `isOpen` first): the
line is **unchanged**, `isOpen` is still held at `false` and the two kept cells differ on `size` and
`overlay` together. Ten eligible axes put the cell count past `MAX_MATRIX_CELLS`, so
`generatePropMatrix` builds the set through `pairwiseCover` rather than a cartesian product, and that
set need not contain any distance-1 cell for the reveal axis to be preferred over. Recorded as
observed; the selection half is Lane B's (see the run report's `## open`). What M104 owns — that the
header stops claiming ten crossed axes — holds either way.

**commerce Gallery, curve mode (commerce-F1).**

```
cd /e/repositories/commerce && node /c/Projekte/120fps/dist/cli.js components/product/gallery.tsx \
  --samples 3 --max-combos 2 --explore-budget 30 --json ...
```

```
React Optimizations
  N=1:
  Render attribution:
    Gallery: 0.2ms self (1 renders)
    Image2: 0.2ms self (1 renders)
  ...
  N=50:
  Render attribution:
    ul: 18.9ms self (1 renders)
    Gallery: 0.9ms self (1 renders)
```

`grep -c reactOptimizations` on the previous run's JSON was 0 for this component in all three modes.

**commerce VariantSelector, curve N=1 (commerce-F2).**

```
1      2.56ms  1.37ms  0.86ms  0    +-598KB  [renders nothing at N=1]
3      9.89ms  3.29ms  1.41ms  15   +85KB
...
Growth: mount linear, rerender linear
  fitted over the points that rendered; N=1 rendered 0 DOM nodes and is excluded.
```

Both runs end `Result: FAIL` on a genuine mount-budget crossing at N=50 on a hostile machine
(`Mount crosses its 50.00ms budget between N=20 and N=50`), unrelated to this milestone.

Cleanup: no `.120fps-harness-*`, `120fps-report*.json` or `git status` entry left in dub, twenty or
commerce.
