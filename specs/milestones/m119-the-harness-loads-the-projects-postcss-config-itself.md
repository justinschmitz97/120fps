---
kind: milestone
status: approved
tests:
  - test/unit/postcss-config-plugins-load-from-the-defining-package.test.ts
  - test/unit/style-engine-detection.test.ts
---

# M119: The harness loads the project's PostCSS config itself

Lane A, run-6 remediation. Files: `src/harness/postcss-config.ts` (new),
`src/harness/style-tooling.ts`, `src/harness/build.ts`, `src/harness/index.ts`.

## Purpose

`plugins: ["@tailwindcss/postcss"]` is what `create-next-app` writes for Tailwind 4, and
`[name, options]` tuples are what a Next.js project writes for `postcss-preset-env`. Neither shape is
something `postcss-load-config` accepts, so Vite dies at the first stylesheet request and the run
ends 30 s later as `component harness did not become ready within timeout`. A workspace package that
owns the config owns the plugin dependency too, so resolving the plugin from the member root fails
even when the shape is valid. After this milestone the harness reads the config, resolves every
plugin from the directory that declares it, and hands Vite a plugin list, so `postcss-load-config`
never runs.

Run-6 evidence: `C:\Projekte\120fps-fieldtest\smoke\run6-smoke1\FINDINGS.md` cluster 1;
logs `logs/{platforms,umami,create-t3-turbo}/real.log`.

## Root causes (verified)

1. **The harness passes a directory, and only sometimes.** `src/harness/build.ts:320-321` sets
   `postcssOption = tailwind3Postcss ?? styleTooling.postcssConfigDir`, and
   `postcssConfigDir` comes from `findPostcssConfigAbove` (`src/harness/style-tooling.ts:151`), which
   returns `undefined` when the member root itself carries the config. All four run-6 repos carry it
   in the member root, so the harness passes nothing and Vite runs `postcss-load-config` on its own
   `root`. The failing logs name that search directly:
   `Failed to load PostCSS config (searchPath: E:/repositories-run6/platforms): [TypeError] Invalid
   PostCSS Plugin found at: plugins[0]`. Changing what `:320` passes is therefore not enough; the
   harness has to hand Vite a plugin list for every project that has a loadable config.
2. **String and tuple entries.** `E:/repositories-run6/platforms/postcss.config.mjs` declares
   `plugins: ["@tailwindcss/postcss"]`; `E:/repositories-run6/umami/postcss.config.js` declares
   `plugins: ['postcss-flexbugs-fixes', ['postcss-preset-env', { … }]]`. `postcss-load-config`
   accepts an object map or a loaded instance, nothing else.
3. **The plugin belongs to the package that declares it.**
   `E:/repositories-run6/create-t3-turbo/apps/nextjs/postcss.config.js` is one line,
   `export { default } from "@acme/tailwind-config/postcss-config"`, and `@tailwindcss/postcss` is a
   dependency of `tooling/tailwind`, not of `apps/nextjs`, so resolution from the member root fails
   with `Loading PostCSS Plugin failed: Cannot find module '@tailwindcss/postcss'`.
4. **`require()` of an ES module returns the namespace.** `readPostcssPluginDeclarations`
   (`src/harness/style-tooling.ts:265-272`) calls `createRequire(file)(file)` and reads `.plugins`
   off the result. Under Node >= 22.12 that call succeeds for an ESM config and yields the module
   namespace, whose `plugins` is `undefined`, so the Tailwind 3 pipeline silently degrades to
   "Could not read a plugin list from …". Reproduced against platforms, umami and plane, all three
   of which report `plugins shape: undefined` before the `default` unwrap and the real shape after.

## MUST

- **A1** For any project root, the harness finds the PostCSS config the way Vite would (member root
  first, then each level up to the workspace root), loads it itself, and passes
  `{ plugins, ...configOptions }` as Vite's `css.postcss`, so `postcss-load-config` never runs.
- **A2** Every plugin entry shape normalizes to one loaded plugin: a string name, a
  `[name, options]` tuple, an object-map key with its options object, an already-constructed
  instance, and a factory function. An object-map entry whose value is `false` stays disabled.
- **A3** A named plugin resolves with `createRequire` from the first base that resolves it, in this
  order: the real directory of each module the config file re-exports or imports from, the config
  file's own directory, the member root, the workspace root.
- **A4** A plugin no base resolves is skipped, and reported once, naming the config file, the plugin
  and every directory tried. Because the report is produced in `resolveStyleTooling`, whose warnings
  `src/harness/prebuild.ts:135` pushes into the static pre-build, `--explain-props` and the real run
  print the same line.
- **A5** A config the harness cannot read (`.ts`/`.cts`/`.mts`, `.postcssrc` JSON or YAML, a function
  config, a `package.json#postcss` key, a `plugins` value that is neither array nor object) leaves
  today's behaviour untouched: the ancestor directory when there is one, otherwise nothing, and
  Vite's own search decides.
- **A6** The Tailwind 3 pipeline keeps precedence: when
  `loadTailwind3PostcssPipeline` returns a pipeline, that pipeline is what Vite gets.

## MUST NOT

- A PostCSS config problem must not end a run as a harness-ready timeout.
- Vite must not receive a plugin list and a config directory at the same time: the list wins and the
  directory is not passed.
- The loader must not invent a plugin: an entry it cannot resolve is dropped and named, never
  replaced by a default.

## Verification

Tests first: `test/unit/postcss-config-plugins-load-from-the-defining-package.test.ts` imports
`loadPostcssConfigPipeline`, `unresolvedPostcssPlugins`, `POSTCSS_PLUGIN_UNRESOLVED_WARNING` and
`findPostcssConfigFile`, none of which existed at `0b3c496`, so the file did not compile before the
implementation landed.

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
(no output)

node node_modules/vitest/vitest.mjs run \
  test/unit/postcss-config-plugins-load-from-the-defining-package.test.ts \
  test/unit/style-engine-detection.test.ts \
  test/unit/tailwind-config-resolves-from-the-member-root.test.ts --maxWorkers=2
 Test Files  3 passed (3)
      Tests  39 passed (39)
```

Baseline of `vitest run test/unit --maxWorkers=2`, established by extracting `0b3c496` with
`git archive` into a scratch tree with a `node_modules` junction: the same 15 files fail there
(77 assertions, 11 of them only because that tree has no `dist/`). With this change and `dist/`
built, 66 assertions fail in 12 files — the same vue, prop, preflight and Next-shim assertions, none
of them touching CSS or PostCSS. No test changed state in either direction.

Corpus, through `C:/Projekte/120fps-fieldtest/scratch/lane-a/dist/cli/main.js` built from this
worktree, each run as
`node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd <cwd> --out
C:/Projekte/120fps-fieldtest/smoke/lane-a/<repo> --label <label> --timeout 600 --cli <scratch> --
<component> --samples 3 --max-combos 2 --explore-budget 30 --no-deltas` (dry runs: `--explain-props`,
`--timeout 300`):

| repo | cwd | component | before (0b3c496) | after |
|---|---|---|---|---|
| platforms | `E:/repositories-run6/platforms` | `components/ui/label.tsx` | `exit=2 seconds=34`, `Failed to load PostCSS config (searchPath: E:/repositories-run6/platforms): [TypeError] Invalid PostCSS Plugin found at: plugins[0]` | `exit=0 seconds=77`, `Result: PASS`, `Stylesheets: app/globals.css (found in the project entry's own imports)` |
| umami | `E:/repositories-run6/umami` | `src/components/common/Badge.tsx` | `exit=2`, same `Invalid PostCSS Plugin found at: plugins[0]` | `exit=0 seconds=13`, `Result: PASS`, `Mode: prop matrix` |
| create-t3-turbo | `E:/repositories-run6/create-t3-turbo/apps/nextjs` | `src/trpc/react.tsx` | `exit=2`, `Loading PostCSS Plugin failed: Cannot find module '@tailwindcss/postcss'` | `exit=0 seconds=23`, `Result: PASS`, `Stylesheets: src/app/styles.css` |
| platforms / umami / create-t3-turbo `--explain-props` | as above | as above | n/a | `exit=0` in 3 s, 3 s, 4 s; no PostCSS warning, because every declared plugin resolves |
| shadcn-admin (unaffected) | `E:/repositories-run5/shadcn-admin` | `src/components/ui/label.tsx` | reached a report | `exit=0 seconds=79`, `Result: PASS`, `Stylesheets: src/styles/index.css` |

Logs: `C:/Projekte/120fps-fieldtest/smoke/lane-a/{platforms,umami,create-t3-turbo,shadcn-admin}/`.
The `before` column for platforms is `a1-base.log`, recorded through the shipped tarball CLI, which
is the same build as `0b3c496`; the other two `before` rows are
`C:/Projekte/120fps-fieldtest/smoke/run6-smoke1/logs/{umami,create-t3-turbo}/real.log`.

## Deferred

- A `.ts` PostCSS config still needs a TypeScript loader the harness does not carry; Vite's own
  search handles it as before.
- An ESM config that `require()` cannot load (top-level await, Node < 22.12) is read by the async
  loader only, so its unresolvable-plugin warning is absent from `--explain-props`. No corpus repo
  has that shape.
