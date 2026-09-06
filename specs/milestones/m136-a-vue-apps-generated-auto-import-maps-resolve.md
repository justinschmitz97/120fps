---
kind: milestone
status: draft
tests:
  - test/unit/vue-support.test.ts
  - test/unit/the-vue-plugin-resolves-through-its-host-framework.test.ts
  - test/unit/a-components-map-registers-its-components.test.ts
  - test/unit/an-auto-import-map-supplies-a-free-identifier.test.ts
  - test/unit/a-missing-identifier-names-the-map-consulted.test.ts
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

- **C3** When a Vue project has a components declaration map on disk — `components.d.ts`,
  `.nuxt/components.d.ts`, or the path a `components.d.ts`-shaped file is written to — the harness
  parses it into `name → { module, exportName }` entries and registers each one before mount
  (`src/harness/entry.ts:308`) as
  `app.component(name, defineAsyncComponent(() => import(module)))`.
- **C4** Registration is additive and never shadows: a component the measured module graph imports
  explicitly wins over the map's entry of the same name.
- **C5** A map entry whose module cannot be resolved is skipped, and the run says which entries were
  skipped and from which map.

### Stage 3 — an auto-import map supplies a free identifier

- **C6** When a Vue project has an auto-import declaration map on disk (`auto-imports.d.ts`, or the
  path the project's config writes it to, including `types/auto-imports.d.ts`), the harness parses it
  into `identifier → { module, exportName }` and, through a harness-owned Vite plugin in the list at
  `src/harness/build.ts:267`, prepends the corresponding import to a module that references the
  identifier freely.
- **C7** The transform is scoped to the measured component's own module graph. A file outside that
  graph, a file in `node_modules`, and a file that already imports or declares the identifier are all
  left untouched.
- **C8** The prepended imports are disclosed: the run states how many identifiers it supplied and
  from which map file.

### Stage 4 — the hint names the map

- **C9** When an identifier is still undefined at render time, the hint names the map file the run
  consulted and whether the identifier was in it. `vitePluginsNotExecuted`
  (`src/report/hints.ts:227-237`) keeps its meaning and gains that sentence.

### Across all stages

- **C13** A Nuxt project whose tsconfig chain covers the measured component through a generated
  config reports that coverage instead of refusing to find one. The verifier for the gap:
  scaffold-nuxt's run prints
  `no referenced config covers app/components/Greeting.vue (tried .nuxt/tsconfig.app.json…)` although
  `.nuxt/` is present and complete. When no config covers the component, the message names the
  generated configs it tried and the `nuxi prepare` remedy M123 already owns; it never claims a
  refusal M123 forbids (C11).
- **C10** Dry/real parity (M100, M110): `--explain-props` reports the same maps found, the same
  entry counts, and the same skipped entries as the real run.
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
- **C3, C4, C5** — `test/unit/a-components-map-registers-its-components.test.ts`: a `components.d.ts`
  with a relative entry, a package entry and an unresolvable entry registers the first two, skips the
  third and names it; `.nuxt/components.d.ts` is parsed with the same shape; a component the graph
  imports explicitly is not shadowed; a project with no map registers nothing.
- **C6, C7, C8** — `test/unit/an-auto-import-map-supplies-a-free-identifier.test.ts`: a module using
  `useCounter` freely gets `import { useCounter } from '@vueuse/core'` prepended; a module that
  already imports it is untouched; a module that declares a local `useCounter` is untouched; a file
  in `node_modules` is untouched; a file outside the component's graph is untouched; the disclosure
  names the count and the map.
- **C9** — `test/unit/a-missing-identifier-names-the-map-consulted.test.ts`: an undefined identifier
  present in the map, and one absent from it, produce distinguishable hints, both naming the map file.
- **C10** — extend `test/unit/explain-props-parity.test.ts`: the dry run reports the same maps, counts
  and skips.
- **C11** — extend `test/unit/vue-support.test.ts` and the M123 tests: a Nuxt project with a missing
  `.nuxt/` file still refuses with `nuxi prepare`; a complete `.nuxt/` is not refused; a non-Nuxt
  project never sees `nuxi prepare`.
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
<filled by lane G: tsc result, the vitest invocations and their verbatim totals,
 and — for C12 — either nuxt.com reaching mount or the verbatim Nuxt-context error>
```

Corpus repros, through a `dist` built in `C:/Projekte/120fps-run7-lane-g`:

```
# stage 1
node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run7/wg-easy/src \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-g/wg-easy \
  --label m136-wg-easy --cli C:/Projekte/120fps-run7-lane-g/dist/cli/main.js \
  -- app/components/Form/Label.vue --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: the SFC compiles (baseline: 500 -> readiness timeout, exit 2, 93 s)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run7/scaffold-nuxt \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-g/scaffold-nuxt \
  --label m136-scaffold-nuxt --cli C:/Projekte/120fps-run7-lane-g/dist/cli/main.js \
  -- app/components/Greeting.vue --samples 3 --max-combos 2 \
     --explore-budget 30 --no-deltas
# expected: passes with no "hoisted transitive install" warning.
#   Note: smoke/run7-new1/scaffold-nuxt.json records class `no-candidate` with an empty
#   candidates array; the component above and the baseline behaviour come from the
#   investigator's manual run, not from the smoke row.

# stage 2
node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/nuxt.com \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-g/nuxt.com \
  --label m136-nuxt-com --cli C:/Projekte/120fps-run7-lane-g/dist/cli/main.js \
  -- app/components/content/Carousel.vue --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: reaches mount, or stops with a named Nuxt-context refusal naming UCarousel and
#           .nuxt/components.d.ts (C12 stop-and-re-scope)

# stage 3
node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run5/vitesse \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-g/vitesse \
  --label m136-vitesse --cli C:/Projekte/120fps-run7-lane-g/dist/cli/main.js \
  -- src/components/TheCounter.vue --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: reaches a report; useCounter resolves via src/auto-imports.d.ts (baseline exit 2, 4 s)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/vue3-element-admin \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-g/vue3-element-admin \
  --label m136-vue3-element-admin --cli C:/Projekte/120fps-run7-lane-g/dist/cli/main.js \
  -- src/components/Fullscreen/index.vue --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: reaches a report (baseline exit 2, 6 s)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run7/it-tools \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-g/it-tools \
  --label m136-it-tools --cli C:/Projekte/120fps-run7-lane-g/dist/cli/main.js \
  -- src/ui/c-modal/c-modal.demo.vue --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: reaches a report (baseline exit 2, 4 s)

# controls: uptime-kuma, soybean-admin, vue-pure-admin unchanged from run7-smoke1 / run7-new1
```

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
- **A Nuxt app context for `@nuxt/ui` runtime components.** If C12 fires, this is what would be
  needed, and it is a new milestone with its own evidence — not a widening of this one.
