---
kind: milestone
status: approved
tests:
  - test/unit/compiler-config-discovery.test.ts
  - test/unit/base-url-import-resolution.test.ts
  - test/unit/alias-shape-warnings.test.ts
  - test/unit/dev-server-file-access.test.ts
  - test/unit/import-scanner-coverage.test.ts
  - test/unit/unresolved-alias-reporting.test.ts
  - test/unit/js-project-prop-extraction.test.ts
  - test/unit/tsconfig-aliases.test.ts
---

# M69: unified config resolution + import-scanner hardening

## Goal

The harness resolves a module the same way the project's own toolchain does, or it says why it could not. Two defects sit behind most "works in the app, 404s in the harness" reports:

- Two resolvers disagree about which config file governs. Alias construction probed exactly `<projectRoot>/tsconfig.json` (`src/harness.ts:1164`), while prop extraction searched upward with `ts.findConfigFile` (`src/prop-gen.ts:1620`). A workspace member that inherits the root `tsconfig.json` got working prop extraction and zero aliases, so every aliased import 404ed.
- The scanner sees a subset of the graph. Dynamic `import()` and `require()` specifiers, query-suffixed specifiers, `.json`/`.cjs`/`.cts` targets, and directory imports resolved through `package.json` were all invisible (`src/harness.ts:1045`, `:1053`, `:1113`), so their packages missed `optimizeDeps.include` and Vite discovered them mid-measurement, which is the reload M34 and M30 exist to prevent.

Silence is the second theme: a wildcard-shape typo produced an alias that could never match, and a stale alias whose target no longer exists was indistinguishable from a bare npm import, so it entered `optimizeDeps.include` as a package that does not exist. Both now name themselves through `HarnessResult.warnings`.

## Scope

### Shared config-file resolution (`src/project-model.ts`)

- `findCompilerConfig(startDir, stopDir?)`: walks upward from `startDir`, returning the first `tsconfig.json`, then `jsconfig.json`, found at a level. `jsconfig.json` carries the same JSON shape and the TypeScript config APIs accept it. The walk stops after examining `stopDir`; an absent `stopDir` means the filesystem root, which is the legacy `ts.findConfigFile` reach. Returns a forward-slash absolute path, because `ts.readConfigFile` asserts on backslash paths when a diagnostic is produced.
- Both callers keep `ts.readConfigFile` + `ts.parseJsonConfigFileContent`, so `extends` chains (relative, array, and `node_modules` preset) resolve exactly as they already did. `test/unit/tsconfig-export-harden.test.ts` covers those chains and is untouched.

### Alias construction (`src/harness.ts:1159`)

- `loadTsconfigAliases(projectRoot, warningsOut?)`. The config comes from `findCompilerConfig(projectRoot, findWorkspaceRoot(projectRoot))`: upward from the member, bounded by the root that governs the install. For a project whose `tsconfig.json` sits at `projectRoot`, level zero matches and nothing changes.
- `baseUrl` set with no `paths` (`src/harness.ts:1192`): each top-level entry of the `baseUrl` directory becomes one alias, so CRA-style `import X from "components/Button"` resolves. A directory entry matches its own name and any subpath (`^components(?=/|$)`); a source file entry matches its stem exactly. Entries named like a package the project declares or has installed are skipped, so a `src/react/` directory never shadows `react`. Enumeration at config time keeps the alias list plain strings, which is what both Vite and the scanner consume.
- Wildcard-shape mismatch (`src/harness.ts:1208`): a pattern with a `*` whose first target has none, or the reverse, produced `^@/\*$`, a regex matching only the literal specifier `@/*`. Such an entry now yields no alias and one warning naming the pattern and the target.
- `ALIAS_SHAPE_WARNING(pattern, target)` and `BROKEN_ALIAS_WARNING(specifier, target)` are exported alongside `SWEEP_DEP_WARNING`.

### Dev server file access (`src/harness.ts:853`)

- `fsAllowDirs(memberRoot, workspaceRoot, aliases)` returns the directories to put in `server.fs.allow`, or `undefined` when every alias target already sits under `memberRoot`. `undefined` keeps Vite's own default list, so a single-package repo boots byte-identically. When a target does sit outside (a monorepo `packages/*` alias, a shim directory in a linked install), the list is `memberRoot`, `workspaceRoot`, and each outside target directory. The boot site adds Vite's own `searchForWorkspaceRoot(memberRoot)` to whatever the helper returned, because replacing the default list must never reach less far than the default did.

### Import scanner (`src/harness.ts:1090`)

- Dynamic `import("x")` and `require("x")` with a string-literal argument join the static `import`/`export … from` regex. Template literals and computed specifiers stay out of reach and are not attempted.
- A specifier is stripped of its `?query` before resolution and before the package name is derived, so `./icon.svg?url` and `pkg/style.css?inline` stop failing silently. A `#` is left alone, because `#utils` is a legitimate alias pattern and a Node subpath import.
- Resolution extensions gain `.cjs`, `.cts`, and `.json` (`.json` last). A directory target resolves through its `package.json` `exports["."]` or `main` before falling back to `index.*`.
- Only source files are enqueued for further walking. A resolved `.json` or asset file is a leaf, so the scanner stops reading files that cannot contain imports.
- `resolveLocalImport` returns which of three things happened: resolved, alias matched with a missing target, or no alias matched. An alias that matched with a missing target is no longer reported as an npm package: a project alias produces `BROKEN_ALIAS_WARNING` and nothing in `optimizeDeps.include`, and a shim alias keeps recording its specifier for shim-usage reporting (M62, `test/unit/shim-usage-reporting-harden.test.ts` H7) without a warning, because a missing shim file is this tool's own build state.
- Warnings from both scans (component and wrapper) are deduplicated and joined to `HarnessResult.warnings` next to the transform and sweep warnings.

### Prop extraction fallback (`src/prop-gen.ts:1619`)

- `createCompilerOptions` uses `findCompilerConfig(dirname(file), stopDir)`, so a `jsconfig.json` project extracts props under its own options. `stopDir` is the workspace root when the file sits in a real project, and undefined when no `package.json` exists anywhere above the file, which preserves today's unbounded reach for bare temp trees.
- `allowJs: true` joins both the no-config fallback and the overrides applied on top of a parsed config. Without it a `.jsx` target is outside the program, `getSourceFile` returns nothing, and extraction reports the component as unparsable. The user named the file to measure, so a project that keeps JavaScript out of its own type check still gets its `.jsx` component read. The flag is inert for `.tsx`.

## Changed contracts

- `baseUrl` without `paths` yielded zero aliases and now yields one alias per resolvable top-level entry. `test/unit/tsconfig-aliases.test.ts:153` ("returns [] when paths is absent") is kept as written: its fixture sets no `baseUrl`, so it still describes the no-`baseUrl` case correctly. A new test states the `baseUrl` case, and the file gains a note that the two are different questions.
- A wildcard-shape mismatch produced an inert alias entry and now produces none plus a warning. No existing test asserted the inert entry.
- A stale project alias produced an `optimizeDeps.include` entry named after a package that does not exist and now produces a warning instead.

## Does NOT include

- `baseUrl` fallback for a project that also declares `paths`. TypeScript applies both; this milestone applies the fallback only when `paths` is absent, which is the reported failure and keeps the existing alias count contract at `test/unit/tsconfig-aliases.test.ts:94`.
- Template-literal or computed dynamic import specifiers.
- Multiple `paths` targets per pattern: the first target still wins, because a Vite alias has one replacement.
- Executing the project's `vite.config.*`.
- Linux case-sensitivity mismatch naming.
- JSDoc-based prop extraction for JavaScript components.
- Dropping asset-only bare specifiers (`pkg/dist/x.css`) from `optimizeDeps.include`.

## Acceptance

- A workspace member with no config of its own picks up the root `tsconfig.json` aliases, and the walk never leaves the workspace root.
- A `jsconfig.json` project gets aliases and prop extraction; a `tsconfig.json` at the same level wins over it.
- `baseUrl: "src"` with no `paths` resolves `components/Button`, and leaves `react` to node resolution.
- A `"@/*": ["./src"]` typo names itself in the run warnings and produces no alias.
- An alias target outside the member root lands in `server.fs.allow`; a project whose targets are all inside keeps Vite's defaults.
- `await import("./Lazy")`, `require("cjs-pkg")`, `./icon.svg?url`, `./data.json`, and a directory import with a `package.json` `main` are all followed.
- A stale `@/gone` alias warns and never reaches `optimizeDeps.include`.
- A `.jsx` component in a project with no config still yields props.
