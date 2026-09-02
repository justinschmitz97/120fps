---
kind: milestone
status: draft
tests:
  - test/unit/subpath-imports-resolve-locally.test.ts
  - test/unit/nuxt-diagnosis-requires-nuxt.test.ts
  - test/unit/react-compiler-target-matches-installed-react.test.ts
  - test/unit/virtual-and-macro-imports-are-preflight-hits.test.ts
  - test/unit/page-error-reaches-its-own-remedy.test.ts
  - test/unit/react-compiler-disclosure-names-target.test.ts
---

# M108: A diagnosis names the layer that failed

## Purpose

Four run-5 repositories failed at exit 2 and were told the wrong thing about why. A run on a
component whose import graph crosses a Node subpath-imports map, a Vite virtual namespace, a Babel
macro, or a React 18 project with the React Compiler declared names the layer that actually failed,
the specifier that reached it, and a remedy grounded in that repository. No run prints a Nuxt remedy
for a repository without Nuxt.

Closes: epic-stack-F1 (blocker), primer-react-F1 (blocker), documenso-F1 (major, reclassified from
blocker), hoppscotch-F2 (minor, reclassified from major). Evidence:
`C:\Projekte\120fps-fieldtest\EVIDENCE.md` rows for the four ids, `verify\epic-stack.md`,
`verify\primer-react.md`, `verify\documenso.md`, `verify\hoppscotch.md`,
`remediation\cluster-briefs.md` G2, `specs/milestones/M107-M117-MAP.md` (M108).

Lane A owns every file below; message constants stay in Lane A even when Lane C prints them. M108's
`imports`-field resolver lands before M107's rescue fixed point (`scanExternalDeps`, conflict C1).

## Root causes (verified)

1. **epic-stack-F1 — the harness manufactures the failure.** `src/harness.ts:4119` classifies
   `#app/utils/misc.tsx` as a bare specifier (`!spec.startsWith(".") && !spec.startsWith("/")`), the
   bare branch at `:4153` collapses it to the package name `#app` (`:4155-4157`), and `:4161`/`:4177`
   put `#app` into `externalPkgs`, which becomes `optimizeDeps.include` at `:3580-3582`. No file in
   `src/` reads a `package.json` `imports` map: `grep -n 'startsWith("#")' src/*.ts` returns only the
   three `.env` comment skippers (`cli.ts:1191`, `harness.ts:2135`, `harness.ts:3146`). Vite resolves
   `#app` against `epic-stack-template`, whose map declares `#app/*` and not `#app`, and throws
   `Missing "#app" specifier in "epic-stack-template" package`. The map's M108 section cites `:4120`,
   `:4155-4157`, `:4160`, `:4175`; in the worktree only `:4160` shifts (to `:4161`), `:4120` is
   `:4119` (as map C1 already records), and the rest are unchanged.
2. **epic-stack-F1 and primer-react-F1 — the diagnosis is out of its own scope.**
   `NUXT_BUILD_MODULE_MISSING` (`src/harness.ts:2968`) is `/Missing "([^"]+)" specifier in
   "([^"]+)" package/`: no `#build` anchor, no Nuxt-presence check. `diagnoseNuxtBuildModule`
   (`src/harness.ts:3008-3024`, map `:3007-3022`) runs first in the chain (`:2856`), so any missing
   `exports` subpath in any package prints `NUXT_BUILD_MODULE_MISSING_ERROR` (`:2978-3006`) with a
   `nuxi prepare` remedy. Neither repository declares `nuxt`. M95 scopes the mechanism to `#build/...`
   modules; M92 requires every printed message to be true.
3. **primer-react-F1 — the React Compiler targets the wrong React.** `loadReactCompilerPlugin`
   (`src/harness.ts:2355`) applies `babel-plugin-react-compiler` with an empty options object at
   `:2362` (map `:2361`), so the plugin defaults to React 19 and emits
   `import { c } from "react/compiler-runtime"`. The installed React is 18.3.1 and that subpath throws
   `ERR_PACKAGE_PATH_NOT_EXPORTED`. `reactCompilerRuntimeDeps` (`:2325-2332`) already probed the same
   module and returned `[]`, and the transform still ran. The project passes `target: "18"` itself
   (`babel.config.cjs:9-15`) and installs `react-compiler-runtime@1.0.0`.
   `specs/overview/00-tdd.md:475` mandates the empty options object: a spec gap, not drift.
4. **hoppscotch-F2 — an unrecognised virtual namespace falls through to a generic remedy.**
   `~icons/lucide/eye` has no file behind it and no recognizer in `src/`. Vite's
   `Failed to resolve import` text matches `VITE_IMPORT_RESOLVE_FAILURE` (`src/harness.ts:2862`)
   inside `diagnoseBundlerFailure` (`:2921-2927`, fall-through at `:2923`) and prints
   `BUNDLER_IMPORT_UNRESOLVED_ERROR` (`:2865-2871`), whose second sentence is a conditional about an
   unbuilt workspace package. The repository declares the producer
   (`packages/hoppscotch-common/package.json:182`, `unplugin-icons 22.5.0`) and the output omits it.
5. **documenso-F1 — a Babel macro is invisible to preflight.** `packages/ui/primitives/dialog.tsx:1`
   imports `@lingui/react/macro`, a Babel plugin the real app compiles away with
   `vite-plugin-babel-macros`. `TRANSFORM_RECOGNIZERS` (`src/preflight.ts:65-117`) is extension-based
   and `recognizeTransform` (`:119-124`), run on every import edge (`:592`), matches nothing for a
   bare `*/macro` specifier, so `PROJECT_TRANSFORM_WARNING` (`:842-857`) never fires and the dry run
   was clean. `signature-pad-color-picker.tsx`, with no Radix Dialog, failed identically.
6. **documenso-F1 — the failure path reports the wrong error.** The macro throws during module
   evaluation, before `waitForReadyOrFatal` (`src/page-errors.ts:331-356`) registers its waiter.
   `fatalWaiters` is fresh per `waitForFatal()` call (`:111-114`, `:174`), so the delivered throw is
   never replayed, `buildFatalPageErrorMessage` (`:311-322`, the only caller of
   `extractThrowingModule`, `:296-306`) never runs, and `enrichTimeoutError` (`:266-286`) prints
   `did not become ready within timeout` and appends `NO_ENV_FILE_REMEDY_NOTE`
   (`src/harness.ts:2212-2217`). The user read `Unable to determine current node version` with an
   environment-file remedy.

## MUST

Lane A files: `src/harness.ts` (A1-A5), `src/preflight.ts` (A6, A7), `src/page-errors.ts` with the
`src/harness.ts` remedy constants (A8, A9).

- A1 A `#`-prefixed specifier resolves through the nearest `package.json` `imports` field of the
  importer's own package, with the conditions Vite uses, including `*` patterns and subpaths. A
  specifier the map resolves to a file in the repository is a local import: that file is measured as
  part of the graph, no `optimizeDeps.include` entry is created for the specifier or any truncation
  of it, and no dep-optimization error names it. A `#`-prefixed specifier that no `imports` field
  maps stays unresolved and gets A2's generic message.
- A2 The Nuxt build-module diagnosis fires only when the specifier starts with `#build`, `#imports`
  or `#app` and `nuxt` is declared in the measured package or at the workspace root. Otherwise the
  printed message names the missing specifier, the package whose `exports`/`imports` map lacks it,
  and the importer when the bundler message carries one, and its remedy is to declare that subpath
  in that map. The exit code stays 2.
- A3 The React Compiler transform emits only runtime imports that resolve from the measured project
  for its installed React major (17, 18, 19): a run on a React 18 project produces no
  `react/compiler-runtime` resolution error. When the runtime module that major requires does not
  resolve, the transform is skipped and one warning names the target, the missing module and the
  package that supplies it; the run continues without the compiler.
- A4 The report's `reactCompiler` object carries the resolved `target` and, when A3 skipped the
  transform, the reason. The terminal line reads `React Compiler: active (v1.0.0, target 18)` and,
  after a skip, `React Compiler: skipped (target 18: react-compiler-runtime not installed)`.
- A5 A bundler failure on a known virtual namespace (`~icons/`, `virtual:`, `unplugin-`) prints that
  a Vite plugin this harness does not run produces the specifier, names the producing package the
  repository declares, and drops the unbuilt-workspace clause. With no declaring package found, the
  message states the namespace and nothing more.
- A6 A Babel-macro import is a `project-transform` preflight hit: a specifier ending in `/macro`, or
  any specifier when `babel-plugin-macros` or a `*-macro` plugin is declared for the measured
  package. The warning names the specifier, names the declared compiler (`vite-plugin-babel-macros`,
  `@lingui/vite-plugin`), states that 120fps never reads the project's vite.config, and names no
  build command.
- A7 A virtual-namespace import (`~icons/`, `virtual:`, `unplugin-`) is a `project-transform`
  preflight hit with the same shape as A6, naming the declaring package, carried in
  `preflight.transforms` and printed once in the real run before the browser starts.
- A8 A page error that reached the harness before a `waitForFatal()` waiter existed is still
  delivered: the readiness failure reports every captured page error with its own text, capped by the
  existing bucket cap, and leads with the first one and its throwing module when the stack carries a
  source frame.
- A9 A remedy attaches only to a page error whose signature it matches. `NO_ENV_FILE_REMEDY_NOTE`
  attaches only when a captured error names an environment variable (`process.env.X`,
  `import.meta.env.X`, or an env-validation message). Any other captured error prints unremedied.

## MUST NOT

- Print `nuxi prepare`, or any Nuxt wording, for a repository that does not declare `nuxt`.
- Put a `#`-prefixed specifier, or a truncation of one, into `optimizeDeps.include`.
- Print `run that package's own build first` for a specifier in a virtual namespace.
- Name a Vite plugin, macro compiler or runtime package that the repository does not declare.
- Change the `externalPkgs` rescue loop (`src/harness.ts:4226-4256`, M107's) or move the diagnosis
  order ahead of `diagnoseUnbuiltWorkspacePackage`.
- Attach a page error captured before mount to a combo's own `pageErrors`, or drop a captured error
  from the JSON report (M99).
- Fail a run that became ready: A8 changes the readiness-failure report only.

## Interfaces needed

- I4 — `ReactCompilerReport` (`src/report.ts:481-485`, lane C) gains `target?: "17" | "18" | "19"`
  and `skipped?: { target: string; missingModule: string }`. Lane C lands the fields and prints them
  at `report.ts:748-753`; lane A fills them. A3 and A4 need it.
- I3 — `preflight.transforms` carries the two new hit sources (Babel macro, virtual namespace) in the
  existing `PreflightHit` shape (`src/preflight.ts:126-137`), so M110's dry run replays them unchanged
  and M110's classifier reads them. A6 and A7 need it. M108 lands the two hit sources only; I3's
  `classifyProjectTransformHits(projectRoot, transforms, { noTransforms?, workspaceRoot? })` export is
  M110's part of the same interface.
- No other interface: A1, A2, A5, A8 and A9 stay inside lane A's files.

Conflicts in `M107-M117-MAP.md`: C1 (`scanExternalDeps`; M107 first), C7 (`src/preflight.ts`; M108
before M110 and M116), C8 (`src/page-errors.ts`; M108 before M114).

## Verification

Unit tests run as `vitest run <files> --maxWorkers=2`.

- A1, A2 — `test/unit/subpath-imports-resolve-locally.test.ts` and
  `test/unit/nuxt-diagnosis-requires-nuxt.test.ts`. New fixture `fixtures/imports-field-project/`:
  `package.json` with `"imports": { "#app/*": "./app/*" }` and no `nuxt`, `app/utils/misc.ts`,
  `app/Button.tsx` importing `#app/utils/misc`. `scanExternalDeps` returns no `#app` entry and queues
  `app/utils/misc.ts`; `diagnoseNuxtBuildModule` on epic-stack's message with this root returns the
  generic text with no `nuxi prepare`; the same message with `nuxt` declared and a `#build/`
  specifier still returns the Nuxt text.
- A3, A4 — `test/unit/react-compiler-target-matches-installed-react.test.ts`. New fixture
  `fixtures/compiler-react18-project/` declaring `babel-plugin-react-compiler` with no runtime
  package; the test copies it to a tmp dir and writes `node_modules/react/package.json` with
  `"version": "18.3.1"` there, since fixtures cannot ship `node_modules` (`.gitignore:1`): report and terminal name `target 18`,
  no `react/compiler-runtime` resolution error appears, the run reports `skipped` and the warning
  names the module. A sibling `fixtures/compiler-react18-runtime-project/` adds a stub
  `node_modules/react-compiler-runtime/` and stays active, as does existing
  `fixtures/compiler-project/` (React 19) at `target: "19"`.
- A5, A7 — `test/unit/virtual-and-macro-imports-are-preflight-hits.test.ts`. New fixture
  `fixtures/virtual-namespace-project/`: `package.json` declaring `unplugin-icons`, `src/Icon.tsx`
  importing `~icons/lucide/eye`. `diagnoseBundlerFailure` on hoppscotch's verbatim Vite text names
  `unplugin-icons` and carries no build command; `runPreflight` reports one `project-transform` hit.
- A6 — same test file. New fixture `fixtures/macro-import-project/`: `package.json` declaring
  `vite-plugin-babel-macros` and `@lingui/react`, `src/Dialog.tsx` importing `@lingui/react/macro`;
  one `project-transform` hit names `vite-plugin-babel-macros` and carries no build command.
- A8, A9 — `test/unit/page-error-reaches-its-own-remedy.test.ts`, with a fake `Page` in the style of
  `test/unit/page-errors.test.ts`: a `pageerror` emitted before `waitForReadyOrFatal` is called still
  appears in the thrown message with its throwing module; three distinct pre-mount errors all appear,
  capped; `Unable to determine current node version` carries no env remedy, and
  `process.env.DATABASE_URL is not defined` carries it.

Corpus, through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs` against a scratch dist built from
this worktree. Commands are copied verbatim from the `EVIDENCE.md` rows; the truncated primer-react
and hoppscotch rows run with `--samples 5 --max-combos 4 --explore-budget 60 --no-deltas`.

- epic-stack-F1: `node run120.mjs --cwd /e/repositories-run5/epic-stack --out .../logs/epic-stack --label ep5-button-real --timeout 1500 -- app/components/ui/button.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`
  — no `Missing "#app" specifier in "epic-stack-template" package`, no Nuxt sentence, no
  `nuxi prepare`; the Vite server starts and the run reaches a report or verdict.
- primer-react-F1: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/primer-react/packages/react --out C:/Projekte/120fps-fieldtest/logs/primer-react --label real-button --timeout 1500 -- src/Button/Button.tsx --samples 5 --max-combos 4 --explore-budg`
  — no `react/compiler-runtime` error and no Nuxt sentence; `React Compiler:` names `target 18`. The
  run still fails with `__DEV__ is not defined` (`verify/primer-react.md`, out of scope): that is the
  expected new failure.
- hoppscotch-F2: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/hoppscotch/packages/hoppscotch-common --out C:/Projekte/120fps-fieldtest/logs/hoppscotch --label envinput-real --timeout 1500 -- src/components/smart/EnvInput.vue --samples 5 --max-c`
  — exit 2 unchanged; the message names `unplugin-icons` as the producer of `~icons/lucide/eye` and
  carries no `run that package's own build first`.
- documenso-F1: `node run120.mjs --cwd /e/repositories-run5/documenso --label real-dialog --timeout 1500 -- packages/ui/primitives/dialog.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`
  — a `[transform:babel-macro]` warning names `@lingui/react/macro` and `vite-plugin-babel-macros`
  before the browser starts; the failure names the throwing module, with no env-file remedy.
- Unaffected control: shadcn-admin button still reaches a report with the same verdict.

`tsc --noEmit` clean. `test/unit/preflight.test.ts`, `test/unit/page-errors.test.ts`,
`test/unit/react-compiler.test.ts`, `test/unit/react-compiler-harden.test.ts`,
`test/unit/virtual-module-diagnosis.test.ts`, `test/unit/import-scanner-coverage.test.ts` stay green.

### Lane A evidence (2026-09-02, scratch dist `A-M108`)

Tests (`node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2`), the five milestone files
plus the six files the section above requires to stay green, plus
`test/unit/bundler-error-presentation.test.ts` (the MAP's baseline defect: sample stack frames now
derive from the running checkout) and `test/unit/m95-m96-followup.test.ts` (its Nuxt fixture now
declares `nuxt`, which A2 requires):

    Test Files  13 passed (13)
         Tests  282 passed (282)

Whole suite, same runner: `Test Files 286 passed (286)`, `Tests 4397 passed | 1 skipped (4398)` —
the four baseline-failing files included.

`node node_modules/typescript/bin/tsc --noEmit`: clean, no output.

Corpus, `node C:/Projekte/120fps-fieldtest/tools/run120.mjs ... --cli
C:/Projekte/120fps-fieldtest/scratch/A-M108/dist/cli.js`, one run at a time, label
`M108-<repo>-after`. "before" lines are the EVIDENCE.md rows' own logs.

- epic-stack-F1 — closed.
  before: `Error: Failed to start Vite dev server in E:\repositories-run5\epic-stack\.120fps-harness-Azc3vv: epic-stack-template imports from "#app", a Nuxt build-time virtual module that does not exist until `nuxi prepare` generates the .nuxt/ directory. Run `nuxi prepare` in this project, then measure again.`
  after: `exit=0 killed=false seconds=68` / `Result: PASS` / `Mode: prop combos (4 measured of 64 generated, +4 scale probes)`. No `Missing "#app" specifier`, no Nuxt sentence, no `nuxi prepare`.
- primer-react-F1 — closed (the expected new failure).
  before: `Error: react imports from "./compiler-runtime", a Nuxt build-time virtual module that does not exist until `nuxi prepare` generates the .nuxt/ directory. Run `nuxi prepare` in this project, then measure again.`
  after: `Error: component harness failed before it became ready: warning.ts: __DEV__ is not defined. Page errors:` / `  - __DEV__ is not defined`. No `react/compiler-runtime` error, no Nuxt sentence; the compiler ran at the installed React 18 with the project's own `react-compiler-runtime`. The `React Compiler: ... target 18` terminal line is lane C's (I4, not landed).
- hoppscotch-F2 — closed.
  before: `Error: src/components/smart/EnvInput.vue?vue&type=script&setup=true&lang.ts imports "~icons/lucide/eye", which the dev server could not resolve to a loadable file. Check that the target exists; if it lives in an unbuilt workspace package, run that package's own build first.`
  after: `Error: src/components/smart/EnvInput.vue?vue&type=script&setup=true&lang.ts imports "~icons/lucide/eye", a module in the `~icons/` virtual namespace: a Vite plugin generates it at request time, and 120fps never reads your vite.config, so nothing answers for it here. This repository declares unplugin-icons, the plugin that owns that namespace; measure a component that does not import from it, or stub the import.` — exit 2 unchanged, plus nine `[transform:virtual-module] ... unplugin-icons` preflight warnings before the browser starts.
- documenso-F1 — closed for the remedy and the transform disclosure, partial on the module name.
  before: `  - Unable to determine current node version` followed by `No .env or .env.local found: 120fps carries a working .env/.env.local injection mechanism, ...`
  after: `Error: component harness failed before it became ready: Unable to determine current node version. Page errors:` / `  - Unable to determine current node version`, preceded by `  [transform:babel-macro] primitives/dialog.tsx → @lingui/react/macro: this project compiles that with a Babel macro compiler the project configures in its vite.config, which 120fps does not load (the harness never reads your vite.config).` No env-file remedy. The captured throw now leads the report instead of `did not become ready within timeout` (A8). Two deviations from the section above: the delivered stack carries no source frame, so no throwing module is named (A8 names one only when a frame exists); and the warning's owner stays generic because documenso declares `vite-plugin-babel-macros` in `apps/remix/package.json`, a sibling workspace member that is neither the measured package nor the workspace root — naming it would need sibling-member manifests (deferred).
- Unaffected control: shadcn-admin `src/components/ui/button.tsx --explain-props`, `exit=0 killed=false seconds=2`, `Component: Button` / `Props (32):` / `Estimated real run: ~2m 9s`.

A6's declared-plugin trigger is not implemented: applied literally it makes every import edge a hit;
only the specifier shapes (`*/macro`, `*.macro`, `babel-plugin-macros`) fire, and only for bare
specifiers, so a project's own `./macro` file stays an ordinary graph edge.

Not implemented, blocked on I4 (lane C has not landed the two `ReactCompilerReport` fields): A4's
report object and terminal line. `ReactCompilerState` (`src/harness.ts`) already carries `target`
and `skipped` for lane C to read.

### Lane C evidence (2026-09-03, scratch dist `C-M108`)

A4 only: `ReactCompilerReport` (`src/report.ts`) carries `target` and `skipped`, `formatTable`
prints them, and `buildReactCompilerReport` (`src/analyze.ts`) forwards lane A's
`ReactCompilerState` into the report object. I4 is closed on both sides.

Tests, `node node_modules/vitest/vitest.mjs run test/unit/react-compiler-disclosure-names-target.test.ts --maxWorkers=2`:

    Test Files  1 passed (1)
         Tests  9 passed (9)

The 54 files that assert on `formatTable` output (`grep -l formatTable test/unit/*.test.ts`),
same runner: `Test Files 54 passed (54)`, `Tests 1123 passed (1123)` — including
`test/unit/react-compiler.test.ts` and `test/unit/react-compiler-harden.test.ts`, whose
`React Compiler: active (v1.0.0)` assertions hold unchanged for a report with no `target`.
`test/unit/react-compiler-target-matches-installed-react.test.ts` and
`test/unit/baseline-slots.test.ts`: `Test Files 2 passed (2)`, `Tests 35 passed (35)`.

`node node_modules/typescript/bin/tsc --noEmit`: clean, no output.

Corpus, `node C:/Projekte/120fps-fieldtest/tools/run120.mjs ... --cli
C:/Projekte/120fps-fieldtest/scratch/C-M108/dist/cli.js`, one run at a time, label
`M108-<repo>-after`. "before" lines are the EVIDENCE.md rows' own logs.

- primer-react-F1 — the terminal line cannot be shown here, the rest closed.
  before: `Error: react imports from "./compiler-runtime", a Nuxt build-time virtual module that does not exist until `nuxi prepare` generates the .nuxt/ directory. Run `nuxi prepare` in this project, then measure again.`
  after: `exit=2 killed=false seconds=36` / `Error: component harness failed before it became ready: warning.ts: __DEV__ is not defined. Page errors:` / `  - __DEV__ is not defined`. No `react/compiler-runtime` error, no Nuxt sentence. `React Compiler:` is a report header line and this run writes no report (`__DEV__`, deferred), so the corpus cannot print it: primer-react is the only corpus repository that declares `babel-plugin-react-compiler` (`grep -l babel-plugin-react-compiler` over epic-stack, documenso, hoppscotch and shadcn-admin returns nothing). The wording is covered by the unit tests above.
- epic-stack-F1 — closed, header block unchanged.
  before: `Error: Failed to start Vite dev server in E:\repositories-run5\epic-stack\.120fps-harness-Azc3vv: epic-stack-template imports from "#app", a Nuxt build-time virtual module that does not exist until `nuxi prepare` generates the .nuxt/ directory. Run `nuxi prepare` in this project, then measure again.`
  after: `exit=0 killed=false seconds=84` / `Mode: prop combos (4 measured of 64 generated, +4 scale probes)` / `Result: PASS`. No `React Compiler:` line, as the repository declares no compiler.
- hoppscotch-F2 — closed, unchanged by lane C.
  after: `exit=2 killed=false seconds=35` / `Error: src/components/smart/EnvInput.vue?vue&type=script&setup=true&lang.ts imports "~icons/lucide/eye", a module in the `~icons/` virtual namespace: a Vite plugin generates it at request time, and 120fps never reads your vite.config, so nothing answers for it here. This repository declares unplugin-icons, the plugin that owns that namespace; measure a component that does not import from it, or stub the import.`
- documenso-F1 — closed, unchanged by lane C.
  after: `exit=2 killed=false seconds=36` / `Error: component harness failed before it became ready: Unable to determine current node version. Page errors:` / `  - Unable to determine current node version`, preceded by `  [transform:babel-macro] primitives/dialog.tsx → @lingui/react/macro: this project compiles that with a Babel macro compiler the project configures in its vite.config, which 120fps does not load (the harness never reads your vite.config).` No env-file remedy.
- Unaffected control: shadcn-admin `src/components/ui/button.tsx --explain-props`, `exit=0 killed=false seconds=3`, `Component: Button` / `Estimated real run: ~2m 9s`.

## Deferred

- primer-react's `__DEV__` injection (`babel-plugin-transform-replace-expressions`,
  `verify/primer-react.md`): A6's recognizer does not cover expression-replacement plugins.
- Honouring the project's `unsupportedPatterns` React Compiler opt-out list (the verifier
  established the `target` mismatch as the cause).
- Running any project Vite plugin: 120fps never reads vite.config (`src/preflight.ts:853-855`).
- The dry run printing the two new hits: `src/analyze.ts:2375` consumes only
  `preflight.soft`/`hard` (lane C, M110's dry-run/real-run parity MUST).
- Resolving `#` specifiers through a workspace-root `imports` map the importer does not inherit.
- The M107 rescue-alias widening and the `externalPkgs` "no installed dir" warning (M107, M110).
- Substituting console `%s`/`%o` placeholders and the Vue provide/inject wording (M114).
