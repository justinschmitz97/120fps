---
kind: milestone
status: approved
tests:
  - test/unit/sass-import-compiles-with-a-disclosed-compiler.test.ts
  - test/unit/css-preprocessor-declared-vs-installed.test.ts
---

# M122: A sass import compiles, with a disclosed compiler

## Purpose

A component whose graph reaches a `.scss` or `.sass` file is measured even when the measured package
resolves no Sass implementation, and the run says once, in the dry run and the real run with the same
words, that it compiled with the Sass 120fps ships and which version that is. A `.less` or `.styl`
file, whose implementation 120fps does not ship, is a named refusal before the browser instead of a
30 s timeout carrying Vite's raw install hint. When only the bundler sees the missing preprocessor —
a `<style lang="scss">` block in a workspace sibling the import walk never enters — the failure is
still named, with the install command in this repository's own package manager.

Closes: run-6 smoke cluster 3 (logto `packages/console`, vue-vben-admin `apps/web-antd`). Evidence:
`C:\Projekte\120fps-fieldtest\smoke\run6-smoke1\FINDINGS.md` cluster 3,
`smoke/run6-smoke1/logs/{logto,vue-vben-admin}/real.log`.

## Root causes (verified)

1. **Vite has exactly two search bases and no config lever.** `loadPreprocessorPath`
   (`node_modules/vite/dist/node/chunks/dep-Dq2t6Dq0.js:44305-44320`) calls
   `requireResolveFromRootWithFallback(root, lang)` (`:7184-7191`), a Node `node_modules` walk-up from
   the CSS root and then a second walk-up from Vite's own installed directory (`_dirname`, `:6540`).
   `loadSassPackage` (`:44329-44338`) tries `sass-embedded` first, then `sass`, and rethrows the
   `sass-embedded` error when both miss. `grep implementation` over the bundle returns no
   CSS-preprocessor hit: `SassPreprocessorOptions` (`node_modules/vite/dist/node/index.d.ts:3468-3541`)
   exposes only `additionalData` and `api`. No absolute path and no module object can be handed to
   Vite; the only lever 120fps has is what resolves from those two directories.
2. **Neither repository has an implementation on the member's chain.** logto: `sass@1.77.8` exists
   only at `E:/repositories-run5/logto/node_modules/.pnpm/vite@6.4.3_*/node_modules/sass`, Vite's own
   optional peer inside the pnpm store; no `package.json` in the workspace declares sass, and neither
   `packages/console/node_modules` nor the root `node_modules` has it. vue-vben-admin: `sass` and
   `sass-embedded` are declared by `internal/vite-config/package.json:52-53` (`"catalog:"`,
   `pnpm-workspace.yaml:169-170`) and symlinked into `internal/vite-config/node_modules` only —
   not on the `apps/web-antd` → workspace-root chain. Both repositories' own dev servers work because
   their own Vite resolves the store copy; 120fps runs its own Vite, so its fallback base is 120fps's
   install.
3. **The hit is already known, and only warned about.** `TRANSFORM_RECOGNIZERS`
   (`src/project/preflight-gates.ts:94`) classifies `.scss` as `css-preprocessor` and
   `classifyPreprocessorAvailability` (`:349`) already splits installed / declared-not-installed /
   neither. The promotion loop at `src/project/preflight.ts:524-527` promotes only codes in
   `UNLOADABLE_FILE_TYPE_CODES`, so logto printed
   `[transform:css-preprocessor] src/ds-components/FormField/Skeleton.tsx → ./Skeleton.module.scss: …`
   and then died 30 s later on
   `Preprocessor dependency "sass-embedded" not found. Did you install it? Try \`npm install -D sass-embedded\`.`
   — an install command in the wrong package manager, for the wrong package, in the wrong directory.
4. **vue-vben-admin is not preflight-decidable.** Its 500 is on
   `packages/effects/layouts/src/basic/header/header.vue?vue&type=style&index=0&scoped=6c3f90bb&lang.scss`:
   an SFC `<style lang="scss">` block, not an import edge, in a workspace sibling reached through the
   `@vben/layouts` barrel. `apps/web-antd` contains no `.scss` at all, and the walk stops at package
   boundaries (`src/project/preflight.ts:490`). Its dry run correctly reports no transform hit.
5. **Every harness fault already passes through a diagnosis chain 120fps owns.**
   `src/pipeline/phases.ts:483` calls `presentBundlerFailure(message, projectRoot, combined)`
   (`src/harness/bundler-failure.ts:89-103`) for the readiness timeout too, and the thrown message
   carries both Vite's preprocessor error and `response 500: GET <url>` naming the requesting file.

## MUST

- 120fps declares `sass` as its own dependency, so Vite's fallback base resolves it.
- When `sass` or `sass-embedded` resolves on the measured member's own walk-up chain, nothing about
  the run changes: Vite finds the project's copy first and no disclosure is printed.
- When neither resolves on that chain and 120fps's own `sass` does, the run prints one warning — one
  per run, not one per hit — with identical text in the dry run and the real run, naming the
  importing file and its chain, saying that neither package resolves from the member root or its
  workspace root, and naming the Sass version 120fps compiled with.
- A `.less`, `.styl` or `.stylus` import whose implementation resolves from neither base is a hard
  preflight refusal before the browser, identical in the dry run, naming the importing file, the
  package looked for, the directories searched, and the install command for the measured member in
  this repository's own package manager.
- A harness failure carrying Vite's `Preprocessor dependency "<pkg>" not found` is presented as a
  named diagnosis: the requesting file taken from the failure text, the packages Vite looked for in
  Vite's own order, the two directories Vite searched, and the member-scoped install command. It
  replaces Vite's raw `npm install -D <pkg>` hint.
- The install command is built from the repository's own package manager and names the directory to
  run in, reusing the detection `packageManagerRunCommand` already uses.

## MUST NOT

- Print a disclosure, or a refusal, for a project whose own Sass implementation resolves.
- Print more than one Sass disclosure per run however many `.scss` edges the graph has.
- Claim a version 120fps cannot resolve: with no bundled implementation the hit falls back to the
  refusal, so no message names a compiler that is not there.
- Print `npm install -D sass-embedded` for a pnpm or yarn workspace, or a command without the
  directory it must run in.
- Change what `classifyPreprocessorAvailability` reports about the project itself: `installed`,
  `declared-not-installed` and `neither` keep their meanings, and the bundled implementation is a
  separate fact layered on top.

## Verification

Tests, `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2`.

`test/unit/sass-import-compiles-with-a-disclosed-compiler.test.ts` with M123's file:
`Test Files 2 passed (2)`, `Tests 32 passed (32)`.

Every test file that reaches `runPreflight`, `preflightFailureMessage`,
`classifyProjectTransformHits`, `presentBundlerFailure` or the package-manager helpers (14 files):
`Test Files 14 passed (14)`, `Tests 193 passed (193)`.

Whole suite, `test/unit/`: `Test Files 6 failed | 330 passed (336)`,
`Tests 32 failed | 4840 passed | 1 skipped (4873)`. All 32 failures are this worktree's own
install state, not this milestone: `fixtures/{vue-project,vue-dual-block}/node_modules` held no
`vue`, `fixtures/m81/node_modules` no `aria-button`, and no `dist/` had been emitted. With those
three fixture directories junctioned to the main checkout's copies and `dist/` built
(`node node_modules/typescript/bin/tsc -p tsconfig.json`), the six files pass:
`vue-dual-block-props` + `prop-default-disclosure` + `prop-cap-ranking` `Tests 31 passed (31)`,
`nextjs-shim` + `nextjs-shim-harden` + `next-runtime-shim-coverage` `Tests 55 passed (55)`.

`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`: clean, no output.

Corpus, `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cli
C:/Projekte/120fps-fieldtest/scratch/lane-b/dist/cli/main.js`, one run at a time.

- logto, `--cwd E:/repositories-run5/logto/packages/console -- src/ds-components/FormField/Skeleton.tsx`.
  before (`smoke/run6-smoke1/logs/logto/real.log:3,5,15`):
  `Error: component harness did not become ready within timeout. Page errors:` /
  ``Preprocessor dependency "sass-embedded" not found. Did you install it? Try `npm install -D sass-embedded`.`` /
  `- response 500: GET http://localhost:5173/src/ds-components/FormField/Skeleton.module.scss`.
  after, dry run (`--explain-props`, label `m122-dry`): `exit=0 killed=false seconds=4`

      [transform:css-preprocessor] src/ds-components/FormField/Skeleton.tsx → ./Skeleton.module.scss: no sass or sass-embedded resolves from the measured package or its workspace root, so Vite falls through to the copy 120fps ships (sass 1.104.0) and this stylesheet compiles with that version rather than one this project pins. Add sass to the measured package to compile with the project's own.

  after, real run (`--samples 3 --max-combos 2 --explore-budget 30 --no-deltas`, label `m122-real`):
  `exit=0 killed=false seconds=33`, `Mode: curve over "formFieldCount" (numeric prop name matches
  scaling pattern)`, `Result: PASS`,
  `Total: 31.0s  (preflight 0s, build 5s, calibration 2s, mount 9s, rerender 4s, explore 9s, attribution 0s, analysis 2s)`.
  The disclosure line is byte-identical to the dry run's (compared after stripping the `⚠ ` prefix)
  and appears once in each log.
- vue-vben-admin, `--cwd E:/repositories-run6/vue-vben-admin/apps/web-antd -- src/layouts/auth.vue`.
  before (`smoke/run6-smoke1/logs/vue-vben-admin/real.log:3,5,16`): the same preprocessor error, on
  `.../packages/effects/layouts/src/basic/header/header.vue?vue&type=style&index=0&scoped=6c3f90bb&lang.scss (×2)`.
  after, dry run (label `m122-dry`): `exit=0 killed=false seconds=6`, no transform warning at all —
  root cause 4 confirmed: `apps/web-antd`'s own import graph reaches no `.scss` edge, so the dry run
  has nothing to disclose.
  after, real run (label `m122-real`): `exit=2 killed=false seconds=26`, and
  `grep -c -E "Preprocessor dependency|response 500"` over the log is `0`: the sibling package's
  `<style lang="scss">` block compiled with the bundled Sass. The run reaches `calibration  (0:19)`,
  `mode: prop combos  (0:22)` and stops on a component-level fact,

      Error: mount phase failed on combo 0 of auth.vue: page.evaluate: TypeError: Cannot destructure property 'Component' of 'undefined' as it is undefined.

  thrown from `packages/effects/layouts/src/authentication/form.vue:11` — the router-view slot props
  the harness does not synthesize. That is past this milestone's boundary and is not covered here.
- Unaffected control: shadcn-admin, `--cwd E:/repositories-run5/shadcn-admin --
  src/components/ui/label.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas`
  (label `m122-m123-control`): `exit=0 killed=false seconds=66`,
  `Mode: prop combos (2 measured of 64 generated, +4 scale probes)`, `Result: PASS`,
  `Stylesheets: src/styles/index.css (found in the project entry's own imports)`.

## Deferred

- Sibling-SFC preflight parity: a `<style lang="scss">` block in a workspace sibling stays invisible
  to the dry run. Reaching it needs the import walk to cross package boundaries and to read SFC style
  blocks, which changes the walk for every repository. vue-vben-admin is covered by the
  bundler-failure diagnosis, not by dry-run parity.
- `preprocessorFor` (`src/harness/stylesheets.ts:190-195`, lane A) still refuses to inject a global
  `.scss` stylesheet whenever no implementation is available in the project, and does not know about
  the bundled one. With 120fps shipping sass that skip is now too strict — nocodb's `assets/style.scss`
  is a live example. Interface request to lane A.
- Bundling `less` or `stylus` as well: each is another dependency for a failure class no run-6
  repository hit through an import edge.
- A `--sass-implementation` flag or honouring the project's own store copy: Vite offers no hook and
  120fps does not search the pnpm store.
