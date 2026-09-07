---
kind: decision
status: accepted
---

## Context

A Vue application built with Vite rarely writes down where its components and composables come from.
`unplugin-auto-import` and `unplugin-vue-components` make `useCounter`, `toRefs`, `<TheCounter>` and
`<UCarousel>` available without an import statement; Nuxt does the same for everything under
`components/` and for its module ecosystem. The identifiers are resolved at build time by plugins
configured in the project's `vite.config` or `nuxt.config`.

120fps mounts the measured component in a harness it builds itself. The Vue mount is a bare
`createApp` (`src/harness/entry.ts:308`), and the harness never executes the project's Vite config —
a policy line recorded in `CHANGELOG:190`, `README:305` and enforced at
`src/harness/vite-config.ts:79-95`. What the harness *does* do is load a curated set of the project's
own plugin packages from the project's `node_modules`, with harness-chosen options
(`src/project/transforms.ts:17-25`, `:86-111`, `src/harness/build.ts:303-309`). Loading a plugin
package and executing a config file have always been two different things here.

Field test run 7 (2026-09-06) inventoried twelve Vue repositories against 0.7.0
(`C:/Projekte/120fps-fieldtest/smoke/run7-FINDINGS.md`, cluster 8). Five are blocked by auto-imports:
vitesse, vue3-element-admin and it-tools fail with `ReferenceError: useCounter / useFullscreen /
toRefs is not defined`; nuxt.com's `<UCarousel v-slot="{ item }">` fails with `Cannot destructure
'item'` and the log never names `UCarousel`; wg-easy cannot compile a `.vue` file at all. Two more
(hoppscotch, vue-vben-admin) are blocked by `app.use` plugin registration, which is a different
problem. Three pass only because the component that was picked happens to touch no auto-import.

The information those five runs need is already on disk, git-tracked, and written by the project's
own tooling as a name-to-module table:

- `.nuxt/components.d.ts:184` —
  `export const UCarousel: typeof import("…/@nuxt/ui/dist/runtime/components/Carousel.vue")['default']`
- `src/auto-imports.d.ts:151` (vitesse) — `const useCounter: typeof import('@vueuse/core').useCounter`
- `types/auto-imports.d.ts:189` (vue3-element-admin), `auto-imports.d.ts` (it-tools)
- `components.d.ts` — `TheCounter: typeof import('./components/TheCounter.vue')['default']`,
  `ElAlert: typeof import('element-plus/es')['ElAlert']`

Four options were compared.

| Option | Fit | Risk | Cost | Reversibility | Maintenance |
|---|---|---|---|---|---|
| (a) run the project's own AutoImport / Components plugin instances | exact | contradicts `CHANGELOG:190`; writes `d.ts` files into the user's repository | high | poor | tracks two plugins' option surfaces |
| (b) parse the generated `d.ts` maps into a name→module table and inject through a harness-owned Vite plugin | covers 5 of 5 blocked repos in stages | a map may name a module that needs a runtime context the harness lacks | medium | good, staged | one text parser per map shape |
| (c) auto-generate a `120fps.setup.vue` replaying `app.use` | covers a different set (hoppscotch, vben) | highest failure surface | high | good | replays arbitrary project code |
| (d) wording only | none | none | low | n/a | none — zero repositories move |

Option (b) contradicts no MUST in M107, M108 or M123, and it advances M123's "nuxt.com must still
reach the browser". Options (a) and (c) are refused; (c) stays available as an opt-in remedy that
already exists in hand-written form (`WRAPPER_CANDIDATES`, `src/harness/exports.ts:21`).

## Decision

1. **A generated declaration file is an input to module resolution, not documentation.** When a Vue
   project has `components.d.ts`, `.nuxt/components.d.ts` or `auto-imports.d.ts` on disk, 120fps
   parses it as a name-to-module table and uses it to resolve what the project's build would have
   resolved.
2. **The maps are read as text; nothing in the project is executed.** No `vite.config`, no
   `nuxt.config`, no plugin instance of the project's own. The injection is performed by a
   harness-owned Vite plugin in the harness's own plugin list (`src/harness/build.ts:267`). This
   decision does **not** change the policy that the project's `vite.config` is never executed
   (`CHANGELOG:190`, `README:305`, `src/harness/vite-config.ts:79-95`) — that line stands exactly as
   written.
3. **Nothing is written into the target repository.** The maps are consumed where they are found. A
   project without them behaves as it does today; 120fps never generates them, never runs
   `nuxi prepare`, and never regenerates `.nuxt/`.
4. **Only what is on disk is resolvable.** An entry whose module does not resolve is skipped and
   disclosed. Nuxt composables declared in `.nuxt/imports.d.ts` point at `#app/nuxt`, a virtual module
   with no file behind it, and are therefore out of scope.
5. **Scope is the project's own source.** An identifier is supplied only to a module under the
   project root and outside `node_modules`, never to a module that already imports or declares it,
   and never to the harness's own directory. A component is registered only when its module resolves
   inside the project's own source tree. Component registration is additive and never shadows an
   explicit import.
6. **Every injection is disclosed.** The run states which map it read, how many entries it used, and
   which it skipped. When an identifier is still undefined at render time, the hint names the map it
   consulted (`src/report/hints.ts:227-237`).
7. **A framework may supply a transform its dependent does not declare.** `@vitejs/plugin-vue`
   resolved through the `nuxt` or `vite` package directory is a legitimate resolution, not a hoisting
   accident, and is not warned about as one.
8. **Staged, with a stop condition.** The four stages are ordered by evidence strength: plugin
   resolution, component registration, identifier injection, hint wording. If a registered component
   fails for want of a runtime framework context, the stage is re-scoped to locally defined components
   rather than extended to synthesise that context (M136 C12).

## Consequences

- `src/project/generated-declarations.ts` owns the parsing. It reads a declaration file with the
  TypeScript parser (`ts.createSourceFile`) and never builds a program: these files are read whether
  or not the measured component's program includes them, and a program would cost a type check the
  answer does not need. Three written shapes carry the same fact and all three are read:
  `declare global { const X: typeof import('m').X }`,
  `declare module 'vue' { interface GlobalComponents { X: typeof import('m')['default'] } }`, and
  Nuxt's `export const X: typeof import("m")['default']`, each also in its parenthesised form
  `(typeof import("m"))["X"]` and inside a wrapper generic such as `LazyComponent<...>`.
- The harness's Vue entry gains a registration block before `createApp`
  (`src/harness/entry.ts`, `vueGlobalComponentBlock`), and the harness's plugin list gains one
  transform (`autoImportTransformPlugin`), pushed after the project's own plugins so the SFC it
  reads is already compiled JavaScript. The prepended imports occupy no line of their own, so every
  line number the browser reports still points at the source line that produced it.
- **A dependency's component is not registered.** Registering `@nuxt/ui`'s `<UCarousel>` from
  `.nuxt/components.d.ts` made it resolvable and then unloadable
  (`Missing "#imports" specifier in "@nuxt/ui" package`), and `defineAsyncComponent` swallowed that
  into a rejected promise: the run passed while measuring an empty tree. Only the project's own
  source is registered; a dependency's entry is disclosed by name instead. This is decision item 8's
  stop condition firing on its first exercise (M136 C12).
- A Vue project whose maps are stale, regenerated by a build the developer has not run, resolves to
  what the map says. This is the same staleness the project's own editor tooling lives with, and it
  is disclosed by decision item 6.
- The maps' shapes are set by two third-party plugins and by Nuxt. A shape change breaks parsing, so
  the parser fails soft: a line it does not recognise yields no entry and costs nothing else, and an
  unreadable file yields an empty table.
- Reading a map is cached by path and mtime, so a rebuilt harness does not re-parse a 700-entry
  Nuxt table.
- `@vitejs/plugin-vue` reached through a declared framework is a bounded search: a package inside
  that framework's own dependency closure must *declare* the plugin and resolve it. A copy that only
  sits on the shared resolution path is still the hoisting accident the existing warning names.
- A `.vue` file is now globbed by the governing-tsconfig walk (`extraFileExtensions`), so a
  references-only root config resolves to the referenced config that includes the component.
- `nocodb` stays refused: `nuxi prepare` genuinely has not run there, `.nuxt/tsconfig.json` is absent,
  and M123's refusal is accurate.
- hoppscotch and vue-vben-admin are not addressed. Their blocker is `app.use`, which option (c) would
  cover and which stays with the hand-written `120fps.setup.vue` remedy.
- If a future decision does want the project's plugin instances, it supersedes this one; this ADR does
  not open that door.
