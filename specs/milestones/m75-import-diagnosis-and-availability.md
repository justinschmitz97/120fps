---
kind: milestone
status: approved
tests:
  - test/unit/virtual-module-diagnosis.test.ts
  - test/unit/package-availability-resolution.test.ts
  - test/unit/repo-shape-detection.test.ts
  - test/unit/workspace-root-discovery.test.ts
  - test/unit/project-transforms.test.ts
---

# M75: import diagnosis and availability coverage

## Goal

Three residuals from the M67-M73 audit, all annoyance-grade: an import the harness cannot compile
fails without naming the plugin that owns it; a package the project can actually import is reported
unavailable because the probe stops at the workspace root; and three repository shapes (Solid,
Preact, JS-with-jsconfig) exist only as temp trees built inside test bodies, so nothing exercises
them through a real directory on disk.

## Scope

### 1. Virtual-module import diagnoses (`src/preflight.ts:49`)

`TRANSFORM_RECOGNIZERS` already covers `.svg?react`, vanilla-extract, `.gql`/`.graphql`, `.mdx`,
`.scss`/`.sass`/`.less`/`.styl`/`.stylus`, `.vue`, and `.svelte`; those need no change. Two import
shapes still reach the harness with no `[transform:…]` note, so the run dies inside Vite naming
only the importing file:

- `wasm`: `/\.wasm$/`, owner `vite-plugin-wasm`. The `?init` and `?url` forms are Vite core's and
  are deliberately not matched — the bare specifier is the one that needs the plugin.
- `shader`: `/\.(glsl|wgsl|vert|frag|geom|comp)$/`, owner
  `a shader loader plugin (e.g. vite-plugin-glsl)`.

Both flow through the existing machinery unchanged: `recognizeTransform` (`src/preflight.ts:92`),
the non-fatal `transforms` bucket in `runPreflight` (`src/preflight.ts:434`),
`PROJECT_TRANSFORM_WARNING` (`src/preflight.ts:550`) and `transformFailureNote`
(`src/preflight.ts:557`).

### 2. Availability follows Node's resolution chain (`src/project-model.ts:141`)

`isPackageAvailable`'s per-level probe walks `memberRoot` up to `workspaceRoot` only
(`workspaceLevels`, `src/project-model.ts:108`), so a package installed at an ancestor above the
workspace root is reported unavailable even though every loader in the codebase would import it:
`loadTailwindVitePlugin` (`src/harness.ts:636`), the React Compiler resolution
(`src/harness.ts:1042`/`1115`), `loadProjectTransform` (`src/harness.ts:1227`),
`resolveReactDomIdentity` (`src/react-profiler.ts:591`) and `loadVueCompiler` (`src/vue-sfc.ts:45`)
all resolve through `createRequire(path.join(root, "/"))`, whose lookup chain has no such bound.

New private `isInstalledOnResolutionChain(fromDir, pkg)`: probe `<dir>/node_modules/<pkg>/package.json`
at `fromDir` and at every ancestor up to the filesystem root, skipping a `node_modules` directory as
a base (mirroring Node's own `_nodeModulePaths`). `isPackageAvailable` becomes
`isPackageDeclared(…) || isInstalledOnResolutionChain(memberRoot, pkg)`; the per-level probe is
dropped because the chain walk is a strict superset of it (`workspaceLevels` returns `memberRoot`
plus ancestors, or `[memberRoot]` when `workspaceRoot` is not an ancestor — every entry is on the
chain). `workspaceLevels` and `isInstalledAt` stay, the former still used by `src/harness.ts:712`.

Deviation from the audit's literal wording
(`createRequire(path.join(memberRoot, "noop.js")).resolve(pkg + "/package.json")`), with reason and
evidence:

- `require.resolve` honours `NODE_PATH`, and pnpm exports `NODE_PATH=<repo>/node_modules/.pnpm/node_modules`
  into every script it runs, which is how the repo's own test suite runs (`specs/overview/00-tdd.md:55`).
  Measured in this repo: with that `NODE_PATH` set, `createRequire(os.tmpdir()).resolve("vue")` and
  `…resolve("@vitejs/plugin-vue")` both succeed, so a `require.resolve` fallback would report `vue`
  available for every temp-tree project in the suite and turn `detectFramework`'s vanilla cases into
  Vue ones. The directory probe cannot see `NODE_PATH` at all.
- `<pkg>/package.json` is answered through the package's `exports` map. Measured in this repo:
  `require.resolve("@vitejs/plugin-vue")` succeeds from `fixtures/vue-project` while
  `require.resolve("@vitejs/plugin-vue/package.json")` throws — the literal probe false-negatives on
  exactly the package the finding names.

Invariant preserved and pinned by test: `isPackageDeclared` does **not** gain the fallback. It gates
consequential decisions — the React Compiler contract (M27 H14, `src/harness.ts:1010`) and the Solid
hard rejection (`src/preflight.ts:377`) — where a resolvable-but-undeclared copy is not evidence the
project ships the package.

### 3. Repository-shape fixtures (`fixtures/`)

Three directories, manifest plus one or two sources, no `node_modules` (fixture installs are
git-ignored):

- `fixtures/solid-project/`: declares `solid-js`, one `Counter.tsx`.
- `fixtures/preact-project/`: declares `preact` and `react-dom: npm:preact/compat`, one `Card.tsx`.
- `fixtures/jsconfig-project/`: JS only, `jsconfig.json` with `baseUrl` + `paths`, `src/Badge.jsx`
  and `src/tokens.js`.

`solid-project` and `preact-project` each carry their own `pnpm-lock.yaml`. Without it
`findWorkspaceRoot` (`src/project-model.ts:51`) climbs to this repository's root — which declares
`react` and `react-dom` — and both fixtures inherit a React declaration that makes the case they
exist to test unconstructable (the reason `test/unit/preflight.test.ts:22` fell back to temp trees).
A lockfile is what a real single-package repo has, and it is the marker `governsInstall`
(`src/project-model.ts:42`) already reads. `jsconfig-project` needs no lockfile: config discovery
takes the nearest hit and never reaches the repository root.

Tests exercise each fixture through the real functions: `runPreflight` for the Solid hard rejection
and for Preact passing that gate, `findCompilerConfig` plus `loadTsconfigAliases` for the jsconfig
tree.

## Does NOT include

- Loading any of the newly recognized plugins. `SUPPORTED_TRANSFORM_PLUGINS` (`src/harness.ts`) stays
  spike-gated; wasm and shader imports are diagnosed, never compiled.
- A generic "unknown extension" recognizer. Vite core serves many non-JS extensions natively
  (assets, `?raw`, `?url`, `.json`, `.css`), so a catch-all would report plugins that are not
  missing.
- `.wasm?init` / `.wasm?url`, which Vite core handles.
- Making pnpm-strict transitive tooling available. A package that lives only inside another
  dependency's own `node_modules` (or inside pnpm's hidden `node_modules/.pnpm/node_modules`) is not
  on the resolution chain from `memberRoot`, so the harness's loaders cannot import it either;
  reporting it available would trade a silent miss for a load failure. The M68 limitation note
  stands, with the cause now stated as unreachability rather than probe depth.
- Any change to `isPackageDeclared`, `src/harness.ts`, `src/analyze.ts`, `src/react-profiler.ts`,
  `src/index.ts` or `specs/overview/*`. No new symbol is exported from the barrel;
  `isInstalledOnResolutionChain` is private to `src/project-model.ts`.
- A Preact measurement path. `preact-project` documents the blind spot (an `npm:` alias reads as a
  `react-dom` declaration), it does not close it.
- Solid or Svelte rendering.

## Changed contracts

- `isPackageAvailable` now accepts a package installed above `workspaceRoot`.
  `test/unit/workspace-root-discovery.test.ts:216` asserted the refusal ("refuses a package
  installed above the workspace root") and is rewritten: M68 chose that bound to keep the probe
  cheap, and it is the divergence from the loaders this milestone removes. The two bounds that
  matter are untouched: `findWorkspaceRoot` still stops at `.git`, and `isPackageDeclared` still
  reads manifests only.

## Acceptance

- `recognizeTransform("./mod.wasm")?.code === "wasm"`; `"./shader.frag"`, `"./shader.glsl"`,
  `"./shader.wgsl"`, `"./shader.vert"` → `"shader"`; `"./mod.wasm?init"` and `"./mod.wasm?url"` →
  `undefined`.
- A component importing a `.wasm` or `.frag` module produces a non-fatal `transforms` hit naming the
  owner, and no `hard` hit.
- A package installed at `<ancestor>/node_modules` above `workspaceRoot` is available; the same
  package is not declared.
- A package reachable only through `NODE_PATH` is not available, while `createRequire` resolves it in
  the same test.
- `runPreflight` against `fixtures/solid-project` returns a hard `unsupported-framework` hit naming
  `solid-js`.
- `runPreflight` against `fixtures/preact-project` returns no hard hit, and
  `isPackageDeclared("react-dom", …)` is true there because the `npm:` alias is invisible to a
  manifest read.
- `findCompilerConfig` on `fixtures/jsconfig-project/src` returns that fixture's `jsconfig.json`, and
  `loadTsconfigAliases` maps `@/` to its `src/`.
