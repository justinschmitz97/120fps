---
kind: milestone
status: draft
tests:
  # Lane A
  - test/unit/explore-stall-hint-names-effective-flags.test.ts
  - test/unit/import-cycle-preflight-hit.test.ts
  - test/unit/preprocessor-options-replay.test.ts
  - test/unit/entry-selects-exports-at-runtime.test.ts
  # Lane B
  - test/unit/portal-nodes-and-sprite-refs.test.ts
  - test/unit/tracing-window-and-retry-signatures.test.ts
  # Lane C
  - test/unit/explore-degrades-instead-of-ending-the-run.test.ts
  - test/unit/curve-empty-render-point.test.ts
  - test/unit/unresolved-sprite-reference.test.ts
---

# M106: crashes and empty renders found only on the real corpus

## Purpose

Five defects from field test run 4 (`C:\Projekte\120fps-fieldtest\REPORT.md`) that no fixture
reproduced and whose root causes the M106 investigation established
(`C:\Projekte\120fps-fieldtest\verify\M106-investigation.md`). Cross-lane by nature: each MUST below names
the owning lane per `M97-M106-MAP.md`. Closes: calcom-F3, excalidraw-F1, twenty-F2, dub-F6, calcom-F5,
plus the investigation's new finding (calcom `Icon.tsx` type-only re-export breaks the generated entry).

## Root causes (verified)

1. **calcom-F3** — `collectTrace` arms its 60 s `Tracing.tracingComplete` timer before the traced action
   (`measure.ts` `TRACE_TIMEOUT_MS`, timer before `Tracing.start`), so the timer covers the interaction,
   not the flush. A portal trigger gets `open-close-10` (20 clicks × 3 s `page.click` timeout) and Radix
   `modal`'s `body { pointer-events: none }` makes 19 of them time out: 57 s+ inside a 60 s window. Explore
   has no degrade path: `withFrameStarvationRetry` (already handles `tracing-timeout`) has no call site
   outside `measure.ts`; the second `withContextRetry` body throws raw. The printed remedy
   (`--no-attribution`) was measured ineffective (identical 124 s failure); `CONTEXT_RETRY_WARNING`
   claims a dev-server reload that did not happen.
2. **excalidraw-F1** — ESM temporal dead zone from entry order, no barrel involved: the generated entry is
   the graph's only root and imports `DropdownMenu.tsx` first, entering the cycle
   `DropdownMenu → DropdownMenuContent → App → LayerUI → MainMenu → DropdownMenu` backwards;
   `MainMenu.tsx:84` reads `DropdownMenu.Trigger` at module scope. Control: the same cycle entered at
   `MainMenu.tsx` mounts (5 combos, report printed).
3. **twenty-F2** — the harness server sets `css: { postcss }` only; `readViteConfigData` marks
   `css.preprocessorOptions` as an ignored key. twenty's `additionalData` (`vite.config.ts:81-86`) is
   `[…template literals…].join('\n')` with `loadPaths` (`:80`), not a plain string literal.
4. **dub-F6** — portal content *is* counted (`countComponentNodes` sums `#root` and body-level portal
   subtrees). `domNodeCount 0` is a render error (missing `TooltipProvider`), and curve mode
   (`metrics.ts`) carries no `renderHealth`/`pageErrors`, so six empty points print `Result: PASS`. The
   same file with `--no-curve --no-auto-scale` prints FAIL with the provider hint.
5. **calcom-F5** — `<use href="#name">` is a same-document fragment reference: no request, so the M70
   network capture is blind; `<svg>` + `<use>` count as two real nodes. The sprite exists only in
   `apps/web/app/layout.tsx`.
6. **New** — `packages/ui/components/icon/Icon.tsx` re-exports a type as a value (`export { IconName, Icon }`);
   the generated entry's named import fails with `does not provide an export named 'IconName'`.

## MUST

### Lane B (`src/measure.ts`, `src/metrics.ts`)
- B1 The `tracingComplete` timer is armed at `Tracing.end`, never before the traced action; the action
  is bounded separately by the caller's remaining wall clock.
- B2 `CONTEXT_RETRY_WARNING` and the second-attempt failure text name the signature that fired
  (`tracing-timeout` vs execution-context loss); "dev server reloaded" is printed only for the
  context-loss signature.
- B3 Every curve scale point drains page errors and carries `renderHealth` and `pageErrors` like a
  combo (`metrics.ts` point shape), so Lane C can judge it.
- B4 `countComponentNodes` returns `{ rootNodes, orphanNodes }` (sum unchanged for every existing caller).
- B5 `collectDomInfo` probes every `<use>` under the measured node set: a `href`/`xlink:href` fragment
  whose id is absent from the document is collected into `MountResult.unresolvedSpriteRefs: string[]`.
- Handoff to Lane C is one change set: B3 + B4 + B5 landed together, built, and announced.

### Lane C (`src/explorer.ts`, `src/stress-patterns.ts`, `src/analyze.ts`, `src/report.ts`, `src/hints.ts`)
- C1 The explore sample body runs inside `withFrameStarvationRetry` around the existing
  `withContextRetry`; a second `tracing-timeout` degrades the combo to "explore skipped (tracing
  stalled)" with the interaction count so far, and the report still prints (exit by verdict, never 2).
- C2 `executeStressPattern` is bounded by the remaining `maxWallClockMs`; `open-close-10` stops at the
  budget and reports how many cycles ran.
- C3 A curve point with `domNodeCount === 0` is `empty` (with its page errors) — excluded from the fit,
  tagged on its row, never part of a `PASS`; when every point is empty the curve verdict is `fail` with
  the render-error hint (provider hint pipeline), exactly as combo mode would print.
- C4 `unresolvedSpriteRefs` on a combo prints a warning naming the ids and the symptom ("renders an
  empty `<svg>`: the sprite that defines `#name` is injected by the application shell, not by the
  component"), a `hints.ts` entry, and a JSON field on the combo.

### Lane A (`src/page-errors.ts`, `src/preflight.ts`, `src/harness.ts`)
- A1 `stallHintForPhase`: the explore-phase stall hint names `--explore-budget` and `--samples`, never
  `--no-attribution` (measured ineffective); the mount/rerender hints keep their current text only
  where `--no-attribution` applies to that phase.
- A2 `runPreflight`'s BFS records back-edges to the entry module: a cycle that returns to the measured
  component's module is reported as an `import-cycle` hit printing the hop chain and the remedy
  (`--wrap` / `120fps.setup.tsx` importing the package's own root first, which is emitted before the
  component import), as a soft hit (the run proceeds; the TDZ failure, if it happens, is then
  attributed to the cycle instead of "harness did not become ready").
- A3 `ViteConfigData.preprocessorOptions`: `css.preprocessorOptions.<lang>.additionalData` is folded
  when it is a string literal, a template literal without substitutions, an array of such joined by a
  literal, or a `+` concatenation of such; `loadPaths`/`includePaths` entries resolved through the
  existing call-expression path resolver and kept only when they exist. The harness server spreads
  the folded options into `css` alongside `postcss`. Anything else stays in `ignoredKeys` with the
  existing warning, now naming the unfoldable shape (`function`, `api`).
- A4 The generated entry never imports a type-only export by value: `detectComponentExport` /
  entry generation skips exports that resolve to types (or uses `import type`), and the error for a
  requested `#Export` that is a type says so.

## MUST NOT
- Count a closed portal's absent content as a component defect (dub-F6's original wording).
- Reorder the user's module graph silently (cycle-aware entry seeding stays opt-in, not implemented here).
- Replay `css.preprocessorOptions.<lang>.api` or any function-valued option.

## Verification
Lane B/C: unit tests per MUST with fake CDP/page objects; real: `cd /e/repositories/calcom && node
/c/Projekte/120fps/dist/cli.js packages/ui/components/form/datepicker/DatePicker.tsx --samples 3
--max-combos 2 --explore-budget 30` reaches a report (no `Tracing.tracingComplete timed out` exit 2);
`dub packages/ui/src/combobox.tsx` bounded curve run prints the provider hint and no `PASS`;
`calcom Badge.tsx` bounded run prints the unresolved-sprite warning naming the icon ids.
Lane A: `excalidraw DropdownMenu.tsx` prints the `import-cycle` chain with the remedy; `twenty
IconButton.tsx` bounded run passes the sass transform (no `Undefined mixin`); `calcom Icon.tsx
--explain-props` and bounded run do not fail on `IconName`.
Each lane records its decisive lines verbatim below and lists its test files in `tests:`.

### Lane A evidence

**A1 — the explore-phase stall hint names flags that bound explore.** `src/page-errors.ts`:
`stallHintForPhase` routed `explore` to `HARNESS_STALL_HINT`, whose lead remedy is
`--no-attribution` — the flag the investigation ran against calcom's own stalling component and
measured as a byte-identical 124 s failure. `EXPLORE_PHASE_STALL_HINT` names the two flags that
really bound that phase (`--explore-budget`, `--samples`) and names no other; `mount` and
`attribution`, where `--no-attribution` does disable the tracing pass that stalls, keep
`HARNESS_STALL_HINT` unchanged, and `rerender`/`delta` keep the hints M89 gave them.

```
$ pnpm vitest run test/unit/explore-stall-hint-names-effective-flags.test.ts
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

`enrichPhaseError(new Error("Tracing.tracingComplete timed out"), { phase: "explore" })` now reads:

```
explore phase failed: Tracing.tracingComplete timed out A Worker, a long-lived timer or a running
animation can keep the page busy so the trace never completes; retry with a shorter
--explore-budget or fewer --samples.
```

`test/unit/delta-phase-stall-hint.test.ts`'s phase table drops `explore` from the
"still names --no-attribution" case for the same reason (mount and attribution stay).

**A2 — a back-edge to the measured module is a disclosed cycle, and the TDZ failure is attributed
to it.** `src/preflight.ts`: the BFS already carries `parents`/`chainTo`; an edge resolving to a
file in `entryFiles` is now a **soft** `import-cycle` hit carrying the hop chain (one per distinct
source file, deduplicated). `SOFT_HIT_WARNING` dispatches on the hit's kind and
`NODE_BUILTIN_WARNING` is kept as its alias, so both existing call sites in `src/analyze.ts` print
the right text with no Lane C edit. `src/page-errors.ts`: `tdzCycleNote` recognizes
`Cannot access 'X' before initialization` in the captured page errors and `enrichTimeoutError`
appends it in place of the env-file line, which would read as a guess beside a known cause.

excalidraw, the F1 repro (`logs/fix-a-m106-excalidraw.log`) — the chain is exactly the one the
investigation named, and the failure now says why:

```
$ node .../cli.js packages/excalidraw/components/dropdownMenu/DropdownMenu.tsx     --samples 3 --max-combos 2 --explore-budget 20
Error: component harness did not become ready within timeout. Page errors:
  - Cannot access 'DropdownMenu' before initialization
DropdownMenu was read before its module finished initializing: an import cycle the generated entry
enters from the component's own file, rather than where the application enters it (see the
import-cycle warning above). Add a 120fps.setup.tsx, or pass --wrap, that imports this package's own
root module first.
...
  components/dropdownMenu/DropdownMenu.tsx → components/dropdownMenu/DropdownMenuContent.tsx →
  components/App.tsx → components/LayerUI.tsx → components/main-menu/MainMenu.tsx →
  components/dropdownMenu/DropdownMenu.tsx: the import graph returns to the measured module (a cycle).
```

Still exit 2 by design: A2 discloses and attributes; re-seeding the entry is the MUST NOT.

**A3 — the foldable half of `css.preprocessorOptions` is replayed.** `src/harness.ts`:
`foldStringExpression` (literal, substitution-free template, `[...].join(sep)`, `+` concatenation)
and `foldPathArray` (through the existing `resolveCallExpressionPath`, keeping only directories that
exist) build `ViteConfigData.preprocessorOptions`; the harness server merges it into the same `css`
object as `postcss`. An unfoldable `additionalData` still lands in `ignoredKeys` with the existing
wording; any other option (`api`, a function value) is named by
`VITE_CONFIG_PREPROCESSOR_OPTION_WARNING` instead, because the old sentence
("additionalData is not replicated") would be false for a config whose `additionalData` folded.
`test/unit/vite-config-static-data.test.ts`'s "reports preprocessor options and plugins" expectation
changes for that reason: a literal `additionalData` is replayed now, so `ignoredKeys` is `["plugins"]`.

twenty, the F2 repro (`logs/fix-a-m106-twenty.log`) — was `Undefined mixin`:

```
$ cd /e/repositories/twenty && node .../cli.js     packages/twenty-ui/src/input/IconButton/IconButton.tsx --samples 3 --max-combos 2 --explore-budget 20
Result: PASS
⚠ vite.config.ts declares css.preprocessorOptions.scss.api, which the harness read but cannot honor:
  the project's Vite config is never executed, and these options select behaviour rather than
  content. Everything else under css.preprocessorOptions (additionalData, loadPaths) is replayed.
Total: 1m 6s
```

**A4 — the entry links whatever the module exports.** `src/harness.ts`: all three generated entries
(`generateReactEntry`, `generateVueEntry`, `generateComposedEntry`) now emit
`import * as __120fps_mod from "/<component>"` plus `__120fps_selectExport(name)`, which throws
`export X is not a runtime value (a type-only export?); runtime exports: …` when the binding is
`undefined`. `#Export` semantics are unchanged: the requested name is what is selected. Four existing
assertions that pinned the named-import shape were updated with a one-line reason
(`vue-support-harden` ×2, `vue-support`, `css-injection-harden`).

calcom, the new finding (`logs/fix-a-m106-calcom-icon*.log`):

```
$ node .../cli.js packages/ui/components/icon/Icon.tsx --explain-props      # EXIT=0, 32 props
$ node .../cli.js packages/ui/components/icon/Icon.tsx --samples 3 --max-combos 2 --explore-budget 20
Error: component harness did not become ready within timeout. Page errors:
  - export IconName is not a runtime value (a type-only export?); runtime exports: Icon, default
$ ... --no-auto-compose                                                      # EXIT=0, full report
```

The ESM link error (`does not provide an export named 'IconName'`) is gone; what remains is
auto-composition composing a type-only name into the scene, which `--no-auto-compose` avoids and
which is upstream of this file (see the request below).
### Lane B evidence

**B3 — no code change, and none was invented.** The mount pass already closes a per-combo window
over the page's error stream (`measure.ts`, `ms.errorCapture.drain()` in the mount loop, merged with
any vsync-bail carry-over and attached as `MountResult.pageErrors`), and curve mode measures its
scale points through that same `measureMount` (`analyze.ts` `runCurveMode`). Lane C's
`buildCurveReport` (`report.ts:1401-1406`) derives `ScalingPoint.renderHealth` and
`ScalingPoint.pageErrors` from `mount.pageErrors`, so every curve point already carries what a combo
carries. Both paths were read end to end before concluding this; recorded as a verified fact.

**B4 — `countComponentNodes` returns the split.** `ComponentNodeCount { rootNodes, orphanNodes }`,
with `totalComponentNodes(count)` giving the old sum, which is what all three existing call sites
(`measureWrapperOverhead`, `runMountUnmount`, `createCalibrationTrace`) now use. `domNodeCount` is
unchanged everywhere. `MountResult.orphanNodes?: number` is set only when portal content exists, so
a portal-free component's report is byte-identical.

**B5 — unresolved sprite references.** `MountResult.unresolvedSpriteRefs?: string[]`, collected in
`runMountUnmount` on the existing `collectDomInfo` gate, between traced windows. Deduped, document
order, leading `#` kept, capped at `MAX_UNRESOLVED_SPRITE_REFS` (10), absent when empty.

Scope, deliberately narrower than the map's wording: only same-document fragments (`href` /
`xlink:href` starting with `#`). An external `<use href="/icons.svg#id">` is fetched by the browser
and its target never enters `document`, so `getElementById` cannot decide it, and checking it would
report every *valid* external sprite as unresolved. calcom-F5's actual shape is `<use href="#name">`
against a sprite injected by `apps/web/app/layout.tsx`.

**Regression found and closed in the same change set.** `page.evaluate` parses a string argument as
an *expression*, and B4/B5 first handed it a `function` declaration followed by a call. Every run
died at `calibration` (`createCalibrationTrace` is the first caller) with
`SyntaxError: Unexpected identifier '__120fpsCountComponentNodes'`. The unit tests had loaded the
same source through `new Function(body)`, which parses a *statement list*, so they were green
against a string no page could run. `asEvaluateExpression(source, call)` wraps both sources in an
IIFE; `COMPONENT_NODE_COUNT_EXPRESSION` and `UNRESOLVED_SPRITE_REFS_EXPRESSION` are what the call
sites pass, and three tests now assert that each parses via `new Function("return (" + expr + ")")`
while the unwrapped form does not.

**B1 — the tracing timer bounds the flush.** `TRACE_FLUSH_TIMEOUT_MS` (renamed from
`TRACE_TIMEOUT_MS`, same 60 s value) is armed immediately before `Tracing.end` instead of before
`Tracing.start`. The `Tracing.tracingComplete` listener is still attached before the action, so a
fast flush cannot resolve into nothing. The traced action is bounded by its caller — the explore
pass's remaining wall clock (Lane C's C2) and the rAF fence elsewhere — which is where an action
budget belongs. Before this, `open-close-10` on a Radix portal spent 20 clicks at a 3 s `page.click`
timeout each, 19 of them timing out against `body { pointer-events: none }`, and 57 s of interaction
inside a 60 s window reported itself as a tracing stall.

**B2 — the retry text names the signature that fired.** `isContextLostError` matches three
signatures and only one of them is a reload. `contextRetryWarningFor(err)` picks
`TRACING_STALL_RETRY_WARNING`, `TARGET_CLOSED_RETRY_WARNING` or the unchanged
`CONTEXT_RETRY_WARNING`; `retryBudgetExhaustedNoteFor(err)` does the same for the exhaustion note.
"the dev server reloaded the page mid-measurement" now prints only for an execution-context loss.
`analyze.ts:2826`'s `contextRetries` noise counter keys on `CONTEXT_RETRY_WARNING` and therefore
stops counting tracing stalls as reloads, with no edit to Lane C's file.

Unit: `test/unit/portal-nodes-and-sprite-refs.test.ts` (17),
`test/unit/tracing-window-and-retry-signatures.test.ts` (12). `pnpm lint` clean; `pnpm build` clean.

Real: after the evaluate fix, `cd /e/repositories/radix-primitives && node
/c/Projekte/120fps/dist/cli.js packages/react/separator/src/separator.tsx --samples 3 --max-combos 2
--explore-budget 15` -> `EXIT=0`, past `calibration`, report printed:

```
Mode: prop combos (2 measured of 64 generated, +4 scale probes)
0    8.82ms   6.89ms   0.54ms   0   0   -   WARN (T1) [render error] [harness fault: asChild] [-> #1: 1 page error]
```

Real, B1 + B5 together — `cd /e/repositories/calcom && node /c/Projekte/120fps/dist/cli.js
packages/ui/components/form/datepicker/DatePicker.tsx --samples 3 --max-combos 2 --explore-budget 30`
(`logs/fix-b-calcom-datepicker.log`). Before: `EXIT=2`, `Tracing.tracingComplete timed out`, no
report. Now `EXIT=0`, `grep -c "tracingComplete timed out"` -> `0`, and the report prints:

```
Mode: prop combos (2 measured of 48 generated, +4 scale probes)
2 of 2 combos warned; warnings do not fail the run.
this component renders an empty <svg>: #calendar is referenced by a <use> element and defined
nowhere in the document. A sprite sheet injected by the application shell is not injected by the
component.
Total: 58.0s
```

JSON: `combos[0..2].unresolvedSpriteRefs === ["#calendar"]` — B5 reaching Lane C's C4 warning and
hint end to end, on the exact component calcom-F5 named.

Cleanup: `120fps-report.json` removed from both repositories, no `.120fps-harness-*`,
`git status --porcelain` empty.
### Lane C evidence

**C1 — explore degrades instead of ending the run.** `src/explorer.ts`: the trace-sample body now
runs inside `withFrameStarvationRetry` (already exported from `measure.ts`, already classifying
`tracing-timeout` via `classifyStall`, `measure.ts:544`) wrapped around the existing
`withContextRetry`. Explore was the one phase with no call site, so a second stall threw raw out of
`inFlight.run` and ended the run at exit 2 with no report. On exhaustion the combo stops exploring,
`EXPLORE_STALLED_WARNING` names it, and the BFS loop's new `stalled` guard leaves everything already
measured in the graph:

```
combo 0: explore skipped (tracing stalled); 3 interactions measured before the stall are kept and
the report still prints
```

**C2 — a stress pattern cannot outlive the budget that bounds it.** `executeStressPattern`
(`src/stress-patterns.ts`) takes the caller's remaining wall clock and returns
`{ stepsRun, stepsPlanned, budgetExhausted }`. `exploreCombo` passes `remainingWallClock()`, derived
from the one `startTime`/`maxWallClockMs` pair the BFS loop already uses, at both call sites (trace
and observer paths). `open-close-10` is 20 clicks at a 3 s `page.click` timeout each; Radix `modal`'s
`body { pointer-events: none }` made 19 of them time out, 57 s inside a 60 s tracing window. The
parameter is optional and unbounded when omitted, so no existing caller changes behaviour.

**C3 — a curve point that rendered nothing.** Implemented once, shared with M104's fourth MUST
(`specs/milestones/m104-modes-measure-what-they-say-they-measure.md`): `ScalingPoint` gains
`renderHealth` (`"error"` when the point's own drain was fatal, `"empty"` otherwise) and
`pageErrors`; the five curve fits run over the rendering points only, with the excluded N values
published as `fitExcludedPoints` and named on the growth line; the row is tagged. In `runCurveMode`,
the broken-point gate widened from `domNodeCount === 0 && pageErrors?.fatal` to
`domNodeCount === 0 && hasPageErrors(...)` — dub's Combobox rendered 0 nodes at every point while
React logged `` `Tooltip` must be used within `TooltipProvider` `` through `console.error`, which is
not fatal, so six empty points printed `Result: PASS`. A non-fatal broken point gets
`CURVE_EMPTY_POINT_WITH_ERRORS_WARNING` rather than the existing wording ("while the page threw"
would be false); both start `scale point N=`, so `renderFailed` and the `renderError` hint pick them
up unchanged. A curve every one of whose points is empty with nothing reported fails with
`CURVE_ALL_POINTS_EMPTY_WARNING`.

**Live evidence — C3, dub Combobox.**

```
cd /e/repositories/dub && node /c/Projekte/120fps/dist/cli.js packages/ui/src/combobox/index.tsx \
  --samples 3 --max-combos 2 --explore-budget 30 --json .../fix-c-dub-combobox.json   # EXIT=1
```

```
Mode: curve over "options" (array prop with items-like name)
1      29.79ms  7.68ms  1.08ms  0  +-2.1MB   [renders nothing at N=1]
3      27.82ms  8.35ms  0.99ms  0  +-178KB   [renders nothing at N=3]
...
50     27.42ms  7.36ms  0.91ms  0  +-260KB   constant [renders nothing at N=50]

Growth: mount constant, rerender constant

Result: FAIL
⚠ every scale point rendered 0 DOM nodes: the component renders nothing across the whole options
  sweep, so there is no growth to classify.
```

The finding's run printed `Result: PASS` over the same six empty points with no textual signal at
all. Every point carries `renderHealth: "empty"` in JSON and `report.pass === false`.

One correction to C3's wording, from what this run actually showed: **no page errors were captured
on any point** (`points[].pageErrors` absent throughout), so the provider hint the MUST anticipated
has nothing to attribute and does not fire — the component renders nothing without throwing. The
widened broken-point gate (any page errors, not only fatal ones) is still what closes the case the
investigation described; here the all-points-empty branch is what fails the run. The `domFlat` hint
is now withheld for this shape (`hints.ts`): its remedy ("point `--curve` at the prop that does
[drive the DOM]") names the wrong thing when nothing rendered at any N, the same reasoning that
already suppressed it whenever a curve render error explains the flat curve.

Real-repo evidence for the mixed case (some points render, one does not) is in M104's Verification
section: commerce `variant-selector.tsx` prints `[renders nothing at N=1]` and `fitted over the
points that rendered; N=1 rendered 0 DOM nodes and is excluded.`

**C4 — unresolved sprite references.** Lane B's B5 delivers
`MountResult.unresolvedSpriteRefs?: string[]` (same-document `#id` targets only, deduped, leading
`#` kept, absent when empty). `buildReport` copies it onto the combo
(`ComboReport.unresolvedSpriteRefs`), one deduped `UNRESOLVED_SPRITE_REFS_WARNING` names every id
across the run, `renderHealthMarks` tags the row `[unresolved sprite]`, and `hintsForReport` adds the
`unresolvedSprite` hint (anchor `#provider-wrapper`, remedy: a `120fps.setup.tsx` whose top-level
side effect injects the same sheet, behind `--wrap`).

**Live evidence — C1, C2 and C4 in one run.**

```
cd /e/repositories/calcom && node /c/Projekte/120fps/dist/cli.js \
  packages/ui/components/form/datepicker/DatePicker.tsx --samples 3 --max-combos 2 \
  --explore-budget 30 --json .../fix-c-calcom-datepicker.json     # EXIT=0, Total: 58.9s
```

The finding's run ended `Tracing.tracingComplete timed out`, exit 2, after 124 s with no report. This
one reaches a report and exits by verdict. The Radix `Popover.Portal` trigger still draws
`open-close-10` and now completes inside the budget:

```
0    16.48ms  5.29ms  1.35ms  5  1  -  WARN (T3) [unresolved sprite]
    28 (click): 92.49ms = 4.62ms x 20 steps [1.44x cal] [portal] (open-close-10)
```

C4 on the same run and on the spec's named repro:

```
⚠ this component renders an empty <svg>: #calendar is referenced by a <use> element and defined
nowhere in the document. A sprite sheet injected by the application shell is not injected by the
component, so the measured render draws nothing for it while still paying for the elements.
```

`combos[0].unresolvedSpriteRefs === ["#calendar"]`, `hints === ["contextFanOut","unresolvedSprite"]`.
`calcom packages/ui/components/badge/Badge.tsx` (bounded, EXIT=0, `Result: PASS`) reports `#ellipsis`
the same way, with `[unresolved sprite]` on its row.

Note on B1: at the time of the DatePicker run, Lane B's B1 was in `dist` (`collectTrace` arms the
`tracingComplete` timer at `Tracing.end`). An earlier build of the same run, with the timer still
armed before the action, is what C1/C2 were written against; both fixes are in the passing run above,
so this run demonstrates the combination, not C1/C2 in isolation.

Unit: `test/unit/explore-degrades-instead-of-ending-the-run.test.ts` (6),
`test/unit/curve-empty-render-point.test.ts` (8). `pnpm lint` clean. The calcom DatePicker and dub
Combobox real-repo runs in this spec's Verification section were not run.
