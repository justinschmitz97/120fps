---
kind: milestone
status: approved
tests:
  - test/unit/react-native-renders-through-react-native-web.test.ts
---

# M127: a React Native app renders through react-native-web

Lane C (`src/harness/deps-scan.ts`).

## Purpose

bluesky-social-app is a React Native Web app: it ships `react-native` and `react-native-web`, and its
own webpack config aliases one to the other, the substitution every React Native Web bundler makes.
Our harness makes no such substitution, so Vite's dependency optimizer pre-bundles `react-native`
itself and the run ends in 147 raw esbuild errors with no diagnosis. After this milestone the same
substitution happens here, and a project that has no `react-native-web` is refused by name instead of
by esbuild.

Run-6 evidence: `C:/Projekte/120fps-fieldtest/smoke/lane-c/bluesky/bluesky-real.log:1653`
(`Error: Build failed with 147 errors:`), `:5` (the entry point is
`node_modules/react-native/types_generated/index.d.ts`), `:69,:91,:113` (48 lines of
`No known conditions for "./Libraries/…" specifier in "react-native" package [plugin vite:dep-pre-bundle]`),
and `bluesky-dry.log` (exit 0: the dry run disclosed none of it).

## Root causes (verified)

1. **A types-only condition selects a `.d.ts` entry for a runtime pre-bundle** —
   `resolveServerConditions` (`src/project/resolve.ts:18-39`) forwards the governing tsconfig's
   `customConditions` into Vite's `resolve.conditions` (`src/harness/prebuild.ts:74`,
   `src/harness/build.ts:359`). bluesky's tsconfig declares
   `"customConditions": ["react-native-strict-api"]`, and `react-native`'s manifest maps
   `exports["."]` to `{"react-native-strict-api": "./types_generated/index.d.ts", "types": "./types/index.d.ts", "default": "./index.js"}`
   and `exports["./*"]` to `{"react-native-strict-api": null, "types": "./*.d.ts", "default": "./*.js"}`.
   The verifier: esbuild's entry in the failing log is exactly `types_generated/index.d.ts`, which no
   other condition selects, and every `No known conditions` error names a `./Libraries/…` subpath the
   same condition maps to `null`.
2. **Every bare specifier becomes a pre-bundle entry, and `react-native` has no substitution** —
   `walkExternalDeps` (`src/harness/deps-scan.ts:362-393`) adds each bare specifier's package to
   `externalPkgs`, which becomes `optimizeDeps.include` (`src/harness/build.ts:258-261,362`). The only
   exclusions are the hardcoded `BLOCKED` set (`deps-scan.ts:399-407`) and `react`/`react-dom`
   (`:411-412`). `src/components/Divider.tsx:1` is `import {View} from 'react-native'`, so
   `react-native` reaches the optimizer with no alias anywhere in the chain
   (`src/harness/prebuild.ts:81-85` holds tsconfig paths, the project's own Vite aliases and the
   Next.js shims, nothing React Native).
3. **A raw esbuild failure has no classifier** — `presentBundlerFailure`
   (`src/harness/bundler-failure.ts:89-103`) matches five shapes, none of which is
   `Build failed with N errors` or `No known conditions for …`, so the fallback
   `stripBundlerStackFrames` hands esbuild's own output to the user.

## MUST

- **C1** With `react-native` in the component's import graph and `react-native-web` resolvable from
  the project, the harness aliases `react-native` to `react-native-web`, replaces it in the
  pre-bundle list, and discloses the substitution once.
- **C2** With `react-native` in the graph and no `react-native-web` installed, the run stops with a
  message that names React Native as the layer this tool cannot render and names the file that
  imports it. The dry run and the real run stop the same way, since both decide it in the static
  scan.
- **C3** With `react-native` in the graph and packages that declare `react-native` as their own
  dependency or peer dependency, the run stops naming those modules, their count and the reason the
  substitution does not reach them. Substituting `react-native` does not make a module built for
  React Native loadable, and this is the shape that produced the raw esbuild wall: 48 of the 50
  remaining errors after C1 were `react-native/Libraries/…` imports written inside
  `react-native-svg`, `@sentry/react-native`, `react-native-safe-area-context`,
  `react-native-pager-view` and `react-native-gesture-handler`.
- **C4** A project without `react-native` in its graph is unchanged: no alias, no disclosure, no
  refusal.

## MUST NOT

- Let esbuild's multi-error output be the diagnosis for this shape.
- Pre-bundle a `.d.ts` entry that a tsconfig `customConditions` value selected: after the alias,
  `react-native`'s own manifest is never resolved for the browser at all.
- Alias `react-native` to anything when `react-native-web` is not installed: a substitution nobody
  can honour would trade one unreadable failure for another.
- Rewrite subpath specifiers: the alias matches `react-native` exactly, the same shape webpack's
  `'react-native$'` uses.

## Verification

- C1 — `test/unit/react-native-renders-through-react-native-web.test.ts`: a project whose component
  imports `react-native` with both packages installed produces an alias whose `find` matches
  `react-native` and not `react-native-svg`, a pre-bundle list holding `react-native-web` and not
  `react-native`, and one disclosure.
- C2 — same file: the same project without `react-native-web` throws, and the message names React
  Native, `react-native-web` and the importing file.
- C3 — same file: a project that also imports a package whose manifest declares `react-native` as a
  peer dependency throws, naming that package.
- C4 — same file: a project importing neither leaves aliases, warnings and the list untouched.
- Suite: the tests above plus `test/unit/import-scanner-coverage.test.ts`,
  `test/unit/unbuilt-sibling-subpath-resolves-to-its-source.test.ts`,
  `test/unit/workspace-sibling-entry-resolution.test.ts`,
  `test/unit/workspace-sibling-transitive-rescue.test.ts`,
  `test/unit/workspace-sibling-diagnosis-wording.test.ts`,
  `test/unit/unbuilt-workspace-source-alias.test.ts`,
  `test/unit/remedy-commands-name-the-directory-to-run-in.test.ts`.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Corpus: bluesky-social-app (`--cwd E:/repositories-run6/bluesky-social-app`, component
  `src/components/Divider.tsx`) must no longer end in esbuild's own output, in the real run and in
  the dry run; shadcn-admin must still reach a report. Runs carry `--no-preflight`, since lane B's
  M124 turns the `@lingui/core/macro` finding in bluesky's graph into a refusal that would stop the
  run before the harness builds.

Recorded run of this milestone's verification:

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   -> TSC_CLEAN
vitest run test/unit/react-native-renders-through-react-native-web.test.ts --maxWorkers=2
  -> Test Files 1 passed (1), Tests 4 passed (4)
vitest run test/unit/react-native-renders-through-react-native-web.test.ts \
  test/unit/import-scanner-coverage.test.ts \
  test/unit/unbuilt-sibling-subpath-resolves-to-its-source.test.ts \
  test/unit/workspace-sibling-entry-resolution.test.ts \
  test/unit/workspace-sibling-transitive-rescue.test.ts \
  test/unit/workspace-sibling-diagnosis-wording.test.ts \
  test/unit/unbuilt-workspace-source-alias.test.ts \
  test/unit/remedy-commands-name-the-directory-to-run-in.test.ts --maxWorkers=2
  -> Test Files 8 passed (8), Tests 60 passed (60)
```

Corpus, through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --timeout 900 --cli
C:/Projekte/120fps-fieldtest/scratch/lane-c/dist/cli/main.js`, scratch dist built from this worktree:

- bluesky, `--cwd E:/repositories-run6/bluesky-social-app -- src/components/Divider.tsx --no-preflight
  --samples 3 --max-combos 2 --explore-budget 30 --no-deltas` (label `m127-real3`) -> exit 2 in 7 s,
  `grep -c ERROR` over the log = 0, `m127-real3.log:3`:
  `Error: src/components/Divider.tsx reaches 55 React Native modules (@bsky.app/alf, @bsky.app/expo-dynamic-app-icon, @bsky.app/expo-image-crop-tool, @bsky.app/expo-scroll-edge-effect, @bsky.app/expo-translate-text and 50 more). react-native itself is substituted by react-native-web for this run, but each of these declares react-native as its own dependency and ships a native implementation this run cannot swap for a web one, so it cannot load in a browser. Measure a component whose imports reach none of them.`
  Before this milestone the same run ended with `Error: Build failed with 147 errors:` in 20 s
  (`bluesky-real.log:1653`).
- bluesky, same component, `--no-preflight --explain-props` (label `m127-dry3`) -> exit 2 in 6 s with
  the same message on `m127-dry3.log:2`, where the dry run used to print prop tables and exit 0.
- Intermediate step, recorded because it is what C3 answers: with C1 alone the run failed with
  `Error: Build failed with 50 errors:` (`m127-real.log:3`), 48 of them
  `No known conditions for "./Libraries/…" specifier in "react-native" package`, raised by files
  inside `react-native-svg` (30), `@sentry/react-native` (9), `react-native-safe-area-context`,
  `react-native-pager-view` and `react-native-gesture-handler`.
- shadcn-admin, `--cwd E:/repositories-run5/shadcn-admin -- src/components/ui/label.tsx --no-preflight
  --samples 3 --max-combos 2 --explore-budget 30 --no-deltas` (label `m127-unaffected`) -> exit 0 in
  80 s,
  `Total: 1m 18s  (preflight 0s, build 1s, calibration 3s, mount 5s, rerender 3s, explore 3s, attribution 0s, analysis 1m 2s)`.

## Deferred

- `.web.tsx`/`.web.ts`/`.web.js` extension priority, which every React Native Web bundler applies
  (`@expo/webpack-config` resolves `web.ts, web.tsx, web.mjs, web.js, web.jsx` before the plain
  extensions). The edit: a `resolveExtensions` field on the static pre-build in
  `src/harness/prebuild.ts` carried into `resolve.extensions` in `src/harness/build.ts:355-360`
  (lane A's file), and `optimizeDeps.esbuildOptions.resolveExtensions` in the same config for the
  dependency optimizer. Without it, a package that ships a `.web.js` variant beside a native module
  keeps the native one, which is why C3 refuses rather than measures. When that lands, C3's rule
  should be narrowed to modules that ship no web variant, and bluesky re-measured.
- A general guard against a `customConditions` value that selects a declaration file: the observed
  case is answered by never resolving `react-native` for the browser. A general rule would have to
  drop a condition per package, and `resolve.conditions` is one global list.
- Aliasing `react-native/<subpath>` specifiers: react-native-web publishes a different internal
  layout, so a prefix alias would map onto files that do not exist.
