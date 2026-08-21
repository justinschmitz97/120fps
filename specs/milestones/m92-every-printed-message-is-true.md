---
kind: milestone
status: draft
---

# M92: every printed message is true of the run

## Purpose

Cross-lane sweep, run last, single worker. Waves 1-3 (M84-M91) and Lane A's own M93-M95 fix
measurement behavior and mechanism; M92 audits every message those mechanisms print and fixes the
ones that can be false, without changing what is measured. Closes: dub-F2, twenty-F3,
element-plus-F3, excalidraw-F6, mantine-F2 (text half, already correct via M93), calcom-F3 (already
correct via M94), plus the nuxt-ui `--explain-props` join gap M95's full-run fix did not reach.

### MUST (verbatim from `specs/milestones/M84-M96-MAP.md`)

- Every message states something true of the run that produced it.
- A deliberate scope exclusion is worded as an exclusion, never as a possible failure.
- A message naming files individually reports each file's actual status.

### MUST NOT

- Rewrite a message for style, tone, or brevity when its claim is already true.
- Change what is measured, synthesized, or gated to make a message easier to keep true (a predicate
  fix that would alter measurement behavior is out of scope; record it as a proposed follow-up
  instead).
- Report an empty prop schema (any extraction path, dry run or full run) without naming the
  resolution failure that produced it, when one is known.

### Invariants

- Every user-facing string is checked against the code path that decided to print it, not against
  the string's own plausibility.
- A batch message (naming several files/candidates at once) is true of every member it names, not
  true on average.

## Design

Four confirmed-false messages, each fixed at its source rather than reworded around:

1. **dub-F2** (`CSS_PLACEHOLDER_SKIPPED_WARNING`, `src/harness.ts`). `stylesheetRuleCount` counts
   brace-delimited rules after stripping comments and `@import`/`@charset`/`@use`; a rule count of 0
   does not mean the file's content *is* comments and imports -- a pure `@tailwind` passthrough (three
   at-rules, zero comments, zero imports) also counts 0. The message no longer asserts a specific
   composition it did not check for; it states what the predicate actually proved (no rule with a
   body survived) and names examples (comments, imports, bare at-rules) without claiming any one of
   them is what's present.

2. **twenty-F3** (`CSS_IMPORT_SKIPPED_WARNING`, `src/harness.ts`). `resolveStylesheetSpecifier`
   never attempted node_modules-style resolution for a bare package specifier
   (`twenty-ui/theme-light.css`), so every bare specifier in a batch was unconditionally reported
   "resolved to no file" even when most of them resolve fine. `resolveBareStylesheetSpecifier` now
   resolves through the package's own `exports` map (exact subpath match, `default`/`import`/
   `require`/`style` conditions) or, absent an `exports` map, a direct join -- real resolution, so the
   warning's batch only ever names specifiers that are genuinely unresolvable.

3. **element-plus-F3** (`src/prop-gen.ts`, `src/analyze.ts`). ADR 0002 excludes two Vue prop forms:
   Options-API (`props: {}`/`extends`/`mixins`) and `<script setup>` runtime-object
   `defineProps({...})`. Only the first had a dedicated disclosure (`VUE_OPTIONS_API_PROPS_WARNING`);
   the second (`extractVueProps`'s `!call` vs `call` distinction inside the `!call?.typeNode` branch)
   fell through silently, so its zero-prop count reached the generic `ZERO_PROPS_WARNING`
   ("extraction may have failed") -- a possible-malfunction framing for a documented, deliberate
   exclusion. `VUE_RUNTIME_DEFINE_PROPS_WARNING` gives it the same register as the Options-API case,
   and `isVuePropsScopeExclusionWarning` recognizes either form so `disclosureReason: "propsExcluded"`
   fires for both. Both `runComboMode` and `explainProps` also stopped stacking the generic
   `ZERO_PROPS_WARNING` on top of a scope-exclusion disclosure that already explains the same zero
   count -- the stacked pair was reproducible for the *pre-existing* Options-API case too (verified
   directly), not only the newly-fixed runtime-form case.

4. **excalidraw-F6** (`CSS_FALLBACK_WARNING`, `src/harness.ts`). The largest-stylesheet fallback's
   `noEntryInPackage` clause said the pick "has no evidence behind it at all," overclaiming: the same
   sentence already states the real basis (`it is the largest stylesheet found under this project`).
   What is actually missing is import-chain corroboration, not evidence outright. Reworded to name
   that precisely (`no import chain corroborates the pick -- it is ranked by size alone`) without
   implying the pick is arbitrary.

5. **nuxt-ui `--explain-props` join gap** (`src/analyze.ts`). `explainProps` never called
   `loadTsconfigAliases`, the function that produces `TSCONFIG_EXTENDS_BROKEN_WARNING` -- Lane A's M95
   fix reached only the full-run path (`buildAndServe`), which does call it. A dry run on a broken
   `extends` chain reported "0 props" with no cause in the same warnings list. `explainProps` now
   calls `loadTsconfigAliases(projectRoot, warnings)` alongside its other read-only, no-browser probes
   (framework/CSS/wrap), matching full-run parity.

6. **dub provider-hint mis-scoping and detection gap** (`src/preflight.ts`, `src/analyze.ts`,
   `src/hints.ts`). A render failure's `component imports X: likely needs a provider wrapper` hint is
   built from `report.providerCandidates`, sourced from `runPreflight`'s one combined walk over
   `entries = [harnessPath, wrapPath?]`. The walk does not distinguish which seed discovered which
   provider hit, so a hit reachable only through the wrapper's own graph got the same "component
   imports" wording as one the measured component actually imports.
   `providersFromEntry(hits, entryRelative)` filters to hits whose `chain[0]` (the seed `chainTo`
   walked back to) is the component's own entry; a wrapper-only hit is silently excluded rather than
   mislabeled, matching this codebase's existing "a wrong guess is worse than no guess" rule for the
   same hint. When the captured error names a specific `XxxProvider`/`XxxContext` symbol,
   `rankProviderCandidates` (hints.ts) moves a matching surviving candidate to the front of the guess
   list -- reordering only, never adding or removing a candidate.

   Verified against dub's real `packages/ui/src/tooltip.tsx`: scoping and ranking were both already
   correct, but had nothing to act on. `TooltipProvider` there is `export function TooltipProvider({
   children }) { return <TooltipPrimitive.Provider ...>{children}</TooltipPrimitive.Provider>; }` --
   zero `createContext`, zero `throw new Error` -- so `detectLocalProviderModule`'s shape never
   matched it, and `@radix-ui/react-tooltip` was absent from `PROVIDER_LIBRARIES`, so
   `detectProviderImport` never matched it either. `TooltipProvider` was never a candidate at all.
   Two additions close this: `detectWrapperProviderModule` recognizes the generic "thin re-export/
   wrapper around another package's already-created Provider" shape -- an exported `*Provider`
   component whose body renders JSX ending in `Provider` (bare `<XProvider>` or namespaced
   `<XPrimitive.Provider>`) -- text-only, same convention as `detectLocalProviderModule`, and
   explicitly deferred to `detectLocalProviderModule` whenever the file has its own `createContext`
   (React's own `Context.Provider` also ends in "Provider"; a context with a benign default that
   never throws must still not be flagged, unchanged). `PROVIDER_LIBRARY_SCOPES` complements
   `PROVIDER_LIBRARIES`'s exact-name map with scope-prefix matching for headless-UI kits that ship
   many packages instead of one (`@radix-ui/*`, the one scope actually evidenced) -- no invented hook
   name, no other kit added without the same evidence.

   A second, real gap surfaced verifying against real source: dub's `tooltip.tsx:12` imports
   `PROSE_STYLES` from `./rich-text-area`, an unrelated named export -- `rich-text-provider.tsx` is
   therefore genuinely reachable from the component's own graph, two hops out, and `providersFromEntry`
   correctly keeps it (a real candidate must not be filtered away). What was false was the wording:
   `component imports X` overclaims a direct relationship for a two-hop transitive reach. `isDirectProviderHit`
   (`src/preflight.ts`) computes hop count from a hit's `chain` (accounting for the one-hop offset
   between a local hit, whose chain ends at the provider file itself, and an external-package hit,
   whose chain ends at the file that imports the package); `analyze.ts` publishes the transitive subset
   as `report.transitiveProviderCandidates` (additive, `providerCandidates` itself unfiltered and
   unchanged); `hints.ts`'s `extraHintLines` picks `PROVIDER_HINT_LINE_TRANSITIVE` ("component's import
   graph reaches X") instead of `PROVIDER_HINT_LINE` ("component imports X") per candidate, by set
   membership -- ranking (which candidate leads) is unaffected either way.

7. **heroui `__120fps_preset` leak** (`src/analyze.ts`). A preset pool's non-literal entry (a
   function/JSX/variable reference the preset file's AST alone cannot read as a value) is stored as a
   `PresetRef` sentinel (`{__120fps_preset, index}`), resolved only once the real preset module loads
   in the browser. `explainValue` serialized it with a plain `JSON.stringify`, leaking the internal
   key into the displayed value column. Now recognized via `isPresetRef` and shown as
   `[preset value]`, matching the existing `[Function]` convention for another value dry-run cannot
   read.

## Open questions

None.

## Verification

- `test/unit/stylesheet-candidate-validation.test.ts`: dub-F2 fixture (three `@tailwind` at-rules,
  zero comments/imports) asserts the corrected wording and the absence of "only comments and
  imports".
- `test/unit/entry-stylesheet-discovery.test.ts`: twenty-F3 fixture (an `exports` map naming two real
  subpaths and one missing one) asserts only the missing one is named, and the two real ones resolve
  and are injected.
- `test/unit/vue-support.test.ts`: element-plus-F3 fixture (`RuntimeProps.vue`) asserts the scope-
  exclusion warning fires and `ZERO_PROPS_WARNING` does not stack on top of it, for both Vue exclusion
  forms.
- `test/unit/stylesheet-candidate-validation.test.ts`: excalidraw-F6 regression asserts the corrected
  wording names the ranking basis and does not claim "no evidence ... at all".
- `test/unit/tsconfig-extends-broken.test.ts`: nuxt-ui-shaped fixture asserts `explainProps` includes
  `TSCONFIG_EXTENDS_BROKEN_WARNING` when the tsconfig chain is broken and the component's own props
  come out empty, and does not fire when the chain resolves.
- `test/unit/dx-features.test.ts`, `test/unit/hints-captured-error.test.ts`: provider-hint scoping and
  ranking, both with real fixtures and hand-built reports. `fixtures/m92-item-b/` mirrors dub's real
  shape directly (a wrapper-shape local `TooltipProvider`, the `@radix-ui/react-tooltip` it wraps, an
  unrelated wrapper-only `rich-text-provider.tsx`, and a clean two-hop `deep-entry.tsx` ->
  `deep-middle.tsx` -> `deep-provider.tsx` chain isolated from any wrapper-entry ambiguity):
  `detectWrapperProviderModule` recognizes the wrapper shape and defers to `detectLocalProviderModule`
  whenever the file has its own `createContext` (regression: `fixtures/m65/theme-store.tsx`'s
  never-throwing local context must still not be flagged); `detectProviderImport` matches
  `@radix-ui/*` by scope with no invented hook, an exact `PROVIDER_LIBRARIES` entry still wins, and an
  un-evidenced package matches neither; `isDirectProviderHit` is boundary-tested for both local and
  external hits at one hop and more; end to end, the component's own hits (local wrapper + wrapped
  package) survive scoping while the wrapper-only hit is excluded, ranking still promotes the
  symbol-matching candidate among discovery-produced (not hand-typed) labels, and a two-hop reach is
  kept as a candidate but worded "component's import graph reaches X", never "component imports X" --
  with a direct/transitive mix getting per-candidate wording and the no-`transitiveProviderCandidates`-
  field case behaving exactly as before this fix.
- `test/unit/dx-features-harden.test.ts`: the `PresetRef` leak, using the existing preset fixture's
  function-valued entry.

## Also fixed under other milestones this session (not in M92's own contract)

Investigation and further live-corpus verification during this session surfaced additional false-
or-incomplete messages and reliability gaps outside M92's four named findings. Each was fixed in the
file(s) its own milestone already owns; recorded here only for traceability, since M92 is the final
milestone in this run and no later spec sync will catch them otherwise.

- **M94** (`src/harness.ts`, `src/analyze.ts`, `src/cli.ts`): the diagnosis-and-strip pipeline
  (`diagnoseUnbuiltWorkspacePackage`/`diagnoseMissingShimExport`/`diagnoseGitignoredGeneratedFile`/
  `diagnoseNuxtBuildModule`/`diagnoseBundlerFailure`/`stripBundlerStackFrames`) was wired only into
  `buildAndServe`'s synchronous boot catch. Extracted into one shared `presentBundlerFailure` and
  routed through two more failure-arrival surfaces: the page-error channel (a transform failing after
  a successful boot -- twenty's sass `Undefined mixin`, shadcn-ui's postcss ENOENT and Vite
  import-resolve failure) via `analyze.ts`'s outer catch, and the async unhandled-rejection surface (a
  fire-and-forget Vite dependency-optimizer rejection arriving after `buildAndServe` already resolved
  -- ant-design's `./version`) via `cli.ts`'s `resolveFatalProcessError`. `stripBundlerStackFrames`
  itself became conservative: it strips only a frame whose path is inside 120fps's own installation,
  keeping any frame into the target repository, since the page-error surface can carry a genuine
  application stack a user needs.
- **M95** (`src/harness.ts`): `NUXT_BUILD_MODULE_MISSING_ERROR` always advised `nuxi prepare` even when
  `.nuxt/` already existed on disk -- a user who ran the advised command got the byte-identical remedy
  back. Now checks `.nuxt/` existence first; when present, names that this module's own generated
  templates are still missing (a root-level prepare does not always run every module's own hooks) and
  points at a discovered `package.json` script (reusing `findLikelyGenerateCommand`) or, absent one, at
  the repo's own scripts, rather than repeating unverified advice.
- **M89** (`src/measure.ts`): `withFrameStarvationRetry`'s own recovery call, `enter()`, was unguarded
  -- a starvation inside `enter()`'s independent style-settle fence escaped the function entirely,
  aborting the whole pass one frame above the exact failure this retry exists to prevent. `enter()` is
  now inside the guarded region and a starvation there counts against the same bounded retry budget.
- **M86** (`src/prop-gen.ts`): `extractFunctionFromInitializer` did not unwrap an `as`/`satisfies`
  assertion or follow a same-file identifier alias (`const Button = InternalButton as
  CompoundedButton`), so Tier-0's source-reference scan never saw the real implementation's
  `props.onClick` reference and `onClick` fell to Tier-3 volume. Both are now unwrapped/followed
  (depth-bounded against a pathological alias cycle) before the existing HOC-call-unwrap check.
- **M91** (`src/composition.ts`, `src/analyze.ts`): `scanJsxComposedLocalImports` excluded every
  non-`.`-prefixed import specifier outright, so a baseUrl-relative bare specifier composed child
  (`import { Carousel } from 'components/carousel'`, commerce's real shape) was invisible to the RSC
  one-hop gate. The scanner now collects every non-type-only import used as a JSX tag; classification
  (local project file vs. real npm dependency) moved to `resolveRelativeJsxChild`, which resolves a
  bare specifier through the same tsconfig `baseUrl`/`paths` machinery (`ts.resolveModuleName`) the
  rest of the import-graph walk already uses, and excludes anything that resolves into `node_modules`.

## Investigated, not changed

- **M93, material-ui's `@mui/icons-material/*` alias (1.5c).** Verified directly:
  `test/unit/wildcard-alias-capture.test.ts`'s existing "extension-suffixed target wildcard
  (material-ui shape)" case builds the correct `find`/`replacement` pair and resolves a real file on
  disk. The alias mechanism works; the warning going silent in a later run is correct (no false
  warning), not a lost disclosure. The persisting `React is not defined` crash on `Autocomplete.js`/
  `Chip.js` has a separate, unidentified cause -- out of this milestone's scope.
- **M88, force-killing a hung browser child on teardown timeout (1.5b).** Investigated:
  `chromium.launch()`'s returned `Browser` (what `createBrowserPool` uses) exposes no process handle
  or kill method in the installed `playwright-core@1.59.1`'s public API --
  `.process()`/`.kill()` exist only on `BrowserServer`, the return type of the unrelated
  `chromium.launchServer()` API, and the client-side `Browser` object holds no process reference at
  all (the actual spawn happens through playwright-core's private, non-exported server-side
  internals). Achieving this would require switching the whole browser-pool architecture to
  `launchServer()`/`connect()`, a materially larger and riskier change to a path every measurement
  goes through, unverifiable here without a real hang to reproduce against (no `pnpm build`, no
  corpus runs). Left as a documented limitation.
- **M87, primevue Accordion.vue's two-level Options-API `extends` chain (Item 4).** Not attempted.
  The generated entry code is confirmed correct (verified live: `h(Accordion, {...props}, { default:
  () => [] })` is served and matches the working single-level case). The remaining defect is in how
  Vue's own `extends` chain resolution (`Accordion -> BaseAccordion -> BaseComponent`) binds
  `this.$slots` for a method inherited two levels up -- a question about Vue runtime behavior this
  milestone's tooling did not reach a way to verify without a real browser/DOM run, which is out of
  this task's scope (no e2e).
