---
kind: milestone
status: draft
tests:
  - test/unit/unbuilt-workspace-source-alias.test.ts
  - test/unit/unresolved-alias-reporting.test.ts
  - test/unit/preflight.test.ts
  - test/unit/the-preflight-walk-crosses-into-an-unbuilt-sibling.test.ts
  - test/unit/an-unbuilt-sibling-contributes-its-types.test.ts
  - test/unit/an-alias-is-resolved-against-its-own-tsconfig.test.ts
---

# M130: an unbuilt workspace sibling is walked, typed and aliased as its own package

Lane B (`src/project/preflight.ts` walk, `src/harness/deps-scan.ts`,
`src/project/compiler-options.ts`, `src/project/tsconfig-aliases.ts`, `src/harness/prebuild.ts`,
`src/props/classify.ts`, `src/props/candidates.ts`).

## Purpose

A monorepo app imports its siblings by package name, and in a fresh clone those siblings have no
`dist/`. Three subsystems answer that shape three different ways. The harness's dependency scan
crosses into the sibling's source and aliases it. The preflight walk stops at the package boundary,
so every gate that protects the run — the unloadable-file-type gate above all — never sees the
imports behind it. The TypeScript compiler options carry no `paths` for the sibling, so a type that
crosses the boundary silently becomes nothing and the props derived from it disappear. And one alias
table, read from the measured package, is applied to files in other packages, producing 149 false
"stale alias" warnings on a single repository. After this milestone all three read the same
workspace: the walk crosses, the compiler resolves, and an alias is judged against the tsconfig that
governs the file that wrote it.

Evidence: `C:/Projekte/120fps-fieldtest/smoke/run7-FINDINGS.md` cluster 2 (F7-F9),
`smoke/run7-smoke1/{directus,dub,twenty}.json` and their logs.

## Root causes (verified)

The verifier for every item below: run-7 investigation (2026-09-06), refuted by default; logs under
`C:/Projekte/120fps-fieldtest/logs/run7-investigate/` and `smoke/run7-smoke1/logs/<repo>/`.

1. **The preflight walk stops at every `node_modules`-resolved edge** — `src/project/preflight.ts`
   `continue`s at `:502` whenever an import resolves through `node_modules`, while
   `walkExternalDeps` (`src/harness/deps-scan.ts:302`, the unbuilt-sibling handling at `:541-559`)
   crosses into the sibling's source and aliases it. In a pnpm workspace a sibling is a symlink under
   `node_modules`, so the walk treats first-party source as a third-party package. The verifier:
   directus's chain `app/src/ai/components/ai-context-menu/empty-state.vue` →
   `components/v-list-item.vue` → `@directus/composables` (barrel `packages/composables/src/index.ts`)
   → `@directus/utils` → `@directus/system-data` → six `.yaml` imports. The yaml recognizer
   (`src/project/preflight-gates.ts:82-86`) never sees that edge, so M110 A5 and F1 — "refused before
   the browser starts", spec `m110-…:123-141` — do not fire, and the run dies on a raw Vite parse
   error instead (which M94 forbids). Recorded outcome: setup-error, exit 2, 94 s.
2. **The compiler options carry no `paths` for an unbuilt sibling** — `createCompilerOptions`
   (`src/project/compiler-options.ts:58-100`) injects nothing for workspace siblings, although
   `src/harness/deps-scan.ts:72-90` has already computed the mapping the harness uses. The verifier:
   dub's `@dub/ui` declares `types: ./dist/index.d.ts` and has no `dist/`, so `ts.resolveModuleName`
   returns UNRESOLVED; `Omit<ComponentProps<typeof EmptyStateBlock>, "children">` contributes nothing;
   the required `icon: React.ElementType` is never synthesized; React reports
   `Element type is invalid … got: undefined`; the verdict is FAIL with a clean prop table and no
   warning, because `warnDegenerateProps` (`src/props/classify.ts:110`) only inspects schemas that
   exist. Every real call site in dub passes `icon`. The seam is already under test at
   `test/unit/unbuilt-workspace-source-alias.test.ts:45-84`.
3. **One alias table is applied to every file the walk reaches** — `src/harness/prebuild.ts:58`
   calls `loadTsconfigAliases(projectRoot, warnings, opts.componentPath)` once, and
   `src/harness/deps-scan.ts:363` applies that one table to every file. `resolveGoverningTsconfig`
   already exists behind the `forFile` parameter (`src/project/tsconfig-aliases.ts:237-244`). The
   verifier: twenty's 149 imports inside `packages/twenty-shared` use that package's own `@/*` →
   `./src/*` (its `tsconfig.json:13-15`) and are judged against twenty-front's `@/*` →
   `./src/modules/*`; all 149 targets exist on disk. Each produces a `BROKEN_ALIAS_WARNING`
   (`src/harness/deps-scan.ts:56-61`, pushed at `:384-386`). The walk memo key serializes the alias
   array (`src/harness/deps-scan.ts:207-231`), so a per-file table changes the key.

4. **A stale alias inside the measured graph is only a warning** — `walkExternalDeps` reports
   `BROKEN_ALIAS_WARNING` and the run continues, so the failure lands minutes later inside Vite's
   import analysis. The verifier: librechat (`E:/repositories-run7/librechat`, appDir `client`,
   measured `src/components/Input/Generations/Button.tsx`). Its dry run prints
   `import "librechat-data-provider/react-query" ... its target
   E:/repositories-run7/librechat/packages/data-provider/react-query does not exist` and exits 0
   (`smoke/run7-new1/librechat.json`); the real run exits 2 after 121 s with
   `src/hooks/useNewConvo.ts imports "librechat-data-provider/react-query", which the dev server
   could not resolve to a loadable file` (`smoke/run7-new1/logs/librechat/real.log:6`). The two
   modes disagree, which M110 forbids.

## MUST

- **C1** An import that resolves through `node_modules` to a workspace sibling whose declared entry
  does not exist on disk is walked as first-party source: the walk continues into the sibling's own
  source entry (the entry `walkExternalDeps` already derives) and every gate applies to the files
  behind it. An import that resolves to a genuine third-party package is still skipped at the same
  point, with the same cost as today.
- **C2** After C1, directus's `.yaml` edge is an `unloadable-file-type` preflight hit and the run is
  refused before the browser starts, in the real run and in `--explain-props` identically. This is
  M110 A5 and F1 restored for the monorepo shape, with the wording those MUSTs fixed:
  the refusal names the importing file, the imported file, the chain from the measured component, the
  loader plugin the project declares for that extension, and the fixture-or-wrapper way out.
- **C3** `createCompilerOptions` injects a `paths` entry for every unbuilt workspace sibling that the
  dependency scan resolved to a source entry, mapping the package name — and its `exports` subpaths,
  as M126 already resolves them — to that source. A type that crosses the boundary resolves, and the
  props it declares are extracted.
- **C4** When a prop annotation references a module that did not resolve, the run warns and names the
  module and the annotation. The warning fires whether or not the resulting schema is empty, so a
  silently-degenerate prop table can no longer be mistaken for a component with no props.
  `computedAnnotationText` (`src/props/candidates.ts:536-545`) is the site that knows the text.
- **C5** An alias is resolved against the tsconfig that governs the file the import was written in,
  through the existing `forFile` lookup (`src/project/tsconfig-aliases.ts:237-244`), memoized by
  governing config path. The walk memo key includes the governing config path so two files under
  different configs cannot share a memo entry.
- **C6** Stale-alias reporting is collapsed by alias pattern: one line per pattern, naming the alias,
  its target root, at most three example specifiers, and `and N more` when more matched. On twenty's
  measured target the dry run prints at most three such lines, and none of them names a target that
  exists on disk.
- **C7** Dry/real parity (M100, M110): `--explain-props` and the real run make the same walk
  decisions, apply the same alias tables, and print the same alias and unresolved-module warnings.
- **C8** An import that matches a configured path alias, resolves to nothing on disk through that
  alias and through node resolution, and lies in the measured component's own import graph — the
  graph `runPreflight` walks, type-only edges excluded — is a hard preflight hit. The run is refused
  before the browser starts, in the real run and in `--explain-props` identically, and the refusal
  names the importing file, the specifier and the missing target. `--no-preflight` bypasses it like
  every other hard hit. A stale alias the preflight walk never reaches keeps C6's collapsed warning.
- **C10** An aliased import written inside a workspace sibling resolves through that sibling's own
  tsconfig at runtime too: when the measured package's alias list cannot resolve the same specifier,
  the harness aliases it to the file the sibling's config names, ahead of the measured entries. When
  the measured package resolves it to a different file, the run discloses the conflict by name and
  keeps the measured package's target.
- **C9** A project alias that matches an unbuilt sibling's specifier before the sibling's own
  rescue does not hide it. When the alias target is absent and the sibling's source answers for that
  specifier, the walk aliases the specifier to the source, ranks that alias ahead of the one that
  matched, walks the source, and prints no stale-alias line for it.

## MUST NOT

- Walk into a third-party package. C1 fires only when the resolved target is inside the workspace
  (a member of the workspace's package globs) *and* its declared entry is missing from disk.
- Alias a sibling that is built. A sibling whose declared entry exists on disk keeps resolving to
  that entry; M107's contract is unchanged.
- Change what `walkExternalDeps` aliases, or how the harness serves an unbuilt sibling at runtime.
  This milestone makes preflight and the compiler agree with the harness, not the other way round.
- Drop a stale-alias warning whose target genuinely does not exist. C6 collapses duplicates; it does
  not raise the bar for reporting.
- Refuse on a `paths` pattern with no prefix and no suffix of its own (`*`, `/*`). Such a key matches
  every bare specifier, so C8 would refuse every project that declares one; the harness already
  skips those patterns (`ROOT_ABSOLUTE_ALIAS_WARNING`).
- Refuse on an alias whose specifier resolves anywhere: through the alias, through node resolution,
  or through an unbuilt sibling's source. C8 fires only where nothing resolves at all.
- Re-root the TypeScript program. The program is already rooted at the component
  (`src/props/program.ts:116-117`); C3 adds `paths`, nothing else.
- Suppress the empty-prop-table warning path that already exists. C4 adds a cause; it removes none.

## Verification

- **C1, C2** — `test/unit/the-preflight-walk-crosses-into-an-unbuilt-sibling.test.ts`: a fixture
  workspace with an app importing `@fix/sib` (declared `main: ./dist/index.js`, no `dist/`) whose
  source imports a `.yaml` file produces a hard `unloadable-file-type` preflight hit naming the chain;
  the same workspace with `dist/` present produces no hit and no walk into the source; an app
  importing a real third-party package produces no walk into `node_modules`; the dry-run and real-run
  gates return the identical decision and text. Extend `test/unit/preflight.test.ts` for the
  `continue`-path regression.
- **C3, C4** — `test/unit/an-unbuilt-sibling-contributes-its-types.test.ts` and
  `test/unit/unbuilt-workspace-source-alias.test.ts`: a component whose props are
  `Omit<ComponentProps<typeof X>, "children">` where `X` comes from an unbuilt sibling extracts `X`'s
  required props; the same component with the sibling built extracts the same set; when a module in
  an annotation does not resolve at all, the run warns and names it; a component that genuinely
  declares no props produces no unresolved-module warning.
- **C5, C6** — `test/unit/an-alias-is-resolved-against-its-own-tsconfig.test.ts` and
  `test/unit/unresolved-alias-reporting.test.ts` (rewrites the expectation at `:47`): two packages
  with the same alias pattern and different targets each resolve against their own tsconfig; a file
  under package B never produces a warning derived from package A's table; twenty-shaped input with
  40 stale specifiers under one pattern produces one line with three examples and `and 37 more`; the
  memo returns different entries for the same file name under two governing configs.
- **C7** — extend `test/unit/explain-props-parity.test.ts`: the dry run and the real run produce the
  same warning list for a fixture with an unbuilt sibling and a stale alias.
- **C10** — `test/unit/a-siblings-own-alias-is-served-to-the-browser.test.ts`: a sibling importing
  `~/icons` under its own tsconfig gets an exact alias to its own file when the measured package
  resolves that name nowhere; when the measured package resolves it to another file, one warning
  names both targets and no alias is added.
- **C9** — `test/unit/a-stale-alias-does-not-hide-a-sibling-source.test.ts`: an app whose tsconfig
  maps `@fix/sib/*` at an unbuilt target still reaches the sibling's `src/sub.ts`, its transitive
  packages appear in `externalDeps`, no stale-alias line is printed, and the rescue alias precedes
  the project alias in the list the harness hands Vite.
- **C8** — `test/unit/a-stale-alias-in-the-graph-is-refused.test.ts`: an aliased import whose target
  is absent, written in a file the preflight walk reaches, is a hard hit naming importer, specifier
  and target; the same alias imported by no file in the graph produces no hit; a prefix-less `*`
  pattern produces no hit; a type-only import of the same specifier produces no hit; the message the
  dry run prints equals the one the real path prints.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus `test/unit/preflight.test.ts`,
  `test/unit/unbuilt-sibling-subpath-resolves-to-its-source.test.ts`,
  `test/unit/workspace-sibling-entry-resolution.test.ts`, `test/unit/prop-cap-ranking.test.ts`,
  then the full unit suite once before the lane's final commit.

Recorded run of this milestone's verification:

```
node node_modules/typescript/bin/tsc -p tsconfig.json          # exit 0; dist/cli/main.js --version = 0.7.0

npx vitest run test/unit/the-preflight-walk-crosses-into-an-unbuilt-sibling.test.ts   test/unit/an-unbuilt-sibling-contributes-its-types.test.ts   test/unit/an-alias-is-resolved-against-its-own-tsconfig.test.ts   test/unit/unresolved-alias-reporting.test.ts   test/unit/a-stale-alias-in-the-graph-is-refused.test.ts   test/unit/a-stale-alias-does-not-hide-a-sibling-source.test.ts   test/unit/a-siblings-own-alias-is-served-to-the-browser.test.ts   test/unit/explain-props-parity.test.ts test/unit/preflight.test.ts --maxWorkers=2
#   Test Files  9 passed (9)      Tests  74 passed (74)

npx vitest run test/unit --maxWorkers=2
#   Test Files  2 failed | 345 passed (347)
#   Tests  2 failed | 4948 passed | 1 skipped (4951)
#   the two failures are the recorded baseline pair (prop-cap-ranking.test.ts,
#   vue-setup-inject-evidence.test.ts); both reproduce in isolation at f54be55.
```

Each MUST was confirmed red before its fix: disabling the C8 push in `runPreflight` fails
`a-stale-alias-in-the-graph-is-refused.test.ts` (2 of 6); disabling the C9 rescue in
`walkExternalDeps` fails `a-stale-alias-does-not-hide-a-sibling-source.test.ts` (2 of 2).

Corpus repros, through a `dist` built in `C:/Projekte/120fps-run7-lane-b`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run5/directus/app \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-b/directus \
  --label m130-directus --cli C:/Projekte/120fps-run7-lane-b/dist/cli/main.js \
  -- src/ai/components/ai-context-menu/empty-state.vue --samples 3 --max-combos 2 \
     --explore-budget 30 --no-deltas
# expected: hard preflight refusal naming the .yaml chain, before the browser, dry == real

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories/dub/apps/web \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-b/dub \
  --label m130-dub-dry --cli C:/Projekte/120fps-run7-lane-b/dist/cli/main.js \
  -- ui/shared/empty-state.tsx --explain-props
# expected: `icon` listed as required (baseline: absent, real run FAIL with a clean prop table)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories/twenty/packages/twenty-front \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-b/twenty \
  --label m130-twenty-dry --cli C:/Projekte/120fps-run7-lane-b/dist/cli/main.js \
  -- src/modules/ui/input/components/TextArea.tsx --explain-props
# expected: <= 3 stale-alias lines, none naming an existing target (baseline 149 lines)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/umbrel/packages/ui \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-b/umbrel \
  --label m130-control --cli C:/Projekte/120fps-run7-lane-b/dist/cli/main.js \
  -- src/components/ui/card.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: unchanged pass-warn, exit 0

node C:/Projekte/120fps-fieldtest/tools/run120.mjs   --cwd E:/repositories-run7/librechat/client   --out C:/Projekte/120fps-fieldtest/logs/run7-lane-b/librechat   --label m130-librechat-dry --cli C:/Projekte/120fps-run7-lane-b/dist/cli/main.js   -- src/components/Input/Generations/Button.tsx --explain-props
# expected: exit 2, refused before the browser, naming src/hooks/useNewConvo.ts,
#           "librechat-data-provider/react-query" and the missing target
#           (baseline: exit 0 with a warning, while the real run exits 2 after 121 s)
```

Recorded corpus runs, `dist` built in `C:/Projekte/120fps-run7-lane-b`, logs under
`C:/Projekte/120fps-fieldtest/logs/run7-lane-b/`:

| Repo | Label | Baseline | Recorded |
|---|---|---|---|
| directus | `m130-directus-dry`, `m130-directus-real` | setup-error, exit 2, 94 s, raw Vite parse error | exit 2 in 6 s (dry) and 3 s (real), refusal byte-identical, before the browser: `../packages/system-data/src/collections/index.ts imports ./collections.yaml`, chain `empty-state.vue → v-list-item.vue → ../packages/composables/src/index.ts → …/use-items.ts → ../packages/utils/shared/index.ts → …` |
| dub | `m130-dub-dry` | verdict-fail, exit 1, 31 s, prop table without `icon` | exit 0 in 13 s, `Props (6)` with `icon function required` first |
| twenty | `m130-twenty-dry` | 149 stale-alias lines | exit 0 in 12 s, 0 stale-alias lines |
| umbrel (control) | `m130-control` | pass-warn, exit 0, 46 s | pass-warn, exit 0, 33 s, same warning set |
| librechat | `m130-librechat-dry`, `m130-librechat-real` | dry exit 0 with 4 stale-alias lines; real exit 2 at 121 s on `librechat-data-provider/react-query` | dry exit 0 in 16 s with 0 stale-alias lines; real exit 2 at 112 s, past both former blockers, on `The requested module '/src/hooks/index.ts' does not provide an export named 'useMediaQuery'`, with 5 `GOVERNING_ALIAS_CONFLICT_WARNING` lines naming the cause |

librechat's `librechat-data-provider/react-query` is **not** a C8 refusal: C3's injected `paths`
resolve it to `packages/data-provider/src/react-query/index.ts`, so the module is not missing and a
refusal would block a run that can now proceed. C9 makes the harness serve the same target. What
still stops librechat is one alias namespace claimed by two packages (`~/*` in both `client/` and
`packages/client/`), which one Vite alias list cannot express; see Deferred.

## Deferred

- **novu's absent package.** `@novu/maily-core/style.css` is genuinely not installed; no resolution
  change reaches it, and it is not this milestone's shape.
- **hoppscotch and vue-vben-admin.** Both are blocked by `app.use` plugin registration, not by
  resolution; the findings assign them the `120fps.setup.vue` remedy (M136 records the same).
- **The exit-code the refusal uses.** C2 refuses before the browser; whether that is exit 2 or a new
  code is the exit-code redesign the findings leave out.
- **Per-importer alias resolution.** Two workspace packages declaring the same alias pattern
  (librechat's `~/*` in `client/` and in `packages/client/`) cannot both be served by one Vite alias
  list. C10 discloses each such import by name (`GOVERNING_ALIAS_CONFLICT_WARNING`) and serves the
  measured package's target. Serving both needs a resolver plugin keyed on the importer, which lives
  in `src/harness/build.ts` and `src/harness/vite-config.ts` — neither is lane B's file.
- **Extending the walk into built siblings' sources.** A built sibling's `dist/` is what the browser
  would load, so walking its source would gate on code the run never executes.
