---
kind: milestone
status: draft
tests:
  - test/unit/vue-support.test.ts
  - test/unit/the-vue-plugin-resolves-through-its-host-framework.test.ts
  - test/unit/a-components-map-registers-its-components.test.ts
  - test/unit/an-auto-import-map-supplies-a-free-identifier.test.ts
  - test/unit/a-missing-identifier-names-the-map-consulted.test.ts
  - test/unit/a-vue-file-is-covered-by-its-referenced-config.test.ts
  - test/unit/a-registered-component-that-cannot-load-is-named.test.ts
---

# M136: a Vue app's generated auto-import maps resolve its components and composables

Lane G (`src/project/transforms.ts`, `src/project/generated-declarations.ts` (new),
`src/harness/entry.ts`, the plugin list in `src/harness/build.ts`, the `vitePluginsNotExecuted` hint
text in `src/report/hints.ts`). Executes ADR
`0006-generated-declaration-files-are-a-resolution-input.md`.

## Purpose

Twelve Vue repositories were inventoried in run 7. Three fail with `ReferenceError: useCounter is not
defined` and its siblings, because the app's build registers those identifiers through
`unplugin-auto-import` and the harness does not. One fails with `Cannot destructure 'item'` from a
Nuxt auto-component the log never names. One cannot compile a `.vue` file at all, because
`@vitejs/plugin-vue` lives only in `.pnpm` and the availability check does not look there. One passes
only because a package manager hoisted a transitive install, and says so in a warning. The
information every one of these runs needs is already on disk and tracked in git: the generated
declaration files the app's own tooling writes — `components.d.ts`, `.nuxt/components.d.ts`,
`auto-imports.d.ts` — are a complete name-to-module table. After this milestone the harness reads
those tables and resolves what they name, in four staged steps, without ever executing the project's
Vite config.

Evidence: `C:/Projekte/120fps-fieldtest/smoke/run7-FINDINGS.md` cluster 8 and
`smoke/run7-smoke1/{nuxt.com,vitesse,vue3-element-admin,soybean-admin,vue-pure-admin,nocodb}.json`,
`smoke/run7-new1/{it-tools,wg-easy,uptime-kuma}.json`.

## Root causes (verified)

The verifier for every item below: run-7 investigation (2026-09-06), refuted by default; logs under
`C:/Projekte/120fps-fieldtest/smoke/run7-smoke1/logs/<repo>/` and `smoke/run7-new1/logs/<repo>/`.

1. **The Vue plugin is looked for only where the project declares it** — `src/project/transforms.ts`
   filters `SUPPORTED_TRANSFORM_PLUGINS` (`:17-26`) through `isPackageAvailable`
   (called at `:52-53`, declared at `src/project/model.ts:153`). The verifier: wg-easy is a pnpm-strict
   Nuxt 4 app that never declares `@vitejs/plugin-vue` itself — Nuxt does — so the package exists only
   under `.pnpm`, the SFC is served untransformed, the module request answers 500 and the run ends in a
   readiness timeout at 93 s. scaffold-nuxt passes only because npm hoisted the same package, and the
   run says so ("found via a hoisted transitive install").
2. **Auto-imported identifiers are free variables in the harness** — the Vue mount is a bare
   `createApp` (`src/harness/entry.ts:308`, `app = createApp(__120fpsRoot);`). The verifier: vitesse
   (`ReferenceError: useCounter is not defined`), vue3-element-admin and it-tools all fail this way,
   each with the `vitePluginsNotExecuted` hint (`src/report/hints.ts:227-237`), which names the cause
   correctly but offers nothing the developer can act on. The tables that would resolve them are on
   disk and git-tracked: vitesse `src/auto-imports.d.ts:151`
   (`const useCounter: typeof import('@vueuse/core').useCounter`), vue3-element-admin
   `types/auto-imports.d.ts:189`, it-tools `auto-imports.d.ts`.
3. **Auto-registered components are unresolved tags** — the verifier: nuxt.com's measured component
   uses `<UCarousel v-slot="{ item }">`, the render fails with `Cannot destructure 'item'`, and the
   log never names `UCarousel`. `.nuxt/components.d.ts:184` declares it:
   `export const UCarousel: typeof import("…/@nuxt/ui/dist/runtime/components/Carousel.vue")['default']`.
   A local map has the same shape (`TheCounter: typeof import('./components/TheCounter.vue')['default']`)
   and a package one too (`ElAlert: typeof import('element-plus/es')['ElAlert']`).
4. **The harness already loads the project's plugin packages, and that is settled policy** —
   `src/project/transforms.ts:17-25` and `:86-111` and `src/harness/build.ts:303-309` load a curated
   set of the project's own plugins from its `node_modules` with harness-chosen options;
   `README:305` documents it. The policy line (`CHANGELOG:190`, `README:305`,
   `src/harness/vite-config.ts:79-95`) forbids *executing the project's `vite.config`*, not loading
   its plugin packages. The verifier: the two are already different things in the code today.
5. **Wrapper and setup injection already exist** — `src/harness/entry.ts:122-138` and `:351-355`,
   with `WRAPPER_CANDIDATES` at `src/harness/exports.ts:21` (including `120fps.setup.vue`, placed
   first for Vue by `detectWrapper` at `:30`). The verifier: the `120fps.setup.*` remedy is what
   hoppscotch and vue-vben-admin need, and it is auto-detected today.

Option (b) — parse the generated `d.ts` maps into a name-to-module table and inject through a
harness-owned Vite plugin — was chosen over (a) running the project's own AutoImport/Components
plugin instances (contradicts `CHANGELOG:190` and writes `d.ts` files into the user's repository),
(c) generating a `120fps.setup.vue` that replays `app.use` (highest failure surface; opt-in only), and
(d) wording alone (moves zero repositories). It contradicts no MUST in M107, M108 or M123, and it
advances M123's "nuxt.com must still reach the browser".

## MUST

### Stage 1 — the Vue plugin resolves through its host framework

- **C1** When the project does not declare `@vitejs/plugin-vue` itself, the harness resolves it from
  the package directory of a framework the project *does* declare and that depends on it (`nuxt`,
  then `vite`), and uses it. The transform is disclosed as it is today.
- **C2** A plugin found this way produces no "hoisted transitive install" warning, because it was not
  found by hoisting. A plugin still found only through hoisting keeps that warning.

### Stage 2 — a components map registers its components

- **C3** When a Vue project has a components declaration map on disk (`components.d.ts`,
  `src/components.d.ts`, `types/components.d.ts`, `src/types/components.d.ts`,
  `app/components.d.ts` or `.nuxt/components.d.ts`, searched in that order) the harness parses it
  into `name -> { module, exportName }` entries and registers each entry whose module resolves
  inside the project's own source tree, before mount, as
  `app.component(name, defineAsyncComponent(() => import(module)))`. An entry whose module
  resolves inside a dependency stays unregistered (C12).
- **C4** Registration is additive and never shadows: a component the measured module graph imports
  explicitly wins over the map's entry of the same name.
- **C5** A map entry whose module cannot be resolved is skipped, and the run says which entries were
  skipped and from which map. An entry left unregistered under C12 is a second, separately named
  class, reported only when the measured component's own source references one of them: the run
  names those, counts the rest, and says why a dependency's component is not registered. A run whose
  component reaches for none of them prints no line, because none of them changes what it renders.
- **C14** A name the measured component reaches for is a tag its `<template>` block writes, or a
  binding its script block leaves free. An imported name, a name the script declares, a name only a
  template comment or a script string spells, and a tag Vue resolves itself (a native HTML element,
  `slot`, `component`, `template`, `transition`, `teleport`, `keep-alive`, `suspense`) are none of
  those. The verifier for the gap: wg-easy's `app/components/Form/Label.vue` was reported as
  referencing `Label` and `Slot`, where `Label` occurs only inside
  `import { Label as RLabel } from 'reka-ui'` and `Slot` only as `<slot />`.
- **C15** A registered component the browser cannot fetch is named. It renders nothing and throws
  no render error, so the entry logs one line per component on the page-error channel the run
  already collects, and the report carries one warning naming each component, its error, and that
  the numbers describe a tree without it.
- **C16** Both map files join the run's source fingerprint (`src/pipeline/phases.ts`,
  `getSourceFingerprint`) and the report records them under `generatedMaps`. Regenerating a map
  changes which components and identifiers resolve, so a cached verdict for the previous table is
  not reused. `--no-transforms` leaves both out, because the run reads neither.

### Stage 3 — an auto-import map supplies a free identifier

- **C6** When a Vue project has an auto-import declaration map on disk (`auto-imports.d.ts`,
  `src/auto-imports.d.ts`, `types/auto-imports.d.ts`, `src/types/auto-imports.d.ts` or
  `app/auto-imports.d.ts`, searched in that order), the harness parses it into
  `identifier -> { module, exportName }` and, through a harness-owned Vite plugin in the harness's
  own plugin list, prepends the corresponding import to the script of a module that references the
  identifier freely. The plugin is added only when the Vue transform itself loaded: without it
  nothing turns an SFC into a module to prepend an import to. An entry whose module is a package
  resolves only when that package is installed on the project's resolution chain, never merely
  because the manifest declares it (ADR 0006 item 4).
- **C7** The transform is scoped to the measured component's own module graph. A file outside that
  graph, a file in `node_modules`, and a file that already imports or declares the identifier are all
  left untouched.
- **C8** The prepended imports are disclosed: before the page loads, the run names the auto-import
  map file it read and how many identifiers that table makes available to the measured component's
  graph. (The count of identifiers actually prepended is not stated: the harness result's warning
  list is copied into the run's warnings in `src/pipeline/analyze.ts` before the page evaluates a
  single module, so a per-module count recorded during transform could never reach the report.
  What is prepended, and to which module, is decided only by C6 and C7.)

### Stage 4 — the hint names the map

- **C9** When an identifier is still undefined at render time, the hint names the map file the run
  consulted and whether the identifier was in it. `vitePluginsNotExecuted` (`src/report/hints.ts`)
  keeps its meaning and gains that sentence. A run that read no map has none to name: the hint says
  so for a React component and under `--no-transforms`, instead of claiming a table it never used.

### Across all stages

- **C13** A referenced config that includes the measured component covers it, whatever the
  component's file extension. The gap was extension-blindness, not a Nuxt layout: TypeScript's own
  file globbing yields no `.vue` path unless the caller passes `extraFileExtensions`, so every
  `.vue` file under a references-only root read as covered by nothing. `expandConfigFileNames`
  (`src/project/model.ts`) passes `.vue` as a deferred-script extension, which is what the editor
  tooling a Vue project runs already does. When no config covers the component the message is
  unchanged: it names the configs it tried and never claims a refusal M123 forbids (C11).
- **C10** Dry/real parity (M100, M110): `--explain-props` reports the same maps found, the same
  entry counts, and the same skipped entries as the real run. Deferred: the dry run never calls
  `buildAndServe`, so its warning list is assembled independently in `src/pipeline/explain-props.ts`,
  a lane-D file. The hunk is one push of the same texts
  (`GENERATED_COMPONENTS_DISCLOSURE`, `GENERATED_MAP_SKIPPED_WARNING`, `DEFERRED_COMPONENTS_WARNING`,
  `AUTO_IMPORT_DISCLOSURE`, all exported from `src/project/generated-declarations.ts`) beside the
  existing `collectStaticPreBuildWarnings` push; it is filed as an interface request, not landed
  here.
- **C11** M123's contract holds unchanged: a project whose tsconfig chain names a missing file under
  `.nuxt/` is still a hard preflight refusal with the `nuxi prepare` remedy
  (`m123-…:57-60`); a project whose `.nuxt/` is complete is still not refused, and nuxt.com must
  still reach the browser (`m123-…:61-62`); `.nuxt/` alone is never a reason to refuse
  (`m123-…:73-74`); and `nuxi prepare` is never printed for a repository that does not declare `nuxt`
  (`m123-…:78`).

### Stop-and-re-scope rule

- **C12** The falsifier the findings state for stage 2 is a stop condition, not a hypothesis to work
  around: **`@nuxt/ui` runtime components may require the Nuxt app context that a bare `createApp`
  does not provide.** If nuxt.com's `<UCarousel>` still fails after C3-C5 with an error that names a
  Nuxt context, injection or plugin (for example `nuxt instance unavailable`, `useNuxtApp`,
  `#app`), the lane **stops**, records the observed error verbatim in this spec's Verification, and
  re-scopes stage 2 to **locally defined components only** — entries whose module resolves inside the
  project's own source tree. The nuxt.com acceptance row then becomes "stops with a named
  Nuxt-context refusal that names `UCarousel` and the map file", which is C9's outcome, and the lane
  does not attempt to synthesise a Nuxt context.

  **C12 fired.** Registering `.nuxt/components.d.ts` in full let `<UCarousel>` resolve, and the
  module then failed to load with a Nuxt-context error the browser reported as a 500:

  ```
  [vite] Internal Server Error
  Missing "#imports" specifier in "@nuxt/ui" package
  response 500: GET http://localhost:5173/node_modules/.pnpm/@nuxt+ui@4.11.0_.../@nuxt/ui/dist/runtime/components/Carousel.vue
  Failed to fetch dynamically imported module: .../@nuxt/ui/dist/runtime/components/Carousel.vue
  ```

  `defineAsyncComponent` turns that load failure into a rejected promise, so the component rendered
  nothing and the run reported **PASS with `domNodeCount: 1` at every scale point** - a measurement
  of an empty tree. A silent pass is worse than the baseline's honest abort, which is exactly the
  outcome C12 exists to prevent. Stage 2 is therefore re-scoped as C3 now states: only an entry
  whose module resolves inside the project's own source tree is registered. A dependency's entry is
  named by `DEFERRED_COMPONENTS_WARNING`, which lists the deferred names the measured component's
  own source references.
## MUST NOT

- Execute the project's `vite.config`, `nuxt.config` or any project code. The maps are parsed as
  text; the plugin that injects is the harness's own
  (`src/harness/vite-config.ts:79-95`, `CHANGELOG:190`, `README:305`).
- Write anything into the target repository — no generated `d.ts`, no `.nuxt/` regeneration, no
  `nuxi prepare` invocation. The maps are read as they are found; a project that has none gets
  today's behaviour.
- Run the project's own `unplugin-auto-import` or `unplugin-vue-components` instances (option (a),
  refuted: it writes into the repository and contradicts `CHANGELOG:190`).
- Generate a `120fps.setup.vue` that replays `app.use` (option (c)). hoppscotch and vue-vben-admin
  stay with the hand-written `120fps.setup.vue` remedy that already exists.
- Resolve Nuxt composables through `.nuxt/imports.d.ts`. Those entries point at `#app/nuxt`, a
  virtual module with no file behind it; out of scope, recorded under Deferred.
- Change M123's refusal, its wording, or when it fires (C11).
- Register a component or prepend an import into a file in `node_modules` or outside the measured
  component's module graph.
- Silently supply an identifier: every stage that changes the module graph discloses what it changed
  (C5, C8).

## Verification

- **C1, C2** — `test/unit/the-vue-plugin-resolves-through-its-host-framework.test.ts`: a fixture that
  declares `nuxt` but not `@vitejs/plugin-vue`, with the plugin present only under the `nuxt` package
  directory, resolves and transforms an SFC; a fixture that declares the plugin directly is unchanged;
  a fixture where the plugin exists only via hoisting still warns; a fixture with no plugin anywhere
  produces today's refusal.
- **C14** — `test/unit/a-components-map-registers-its-components.test.ts`, "deciding which deferred
  names a component reaches for": the wg-easy `Form/Label.vue` shape names none of them; a template
  tag in either case form names one; a native element, a Vue built-in, an imported name, a local
  declaration, a template comment and a script string each name none.
- **C15** — `test/unit/a-registered-component-that-cannot-load-is-named.test.ts`: the entry
  registers with an `onError` that logs the prefixed line; the line is read back off a combo and off
  a curve point, deduped across both; an ordinary page error yields nothing; the warning names each
  component and its error.
- **C16** — same file: the map files a Vue component's run resolves through are listed, and a React
  component and a project without a map list none.
- **C3, C4, C5** — `test/unit/a-components-map-registers-its-components.test.ts`: a `components.d.ts`
  with a project-source entry, a dependency entry and an unresolvable entry registers the first,
  defers the second by name and skips the third by name; `.nuxt/components.d.ts` is parsed with the
  same shape, including its `LazyComponent<...>` wrapper; a deferred name is matched in the measured
  source in both `<UCarousel>` and `<u-carousel>` form; the measured component stays bound to its own
  module import, so an explicit import is never shadowed; a project with no map registers nothing.
- **C6, C7, C8** — `test/unit/an-auto-import-map-supplies-a-free-identifier.test.ts`: a module using
  `useCounter` freely gets `import { useCounter } from "@vueuse/core"` prepended; a module that
  already imports it is untouched; a module that declares `useCounter` at any scope is untouched; a
  name that appears only as a property or inside a string is untouched; a file in `node_modules`, a
  file outside the project, a style block and a virtual module are all refused as transform targets;
  the disclosure names the count and the map.
- **C9** — `test/unit/a-missing-identifier-names-the-map-consulted.test.ts`: an undefined identifier
  present in the map, and one absent from it, produce distinguishable hints, both naming the map file.
- **C10** — deferred, see the contract item: `test/unit/explain-props-parity.test.ts` is unchanged
  and still passes.
- **C11** — `test/unit/vue-support.test.ts`,
  `test/unit/nuxt-app-is-refused-or-reaches-the-first-measurement.test.ts` and
  `test/unit/nuxt-diagnosis-requires-nuxt.test.ts` are unchanged and pass: a Nuxt project with a
  missing `.nuxt/` file still refuses with `nuxi prepare`; a complete `.nuxt/` is not refused; a
  non-Nuxt project never sees `nuxi prepare`.
- **C13** — `test/unit/a-vue-file-is-covered-by-its-referenced-config.test.ts`: a references-only root
  whose referenced config includes `app/**/*` covers `app/components/Greeting.vue` and supplies its
  `paths`; the same config still covers a `.ts` file beside it; a target no referenced config
  includes still reports `no referenced config covers` and names what it tried.
- **C12** — recorded below: either nuxt.com reaches mount, or the verbatim Nuxt-context error and the
  re-scoped stage-2 contract.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus `test/unit/vue-support.test.ts`, `test/unit/project-transforms.test.ts`,
  `test/unit/nuxt-app-is-refused-or-reaches-the-first-measurement.test.ts`,
  `test/unit/nuxt-diagnosis-requires-nuxt.test.ts`,
  `test/unit/entry-selects-exports-at-runtime.test.ts`, then the full unit suite once before the
  lane's final commit.

Recorded run of this milestone's verification:

```
$ node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
(no output, exit 0)

$ npx vitest run     test/unit/the-vue-plugin-resolves-through-its-host-framework.test.ts     test/unit/a-components-map-registers-its-components.test.ts     test/unit/an-auto-import-map-supplies-a-free-identifier.test.ts     test/unit/a-missing-identifier-names-the-map-consulted.test.ts     test/unit/a-vue-file-is-covered-by-its-referenced-config.test.ts     test/unit/a-registered-component-that-cannot-load-is-named.test.ts --maxWorkers=2
 Test Files  6 passed (6)
      Tests  71 passed (71)

$ npx vitest run test/unit/module-ratchets.test.ts test/unit/module-boundaries.test.ts     test/unit/hints.test.ts test/unit/mount-abort-hints-name-read-evidence.test.ts     test/unit/project-transforms.test.ts     test/unit/nuxt-app-is-refused-or-reaches-the-first-measurement.test.ts     test/unit/entry-selects-exports-at-runtime.test.ts --maxWorkers=2
 Test Files  7 passed (7)
      Tests  83 passed (83)

$ npx vitest run test/unit --maxWorkers=2
 Test Files  2 failed | 375 passed (377)
      Tests  2 failed | 5334 passed | 1 skipped (5337)
   Duration  472.12s
# the two failures are the recorded pre-existing pair, confirmed in isolation:
$ npx vitest run test/unit/prop-cap-ranking.test.ts test/unit/vue-setup-inject-evidence.test.ts
 Test Files  2 failed (2)
      Tests  2 failed | 6 passed (8)
```

Corpus results, `dist` built in `C:/Projekte/120fps-run7-lane-g` at the review-fix commit, profile
`--samples 3 --max-combos 2 --explore-budget 30 --no-deltas`, logs under
`C:/Projekte/120fps-fieldtest/logs/run7-lane-g/<repo>/`:

| Repo | Component | Baseline | Observed | Stage |
|---|---|---|---|---|
| wg-easy | `app/components/Form/Label.vue` | setup-error, exit 2, 93 s | **PASS**, exit 0, 17.0 s; no hoisting warning; 206 project components registered from `src/.nuxt/components.d.ts`; no deferred line, because the map's `Label` occurs in this component only inside `import { Label as RLabel }` and `Slot` only as `<slot />` (C14) | 1 |
| scaffold-nuxt | `app/components/Greeting.vue` | pass with "found via a hoisted transitive install" | **PASS**, exit 0, 10.9 s; hoisting warning gone; `no referenced config covers` gone, replaced by `.nuxt/tsconfig.app.json covers app/components/Greeting.vue and supplies paths, jsxImportSource`; 2 components registered | 1, C13 |
| nuxt.com | `app/components/content/Carousel.vue` | setup-error, exit 2, 37 s; log never names `UCarousel` | exit 2, 48 s, same `Cannot destructure property 'item'` abort; 192 project components registered, and the run names what it declined: `.nuxt/components.d.ts maps ProseImg, UCarousel, which this component's source references, to modules inside a dependency … 600 further entries are in the same class.` Both tags are written in this SFC's `<template>` (`:9` and `:8`). | 2, C12 |
| vitesse | `src/components/TheCounter.vue` | diagnosed-error, exit 2, 4 s (`useCounter is not defined`) | **PASS**, exit 0, 39.5 s; 4 DOM nodes, 9 interactions; `src/auto-imports.d.ts maps 305 auto-imported identifiers`, 3 components registered, 1 entry skipped (`README`, a `.md` module) | 3 |
| vue3-element-admin | `src/components/Fullscreen/index.vue` | diagnosed-error, exit 2, 6 s | **PASS**, exit 0, 12.8 s; `types/auto-imports.d.ts maps 296 auto-imported identifiers`, 40 components registered | 3 |
| it-tools | `src/ui/c-modal/c-modal.demo.vue` | diagnosed-error, exit 2, 4 s | **PASS**, exit 0, 11.0 s; 153 components, 280 identifiers; `generatedMaps` in the report names both files (C16). The run also discloses a page error from the project's own `src/ui/c-button/c-button.vue:51`, `Cannot access 'size' before initialization`; `size` appears in no entry of `auto-imports.d.ts`, so the injector cannot be its source, and the earlier abort had hidden it. | 3 |
| uptime-kuma (control) | `src/components/Tag.vue` | setup-error, exit 2 | unchanged class: setup-error, exit 2, 5 s, carrying M129's `sass 1.42.1 … does not define it. Install sass 1.45.0 or newer` diagnosis; no map lines | control |
| vue-pure-admin (control) | `src/views/components/slider/components/Input.vue` | pass-warn, exit 0 | unchanged: PASS, exit 0, 25.6 s, 4 warnings, `generatedMaps` absent (the project has no generated map at a searched path) | control |

No repository in the corpus produced a `could not be loaded by the browser` warning (C15) after stage 2
was re-scoped, which is the expected result: every registered module is now a file in the project's
own source tree.

`git status --porcelain` in every target repository is unchanged by these runs. `vue3-element-admin`
(`pnpm-lock.yaml`) and `uptime-kuma` (`package-lock.json`) carry a pre-existing lockfile edit that
predates the lane.

## Deferred

- **Nuxt composables through `#imports`.** `.nuxt/imports.d.ts` resolves to `#app/nuxt`, a virtual
  module with no file behind it; nothing on disk can be imported for it. Explicitly out of scope.
- **`app.use` plugin replay** (option (c)). hoppscotch (vue-i18n) and vue-vben-admin
  (`<RouterView v-slot>`) stay with the hand-written `120fps.setup.vue` remedy. Auto-generating one
  is opt-in at best and has the highest failure surface of the four options.
- **nocodb.** `nuxi prepare` genuinely refuses it (`.nuxt/tsconfig.json` absent); M123's refusal is
  accurate and stays.
- **soybean-admin, vue-pure-admin, uptime-kuma.** They pass because the picked leaf touches no
  auto-import; they are controls here, not targets.
- **A Nuxt app context for a dependency's runtime components.** C12 fired, so this is what nuxt.com
  would need, and it is a new milestone with its own evidence, not a widening of this one. Its first
  requirement is the one this lane found the hard way: an async component that fails to load must
  fail the run instead of rendering nothing and passing.
- **Dry/real parity for the map disclosures (C10).** `src/pipeline/explain-props.ts` belongs to
  lane D; the hunk is described in C10 and is an interface request to the coordinator.
- **A per-module count of prepended imports (C8's original wording).** The harness result's warning
  list is consumed before the page loads, so the count of identifiers actually supplied has no
  channel to reach the report. C8 states what the run does state: the map file and the size of its
  table.
