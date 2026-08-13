---
kind: milestone
status: draft
tests:
  - test/unit/m57-vue-support.test.ts
  - test/e2e/m57-vue-support.test.ts
---

# M57 — Vue support

## Purpose

Every measurement guarantee this tool makes is framework-neutral, and none of
them are available to anyone outside React.

Nine of the twenty-four modules contain no React reference at all — `measure`,
`explorer`, `discovery`, `stress-patterns`, `isolation`, `observers`, `noise`,
`page-errors`, `ci-report`. That is the CDP tracing, driven frame pacing, the
exploration loop, the interaction taxonomy, the isolation phases, the noise
sentinel and the CI serializers: the expensive half, already paid for. What is
React-bound is the entry template that mounts the thing (`harness.ts`), the
props extractor that feeds it (`prop-gen.ts`), and the optimization pass
(`react-profiler.ts`).

`--framework vanilla` already exists and gates exactly one thing:
`analyze.ts:1304` skips the React optimization pass. Everything else runs
unchanged. A Vue component would already measure end to end if the harness
could mount it.

The codebase also already names this gap. `preflight.ts:71` recognizes `.vue`
and warns that `@vitejs/plugin-vue` is missing. M57 turns that warning into a
load, exactly as M48 did for SVGR and vanilla-extract.

## Contract

### MUST

- `hasAcceptedComponentExtension` accepts `.vue`. `npx 120fps ./Button.vue`
  runs the standard pipeline and produces a `Report` of the same shape.
- `detectFramework(projectRoot)` returns `"vue"` when `vue` is a dependency and
  `react`/`react-dom` are not. `--framework` accepts `vue`.
- Prop extraction reads `defineProps<T>()` and `withDefaults(defineProps<T>(),
  …)` from `<script setup lang="ts">`, producing the same `PropSchema[]` the
  React path produces. Kinds, value pools, required flags and the auto-scaling
  detection all behave identically downstream.
- The harness mounts an SFC through `@vitejs/plugin-vue`, **resolved from the
  project's own `node_modules`**, never bundled by 120fps.
- `window.__120fps` keeps its exact surface — `mount(props)`, `unmount()`,
  `rerender(props)`, `getContainer()`, `mountWrapperOnly()`, `viewport`,
  `hasSetup`, `teardown()`. Byte-identical semantics, so no measurement module
  changes.
- `rerender(props)` MUST NOT resolve before Vue has patched the DOM (see
  Design → scheduling).
- A provider wrapper (`120fps.setup.vue`, or `--wrap`) wraps the component via
  its default slot, with the same import-time-side-effects-run-first guarantee.
- `EnvFingerprint` records the framework. A baseline entry measured under one
  framework never compares against another.
- `--isolate strictmode` is a usage error under Vue, naming that StrictMode is a
  React development-mode property with no Vue equivalent.

### MUST NOT

- Change the control API contract, or any module in the framework-neutral set
  above. If a Vue change requires editing `measure.ts`, the abstraction is in
  the wrong place.
- Ship `vue`, `@vue/compiler-sfc` or `@vitejs/plugin-vue` as a 120fps
  dependency. The project's Vue version is the one that must compile its own
  components (M27's React Compiler precedent).
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

### File support and prop extraction

The TS Compiler API cannot parse `.vue`. Extraction runs in two steps:

1. `@vue/compiler-sfc`'s `parse()` — resolved from the project — yields the
   `<script setup>` block and its `lang`.
2. That block's content is handed to the existing cached-program machinery as a
   virtual `.ts` file, and a Vue-specific finder locates the `defineProps` call
   and reads its type argument.

The finder is genuinely new work: React's props type is a function *parameter*
type or a class heritage type argument, and `findComponentPropsType` walks for
those. `defineProps<T>()` is a call expression whose type argument is the
props type. `withDefaults(defineProps<T>(), { … })` nests it one level, and the
defaults object is a second source of value information the React path has no
analogue for — a defaulted prop is a strong signal for the anchor value that
delta pairs and matrix baselines are built from.

Per ADR 0002 this stays TypeScript-only. The runtime object form
(`defineProps({ label: String })`) yields no types and is out of scope, as
untyped JS components already are.

### Renderer adapter

`harness.ts` grows a renderer abstraction supplying four things: the entry's
import block, the mount body, the unmount body, and the `renderTree` helper.
React's implementation is the current template, moved rather than rewritten —
the M26 `renderTree` single-render-site rule and the M25 stylesheet import block
are renderer-independent and stay where they are.

Vue's implementation:

- Props travel through a `reactive` object. `mount(props)` assigns into it and
  calls `createApp(...).mount(container)`; `rerender(props)` mutates the same
  object, so the component patches instead of remounting — which is what makes
  the React and Vue rerender numbers describe the same event.
- The wrapper is applied as `h(Wrapper, null, { default: () => h(Component,
  propsProxy) })`, keeping the wrapper outside the component exactly as
  `createElement(wrap, null, el)` does.
- Auto-scale fan-out renders N children inside one wrapper element, wrapped
  once — the M26 rule.
- `unmount()` calls `app.unmount()`.

### Scheduling — the one real measurement hazard

React's `root.render()` and Vue's reactive update do not flush the same way.
Vue batches into a microtask queue drained on `nextTick()`. If `rerender()`
resolves before that queue drains, the traced window closes before the patch
lands and every Vue rerender number is a measurement of scheduling a rerender,
not performing one.

So the Vue control API awaits `nextTick()` inside `rerender()` before
resolving, ahead of the double-rAF fence the caller applies. The fence is not
sufficient on its own and must not be relied on: it proves a frame was
presented, not that Vue's queue drained into it.

This wants an explicit test — mount, rerender into a prop that changes text
content, assert the DOM shows the new content at the moment `rerender()`
resolves — because a wrong answer here does not fail, it silently reports
implausibly fast rerenders.

### Plugin loading

`.vue` moves from `TRANSFORM_RECOGNIZERS` (warn) to
`SUPPORTED_TRANSFORM_PLUGINS` (load), reusing M48's machinery wholesale:
resolution from the project's `node_modules`, `resolvePluginFactory` for the
export shape, and the `configureServer`/`handleHotUpdate` hook stripping that
keeps a project plugin out of the harness server's lifecycle. A project with
`.vue` files and no `@vitejs/plugin-vue` keeps today's named warning.

### What Vue gets instead of the React pass

Nothing, in this milestone. `runReactAnalysis` does not run; the report carries
no optimization block. Vue's analogues — re-render triggers via
`onRenderTriggered`, `provide`/`inject` fan-out, non-memoized computed chains —
are real and worth having, but mapping them is its own spike with its own
findings and its own hints, and bolting approximations onto React's finding
names would produce advice that does not apply.

## Open questions

Each wants a spike before implementation, not a guess in this spec:

1. Does `defineProps<T>()` type resolution work against a virtual `.ts` file, or
   does the checker need the SFC's real module identity to resolve imported prop
   types? If the latter, extraction needs a resolution shim mapping the virtual
   file back to the `.vue` path.
2. Does `withDefaults` defaults extraction belong in `prop-gen` (as value pool
   seeding) or in `prop-gen-values` (as anchor selection)? The second is
   cleaner; the first is where the AST already is.
3. Does the M40 late-mutation probe read Vue's async component and `Suspense`
   boundaries the same way it reads React's? The probe is DOM-level and should,
   but "should" is not a measurement.
4. Do Vue's scoped-style attributes (`data-v-*`) perturb `computeDomHash` or the
   M47 volatility probe? They are stable per build, so likely not — worth one
   fixture.

## Deferred

- Vue-specific optimization detection (the analogue of M18). Wants its own
  milestone and its own hint copy.
- Nuxt module shims, the analogue of M19's Next.js layer.
- Options API and `.vue` files without `<script setup>`. `<script setup>` is
  Vue 3's documented default and covers the typed-component population this
  tool targets.
- Vue 2. Out of support upstream.
- Svelte and Solid. The renderer adapter this milestone introduces is the seam
  they would use; proving it with a second renderer is the point, adding a third
  before the second ships is not.
- Auto-composition for Vue. One component per SFC leaves nothing to infer;
  compound Vue components use `.fixture.vue`.
