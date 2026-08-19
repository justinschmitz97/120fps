---
kind: milestone
status: approved
tests:
  - test/unit/entry-stylesheet-discovery.test.ts
  - test/unit/global-stylesheet-fallbacks.test.ts
  - test/unit/vite-config-static-data.test.ts
  - test/unit/browser-process-env-defines.test.ts
  - test/unit/style-engine-detection.test.ts
---

# M71: evidence-driven CSS discovery + vite.config data recovery

## Goal

A measurement is only worth its number when the component renders the way it renders in the app. Two sources of unstyled or half-styled measurements remain:

- Stylesheet discovery was a filename allowlist. `detectGlobalCss` probed eight fixed paths with `fs.statSync` and returned the first hit (`src/harness.ts` `GLOBAL_CSS_CANDIDATES` / `detectGlobalCss`). A create-vite app (`src/style.css`), any `.scss` entry, and any stylesheet reachable only through the project's own entry module were all invisible, and the run reported "no stylesheets" without saying it had only guessed at filenames.
- The project's `vite.config.*` is never executed (hard invariant) and, until now, never read either. Its `publicDir`, its literal `resolve.alias` entries, and the mere presence of things the harness cannot replicate were all lost silently. A moved `publicDir` means the project's fonts 404 and every text metric is a fallback-font metric.

Two adjacent silences are fixed with them: the Tailwind plugin was loaded only when a stylesheet had already been found, and `process.env.*` in a client module threw `ReferenceError: process is not defined` in the dev server, because Vite's own `process.env` shim does not reach client source in dev (verified below).

## Scope

### Stylesheet discovery (`src/harness.ts`, `resolveCssFiles` in `src/analyze.ts`)

Priority order, first layer that yields at least one validated file wins:

1. **Explicit `--css`** (`resolveCssFiles`): unchanged. Paths resolve against `process.cwd()`, a missing or non-file path throws, and detection is suppressed.
2. **Entry import graph** (`discoverGlobalCss` → `findProjectEntry` + `entryStylesheetImports`). The project's real entry is located, then that entry file's *own* side-effect stylesheet imports are collected, in import order:
   - `index.html` at the project root: the `src` of the first `<script type="module" src="…">`, resolved relative to the html file (create-vite, plain Vite).
   - Next.js, first hit wins: `app/layout.*`, `src/app/layout.*`, `pages/_app.*`, `src/pages/_app.*` with extensions `.tsx`, `.jsx`, `.ts`, `.js`.
   - Only static side-effect imports (`import "./x.css"`), only the extensions `.css`, `.scss`, `.sass`, `.less`, `.styl`, and never a `*.module.*` specifier: a CSS module exports class names and injecting it globally measures a stylesheet the app never loads globally.
   - Relative specifiers resolve against the entry file. A non-relative specifier is resolved through the project's tsconfig alias table (`loadTsconfigAliases`, the same table the harness builds), which is what makes the common Next.js `import "@/app/globals.css"` work. A specifier that no alias resolves (a bare package stylesheet, an alias whose target is missing) is skipped and named in one warning.
   - A preprocessor stylesheet is injected only when its compiler is installed (`sass` or `sass-embedded` for `.scss`/`.sass`, `less`, `stylus`), because Vite fails the whole entry module with "Preprocessor dependency … not found" otherwise. A skipped one is named in a warning.
3. **Candidate list** (`GLOBAL_CSS_CANDIDATES`, `detectGlobalCss`): unchanged semantics, extended list (below). Still at most one file.
4. **Largest-stylesheet fallback** (`largestStylesheet`): a bounded scan under the project root for the largest non-`*.module.*` stylesheet, skipping every dot-directory (`.git`, `.next`, `.turbo`, `.cache`, the harness's own `.120fps-*`) plus `node_modules`, `dist`, `build`, `out`, `coverage`, `public`, and `storybook-static`, capped at 8 levels deep and 4000 visited entries. `public` is excluded because a stylesheet there is served as a static asset and loaded by a `<link>`, never by the module graph. Ties break on path, so one project always yields one answer. The pick is injected **with** a warning naming the file and the reason, because a fallback that is silently wrong is worse than one that says it guessed.

Every auto-detected path is `fs`-validated (`isFile`) before it leaves discovery: a specifier that does not exist kills the whole harness entry module, and only `--css` validated its input before this milestone. Layers 2 and 3 deduplicate against each other by absolute path.

`detectGlobalCss` and `GLOBAL_CSS_CANDIDATES` keep their exports and their meaning ("the conventional-filename layer"), so nothing that depends on them changes shape.

### Tailwind plugin gate (`src/harness.ts`, `buildAndServe`)

`cssFiles.length > 0 && detectTailwindVite(projectRoot)` becomes `resolveStyleTooling(projectRoot).tailwind`. The plugin generates utility CSS for the classes the measured component uses; whether a *global* stylesheet was also found says nothing about whether the plugin is needed. `resolveStyleTooling` takes no stylesheet list at all, which is the decoupling.

### vite.config static text scan (`src/harness.ts`, `readViteConfigData`)

`vite.config.ts|js|mjs|mts|cjs|cts` at the project root is read as text and parsed with `ts.createSourceFile`. Nothing is imported and nothing is executed; the invariant is unchanged. The exported config object is located through `export default {…}`, `export default defineConfig({…})`, `defineConfig(() => ({…}))` / `defineConfig(() => { return {…} })`, and `module.exports = {…}`. Only that object's own top-level properties are read:

- `publicDir`: a string literal, resolved against the config's directory and passed to `createServer` when the directory exists. Absent or non-literal leaves Vite's default (`<root>/public`) untouched.
- `resolve.alias`: an object literal's string-literal-to-string-literal entries become aliases, `find` matching a whole leading segment (`^@(?=/|$)`, the same rule `@rollup/plugin-alias` applies to the object form). The target resolves against the config's directory and must exist. They merge **after** the tsconfig aliases and **before** the Next.js shims, so a tsconfig `paths` entry wins on conflict, which is the precedence TypeScript users already assume.
- Ignored-key detection: a `publicDir` that is not a literal or names nothing, a non-literal or non-object `resolve.alias` (an alias whose target is missing counts), any `css.preprocessorOptions`, and a non-empty `plugins` array each add one entry to a single `VITE_CONFIG_IGNORED_WARNING`, naming the config file and the keys found and not honored. A config whose exported object is not statically reachable at all (`export default buildConfig(mode)`) reports the single key `a computed config object`. The list is emitted in a fixed order, so the warning reads the same however the config file was written. `css.preprocessorOptions` specifically warns that Sass/Less global injection (`additionalData`) is not replicated, so a project whose variables come from there knows why its component looks unstyled.

### PostCSS config discovery (`src/harness.ts`, `findPostcssConfigAbove`)

**Verified in the installed Vite 6.4.2** (`node_modules/vite/dist/node/chunks/dep-Dq2t6Dq0.js`): `resolvePostcssConfig` calls `postcssrc({}, searchPath, { stopDir })` with `searchPath = config.root` and `stopDir = searchForWorkspaceRoot(config.root)`, and the bundled lilconfig loop searches a directory *before* testing `dir === stopDir`, so the stop directory is inclusive. Vite therefore **does** walk upward past the harness root — the audit hypothesis that it does not is false in the general case.

The gap is narrower and real: `searchForWorkspaceRoot` recognizes only `pnpm-workspace.yaml`, `lerna.json`, and a `package.json` with a `workspaces` field (`ROOT_FILES` has `.git`, `rush.json`, `nx.json` commented out, and no lockfile). This tool's `findWorkspaceRoot` also accepts a bare lockfile (`WORKSPACE_LOCKFILES`). In a repo whose root carries only a lockfile, Vite's `stopDir` collapses to the member package and an ancestor `postcss.config.*` is never found.

So: probe `postcss.config.{js,cjs,mjs,ts,cts,mts}` and `.postcssrc{,.json,.yaml,.yml,.js,.cjs,.mjs,.ts,.cts,.mts}` (postcss-load-config's own search places, minus `package.json`) from the member root upward to and including `findWorkspaceRoot(memberRoot)`. When the first hit is **above** the member root, pass `css: { postcss: <that directory> }`; when the member root has its own config, pass nothing and let Vite find it. Passing the directory is a no-op wherever Vite's own walk would have reached the same file.

### Browser `process.env` (`src/harness.ts`, `readEnvDefines`)

**Verified in the installed Vite 6.4.2**: the `vite:define` transform returns immediately for `consumer === "client"` outside a build, so config `define` entries are *not* substituted into client source in dev. The user's defines instead reach the page through `vite/dist/client/env.mjs`, which receives `__DEFINES__` from `vite:client-inject` and assigns each dotted key onto `globalThis` at runtime. Vite's own `process.env`/`process.env.NODE_ENV` shims live in `definePlugin` and never reach client dev source (only `process.env.NODE_ENV` is patched, by a separate `vite:client-inject` branch). Consequence: without a `define`, `process` is undefined in the page and `process.env.ANYTHING` throws `ReferenceError`.

- `.env` then `.env.local` are read at the workspace root and then at the member root, each level overriding the one before, with `KEY=VALUE` parsing only: `#` comments, blank lines, an optional `export ` prefix, and one layer of surrounding quotes. No interpolation, no `dotenv` dependency.
- Only `NEXT_PUBLIC_*` and `VITE_*` keys are defined, as `process.env.<KEY>`. Every other key stays out: a `.env` holds database URLs and API secrets, and the page is a browser context.
- `"process.env": "{}"` is always defined, so a key the project did not export yields `undefined` instead of a `ReferenceError`.
- Ordering is safe in both mechanisms, verified: `serializeDefine` sorts keys, and `"process.env"` sorts before `"process.env.VITE_X"`, so `env.mjs` creates the empty object first and then writes the specific key into it. For the build/SSR path esbuild's `define` is longest-match and order-independent (checked against esbuild 0.25.12: `{"process.env":"{}","process.env.NEXT_PUBLIC_A":"\"hello\""}` yields `"hello"` for the specific member and `define_process_env_default.OTHER` for an unlisted one, in either key order).
- Confirmed against a booted harness: `/@vite/env` served `defines = {"process.env": {}, "process.env.NEXT_PUBLIC_TITLE": "smoke"}` for a project whose `.env` also held `DATABASE_URL`, which is absent.

### Unreplicated styling engines (`src/harness.ts`, `detectUnsupportedStyleEngines`)

`unocss`, `@unocss/vite`, `@linaria/vite`, `@linaria/core`, `@pandacss/dev` are recognized through `isPackageAvailable` (member root and workspace root, declaration or install). Presence produces one warning naming the packages and stating that their styling is not replicated. No plugin is loaded and no measurement changes: the warning exists so an unstyled-looking number is explainable.

### Fixture

`fixtures/vite-app/`: create-vite shaped. `index.html` with `<script type="module" src="/src/main.tsx">`, `src/main.tsx` importing `./style.css`, `./theme.scss`, and `./widget.module.css`, plus `src/style.css`, `src/theme.scss`, `src/widget.module.css` and a `package.json` that declares `sass`, so the Sass import is injectable evidence rather than a skipped one. Exercised by file-based unit tests only; no browser. Fixture `node_modules` directories are git-ignored, so availability is stated through the manifest.

## Changed contracts

- `GLOBAL_CSS_CANDIDATES` gains `src/style.css` (create-vite's own name) and the `.scss` variants of the existing names, appended so every previously winning path still wins. `test/unit/css-injection.test.ts` asserted the exact eight-entry list and is updated to the new list; its per-candidate and precedence tests are unchanged in meaning.
- Auto-detection can now return more than one file, in import order. `HarnessResult.cssFiles`, `BuildHarnessOptions.cssFiles`, the entry generator, and `CssReport.files` were already arrays; nothing changes shape.
- `resolveCssFiles(options, projectRoot)` gains an optional third parameter, a warning sink. The return value stays `{ files, autoDetected }` exactly, so `CssReport` is untouched and every existing caller and assertion keeps working.
- `buildAndServe` passes `publicDir`, `define`, and (conditionally) `css.postcss` to `createServer`, and its alias list gains the vite.config entries.

## Does NOT include

- Executing, importing, or bundling the project's `vite.config.*`. The scan is text only.
- `css.preprocessorOptions` passthrough (`additionalData`, `includePaths`, custom importers). Presence is warned about; behavior is not replicated.
- Nuxt's `css: []` array in `nuxt.config.*`, and any other framework config that lists stylesheets outside `vite.config`.
- CDN-loaded Tailwind and `twin.macro`. A CDN `<script>` lives in the project's own `index.html`, which the harness never serves, and `twin.macro` needs a Babel pipeline the harness does not run; both are structurally unreachable here.
- Bare package stylesheet imports from an entry. One that looks like a stylesheet (`import "normalize.css"`) is named in a warning and not injected; an extensionless package subpath (`import "swiper/css"`) is not recognized as a stylesheet at all, because only the specifier's extension can say what it is without resolving the package.
- A deep walk of the entry's import graph for stylesheets. Only the entry file's own imports are read; a stylesheet imported by a component two hops down stays out.
- Non-literal `publicDir` and non-literal alias targets. They are ignored-key evidence, not values.

## Acceptance

- A create-vite project (`index.html` → `src/main.tsx` → `import "./style.css"`) injects `src/style.css`, and its `*.module.css` import is not injected.
- A Next.js project whose `app/layout.tsx` does `import "@/app/globals.css"` injects `app/globals.css` through the tsconfig alias table; the same import with a broken alias injects nothing and warns.
- An entry importing two stylesheets injects both, in import order.
- An entry importing `./theme.scss` in a project without `sass` installed injects nothing from that import and warns.
- A project with no entry and no candidate filename injects its largest non-module stylesheet and warns that it guessed.
- A candidate path that exists but is a directory, or a detected file deleted between scan and validation, is dropped rather than embedded.
- A project with `@tailwindcss/vite` and no global stylesheet still loads the Tailwind plugin.
- `publicDir: "static"` in `vite.config.ts` reaches `createServer`; a non-literal `publicDir` does not.
- `resolve: { alias: { "@": "./src" } }` in `vite.config.ts` yields one alias; `alias: { "@": path.resolve(...) }` yields none and one warning naming `resolve.alias`, `css.preprocessorOptions`, and `plugins` as found and ignored.
- `.env` with `NEXT_PUBLIC_API=https://x` yields `define["process.env.NEXT_PUBLIC_API"]`, `.env.local` overrides `.env`, the member root overrides the workspace root, `DATABASE_URL` is never defined, and `"process.env": "{}"` is always present.
- A monorepo member whose only `postcss.config.js` sits at the workspace root passes that directory as `css.postcss`; a member with its own config passes nothing.
- A project with `unocss` installed warns that its styling is not replicated, and no unocss plugin is loaded.
