---
kind: milestone
status: approved
tests:
  - test/unit/m57-vue-support.test.ts
  - test/unit/m57-vue-harden.test.ts
  - test/e2e/m57-vue-support.test.ts
---

# M57 — Vue support

## Purpose

Every measurement guarantee this tool makes is framework-neutral. Before M57
none of them were available outside React.

Nine of the modules contain no React reference at all — `measure`, `explorer`,
`discovery`, `stress-patterns`, `isolation`, `observers`, `noise`,
`page-errors`, `ci-report`. That is the CDP tracing, driven frame pacing, the
exploration loop, the interaction taxonomy, the isolation phases, the noise
sentinel and the CI serializers: the expensive half, already paid for. What was
React-bound is the entry template that mounts the thing (`harness.ts`), the
props extractor that feeds it (`prop-gen.ts`), and the optimization pass
(`react-profiler.ts`).

## Contract

### MUST

- `hasAcceptedComponentExtension` accepts `.vue`. `npx 120fps ./Button.vue`
  runs the standard pipeline and produces a `Report` of the same shape.
- `detectFramework(projectRoot)` returns `"vue"` when `vue` is a dependency and
  `react`/`react-dom` are not. `--framework` accepts `vue`. A `.vue` file is
  measured as Vue whatever the flag says — no flag can make React render an SFC.
- Prop extraction reads `defineProps<T>()` and `withDefaults(defineProps<T>(),
  …)` from `<script setup lang="ts">`, producing the same `PropSchema[]` the
  React path produces. Kinds, value pools, required flags and the auto-scaling
  detection all behave identically downstream.
- The harness mounts an SFC through `@vitejs/plugin-vue`, **resolved from the
  project's own `node_modules`**, never bundled by 120fps.
- `window.__120fps` keeps its exact surface — `mount(props)`, `unmount()`,
  `rerender(props)`, `getContainer()`, `mountWrapperOnly()`, `viewport`,
  `hasSetup`, `teardown()`.
- `rerender(props)` MUST NOT resolve before Vue has patched the DOM.
- A provider wrapper (`120fps.setup.vue`, or `--wrap`) wraps the component via
  its default slot, with the same import-time-side-effects-run-first guarantee.
- `EnvFingerprint.framework` records the framework. A baseline entry measured
  under one framework never compares against another.
- `--isolate strictmode` is a usage error under Vue, naming that StrictMode is a
  React development-mode property with no Vue equivalent.

### MUST NOT

- Change the control API contract, or any module in the framework-neutral set
  above. No file in that set was edited.
- Ship `vue`, `@vue/compiler-sfc` or `@vitejs/plugin-vue` as a 120fps
  dependency.
- Emit `ReactOptimizations` for a Vue run, or let Vue findings reuse React
  finding names.
- Alter React-path output. A React run's report, entry source and timings are
  bit-for-bit what they were before this milestone.

### Invariants

- Tier budgets, verdicts, CV/instability, noise levels, baseline slots and the
  four CI output modes are framework-blind and stay so.
- One measured file, one component. Vue's one-component-per-SFC idiom means
  auto-composition (M17) has nothing to infer; it is skipped, not adapted.

## Design

### SFC parsing — `src/vue-sfc.ts`

`loadVueCompiler(fromDir)` resolves the project's own SFC parser through
`createRequire`, cached per lookup directory. `VUE_SFC_SPECIFIERS` is
`["vue/compiler-sfc", "@vue/compiler-sfc"]` **in that order**: under pnpm only
the subpath resolves from a project that declares `vue`, because
`@vue/compiler-sfc` is a transitive dependency and is not linked at the top
level. Unresolvable with a `.vue` target, `analyze` fails immediately with
`VUE_COMPILER_MISSING` rather than deep inside Vite minutes later.

`parseSfcScript` returns the `<script setup>` block only. A hand-rolled
top-level tag scan was measured against the real parser on six SFCs and agreed
on five; it read a `<script setup>` block that was inside an HTML comment. The
project's compiler is used everywhere, with no fallback scanner.

### Prop extraction

The TS Compiler API cannot parse `.vue`, so the script block is served to the
program from memory as a virtual `<sfc>.ts` **in the SFC's own directory**
(`createCachedProgram`'s `VirtualScripts` parameter). Measured: prop types
imported from a sibling module resolve, and so do tsconfig `paths` aliases —
no resolution shim is needed. `getSemanticDiagnostics` reports `defineProps` and
`withDefaults` as undefined names; nothing reads diagnostics, only the type node.

The resolver serves **any** `<x>.vue.ts` whose `<x>.vue` exists, not just the
measured file. TS's bundler resolution probes `./Child.vue.ts` for a specifier
it cannot otherwise place, so an SFC that imports another SFC type-checks, and
`projectSourceFiles` returns the whole `.vue` graph — collapsing each virtual
name back to its real `.vue` file so the M39 fingerprint moves when the
component does.

`findDefineProps` locates the call: React's props type is a function *parameter*
type, this one is a call's type argument, so the React finder cannot be reused.
`withDefaults` defaults land in `prop-gen` as **value-pool ordering**: the
default is moved to the front of `PropSchema.values`, which every anchor in the
pipeline already reads (`resolveAnchorValue` → `values[0]`). Delta pairs, matrix
baselines and curve anchors therefore use the value the author called normal,
through one seam and with no change to `prop-gen-values`. Vue's factory form for
array/object defaults (`() => []`) is read through the arrow body.

Per ADR 0002 this stays TypeScript-only. The runtime object form
(`defineProps({ label: String })`) yields no types and extracts no schemas,
exactly as an untyped React component does.

### Renderer adapter

`rendererFor(filePath)` returns `"vue"` for `.vue` and `"react"` otherwise — the
file's own extension is stronger evidence than anything in package.json.
`generateEntry` dispatches to `generateVueEntry` / `generateReactEntry`; React's
implementation was moved, not rewritten. The M25 stylesheet block, the M41
setup/teardown blocks, the M44 preset resolver and the M26 single-render-site
rule are renderer-independent and shared.

The Vue entry has no JSX, so it is written as `entry.ts` and `index.html` names
whichever file was written. Props travel through a `shallowRef` holding a plain
object: the component sees the same unproxied props a parent would hand it (a
deep `reactive` would add proxy cost to the thing being measured), and a new
object identity patches the child instead of remounting it. The wrapper is
applied as `h(Wrapper, null, { default: () => node })`, keeping it outside the
component exactly as `createElement(wrap, null, el)` does. Auto-scale fans N
instances out inside one element, wrapped once.

`optimizeDeps.include` and `resolve.dedupe` are per renderer: a Vue project has
no `react` to pre-bundle and an unresolvable include aborts server start.

`vueComponentName` derives the entry's import binding from the filename, because
an SFC's component is its default export and has no exported name. Vue's own
kebab-case convention is not a JavaScript identifier, so `my-button.vue`
becomes `MyButton`.

### Scheduling — the one real measurement hazard

Vue batches updates into a microtask queue drained on `nextTick()`. The control
API awaits it inside `rerender()` before resolving. The caller's double-rAF
fence proves a frame was presented, not that Vue's queue drained into it, and a
wrong answer here does not fail — it reports implausibly fast rerenders. An e2e
test reads the DOM at the moment `rerender()` resolves.

### Plugin loading

`@vitejs/plugin-vue` is in `SUPPORTED_TRANSFORM_PLUGINS`, reusing M48's
machinery wholesale: resolution from the project's `node_modules`,
`resolvePluginFactory` for the export shape, and the
`configureServer`/`handleHotUpdate` hook stripping that keeps a project plugin
out of the harness server's lifecycle. The `vue` entry stays in
`TRANSFORM_RECOGNIZERS`, so a project with `.vue` files and no plugin keeps
today's named warning.

### SFCs that produce no component

`@vitejs/plugin-vue` emits `import _sfc_main from "<sfc>?vue&type=script"`
whenever an SFC has any `<script>` block, so a block that produces no default
export fails module evaluation in the browser. `sfcProducesComponent` checks
this before the harness directory exists and raises `SFC_NO_COMPONENT`;
otherwise the run dies as a 30-second readiness timeout naming the harness
rather than the file to fix — the Vue analogue of the missing-default-export
wrapper M26 fixed for React.

An **empty** `<script setup>` counts as absent to the Vue compiler, so a
named-exports script beside one produces no component. That is the shape that
looks most correct and fails hardest, and it is the shape a wrapper is naturally
written in. A default export of a plain object counts as a component (Vue's
Options API), unlike React's `hasCallableDefaultExport`.

### Preflight

Preflight parses `.vue` entries through the same compiler and walks relative
`.vue` import edges by hand — TypeScript cannot resolve the specifier, and the
M48 transform note must not end the walk or a `server-only` import one SFC deep
would never be found. Aliased `.vue` specifiers are not resolved: preflight is a
best-effort net, and an unresolved edge costs coverage, never a false failure.
The async-function-component check is React-only and is skipped for `.vue`.

### What Vue gets instead of the React pass

Nothing, in this milestone. `runReactAnalysis` does not run and the report
carries no optimization block. Vue's analogues — `onRenderTriggered`,
`provide`/`inject` fan-out, non-memoized computed chains — are real and worth
having, but mapping them is its own spike with its own findings and its own
hints, and bolting approximations onto React's finding names would produce
advice that does not apply.

## Resolved questions

1. **Does `defineProps<T>()` resolve against a virtual `.ts` file?** Yes, with
   no resolution shim, including prop types imported from sibling modules and
   through tsconfig `paths`. Measured against `Button.vue`, `Card.vue` and
   `Aliased.vue`.
2. **Where do `withDefaults` defaults belong?** `prop-gen`, as value-pool
   ordering — every anchor already reads `values[0]`, so nothing in
   `prop-gen-values` changes.
3. **Does M40's late-mutation probe read a Vue scene?** Yes. A component that
   mutates the DOM 40 ms after mount reports `measuredState: "late-mutation"`.
4. **Do `data-v-*` scoped-style attributes perturb the volatility probe?** No.
   They are build-stable, so a scoped-style component reports zero volatile
   regions.

## Hardening

Twenty hypotheses, each with a fixture. Four found real defects, all fixed.

| # | Hypothesis | Result |
|---|---|---|
| H1 | Kebab-case filename (`my-button.vue`) yields an invalid import binding | **fixed** — `vueComponentName` PascalCases across separators |
| H2 | Filename that cannot start an identifier (`2col.vue`) | pass — prefixed to `Component2col` |
| H3 | `<script setup>` with no `defineProps` | pass — no schemas, still mounts |
| H4 | Runtime `defineProps({ … })` object form | pass — no schemas (ADR 0002) |
| H5 | Factory defaults (`rows: () => [...]`) in `withDefaults` | pass — arrow body read |
| H6 | Inline props type literal instead of a named interface | pass |
| H7 | Props type imported through a tsconfig `paths` alias | pass |
| H8 | Plain `<script>` with no default export | **fixed** — `SFC_NO_COMPONENT` before boot; a plain-object default export counts as a component |
| H9 | `server-only` reached one `.vue` import deep | **fixed** — preflight walks `.vue` edges instead of stopping at the transform note |
| H10 | `</script>` boundaries and a `generic=` attribute containing a quoted `>` | pass — the project's parser, not a tag scan |
| H11 | Auto-scale fan-out and array scaling combos | pass — one render site, one wrapper |
| H12 | `<stem>.props.ts` presets on a `.vue` component | pass |
| H13 | M39 fingerprint tracks SFC edits, never the virtual script | **fixed** — `projectSourceFiles` roots at the virtual script and reports the `.vue` file |
| H14 | Vue project without `@vitejs/plugin-vue` | pass — M48 warning survives, plugin not loaded |
| H15 | No `vue` resolvable at all | pass — extraction degrades to `[]`, `analyze` raises `VUE_COMPILER_MISSING` |
| H16 | Isolation phases other than `strictmode` | pass |
| H17 | `--css` injection into the Vue entry | pass — stylesheet, runtime, component, in that order |
| H18 | `scanExternalDeps` through a relative `.vue` import | pass |
| H19 | An SFC whose setup throws | pass — props still extract; the throw reaches page-error capture |
| H20 | React entry unchanged | pass — no Vue vocabulary, `createRoot` and `__120fpsInStrict` intact |

## Deferred

- Vue-specific optimization detection (the analogue of M18). Wants its own
  milestone and its own hint copy.
- Nuxt module shims, the analogue of M19's Next.js layer.
- Options API and `.vue` files without `<script setup>`. They mount and measure;
  they extract no props.
- Vue 2. Out of support upstream.
- Svelte and Solid. The renderer adapter this milestone introduces is the seam
  they would use.
- Auto-composition for Vue. One component per SFC leaves nothing to infer;
  compound Vue components use `.fixture.vue`.
- Aliased `.vue` specifiers in the preflight walk.
