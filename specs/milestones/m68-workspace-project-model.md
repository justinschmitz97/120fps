---
kind: milestone
status: approved
tests:
  - test/unit/workspace-root-discovery.test.ts
  - test/unit/monorepo-tooling-detection.test.ts
  - test/unit/framework-detection-precedence.test.ts
  - test/unit/workspace-config-fallback.test.ts
  - test/unit/reference-worktree-linking.test.ts
  - test/unit/project-root-resolution.test.ts
  - test/unit/react-profiler.test.ts
  - test/unit/react-profiler-harden.test.ts
  - test/unit/react-compiler-harden.test.ts
---

# M68: workspace-aware project model + resolution-based detection

## Goal

A component inside a workspace member measures the same as one in a single-package repo. Today every question about the project is answered by the nearest `package.json` alone, so a member that declares nothing inherits nothing: the Vue plugin is not loaded, Tailwind is not wired, the compiler is not detected, and a root lockfile bump never invalidates a baseline.

Two roots replace one:

- `memberRoot`: nearest ancestor of the component containing `package.json`. Unchanged semantics: harness dir placement, Vite root, relative component key, baseline location.
- `workspaceRoot`: nearest ancestor at or above `memberRoot` that governs the install. Equal to `memberRoot` in a single-package repo, which is the invariant every existing test encodes.

## Scope

### Project model (new module `src/project-model.ts`)

- `findProjectRoot(dir)` moves here from `src/harness.ts:1007`; `harness.ts` re-exports it so every importer and `src/index.ts:185` keep working.
- `findWorkspaceRoot(memberRoot)`: walk from `memberRoot` upward, first hit wins. A directory qualifies when it has `pnpm-workspace.yaml`, a `package.json` with a `workspaces` field, or one of `pnpm-lock.yaml` / `yarn.lock` / `package-lock.json`. The walk stops after examining a directory containing `.git`: a workspace never spans repositories, and without a bound a stray lockfile in a home directory would capture every project under it. No hit → `memberRoot`.
- `resolveProjectModel(dir)`: `{ memberRoot, workspaceRoot }` for a component directory.
- `declaredPackages(root)`: names across `dependencies`, `devDependencies`, `peerDependencies` of `root/package.json`; empty on a missing, unparsable, or non-object manifest.
- `isPackageDeclared(pkg, memberRoot, workspaceRoot?)`: `pkg` in `dependencies`, `devDependencies`, or `peerDependencies` of either root's manifest.
- `isPackageAvailable(pkg, memberRoot, workspaceRoot?)`: declared as above, or installed at `<level>/node_modules/<pkg>/package.json` for any level from `memberRoot` up to `workspaceRoot`.

Deviation from the audit's literal wording (`createRequire(memberRoot).resolve(pkg)`), with reason: `require.resolve` honours `NODE_PATH`, which the test runner points at pnpm's hoisted store, so every package would resolve from every directory and the gate would be meaningless under test. It also resolves symlinks, so a pnpm member link answers with a store path that no longer names the level it was reached from. The directory probe is deterministic, is not weaker than today's gate anywhere, and covers the case the audit named: an npm/yarn/pnpm hoist that puts a package at a level the manifests do not mention. A package resolvable only from above `workspaceRoot` stays undetected, exactly as today.

`isPackageAvailable`'s per-level `node_modules/<pkg>` probe only sees a package that landed at one of those levels' own `node_modules`; under pnpm's strict, non-hoisting layout a dependency's own transitive dependency (e.g. Nuxt's bundled `@vitejs/plugin-vue`) lives inside that dependency's `node_modules`, one level the probe never walks into, and stays invisible to `isPackageAvailable` there. Hoisted layouts (npm, yarn classic, pnpm with hoisting) are the case this primitive covers.

### Detectors switched to the presence primitive

- `detectNextJs` (`src/harness.ts:49`): also reads `peerDependencies`, which the other detectors already did.
- `detectTailwindVite` (`src/harness.ts:224`).
- `detectReactCompiler` (`src/harness.ts:271`): declaration only, across both levels. M27 H14 (`test/unit/react-compiler-harden.test.ts`) keeps its contract that a resolvable but undeclared compiler stays inactive: the compiler rewrites the code being measured, and a hoisted transitive copy is not a statement that the project ships it. The workspace root's manifest is such a statement; an install is not.
- `detectProjectTransforms` (`src/harness.ts:463`): the gate that made a Vue monorepo member mount nothing.
- `detectFramework` (`src/react-profiler.ts:98`): two changes.
  - Precedence: the member manifest decides whenever it names `react`/`react-dom` or `vue` (React still wins a tie). Only a member that names no framework falls back to the workspace manifest and then to the install probe. Union-without-precedence would turn a Vue package inside a React monorepo into a React measurement.
  - Fail closed: an unreadable, unparsable, or non-object manifest now yields `vanilla` with a warning through the optional `onWarning` callback. The old `react` default mounted non-React code as React. `analyze()` forwards the warning into the run warnings (`src/analyze.ts:2004`).
  - The `.vue` extension override in `resolveFramework` (`src/analyze.ts:2519`) is untouched and still wins over everything.

### Dependency identity and reference worktrees

- Fingerprint sources (`src/analyze.ts:2078`): extracted as `projectConfigFingerprintFiles(memberRoot, workspaceRoot?)`. Tooling configs and lockfiles are probed at `memberRoot` first, then at `workspaceRoot`, so a root lockfile bump invalidates a member's baseline. Each name contributes at most one path.
- `--compare` (`src/compare.ts:103`): `nodeModulesLinkDirs(repoRoot, memberRoot)` lists every directory from `repoRoot` down to `memberRoot` that has a `node_modules` in the source repo; `linkNodeModules` junctions each one into the reference worktree. Under pnpm workspaces the member's own `node_modules` holds `react`/`vue`, so linking only the repo root left the reference side unable to resolve the renderer.
- Budget config (`src/budget.ts:234`): `120fps.config.json` is read from `memberRoot`, falling back to `workspaceRoot`. A monorepo keeps one committed policy at the root; a member config still wins. Baselines stay at `memberRoot` alone: an entry key is relative to the member, and two members would collide at the root.

### Fixture

`fixtures/workspace-monorepo/`: workspace root with `pnpm-workspace.yaml` plus a manifest declaring the shared tooling (`react`, `react-dom`, `@vitejs/plugin-vue`, `@tailwindcss/vite`, `next`, `babel-plugin-react-compiler`), and `packages/ui` whose own manifest declares none of it. No `node_modules`: fixture installs are git-ignored here, so the install-probe path is exercised from temp trees the tests build themselves. Unit tests only, no browser.

## Does NOT include

- Yarn PnP (`.pnp.cjs`) resolution.
- Executing the project's `vite.config.*`.
- tsconfig path/alias resolution: `loadTsconfigAliases` (`src/harness.ts`) is a later milestone's and is untouched here.
- CSS discovery across workspace levels.
- Baselines at the workspace root.
- Adding the new fixture to the repo's own `pnpm-workspace.yaml`.

## Changed contracts

- `detectFramework(root)` on a broken manifest: `react` → `vanilla` plus a warning. `test/unit/react-profiler.test.ts` (missing manifest, malformed JSON) and `test/unit/react-profiler-harden.test.ts` (non-object JSON, non-object dependency section) assert the old default and are updated: the fail-open default is the defect being fixed.
- `test/unit/project-root-resolution.test.ts` D7 keeps asserting nearest-package.json wins. `findProjectRoot` is unchanged, so the monorepo case there stays correct; the workspace level is additive.

## Acceptance

- Single-package repo: `workspaceRoot === memberRoot`, every detector answers exactly as before.
- pnpm workspace member declaring nothing: Next shims, Tailwind, the React Compiler, and the project transforms are all detected from the root manifest.
- A package hoisted to a level no manifest mentions is detected by the install probe, except for the React Compiler, which stays declaration-gated.
- Broken manifest: `vanilla` plus a warning, never `react`.
- Member lockfile absent, root lockfile present: the root lockfile is a fingerprint source.
- `--compare` links `node_modules` at the member level as well as the repo root.
