---
kind: milestone
status: draft
tests:
  # Lane A
  - test/unit/tsconfig-references-select-the-governing-config.test.ts
  - test/unit/jsx-automatic-regardless-of-project-jsx.test.ts
  - test/unit/root-absolute-path-alias-rejected.test.ts
  - test/unit/tsconfig-custom-conditions-forwarded.test.ts
  # Lane B
  - test/unit/prop-extraction-shares-the-tsconfig-reader.test.ts
---

# M109: the tsconfig is read the way TypeScript reads it

Lanes A (reader, harness) and B (prop-gen consumer), per `specs/milestones/M107-M117-MAP.md`.

## Purpose

A developer measures a component in a project whose tsconfig has a normal shape TypeScript
understands and 120fps does not: a references-only root (`npm create vite@latest -- --template
react-ts` writes one), `"jsx": "preserve"` (the standard Vite library setup, where the project's own
`@vitejs/plugin-react` supplies the runtime), a `paths` key that maps `"/*"`, or `customConditions`.
Today each shape ends the run before the first measurement or drops the aliases silently. After M109
one reader, called by the real run and `--explain-props`, reads what TypeScript reads and names the
config it chose.

Closes: ark-F1 (blocker), react-spectrum-F2 (blocker, react-spectrum-F6 folded in), coordinator-F1
(blocker).

Run-5 evidence: `C:\Projekte\120fps-fieldtest\EVIDENCE.md:56` (ark-F1), `:63` (react-spectrum-F2),
`:85` (coordinator-F1), `:108` (the shared-mechanism row), `:133` (F6 reclassification);
`verify\ark.md:8-48`, `verify\react-spectrum.md:32-72` and `:100-107`,
`findings\_coordinator-tsconfig-references.md`; `remediation\cluster-briefs.md:64-88` (G3).

## Root causes (verified)

1. **ark-F1** — `createServer` (`src/harness.ts:3528-3583`) passes no `esbuild` option, so
   `vite:esbuild` reads the project tsconfig for the `ts`/`tsx` loaders and ark's
   `"jsx": "preserve"` (`/e/repositories-run5/ark/packages/react/tsconfig.json:4`) falls through to
   esbuild's classic `React.createElement` transform. ark imports only named React exports, so the
   first JSX evaluation throws `React is not defined`. The verifier measured `transformWithEsbuild`
   with ark's real tsconfig: `hasCreateElement: true`, `hasJsxRuntime: false`; with
   `{ jsx: "automatic", jsxImportSource: "react" }` the runtime import appears. Every `.tsx` in that
   repository is mis-transformed, not only the accordion. `src/harness.ts:2657-2704` fixed this
   failure mode for `.js` through `jsxInJsPlugin` (applied at `:3488`); the `.ts`/`.tsx` path was
   left to the project tsconfig. (The map's `:2679-2684` is that plugin's comment; the transform
   call sits at `:2697-2700`.)
2. **react-spectrum-F2, wall one** — the root tsconfig declares `paths: { "/*": ["./*"] }`
   (`/e/repositories-run5/react-spectrum/tsconfig.json:40-44`; the member package has no tsconfig,
   so the root governs). `buildPathAliasEntry` takes the "pattern and target both end in `/*`"
   branch (`src/harness.ts:4404-4407`, which the map cites as `:4402-4408`), whose prefix here is the
   empty string, and builds `{ find: /^\//, replacement: "<workspaceRoot>/" }`. Vite merges user
   aliases before its own client alias, so `/@vite/client` and `/.120fps-harness-*/entry.tsx` are
   rewritten into the workspace root and 404 — the two page errors, exit 2, three runs of three.
3. **react-spectrum-F2, wall two** — the same tsconfig declares `customConditions: ["source"]`
   (`tsconfig.json:20`) and `react-aria` publishes its subpaths through the `source` condition with
   no `dist/`. `resolve.conditions` is only ever filled from a vite config
   (`src/harness.ts:3574-3578`); `grep -n customConditions src` finds no reader hit. The verifier
   measured a bare vite@6.4.3 server on the same root: 500 `Failed to resolve import
   "react-aria/private/live-announcer/LiveAnnouncer"` without the condition, 200 with it. Fixing the
   alias alone moves the failure; it does not produce a run.
4. **coordinator-F1** — `parseTsconfigPathsConfig` (`src/harness.ts:4461`, `ts.readConfigFile`
   `:4464`, `ts.parseJsonConfigFileContent` `:4475`) and `createCompilerOptions`
   (`src/prop-gen.ts:2952`, the same two calls at `:2976` and `:2983`) resolve `extends` and never
   `references`. `findCompilerConfig` (`src/project-model.ts:77-90`) stops at the nearest config, so
   a create-vite root (`{ "files": [], "references": [...] }`, `C:/Projekte/tmp-vite-refs/
   tsconfig.refs.bak`) yields no `paths` at all: the real run exits 2 with `imports "@/lib/utils",
   which the dev server could not resolve` and `--explain-props` prints no alias warning. The
   control run with the same `compilerOptions` in the root tsconfig passes.

## MUST

### Lane A (`src/project-model.ts`, `src/harness.ts`)

- **A1** One reader answers "which config governs this file, and what does it say". When the nearest
  `tsconfig.json`/`jsconfig.json` declares no `compilerOptions` and lists `references`, the
  referenced config whose `include`/`files` covers the file supplies `paths`, `baseUrl`,
  `jsxImportSource` and `customConditions`; when more than one referenced config covers the file,
  the first in the root's `references` array wins; a cycle or a missing reference target ends the
  walk with the nearest config's options, no throw and no run failure. A nearest config carrying its
  own `compilerOptions` still wins outright (the README's "nearest one wins" stays true). A
  component under a references-only root imports through the referenced config's `paths` at run
  time: the dev server resolves them, the run prints no `imports "@/lib/utils", which the dev server
  could not resolve` (`src/harness.ts:2867`) for a key that config declares, and the exit code is
  the verdict's, never 2 for this cause.
- **A2** A references-only nearest config is disclosed once per run, in the dry run and the real run
  with identical text, and reaches the JSON `warnings` array. The sentence names the nearest config
  path, the chosen referenced config path, and the field it supplied (`tsconfig.json declares no
  compilerOptions and lists references; tsconfig.app.json covers src/components/Button.tsx and
  supplies paths`). When no referenced config covers the file, the sentence says so and names every
  config it tried.
- **A3** `.ts`, `.tsx`, `.js` and `.jsx` compile with the automatic JSX runtime and the project's
  `jsxImportSource` (`"react"` when the config declares none), whatever the config's `jsx` value is.
  A `"jsx": "preserve"` project prints no `React is not defined` page error and reaches a verdict
  line; the exit code is the verdict's, never 2 for this cause.
- **A4** A `paths` key whose non-wildcard prefix is empty (`"/*"`, `"*"`) builds no alias. It is
  reported once in the alias-warning register, naming the key, its target and the config file that
  declared it, and the run continues with the remaining keys. `/@vite/client` and the harness entry
  (`/.120fps-harness-*/entry.tsx`) answer HTTP 200 in a project that declares such a key, and a
  `/@fs/<allowed path>` request is not rewritten by the user alias.
- **A5** `customConditions` from the governing config reaches the dev server's resolve conditions:
  when a vite config also declares conditions, the server receives the vite config's list followed
  by the config's conditions it does not already contain, and the resulting list is disclosed once
  naming both sources. A package that publishes a subpath only under such a condition resolves.

### Lane B (`src/prop-gen.ts`)

- **B1** `--explain-props` on the create-vite repro prints the prop count the control tree with
  inlined `compilerOptions` prints, and prints A2's disclosure with A2's wording; the preflight walk
  sees the same options through `projectCompilerOptions` (`src/preflight.ts:486`), so no queued file
  is dropped for an alias the referenced config declares and `src/preflight.ts` needs no edit.
- **B2** A read or parse failure keeps today's behaviour: one warning per config path per process
  (`src/prop-gen.ts:2937-2943`), extraction continues on the built-in defaults, and no run fails
  because of the reader.

## MUST NOT

- Build an alias matching a root-absolute URL from a user `paths` key.
- Pick a different config in `--explain-props` than in the real run; both call the reader.
- Change how `.vue` SFC blocks or `node_modules` `.js` files compile; `jsxInJsPlugin`'s scope
  (`src/harness.ts:2685-2704`) is unchanged.
- Follow `references` from a config that declares its own `compilerOptions`.
- Print the references disclosure more than once per run, or print it for a project without
  `references`.

## Interfaces needed

- **I1, producer lane A, consumer lane B.** `resolveGoverningTsconfig(fileOrDir, stopDir?)` exported
  from `src/project-model.ts` (lane A's file, already imported by `src/prop-gen.ts:15` and
  `src/harness.ts:16-25`, so no import cycle and no new owned file). Return shape:
  `{ configPath: string | undefined, nearestConfigPath: string | undefined, viaReferences: boolean,
  options: ts.CompilerOptions, base: string, warnings: string[] }`, where `options` is
  `parseJsonConfigFileContent`'s result for the governing config and `warnings` carries A2's
  sentence plus the existing `TSCONFIG_EXTENDS_BROKEN_WARNING` text. B1 and B2 need it, consumed at
  `src/prop-gen.ts:2952-3008` in place of the local `findCompilerConfig` + `readConfigFile` pair;
  A1, A2, A3 and A5 produce it at `src/harness.ts:4461-4514` and `:4516-4592` (the map's
  `:4461-4513` and `:4516-4590` stop one and two lines short of these declarations). M111 A2 is a
  read-only consumer: it asserts only that the reader's answer for a file does not change with the
  shell directory, and adds no member to the return shape.
- **Producer lane A, consumer lane C.** None. A2's and A4's sentences reach the dry run through the
  existing `warningsOut` channel (`src/harness.ts:3235` inside `collectStaticPreBuildWarnings`,
  forwarded at `src/analyze.ts:2362-2367`) and the report through `report.warnings`
  (`src/report.ts:543`). Lane C changes nothing.
- **Conflict C2 in `M107-M117-MAP.md`, not an interface.** M111 (G5) edits the same
  `createServer({...})` options object (`src/harness.ts:3528-3583`) that A3 and A5 extend. M109
  lands its `esbuild` and `resolve` keys first; M111 re-reads the region before its own edit.

## Verification

Three-fold per the map: these tests pass and lane A's and lane B's existing tests stay green;
`tsc --noEmit` clean; the corpus repros run through
`node C:/Projekte/120fps-fieldtest/tools/run120.mjs` against a scratch dist built from this
worktree, plus one unaffected repository (shadcn-admin button) still reaching a report.

**Fixtures.** One new shared directory `fixtures/tsconfig-shapes/` with three self-contained
projects, mirroring `fixtures/vite-config-project/`: `jsx-preserve/` (tsconfig `"jsx": "preserve"`,
a `.tsx` importing only named React exports), `root-slash-alias/` (`paths: { "/*": ["./*"] }` plus
one working `@/*` key), `project-references/` (root `{ "files": [], "references": [...] }`, `paths`
and `customConditions` only in `tsconfig.app.json` with `include: ["src"]`, a `tsconfig.node.json`
covering `vite.config.ts`, and a component importing `@/lib/utils`). The map's
`fixtures/tsconfig-references/` is `project-references/` under the cluster brief's name; no existing
fixture directory is edited.

- **A1, A2** (`test/unit/tsconfig-references-select-the-governing-config.test.ts`) — the reader on
  `project-references/src/components/Button.tsx` returns `tsconfig.app.json` as `configPath`,
  `tsconfig.json` as `nearestConfigPath`, `viaReferences: true` and the `@/*` paths entry; on
  `vite.config.ts` it returns `tsconfig.node.json`; on `jsx-preserve/` it returns the nearest config
  with `viaReferences: false`. A reference cycle written into a tmpdir copy returns the nearest
  config and throws nothing. `collectStaticPreBuildWarnings` on the references fixture yields
  exactly one sentence naming both config paths; two calls in one process yield it once; the same
  string appears in the dry-run warning list and in `report.warnings`.
- **A3** (`test/unit/jsx-automatic-regardless-of-project-jsx.test.ts`) — the harness transform of
  `jsx-preserve/`'s `.tsx` contains the `jsx-runtime` import and no `React.createElement`, asserted
  as `test/unit/jsx-in-js-transform.test.ts` asserts for `.js`.
- **A4** (`test/unit/root-absolute-path-alias-rejected.test.ts`) — `loadTsconfigAliases` on
  `root-slash-alias/` returns the `@/*` entry and no entry whose `find` matches `/@vite/client`, and
  pushes one warning naming `"/*"` and the config file, and a booted harness server on
  `root-slash-alias/` answers 200 for `/@vite/client` and for the harness entry.
- **A5** (`test/unit/tsconfig-custom-conditions-forwarded.test.ts`) — the built server options for
  `project-references/` carry `source` in `resolve.conditions`; with a vite config declaring
  `["browser"]` the list is `["browser", "source"]` and the disclosure names both sources.
- **B1/B2** (`test/unit/prop-extraction-shares-the-tsconfig-reader.test.ts`) — `extractProps` on
  `project-references/src/components/Button.tsx` reports the props the `@/*`-aliased module
  contributes, matching the same component under a control root with inlined `compilerOptions`; an
  unreadable config warns once and returns the defaults.

Corpus (commands verbatim from the `EVIDENCE.md` rows named above):

- ark-F1 — `node run120.mjs --cwd .../ark/packages/react --label react-accordion-nomatrix --
  src/components/accordion/accordion-root.tsx --samples 5 --max-combos 4 --explore-budget 60
  --no-deltas`. Expected after the fix: no `React is not defined` page error, a `Result:` verdict
  line, exit by verdict.
- react-spectrum-F2 — `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd
  /e/repositories-run5/react-spectrum/packages/react-aria-components --out
  C:/Projekte/120fps-fieldtest/logs/react-spectrum --label real-button --timeout 1500 --
  src/Button.tsx --samples 5 --max-combos 4 -` (the `EVIDENCE.md:63` row truncates its last flag;
  the run's full flag set is in the log header that row names). Expected after the fix: no 404 for
  `/@vite/client` or `/.120fps-harness-*/entry.tsx`, one warning naming the `"/*"` key from
  `tsconfig.json`, `source` among the resolve conditions, and either a report or a refusal naming
  the workspace-sibling layer (react-spectrum-F1, M107's finding).
- coordinator-F1 — `cd C:/Projekte/tmp-vite-refs && cp tsconfig.refs.bak tsconfig.json && node
  C:/Projekte/tmp-120fps-head/dist/cli.js src/components/Button.tsx --isolate mount --samples 2
  --json out-a.json`, run against this worktree's scratch dist in place of
  `tmp-120fps-head/dist`. Expected after the fix: exit 0 with the `Result:` line control run B
  produced, `out-a.json`'s `warnings` carrying A2's sentence, and `--explain-props` on the same tree
  printing that sentence and run B's prop count.

## Deferred

- Solution-style references with build semantics (`outDir`/`.d.ts` redirection, `--build` ordering):
  no finding needs a redirected declaration path, and following one would change which file is
  measured.
- A config declaring both `compilerOptions.paths` and `references`: the nearest config wins (MUST
  NOT). No run-5 repository has that shape; changing it without evidence would be a guess.
- The baseUrl-only workspace-root fallback stays out of scope, as the M76 spec states.
- Per-file `jsxImportSource`: one project-level value continues to serve, as `resolveJsxImportSource`
  (`src/harness.ts:2713-2734`) already does.
- react-spectrum's third wall — the workspace sibling with no `dist/` — is M107's
  (react-spectrum-F1); M109 does not widen the sibling rescue.
- A Vue-renderer project's `.tsx` with no `jsxImportSource`: A3's default stays `react`; the MUST
  NOT above covers `.vue` blocks, and no run-5 repository measures a Vue `.tsx`.
- React without a `react/jsx-runtime` export (<16.14): A3 extends to `.ts`/`.tsx` the setting
  `jsxInJsPlugin` has applied to `.js` since M77; the failure mode and its remedy are unchanged, and
  no MUST adds a version probe.
- Reading `references` for anything but compiler options (project-wide checking, program
  construction): the harness constructs no multi-project program.
