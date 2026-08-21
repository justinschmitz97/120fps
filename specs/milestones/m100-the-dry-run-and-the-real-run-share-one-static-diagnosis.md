---
kind: milestone
status: draft
tests:
  - test/unit/static-prebuild-warning-parity.test.ts
  - test/unit/mode-prediction-parity.test.ts
  - test/unit/vue-project-react-file-gate.test.ts
---

# M100: the dry run and the real run share one static diagnosis

## Purpose

Lane C (+ I5 in Lane A). Closes: twenty-F1, dub-F3, calcom-F4, element-plus-F4, chakra-ui-F4,
nuxt-ui-F3, preact-app-F1, excalidraw-F4. Rescopes: taxonomy-F1, mantine-F2 (runtime-only). Root
cause: `C:\Projekte\120fps-fieldtest\verify\V6-explain-props-parity.md`.

`--explain-props` is the tool's own cheapest and most-recommended first probe. V6 traced both call
chains and found the divergence point exactly: `explainProps` returns at `analyze.ts:2091`, while
`analyze()` computes three more static things (`:2533` the `Stylesheets:` line, `:2776`
`providerCandidateLabels`, `:2809` `PROJECT_TRANSFORM_WARNING`) and then enters `buildAndServe`
(`harness.ts:2452`), where seven further **filesystem-only** probes live: `readViteConfigData`
(text-parsed, never executed), `scanExternalDeps`, `UNSUPPORTED_NEXT_MODULE`, `resolveStyleTooling`,
the transform-plugin load. Nothing in those needs a bundler or a browser; they were unreachable from
the dry run only because they were nested inside the function that starts a server.

The result was a dry run that says nothing about the fact that then kills the real run: twenty's
`vite.config.ts` `additionalData` gap (4/5 candidates crash on it), dub's unbuilt-`dist/` workspace
substitution, nuxt-ui's stale `#build/ui/badge` alias — which is exactly why `--explain-props`
reported "0 props" there with no cause named.

Two gaps run the other way (real run under-discloses): chakra-ui-F4's `#SelectTrigger` retarget
remedy (`analyze.ts:2084`, dry-only) and calcom-F4's composed run measuring `props: {}` with none of
the extraction warnings the dry run printed, because `runComboMode`'s `useFixture || composed` branch
(`analyze.ts:1606`) never calls `ctx.getSchemas()` at all.

And one is a prediction mismatch rather than a warning: element-plus-F4's dry run prints
"Curve mode: would activate" and "Matrix mode: would auto-activate" as two independent booleans
(`analyze.ts:2117`, `:2203`), while the real dispatcher returns at curve (`:3078`) before ever
reaching the matrix branch, which is additionally gated on `!matrixDisabled && !useFixture &&
!composed` (`:3088`).

## Contract

### MUST

- `explainProps` and `analyze()` both call `collectStaticPreBuildWarnings` (I5) and print its
  warnings identically; the `Stylesheets:` line (`analyze.ts:2533`) and the alternative-export note
  (`:2084`) print in both modes.
- Mode prediction in the dry run uses the real dispatcher's predicate and precedence (`:3067-3099`)
  through one shared `predictMode()`; "Matrix mode: would auto-activate" is printed only when the
  real run would pick matrix.
- A composed run that skips `getSchemas()` (`analyze.ts:1605`, `:944`) still emits the extraction
  warnings the dry run printed, plus a "measured with no props" caveat when `props` is `{}`.
- M91's MUST NOT is restated here as: **a refusal or warning decidable from the filesystem alone
  appears in both modes**; refusals that need the browser (module evaluation, provider throws) are
  listed as runtime-only, and the dry run's footer says so in one line.

### MUST NOT

- Start a Vite server or browser from `--explain-props`.

### Invariants

- No warning text changes. This milestone moves where a warning is computed and who prints it,
  never what it says; a wording defect found on the way is M92's kind of work, not this one's.
- The rescoped M91 MUST NOT does not weaken M91: `m91-modes-and-flags-disclose-identically.md` is not
  edited, and its original sentence ("Let a dry run report a clean result where the real run refuses,
  or the reverse") stays the goal. What changes is which violations count as defects: taxonomy-F1
  (`env.mjs` throws a zod validation error during browser module evaluation) and mantine-F2 (a
  provider throw at render) are **runtime-only** and are permanently out of the dry run's reach, so
  they are disclosed as a class in the footer instead of counted as parity bugs forever.

## Runtime-only refusals (the footer's one line)

Decidable only with a browser, therefore never reachable from `--explain-props`:

| refusal | mechanism | evidence |
|---|---|---|
| module-evaluation throw | the module's own top-level code runs (`env.mjs` validating `process.env` through zod) | taxonomy-F1, V6 §3 |
| provider/context throw at render | React/Vue raise during mount, not during resolution | mantine-F2, V6 row 23 |
| a synthesized value the component rejects at runtime | the value is legal by type and illegal by behavior | dub-F2, V6 §3 (refuted as parity) |

## Interface obligations implemented in Lane C files

These three close element-plus-F1 and element-plus-F2, which the map assigns to **M98** (Lane B).
Their contract is M98's; only the code half in `src/analyze.ts` is Lane C's, and it is recorded here
because all three are the same subject as this milestone: what the two modes disclose.

1. **I2 call swap (`analyze.ts:2016-2029`).** `assertRendererSupported(resolvedPath, projectRoot)`
   (Lane A, `harness.ts:465`) is called before `assertReactDomClient`, matching the order Lane A
   installed at `harness.ts:2604-2608`, so a Vue project's `.tsx` fails as "no mount path for a Vue
   JSX file" in both modes instead of "react-dom is not a dependency", which reads as an install
   problem and invites a remedy that cannot help.
2. **Empty accumulated-warnings header (`analyze.ts:2374-2376`).** `formatAccumulatedWarnings`
   emitted `Warnings recorded before this failure:` unconditionally, so element-plus's dry run
   printed a header with nothing under it (V4 secondary observation #1). An empty list now
   contributes nothing.
3. **I3b (`analyze.ts:1967`, `:1986`).** `explainProps`'s options gain
   `framework?: "react" | "vue" | "vanilla" | "auto"`, passed to `resolveFramework` in place of the
   hardcoded `"auto"`, so `FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING` fires in the dry run exactly as it
   already does in the real run (`analyze.ts:2490`). `--framework vue --explain-props` was a silent
   no-op while the same flag on the real run was a disclosed one. Lane A's I3a (`cli.ts:1091-1099`)
   forwards the flag.

## Design

### Shared static pre-build probe (I5)

Lane A exports `collectStaticPreBuildWarnings(projectRoot, opts)` from `src/harness.ts`, returning
`{ warnings, viteConfig, externalDeps, styleTooling, nextModules }` — everything `buildAndServe`
computed before starting a server that needs only the filesystem — and `buildAndServe` accepts the
precomputed result via `opts.preBuild` instead of recomputing it.

Lane C calls it from both sides:

- `analyze()` at the point `buildAndServe` used to compute it, passing the result down as
  `opts.preBuild` so the real run's warning order and text are byte-identical to today's.
- `explainProps` after `loadTsconfigAliases` and before the renderer gates, pushing
  `result.warnings` into its own `warnings` array — the same position in the sequence the real run
  computes them, per M91's ordering rule.

The `Stylesheets:` line moves the same way: `formatStylesheetsLine(cssReport)` is already exported
(`report.ts:592`) and `explainProps` already resolves `cssReport`'s inputs via `resolveCssFiles`, so
the dry run formats the identical line from the identical data. The alternative-export note
(`analyze.ts:2084`) travels in the opposite direction: the AST work that produces it is lifted into a
helper both paths call, so the real run prints the `#SelectTrigger` retarget remedy it currently
drops.

### One `predictMode()`

`predictMode(input)` returns `"isolation" | "curve" | "matrix" | "combo"` from the dispatcher's own
precedence, in the dispatcher's own order:

1. `isolation` when isolation phases were requested (`analyze.ts:3061`)
2. `curve` when a curve match exists (`:3067`) — returns, so matrix never runs
3. `matrix` when `!matrixDisabled && !useFixture && !composed` and (`--matrix` or
   `shouldAutoActivateMatrix(schemas)`) (`:3088-3095`)
4. `combo` otherwise

`analyze()`'s dispatcher calls it instead of re-deriving the branch conditions inline, so the two can
no longer disagree; the dry run calls it with the same inputs it can compute statically and prints
one predicted mode plus, when a lower-precedence mode would also have qualified, the reason it loses.
`PropsExplanation.matrixWouldActivate` keeps its meaning ("the matrix predicate is satisfied") and
stops being the thing printed as a prediction.

### Composed runs emit their extraction warnings

`runComboMode`'s `useFixture || composed` branch (`analyze.ts:1606`) and `runIsolationMode`'s
(`:944`) short-circuit to `combos = [{}]` without calling `ctx.getSchemas()`, so `extractSchemas`'s
`onWarning` never fires and calcom's Select run printed none of the 73-prop extraction diagnostics
the dry run printed. Both branches call `ctx.getSchemas()` for its warnings only — the schemas
themselves are still unused, the combo list is still `[{}]` — and a `props: {}` measurement adds the
"measured with no props" caveat naming why (a fixture owns its scene, or auto-composition does).

## Open questions

None.

## Status

Every MUST implemented. The four contract items land in three places:

1. `collectStaticPreBuildWarnings` (I5) called from `explainProps`, the `Stylesheets:` line formatted
   from the shared `buildCssReport`, and the I2 / empty-header / I3b obligations.
2. `alternativeExportNote` (chakra-ui-F4) extracted from `explainProps` and called from the real
   run's shared `extractSchemas` closure, so both modes print the `#SelectTrigger` retarget remedy
   from one computation.
3. `predictMode` shared by the dispatcher and the dry run, the runtime-only footer, and the
   composed/fixture branches calling `ctx.getSchemas()` for its warnings plus
   `NO_PROPS_MEASURED_WARNING` and a `[no props applied]` row mark (calcom-F4).

## Verification

**Unit.** `test/unit/vue-project-react-file-gate.test.ts` (6) covers the three interface
obligations. `test/unit/explain-props-parity.test.ts`, `tsconfig-extends-broken.test.ts`,
`dry-run-flag-forwarding.test.ts`, `dx-features.test.ts` — 71 passed, unchanged. `pnpm lint` clean.

**dub Badge dry run (dub-F3).**

```
cd /e/repositories/dub && node /c/Projekte/120fps/dist/cli.js packages/ui/src/badge.tsx --explain-props
```

```
Warnings:
  src/styles.css contains no CSS rule with a body of its own ...
  Stylesheets: none found (checked the project entry, conventional filenames, and the largest stylesheet under the project)
  @dub/utils is a workspace package whose package.json points at an unbuilt dist/; its own source at
  E:/repositories/dub/packages/utils/src/index.ts resolves and was aliased in its place, so this run
  measures the real module.

Dry run: nothing was measured, no report was written.
Every refusal decidable from the filesystem is printed above. Three classes are not: a module that
throws while it evaluates, a provider or context that throws at render, and a value this tool
synthesized that the component rejects only at runtime. A real run can still refuse where this one
was clean.
```

The third line is verbatim the entry V6 §4 recorded as present only in the real run's `warnings[]`.
The dry run's set was one line before this milestone.

**preact-app button dry run (preact-app-F1).**

```
cd /e/repositories/preact-app/apps/dashboard && node .../cli.js components/button.tsx --explain-props
# EXIT=2
Warnings recorded before this failure:
  Stylesheets: ../../node_modules/tailwindcss/tailwind.css, ../../node_modules/react-tippy/dist/tippy.css,
  ../../node_modules/@fontsource/red-hat-text/400.css, ... styles/index.sass (found in the project
  entry's own imports)
```

Byte-identical to the line V6 §4 recorded as the real run's only extra warning at the same
`assertReactDomClient` gate.

**element-plus tabs.tsx dry run (element-plus-F1, F2, empty header).**

```
cd /e/repositories/element-plus && node .../cli.js packages/components/tabs/src/tabs.tsx \
  --explain-props --framework vue                                            # EXIT=2

Error: tabs/src/tabs.tsx is a .tsx file in a Vue project (this project declares vue and not
react-dom). 120fps mounts Vue components from .vue single-file components only, so a Vue JSX /
render-function file has no mount path here; --framework vue cannot change that, because a component
always mounts by its file extension. Point 120fps at this component's .vue SFC, or measure the file
in a project that declares react-dom.

Warnings recorded before this failure:
  --framework vue does not change how this file mounts: a component always mounts by its file
  extension (this file mounts as react). The flag only selects which post-mount analysis pass runs.
  Stylesheets: none found (checked the project entry, conventional filenames, and the largest
  stylesheet under the project)
```

Previously: `react-dom is not a dependency of this project ...` followed by the header with nothing
under it, byte-identical with and without `--framework vue`.

**element-plus badge.vue mode prediction (element-plus-F4).**

```
Curve mode:   would not activate: no array or numeric scaling prop
Matrix mode:  would not auto-activate
```

The parity break is gone, and by a different route than expected: Lane B's M103 excluded `max` from
`detectScalingProps` (base-ui-F3's bound/step exclusion list), so the curve prediction the dry run
used to print is no longer made at all. The precedence path this milestone added
(`Matrix mode: predicate matches, but curve mode takes precedence ...`) is therefore not exercised by
this component; it is covered by unit test instead. The real-run half of this repro was not re-run.

Cleanup: no `.120fps-harness-*`, `120fps-report*.json` or `git status` entry left in dub, preact-app
or element-plus.

**chakra select, dry run vs bounded run (chakra-ui-F4).**

```
cd /e/repositories/chakra-ui && node .../cli.js packages/react/src/components/select/select.tsx --explain-props
cd /e/repositories/chakra-ui && node .../cli.js packages/react/src/components/select/select.tsx \
  --samples 3 --max-combos 2 --explore-budget 30 --json ...            # EXIT=1, Result: FAIL [render error]
```

Both now print the same two lines, the second of which the real run used to drop entirely:

```
⚠ Warning: no representative value could be synthesized for collection (ListCollection<T> is a class
  instance) in E:\repositories\chakra-ui\packages\react\src\components\select\select.tsx. Add
  select.props.tsx next to it to supply real values.
⚠ SelectRoot has a required prop this tool cannot synthesize a real value for; this file also exports
  SelectTrigger, whose props are all synthesizable. Target it with #SelectTrigger if it is the
  component you meant to measure.
```

**calcom Select, bounded run (calcom-F4).**

```
cd /e/repositories/calcom && node .../cli.js packages/ui/components/form/select/Select.tsx \
  --samples 3 --max-combos 2 --explore-budget 30 --json ...            # EXIT=0
```

```
0    20.03ms  12.64ms  1.63ms  14  1  -  WARN (T2) [no props applied] [1 page error]
...
⚠ Warning: no representative value could be synthesized for components (no synthesizable members on
  Partial<SelectComponents<Option, IsMulti, Group>>) in E:\repositories\calcom\packages\ui\components\
  form\select\Select.tsx. Add Select.props.tsx next to it to supply real values.
⚠ measured with no props (props: {}): an auto-composed scene supplies the render, so none of this
  component's own extracted props were applied. Any prop diagnostics above describe the schema, not
  what was measured.
```

The finding's run printed neither line and reported `props: {}` with no caveat at all.

Cleanup: `git status --porcelain` empty and no harness dirs or report files under calcom or
chakra-ui after the runs.
