---
kind: milestone
status: draft
tests:
  - test/unit/verdict-report-clarity-harden.test.ts
  - test/unit/page-errors.test.ts
  - test/unit/isolation-orchestrate-harden.test.ts
  - test/unit/matrix-transparency.test.ts
  - test/unit/dx-features-harden.test.ts
  - test/unit/style-engine-detection.test.ts
  - test/unit/harness-sweep.test.ts
  - test/unit/fixture-harden.test.ts
  - test/unit/project-transforms.test.ts
---

# M83: modes and flags never lie about what ran

## Goal

A flag either does what it says or says it did not, and a report never contradicts itself.
Eight defects, all surfaced only in the handful of field-test repositories whose runs completed
far enough to expose them (`C:\Projekte\120fps-fieldtest\findings\*.md`, 2026-08-20 field test).
Per `specs/milestones/M76-M83-MAP.md`, this milestone owns parity between what a flag promises and
what ran, plus report self-consistency; it does not own preflight gates (M78) or the failure path
(M79). It continues M64's line of work ("report statements match what actually happened") and
must not contradict it, and it continues M54's precedent that a mode conflict is disclosed with a
warning, not silently resolved.

The sharpest instance: element-plus's `button.vue` full run (`findings/element-plus.md` F2)
reports `DOM 0` on all 8 discrete prop combos and asserts in prose "the component renders nothing
for these props" — while the *same run's* scale-probe rows (`×1 copies` … `×50 copies`), printed
in the same table two lines below, report correct nonzero DOM counts for the identical component.
Read from source (`src/analyze.ts:380` `buildReport`, `src/report.ts:138` `ComboReport`), both rows
live in the exact same `combos: ComboReport[]` array and are produced by the exact same
`domNodeCount` computation (`src/measure.ts:56` `countComponentNodes`, called once per combo at
`src/measure.ts:1114` regardless of whether the combo carries a real prop variation or the M61
sibling-copies scale probe). There are not "two measurement code paths" here to reconcile — there
is one path and no check that a combo's own report agrees with its siblings before the report
asserts a categorical claim about the whole component.

## Scope

### 1. Report self-consistency: a DOM-count disagreement within one run is reportable, not asserted away

`src/report.ts:765` `appendEmptyRenderNote` prints `"Combo #N … the component renders nothing for
these props"` whenever `report.combos` contains any entry with `renderHealth === "empty"`
(`src/analyze.ts:477`: set per-combo when `domNodeCount === 0` and no page error fired). It never
checks whether another combo in the *same* `report.combos` array — including a scale-probe combo
(`combo.scaleProbe !== undefined`, `src/report.ts:171-175`) — measured a nonzero count for the same
component. Since `runComboMode` (`src/analyze.ts:1364`) always appends the scale-probe combos to
the same `combos` array used for discrete prop combos (`src/analyze.ts:1394-1395`:
`combos = [...combos, ...scaleCombos]`), the two kinds of rows are not independent phases; a
"renders nothing" claim contradicted by a sibling row in the same array is a same-run
inconsistency, not a description of two different things.

Add `detectRenderHealthInconsistency(combos: ComboReport[]): string | undefined` in `src/report.ts`,
next to `appendEmptyRenderNote`. It returns a `RENDER_HEALTH_INCONSISTENT_WARNING` message when the
array contains at least one combo with `renderHealth === "empty"` and at least one other combo with
`domNodeCount > 0`; otherwise `undefined`. Two consumers, one detector:

- `buildReport` (`src/analyze.ts:380`, right after the per-combo `for` loop closes at
  `src/analyze.ts:485`, before the scale-probe curve-fit block) calls it and, when it returns a
  message, pushes it onto the run's warnings the same way every other `buildReport`-time warning
  reaches `report.warnings` — so the JSON report carries the caveat, not only the terminal text.
- `appendEmptyRenderNote` (`src/report.ts:765-773`) calls it to decide its own phrasing: when
  inconsistent, it names the specific empty and nonzero combo indices and states the disagreement
  instead of asserting "the component renders nothing for these props" as settled fact.

`combo.renderHealth` itself is unchanged: it stays a fact about that one combo's own measurement.
Nothing here claims to know *why* button.vue's discrete combos undercounted — establishing that
would require dynamically reproducing the harness, which is out of reach from source reading alone;
per the milestone brief's own allowance, the fix is scoped to detection and disclosure.

`RENDER_HEALTH_INCONSISTENT_WARNING(emptyIndices: number[], nonEmptyIndices: number[]): string`:
`"combo(s) #<emptyIndices> rendered 0 DOM nodes while combo(s) #<nonEmptyIndices> rendered a
nonzero count in the same run: this disagreement was not resolved, so it is reported rather than
asserted as 'the component renders nothing'."`

### 2. The harness must not blame the component for its own noise

element-plus's `avatar.vue` (`findings/element-plus.md` F3) earns WARN on 5 of 8 combos from a
repeated 404 to `http://localhost:5177/.120fps-harness-KAGFHv/test`. The field test's own
hypothesis — "120fps's own dev-server scaffolding polling something" — does not hold up: read from
source, `.120fps-harness-*` (`src/harness.ts:212`, `createHarnessDir`) contains exactly two files
120fps itself writes, `entry.tsx` and `index.html` (`src/harness.ts:1525-1526`), and nothing in
`src/harness.ts` or `src/measure.ts` ever requests a path named `test` under it.

The real mechanism, verified against the actual repo (`C:\Projekte\120fps-fieldtest\repos\element-plus\packages\components\avatar\src\avatar.vue`):
`avatar.vue:33-36` declares `src: string` with default `''`; `avatar.vue:4` gates `<img
:src="src">` on `(src || srcSet)`. `resolveAnchorValue` (`src/prop-gen-values.ts:126-147`) returns
the literal placeholder `"test"` for any unconstrained `string`-kind prop with no enumerable values
(`:131`), and `buildAllDeltaPairs`/`generateCombinations` (`src/prop-gen-values.ts:15-66`,
`:188+`) only ever varies boolean, union, or optional-object props — a plain `string` prop like
`src` is never a delta-pair axis, so it sits at its anchor value (`"test"`) across every discrete
combo. `<img src="test">` is a real, same-origin, relative request; it resolves against the page's
own URL, which *is* the harness's Vite-served root (`src/harness.ts:1729`:
`` `http://localhost:${port}/${harnessDirName}/` ``), landing on
`.../.120fps-harness-<id>/test` and 404ing. This is 120fps's own synthesized placeholder value
colliding with 120fps's own serving root — not the component doing anything wrong, and not the
harness "polling itself" either. `page-errors.ts`'s M70 `requestfailed`/`response >= 400` listeners
(`src/page-errors.ts:88-100`) have no way to tell this apart from a genuine CSS-import 404, because
they see only a URL.

Fix: `attachPageErrorCapture` (`src/page-errors.ts:65`) gains an optional second parameter,
`harnessDirName?: string`. When a failed/4xx+ request's path is a *direct child* of
`/${harnessDirName}/` with **no further subdirectory and no file extension** on its final segment
(a bare, extension-less filename resolved directly under the harness root), the message is not
passed to `session.record`/`segment.record` — it never reaches per-combo page-error attribution.
Export the predicate as `isHarnessInternalNoise(url: string, harnessDirName: string): boolean` for
unit testing without a browser, matching the existing testable-predicate style
(`hasPageErrors`, `src/page-errors.ts:150`). This rule is deliberately narrow: every legitimate
asset request the harness serves — the component's own source (`/src/...`), Vite's own paths
(`/@vite/client`, `/@fs/...`, `/node_modules/.vite/deps/...`), and any real CSS/JS/image import —
either carries a file extension or a directory prefix, so a genuine CSS-import 404 (what M70 exists
to surface) is never excluded by this rule; only a bare, unextended, direct-child request is, which
is exactly the shape a relative string value resolves to.

`harnessDirName` is already computed once per harness build (`src/harness.ts:1466`:
`path.basename(harnessDir)`) and is available on `HarnessResult` via `harnessDir`
(`src/harness.ts:116`). Thread `path.basename(harness.harnessDir)` into
`attachPageErrorCapture`'s four call sites (`src/measure.ts:641`, `:667`, `src/explorer.ts:461`,
`src/react-profiler.ts:772`) the same way `onWarning` is already threaded through these exact
functions (M70) — as an added field on the existing options objects (`MeasureOptions`,
`ExploreOptions`, `ReactAnalysisOptions`), not a new parameter shape.

### 3. A verdict must respect the tool's own noise classification

element-plus's `button-group.vue` under `--isolate memory` (`findings/element-plus.md` F4) prints
`Leak suspected: YES` / `Result: FAIL` in the same run that prints `machine: hostile (probe CV 33%,
0% of metrics unstable)`. The "0% of metrics unstable" is itself explained by source:
`attachHarnessContext`'s noise computation (`src/analyze.ts:2117-2141`) derives `unstableFraction`
from `report.combos`, and isolation-mode reports always set `combos: []`
(`src/analyze.ts:807`), so `unstableFraction` is structurally always 0 for an isolation run —
`probeCv` alone crosses `HOSTILE_CV_PERCENT` (`src/noise.ts:27`, 30%) to classify the run hostile.

The structural bug is ordering, not just a missing check: `report.pass =
computeIsolationVerdict(run.isolation, mountBudgetMs)` is assigned at `src/analyze.ts:809`, and
`report.noise` does not exist until `ctx.attachHarnessContext(report)` runs at
`src/analyze.ts:826` — seventeen lines later in the same function
(`runIsolationMode`, `src/analyze.ts:750`). `computeIsolationVerdict`
(`src/isolation.ts:481-493`) has no way to read a noise level that has not been computed yet, and
its memory branch (`:488`: `if (isolation.memory?.leakSuspected) return false;`) is a bare
threshold from `buildMemoryReport` (`src/isolation.ts:156-173`, `leakSuspected: heapGrowthPerCycle
> LEAK_BYTES_PER_CYCLE`) with no noise input at all. Per M46's own precedent (hostile runs skip
baseline comparison entirely; `specs/overview/02-milestones.md` M46), the parallel treatment here
is: a hostile run's leak signal does not unilaterally fail the run.

Fix, both in `runIsolationMode` (`src/analyze.ts:750-858`):

- Reorder: build the `report` object with a placeholder `pass` value, call
  `ctx.attachHarnessContext(report)` first (populating `report.noise`), then compute and assign
  `report.pass = computeIsolationVerdict(run.isolation, mountBudgetMs, report.noise?.level)`
  afterward. `Report.pass` is already mutated after construction elsewhere in this codebase
  (e.g. `report.matrixReport = ...` at `src/analyze.ts:1158`), so this is not a new pattern.
- `computeIsolationVerdict` (`src/isolation.ts:481`) gains a third, optional parameter,
  `noiseLevel?: NoiseLevel` (imported from `src/noise.ts:4`). The memory branch becomes:
  `if (isolation.memory?.leakSuspected && noiseLevel !== "hostile") return false;`. Only
  `"hostile"` suppresses the flip — `"noisy"` still fails, mirroring M46's own two-tier split
  (noisy warns and still compares; only hostile skips the comparison outright).
- When suppression applies (`leakSuspected && noiseLevel === "hostile"`), push
  `LEAK_VERDICT_NOISE_QUALIFIED_WARNING(noise.signals.probeCv)` onto `report.warnings` so the raw
  signal (`isolation.memory.leakSuspected: true`, unchanged) is never hidden — only the FAIL
  rollup is withheld, and the report says why.

`LEAK_VERDICT_NOISE_QUALIFIED_WARNING(cvPercent: number): string`: `"leak suspected (heap growth
crossed the per-cycle threshold), but this run's machine noise was hostile (probe CV
<cvPercent>%): the FAIL this would otherwise cause is withheld until a quieter run confirms it."`

This is a coupling, not a retraction: `element-plus-F4` was recorded tentative (no heap snapshot
taken), and this milestone does not claim the leak was false — it specifies that a run the tool's
own sentinel calls hostile does not get to also assert a confident FAIL from the same run.

### 4. A flag never silently no-ops

General rule: when an explicit flag cannot take effect because of how the run resolved, the run
says so in `report.warnings`. Three instances, all sharing this one rule:

**4a. `--matrix` silently no-ops under auto-activated curve mode (twenty-F6).** In
`analyze`'s mode dispatch (`src/analyze.ts:2378-2404`), the curve check runs first and
returns unconditionally on any match — including an *auto-detected* one — before the matrix branch
ever inspects `options.matrixMode`:

```
const curveMatch = await resolveCurveMatch(ctx);      // src/analyze.ts:2379
if (curveMatch) {
  progress(`mode: curve on ${curveMatch.schema.name}`);
  return await runCurveMode(ctx, curveMatch);           // returns here — matrix is never checked
}
// --- Matrix mode check --- (src/analyze.ts:2386, unreached when curveMatch is truthy)
```

`src/cli.ts:612` already rejects an *explicit* `--curve` combined with an explicit `--matrix` as a
usage error, so by the time this code runs, a truthy `curveMatch` here can only be an
auto-detection (`resolveCurveMatch`, `src/analyze.ts:869-908`) — the explicit-`--curve` case
already errored at parse time. The gap is exactly: `--matrix` explicit + curve auto-activates.

Fix: immediately before returning `runCurveMode` at `src/analyze.ts:2381-2383`, check
`options.matrixMode === true` (the same explicit-request check already used at
`src/analyze.ts:2393`). When true, push `MATRIX_SUPPRESSED_BY_CURVE_WARNING(curveMatch.schema.name)`
onto `ctx.runWarnings` before returning — `runCurveMode` already calls
`ctx.attachHarnessContext(report)` (`src/analyze.ts:1004`), which flushes `runWarnings` into
`report.warnings`, so no new plumbing is needed.

`MATRIX_SUPPRESSED_BY_CURVE_WARNING(propName: string): string`: `"--matrix did not activate: curve
mode auto-activated on <propName> first, and a run is one whole-run mode or the other. Re-run with
--no-curve to force matrix instead."`

**4b. `--framework vanilla` has no effect on mount for `.tsx` (preact-app-F4).**
`rendererFor` (`src/harness.ts:27-28`: `isVueFile(filePath) ? "vue" : "react"`) decides which
mount template the harness generates and is purely extension-based; it never reads
`--framework`. `resolveFramework` (`src/analyze.ts:2562-2570`) *already* computes this same
extension check inline (`isVueFile(componentPath)`) to decide whether to force `"vue"` regardless
of the requested mode — so an explicit `--framework react` on a `.vue` file is *also* silently
discarded today, by the same code, not just the vanilla-on-tsx case `--help` was tested against.
`--help` (`src/cli.ts:711`) describes `--framework <react|vue|vanilla|auto>` as "Framework
detection mode" with no scope note; in reality the flag only ever affects which *post-mount
analysis* pass runs (`shouldRunReact = ctx.framework === "react"`, `src/analyze.ts:1512`), never
which mount template is used.

Fix: `resolveFramework` (`src/analyze.ts:2562-2570`) computes what will actually mount using the
exact same extension check it already performs, compares it against an explicit (non-`"auto"`)
request, and warns on mismatch before returning:

```ts
export function resolveFramework(
  mode: "react" | "vue" | "vanilla" | "auto",
  projectRoot: string,
  componentPath?: string,
  onWarning?: (warning: string) => void,
): "react" | "vue" | "vanilla" {
  const mounts = componentPath && isVueFile(componentPath) ? "vue" : "react";
  if (mode !== "auto" && mode !== mounts) {
    onWarning?.(FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING(mode, mounts));
  }
  if (componentPath && isVueFile(componentPath)) return "vue";
  return mode === "auto" ? detectFramework(projectRoot, onWarning) : mode;
}
```

`onWarning` here is already wired to `frameworkWarnings` (`src/analyze.ts:2018-2021`), which already
seeds `runWarnings` (`src/analyze.ts:2042`) — zero new plumbing. This covers both directions:
`--framework vanilla`/`vue` on a non-`.vue` file (mounts react anyway; the flag still affects
analysis dispatch, which the warning should name) and `--framework react` on a `.vue` file (mounts
vue anyway, and `ctx.framework` itself is also force-reset to `"vue"`, so the flag has no effect at
all there). `mode === "auto"` is exempted, preserving today's silent auto-detection.

`FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING(requested: string, mounts: string): string`: `"--framework
<requested> does not change how this file mounts: a component always mounts by its file extension
(this file mounts as <mounts>). The flag only selects which post-mount analysis pass runs."`

**4c. `--matrix` with no crossable axis degenerates to a blank `Prop Matrix ()` (commerce-F5).**
`shouldAutoActivateMatrix` (`src/prop-gen-values.ts:340-345`) requires at least 2 eligible
(boolean or small-union) props before auto-activating, but an *explicit* `--matrix`
(`options.matrixMode === true`, `src/analyze.ts:2393-2394`) bypasses that check entirely
(`activateMatrix = true` unconditionally). `runMatrixMode` (`src/analyze.ts:1011-1020`) then
computes `matrixAxes` with the same eligibility filter and, for a component like `price.tsx`
(only plain-`string` props, zero eligible axes), gets an empty array. `formatMatrixOutput`
(`src/report.ts:1302-1314`) prints `Prop Matrix ()` — empty parens — with the single anchor-value
cell and no explanation.

Fix: in `runMatrixMode` (`src/analyze.ts:1011-1020`, right after `matrixAxes` is computed,
alongside the existing `fullMatrixCells`/`MATRIX_PAIRWISE_COVER_WARNING` check at `:1024-1027`),
push `MATRIX_NO_AXES_WARNING` onto `runWarnings` when `matrixAxes.length === 0`, following the
exact placement convention `MATRIX_BASELINE_WARNING` already uses at `src/analyze.ts:1040-1044`.

`MATRIX_NO_AXES_WARNING`: `"matrix mode found no boolean or small-union prop to cross: the single
cell shown is the anchor combo, not a real matrix. Re-run --explain-props to see why no prop
qualified as an axis."`

### 5. `--explain-props` must predict the run's mode, including the sibling-copies scale probe

base-ui's `Separator.tsx` (`findings/base-ui.md` F6): `--explain-props` prints `"Curve mode: would
not activate: no array or numeric scaling prop"` and the actual run auto-activates a *different*
mechanism than the one that line is even about — the M61 sibling-copies scale probe (`×1 copies`
… `×50 copies` rows, a `scalingCurve`/`Growth:` result). Read from source, these are two unrelated
mechanisms sharing one dry-run line:

- The "Curve mode: would (not) activate" line (`src/analyze.ts:1763-1767`,
  `formatExplainProps`) is driven by `detectScalingProps(schemas)[0]`
  (`src/analyze.ts:1679`) — the exact same function `resolveCurveMatch`
  (`src/analyze.ts:898`) calls for the real run's *whole-run* curve-mode auto-activation. This
  prediction is correct and already matches: Separator genuinely has no array/numeric prop, so
  whole-run curve mode genuinely does not activate.
- The sibling-copies scale probe (`gateScalePoints` + `scaleCombos`,
  `src/analyze.ts:1392-1395`) is a *separate*, unconditional mechanism appended to every default
  combo-mode run (`runComboMode`, `src/analyze.ts:1364`) for any target that is not a fixture and
  not an auto-composed scene (the same `else` branch at `:1377-1396`) — regardless of whether the
  component has any array/numeric prop at all. `--explain-props` never mentions it.

Fix: `explainProps` (`src/analyze.ts:1644-1706`) computes an additional field,
`scaleProbeWillRun: boolean`, using the same gating condition `runComboMode` uses for the
non-curve path: `!isFixturePath(resolvedPath)` (`isFixturePath`, `src/analyze.ts:2576-2578`, cheap
and already exported) and no curve match (`!curveMatch`, since when curve *does* activate the
scale probe never runs — it is the curve sweep itself). Auto-composed-scene detection is not
cheaply available inside the dry run's scope; this field is therefore accurate for the common
non-fixture, non-composed case (which is what base-ui-F6 observed) and may be imprecise for an
auto-composed scene — noted below as an accepted scope limit, not silently glossed over.
`formatExplainProps` (`src/analyze.ts:1732+`) prints a second line under the existing curve line:

`"Scale probe:  would still run N=1/5/20/50 synthetic copies and report a growth class, independent of curve mode"`
(omitted only when `scaleProbeWillRun` is false).

Per the M76-M83 map, gate parity for `--explain-props`/`--no-preflight` is M78's; this is mode
*prediction* — whether the dry run's stated mode matches the real run's mode — which is this
milestone's.

### 6. A style-engine warning must be earned by the import graph, not by the manifest

twenty's `JsonDisplay.tsx` (`findings/twenty.md` F5) never imports `@linaria/react` or
`@linaria/core`, directly or transitively, yet its successful run prints the Linaria
"generates styles through a build step this harness does not run" warning. Confirmed from source:
`detectUnsupportedStyleEngines` (`src/harness.ts:663-670`) filters
`UNSUPPORTED_STYLE_ENGINES` (`src/harness.ts:655-661`: `unocss`, `@unocss/vite`, `@linaria/vite`,
`@linaria/core`, `@pandacss/dev`) purely by `isPackageAvailable(pkg, projectRoot, workspaceRoot)`
(`src/project-model.ts:165-172`) — a manifest/resolution-chain check with no reference to what the
measured component's own import graph touches.

The harness already builds exactly that import graph, for a different purpose: `scanExternalDeps`
(called at `src/harness.ts:1555-1570`) populates `externalDeps`, the list of package names the
component's (and wrapper's) resolved imports actually reach, already used to build
`optimizeDeps.include`. `unshimmedNextModules`/shim matching (`src/harness.ts:1579-1584`) already
demonstrates the precedent of checking `importedSpecifiers` instead of the manifest for a
scoped-to-this-component decision.

Fix: `resolveStyleTooling` (`src/harness.ts:728-742`) and `detectUnsupportedStyleEngines`
(`src/harness.ts:663-670`) gain a required `importedPackages: readonly string[]` parameter — the
same `externalDeps` list already computed at the call site: `resolveStyleTooling(projectRoot,
workspaceRoot)` at `src/harness.ts:1607` becomes `resolveStyleTooling(projectRoot, workspaceRoot,
externalDeps)`. `externalDeps` is already built earlier in the same function, at
`src/harness.ts:1553-1572`, so `:1607` already runs after it — no reordering needed, only the
extra argument. Its filter becomes: `UNSUPPORTED_STYLE_ENGINES.filter((pkg) =>
importedPackages.includes(pkg))` — package
availability no longer gates the warning at all; import-graph membership does. `isPackageAvailable`
is no longer called from this path.

### 7. Clean up after failure

`.120fps-harness-*` scaffold directories persist after a crashed run — observed in ant-design,
chakra-ui, dub, mantine, nuxt-ui, and cal.com (`findings/*.md`), one directory per crash,
accumulating as untracked `git status` noise. `sweepStaleHarnessDirs`
(`src/harness.ts:1795-1813`) exists and runs at the *start* of every harness build
(`src/harness.ts:1462`), but it only removes entries older than `STALE_HARNESS_MAX_AGE_MS`
(`src/harness.ts:1793`, one hour) — it cannot remove the directory the *current* run is about to
create, and a repository that is never measured again keeps the litter forever, or for up to an
hour on the next run.

The directory itself is created at `src/harness.ts:1465` (`createHarnessDir`) and populated at
`:1525-1526`. The only code that ever removes it is `cleanup` (`src/harness.ts:1734-1737`,
`fs.rmSync(harnessDir, { recursive: true, force: true })`), which is reachable *exclusively*
through the `HarnessResult` object returned at `:1739-1753` — i.e., only when `buildHarness`
succeeds all the way through. Every failure between `:1465` and the successful return (the
`bootServer()` catch at `:1719-1724`, which re-throws `VITE_START_FAILED` with **no** `rmSync`
call — the exact failure shape behind nuxt-ui F1/F2, mantine F1, dub F1, and chakra-ui F3/F4's
"Failed to start Vite dev server" messages; and any earlier throw, e.g. `assertReactDomClient`,
`SFC_NO_COMPONENT`, plugin/transform loading) leaks the directory, because `cleanup` was never
constructed or returned.

ant-design's F1 crash is a further case: a raw, unhandled Node exception (esbuild resolve failure,
`Node.js v24.15.0` uncaught-exception footer) that escapes *every* try/catch in the process, not
just the one at `:1719-1724`. Per the M76-M83 map, an uncaught build failure surviving to the
process boundary is M79's territory ("uncaught build failures" is listed explicitly under M79); the
directory it leaves behind is this milestone's, listed verbatim as requirement 7.

Fix, two layers, covering both failure shapes:

- The `bootServer()` catch block (`src/harness.ts:1719-1724`) calls
  `fs.rmSync(harnessDir, { recursive: true, force: true })` before re-throwing — covers the common,
  caught-and-rethrown case (4 of the 6 repositories cited).
- A module-level `Set<string>` in `src/harness.ts` tracks harness directories created but not yet
  cleaned up: add `harnessDir` to the set immediately after `createHarnessDir()` returns
  (`:1465`), remove it inside `cleanup` (`:1734-1737`) and inside the new catch-block `rmSync`
  above. A single `process.on("exit", ...)` handler, registered once at module load, synchronously
  `fs.rmSync`s every directory still in the set (Node's `"exit"` event only permits synchronous
  work, which `fs.rmSync` already is, and it fires after an uncaught exception terminates the
  process, not only on a graceful return) — this is the layer that covers ant-design's raw,
  unhandled-exception case, which bypasses every try/catch in `src/harness.ts`.

### 8. Minor, folded in briefly

- **chakra-ui-F7** (default-export resolution picks `DialogRootProvider` over `DialogRoot`):
  `detectComponentExport` (`src/harness.ts:2265-2304`) resolving to the file's marked
  `export default` (`:2291-2292`) is correct per JS/TS's own semantics — Chakra's own authoring
  choice, not a resolver bug, and the existing `#ExportName` override is already the documented
  escape hatch. No change to *which* export is picked (a precedence change is a larger, riskier
  behavior change than a P3 finding justifies). Add one disclosure to `explainProps`
  (`src/analyze.ts:1644-1706`): when the resolved export's schema has a `degenerate`-flagged
  required prop (M60) and another export in the same file's `exports` list has an
  all-non-degenerate schema, append a note naming that alternative and its `#ExportName` override —
  reusing the `degenerate` flag M60 already computes per prop.
- **primevue-Minor1** (fixture suggestion offers `.tsx` for a `.vue` candidate, untested whether
  accepted): settled by reading `detectFixture` (`src/analyze.ts:2580-2592`) directly — it does
  **not** accept `.fixture.tsx` for a Vue target; it looks only for `${stem}.fixture.vue`
  (`:2585-2586`). The fixture-suggestion hint, built inline inside `formatTable`
  (`src/report.ts:710-719`, not a separately named helper) with a hardcoded
  `` `${stem}.fixture.tsx` `` at `:715-718`, is confirmed wrong for `.vue` components — it names a
  file the loader will never find. Fix: branch on `isVueFile(report.componentPath)` the same way
  `detectFixture` already does, suggesting `${stem}.fixture.vue` for a Vue target.
- **primevue-Probe1** (no disclosure when `@vitejs/plugin-vue` resolves via a hoisted transitive
  copy rather than a declared dependency): the resolution itself is correct and by design per M75
  (`isInstalledOnResolutionChain`, `src/project-model.ts:153-161`); only the disclosure is
  missing, confirmed by reading `detectProjectTransforms` (`src/harness.ts:1191-1196`), which
  calls `isPackageAvailable` — folding `isPackageDeclared || isInstalledOnResolutionChain` — with
  no record of which branch matched. Fix: `detectProjectTransforms(projectRoot, workspaceRoot?,
  onWarning?)` checks `isPackageDeclared(entry.packageName, ...)` separately for each matched entry
  and, when false (available only via the resolution-chain fallback), calls
  `onWarning?.(HOISTED_TRANSFORM_WARNING(entry.packageName))`. Its call site
  (`src/harness.ts:1620`) already has a warnings array in scope one line above
  (`transformWarnings`, `:1619`) that reaches `buildWarnings` the same way
  `loadProjectTransformPlugins`'s own `onWarning` already does two lines later (`:1623-1625`):
  pass `(w) => transformWarnings.push(w)` at the `:1620` call.
  `HOISTED_TRANSFORM_WARNING(packageName: string): string`: `"<packageName> was found via a
  hoisted transitive install, not declared in this project's own package.json; a stricter
  installer (no hoisting) would not resolve it."`

## Changed contracts

- An isolation run's `report.pass` is no longer computed before `report.noise` exists in the same
  function; `computeIsolationVerdict` takes an optional `noiseLevel` and no longer fails a run on
  `leakSuspected` alone when the run's own noise sentinel says hostile.
- `detectUnsupportedStyleEngines`/`resolveStyleTooling` no longer treat manifest/resolution-chain
  package availability as sufficient for a style-engine warning; the component's own scanned
  import graph is now required. A workspace member that declares an unsupported style engine but
  whose measured component never imports it no longer gets the warning (twenty-F5's case).
  `isPackageAvailable`-only detection for this one warning is removed; every other consumer of
  `isPackageAvailable` (transform detection, React Compiler eligibility) is unchanged.
- `attachPageErrorCapture` gains an optional `harnessDirName` parameter; a bare, extension-less
  request landing directly under the harness's own serving root no longer reaches per-combo
  page-error attribution. Every other network failure — including a real CSS/asset 404, which is
  what M70 added these listeners to catch — is unaffected.
- `resolveFramework` now calls `onWarning` on an explicit, non-`"auto"` mismatch between the
  requested framework and what the file will actually mount by extension; previously silent in
  both directions (`vanilla`/`vue` requested on a non-`.vue` file; any non-`"vue"` request on a
  `.vue` file).
- `--matrix`, explicitly requested, that loses to an auto-activated curve mode now produces a
  warning instead of a byte-identical, unacknowledged fallback to the curve run.

## Does NOT include

- Preflight gate parity across `--explain-props`/`--no-preflight` (M78) and the failure path itself
  — warnings surviving a crash, uncaught build failures, exit codes (M79). Requirement 7's
  `process.on("exit")` safety net cleans up the harness *directory* on an uncaught failure; it does
  not change how that failure's diagnostics or exit code are presented, which stays M79's.
  Ant-design's F1 raw stack trace itself is out of scope here.
- Stylesheet selection/disclosure generally (M82) and composition disclosure (M80). Requirement 6
  touches only the style-*engine* warning's attribution source, not CSS file discovery.
- Prop-synthesis correctness (M81): the `"test"` placeholder that produces requirement 2's
  harness-internal 404 is not changed here — M81 owns making synthesized values semantically
  aware (per commerce-F1's classification). This milestone only stops the resulting noise from
  being misattributed to the component.
- Config/alias resolution (M76, M77): mantine's tsconfig-paths climb and chakra's
  workspace-root `vite.config.ts` threading are not touched by this milestone.
- Changing *which* export `detectComponentExport` resolves to (chakra-ui-F7) — disclosure only, per
  scope 8.
- The ADR-scoped items in the M76-M83 map (Vue runtime-form props, the `.js`/`.ts` entry gate) —
  product decisions, not this milestone's.
- Composed/auto-composed-scene precision for requirement 5's `scaleProbeWillRun` prediction — scoped
  to the non-fixture, non-composed case, which is what base-ui-F6 observed.

## Acceptance

- A fixture component whose discrete-combo phase reports `domNodeCount: 0` for some combos and
  `domNodeCount > 0` for a scale-probe combo in the same run: the terminal output states the
  disagreement by combo index instead of asserting the component renders nothing, and
  `report.warnings` carries `RENDER_HEALTH_INCONSISTENT_WARNING`.
- A component whose only network 404 resolves to `<harness-root>/<bare-name>` with no extension:
  that 404 does not appear in any combo's `pageErrors`, and does not affect that combo's verdict.
  A component whose CSS import genuinely 404s (a path with an extension) still surfaces it,
  unchanged from M70.
- A memory-isolation fixture run classified `machine: hostile` with `leakSuspected: true`:
  `report.pass` is not forced to `false` by the leak alone, `isolation.memory.leakSuspected` is
  still `true` in the JSON, and `report.warnings` names the noise-qualified suppression. The same
  fixture under a `machine: quiet`/`noisy` classification still fails on `leakSuspected`.
- A fixture with an array/numeric-scaling-eligible prop under `--matrix`: the run auto-activates
  curve mode (unchanged) and `report.warnings` contains `MATRIX_SUPPRESSED_BY_CURVE_WARNING`
  naming the prop that won.
- A fixture with zero boolean/small-union props under `--matrix`: `report.warnings` contains
  `MATRIX_NO_AXES_WARNING`; the 1-cell result is unchanged.
- `--framework vanilla` on a `.tsx` fixture: the harness still mounts via React (unchanged), React
  analysis is still skipped (unchanged), and `report.warnings` contains
  `FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING("vanilla", "react")`. `--framework react` on a `.tsx`
  fixture: no such warning.
- A crashed run (forced `bootServer` failure) leaves no `.120fps-harness-*` directory in the
  target directory afterward; a second forced failure that bypasses `src/harness.ts`'s own
  try/catch (simulated uncaught exception) is still cleaned up via the `process.on("exit")` sweep.
- A workspace member that declares `@linaria/core` in `package.json` but whose measured component's
  import graph never reaches it: no `UNSUPPORTED_STYLE_ENGINE_WARNING` for Linaria. A sibling
  component in the same member that does import `@linaria/react`: the warning still fires.
- `--explain-props` on a non-fixture, non-composed component with no array/numeric prop: output
  includes both "Curve mode: would not activate" and the scale-probe disclosure line; a real run on
  the same component shows the `×N copies` rows the disclosure predicted.
