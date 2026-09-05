---
kind: milestone
status: approved
tests:
  - test/unit/babel-macro-import-is-refused.test.ts
---

# M124: A Babel macro import is refused before the browser

## Purpose

A component whose import graph reaches a Babel macro is refused by preflight, with the same text in
the dry run and the real run, naming the importer, the macro specifier, the compiler the project
declares for it and the way out. 120fps loads no macro compiler and never will, so the hit is
decidable from disk and belongs before the browser starts.

Closes: run-6 smoke cluster 6 (documenso), the reappearance of run-5 finding documenso-F1 one layer
later. Evidence: `C:\Projekte\120fps-fieldtest\smoke\run6-smoke1\FINDINGS.md` cluster 6,
`smoke/run6-smoke1/logs/documenso/{dry,real}.log`.

## Root causes (verified)

1. **The hit is known before the browser and printed as a warning.** `isMacroSpecifier`
   (`src/project/preflight-gates.ts:147-156`) matches `*/macro`, `*.macro` and `babel-plugin-macros`;
   the recognizer at `:110` turns the edge into a `project-transform` hit and
   `declaredTransformOwner` (`:177`) resolves documenso's owner to `vite-plugin-babel-macros`. The
   promotion loop at `src/project/preflight.ts:524-528` promotes a `project-transform` hit to a hard
   refusal only when its code is in `UNLOADABLE_FILE_TYPE_CODES`
   (`src/project/preflight-gates.ts:168`, the four data-loader codes). `babel-macro` is not in that
   set, so the run continues past a complete diagnosis.
2. **No macro compiler is loadable, ever.** `SUPPORTED_TRANSFORM_PLUGINS`
   (`src/project/transforms.ts:17-26`) is `svgr`, `vanilla-extract`, `vue`. `babel-macro` can never
   appear in `detectProjectTransforms`'s loadable set, so every `babel-macro` hit that survives
   `classifyProjectTransformHits` (`src/project/preflight-gates.ts:365`) is unloadable by
   construction — the same standing as the data-loader codes M110 A5 promoted.
3. **What the user reads instead.** documenso `apps/remix`,
   `app/components/embed/embed-client-loading.tsx`: preflight prints
   `[transform:babel-macro] app/components/embed/embed-client-loading.tsx → @lingui/react/macro: this project compiles that with vite-plugin-babel-macros, which 120fps does not load (the harness never reads your vite.config). The import may fail to build, or build unstyled.`
   and the run then dies in the browser with
   `Error: component harness failed before it became ready: Unable to determine current node version.`
   — `@lingui/react/macro` reaching the browser unexpanded.

## MUST

- A `project-transform` hit whose `transformCode` is `babel-macro` is a hard preflight hit
  (`kind: "unloadable-macro"`), refused before the browser and with the identical message in the dry
  run.
- The refusal names the importer, the macro specifier, the full chain, and the declared macro
  compiler when the measured package or its workspace root declares one; with none declared it says
  so instead of naming a package.
- The refusal's remedy is to write the macro call out by hand, to measure a component whose graph
  does not reach the macro, or to pass `--no-preflight`.
- The hit stays in `preflight.transforms`, so `--no-preflight` still prints the transform warning and
  runs the rest of the pipeline unchanged: with the flag, preflight raises no refusal, the harness
  builds, the browser starts and whatever the run would have found without this milestone is still
  found. Lane C's twenty and bluesky-social-app work runs that way.
- A refusal that is not a transform refusal still wins the message: a `server-only`,
  `use-server`, `async-component`, `unsupported-framework`, `yarn-pnp` or `not-installed` hit is
  reported ahead of `unloadable-macro`, as it already is ahead of `unloadable-file-type`.

## MUST NOT

- Promote a `virtual-module` hit: an unrecognised virtual namespace stays a warning (M108 A7).
- Fire on a relative `./macro` or `/macro` path: that is the project's own file and an ordinary
  graph edge (`isMacroSpecifier`'s first guard).
- Claim the project compiles the macro with a package it declares nowhere (M92).
- Claim that nothing is on disk behind the specifier: `@lingui/react/macro` is a real module that
  throws when it evaluates unexpanded.

## Verification

Tests, `node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2`.

`test/unit/babel-macro-import-is-refused.test.ts`: `Test Files 1 passed (1)`, `Tests 10 passed (10)`.

Every test file that reaches `runPreflight`, `preflightFailureMessage`,
`PREFLIGHT_BYPASSED_WARNING`, `PreflightKind` or `classifyProjectTransformHits` (18 files):
`Test Files 4 failed | 14 passed (18)`, `Tests 37 failed | 333 passed (370)`. The four failing files
fail identically before this milestone: with `src/project/preflight.ts` and
`src/project/preflight-gates.ts` checked out at `0b3c496`,
`test/unit/{vue-support,vue-support-harden,dx-features,dx-features-harden}.test.ts` reported
`Test Files 3 failed | 1 passed (4)`, `Tests 36 failed | 165 passed (201)`, and
`test/unit/{unloadable-file-type-import-is-refused,dx-features,dx-features-harden}.test.ts` reported
`Test Files 2 failed | 1 passed (3)`, `Tests 3 failed | 106 passed (109)`. Every one of those
failures reads

    Cannot read .vue components: neither vue/compiler-sfc nor @vue/compiler-sfc resolves from
    C:\Projekte\120fps-lane-b\fixtures\vue-project.

— this worktree's Vue fixtures have no installed `vue`. This milestone adds no failure.

`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`: clean, no output.

Corpus, `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cli
C:/Projekte/120fps-fieldtest/scratch/lane-b/dist/cli/main.js`, one run at a time.

- documenso, `--cwd E:/repositories-run5/documenso/apps/remix --
  app/components/embed/embed-client-loading.tsx`.
  before (`smoke/run6-smoke1/logs/documenso/real.log`, and re-run at `0b3c496` as
  `smoke/lane-b/documenso/b3-repro.log`): `exit=2 killed=false seconds=43` /
  `Error: component harness failed before it became ready: Unable to determine current node version.`,
  with the macro named only as a warning.
  after, dry run (`--explain-props`, label `m124-dry`): `exit=2 killed=false seconds=2`

      Error: Cannot measure this component in a browser: app/components/embed/embed-client-loading.tsx imports @lingui/react/macro, a Babel macro, which a compiler is meant to rewrite away while the project builds.
        app/components/embed/embed-client-loading.tsx → @lingui/react/macro
      This project compiles that with vite-plugin-babel-macros. 120fps loads only its supported transforms (svgr, vanilla-extract, vue) and never reads your vite.config, so nothing here expands it: the macro's own module would reach the browser instead of the code it would have generated.
      In a copy of this component, write the macro call out by hand as the code the compiler would have generated, or measure a component below this one whose graph does not reach the macro. Pass --no-preflight to attempt the run anyway.

  after, real run (`--samples 3 --max-combos 2 --explore-budget 30 --no-deltas`, label `m124-real`):
  `exit=2 killed=false seconds=2`, byte-identical text after the
  `preflight: walking the import graph` progress line. Dry and real agree.
- documenso with `--no-preflight` (label `m124-nopreflight`): the pipeline runs unchanged and ends
  where it ended before this milestone —
  `- Unable to determine current node version`, preceded by
  `[transform:babel-macro] app/components/embed/embed-client-loading.tsx → @lingui/react/macro: this project compiles that with vite-plugin-babel-macros, …`
  and `--no-preflight bypassed 1 babel-macro finding: app/components/embed/embed-client-loading.tsx → @lingui/react/macro`.
- Unaffected control: shadcn-admin `--cwd E:/repositories-run5/shadcn-admin -- src/components/ui/label.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas`,
  `exit=0 killed=false seconds=113`, `Mode: prop combos (2 measured of 64 generated, +4 scale probes)`,
  `Stylesheets: src/styles/index.css (found in the project entry's own imports)`.

## Deferred

- Recognising a macro by a declared `babel-plugin-macros`-style plugin rather than by the specifier
  shape (M108 A6's deferred half: applied literally it makes every import edge a hit).
- twenty's unbuilt-workspace-sibling message (smoke cluster 9) and bluesky-social-app's
  react-native-web esbuild errors (smoke cluster 5) are now masked by this refusal, which fires
  before the harness build. Both projects' macros would fail in the browser anyway; both findings
  stay reachable with `--no-preflight`.
