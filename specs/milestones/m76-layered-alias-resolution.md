---
kind: milestone
status: draft
tests:
  - test/unit/tsconfig-aliases.test.ts
  - test/unit/vite-config-workspace-root.test.ts
  - test/unit/wrap-workspace-root-fallback.test.ts
  - test/unit/import-scanner-coverage.test.ts
---

# M76: layered alias resolution across the workspace

## Goal

Four config lookups the harness performs — tsconfig `paths`, `vite.config`'s `resolve.alias`,
`120fps.setup.*` wrapper detection, and the import scanner's package-root collapsing — all read
from the component's own package (`projectRoot`) and stop there, even though `workspaceRoot` is
already computed next to three of them (`src/harness.ts:1531`). A monorepo member that inherits
its real build configuration from the workspace root gets none of it: mantine's `@mantine/hooks`
alias lives only in the root `tsconfig.json`; chakra-ui's `@chakra-ui/react` alias and its
`120fps.setup.tsx` wrapper both live only at the pnpm-workspace root; cal.com's harness resolves a
bare `@calcom/ui` package root that no source file imports, because the import scanner collapses
every subpath specifier to its package name unconditionally, and the workspace sibling's `exports`
map has no `"."` entry for that collapsed name to land on.

None of these four gaps is "climb past the nearest config" — the M69 nearest-wins contract at
`findCompilerConfig` is correct and TypeScript itself would not inherit root `paths` into a
package config that lacks `extends`. Each is a **second, explicit layer** consulted only when the
member's own answer is silent, applied additively, and disclosed by name whenever it is the thing
that made a component resolve. A user reading `HarnessResult.warnings` needs to know an alias, a
condition, or a wrapper came from a config or file their component's own package does not
reference.

Closes: mantine-F1, chakra-ui-F2, chakra-ui-F3, calcom-F1.

## Scope

### Workspace-root fallback for tsconfig `paths` (`src/harness.ts:2140`, `src/project-model.ts:77`)

`loadTsconfigAliases(projectRoot, warningsOut?)` (`src/harness.ts:2140-2206`) keeps its existing
first step unchanged: `findCompilerConfig(projectRoot, workspaceRoot)` (`:2147`) walks upward from
the member, nearest wins, and the walk still never leaves `workspaceRoot`. `test/unit/tsconfig-
aliases.test.ts` covers this step and is untouched — every fixture in that file is a single bare
tmpdir with no ancestor lockfile or `.git`, so `findWorkspaceRoot` (`src/project-model.ts:51-60`)
always returns the fixture's own root as `workspaceRoot`, making it identical to `projectRoot`.

A second, additive pass now probes `workspaceRoot` for its own compiler config:
`findCompilerConfig(workspaceRoot, workspaceRoot)` — a single-directory check, not a walk, because
`stopDir === startDir` returns after the first iteration whether or not a config was found there
(`src/project-model.ts:80-89`). When that config exists, differs from the member's own config file,
and declares `paths`, its patterns are parsed with the same per-entry logic the member pass already
uses (wildcard-shape validation, `escapeRegex`, `path.resolve` against the config's own `baseUrl`
or `pathsBasePath`, `src/harness.ts:2187-2205`). Only patterns **absent from the member's own
pattern set** are kept; a pattern the member already declares — with any target, including one that
does not resolve — is left to the member's own answer, because the member deliberately owns that
name. Each kept entry is tagged as workspace-root-sourced (a `fromWorkspaceRoot` marker paired with
the root config's absolute path, carried the same way `isShim` already rides on the shared `alias`
array at `src/harness.ts:1544-1548`) and appended after the member's own aliases, so a matching
member alias always wins purely by pattern precedence, never by array order.

`resolveLocalImport` (`src/harness.ts:1949-1978`) and `scanExternalDeps` (`:2008-2091`) already
carry a `viaShimAlias` flag through a resolved match for exactly this kind of attribution (M62);
they gain a parallel `viaWorkspaceRootAlias` flag read off the same tag. The first time a scanned
specifier actually resolves through a workspace-root-fallback alias, `scanExternalDeps` pushes one
`WORKSPACE_ROOT_ALIAS_WARNING(specifier, pattern, target, configFile)`, deduplicated per specifier
the same way `BROKEN_ALIAS_WARNING` already is (`reportedBrokenAliases`, `:2017,2057-2060`).
Disclosure is usage-triggered, not merged-pattern-count-triggered: a root `tsconfig.json` in a
large monorepo can declare dozens of `@scope/*` patterns for packages the current component never
touches, and warning about all of them would bury the one that actually mattered.

### Layered `vite.config` reads: aliases and `resolve.conditions` (`src/harness.ts:835`)

`readViteConfigData(projectRoot)` gains a second parameter with the same default-parameter idiom
`resolveStyleTooling` and `readEnvDefines` already use at this exact call site
(`src/harness.ts:1607`, `:1646`): `readViteConfigData(projectRoot: string, workspaceRoot: string =
findWorkspaceRoot(projectRoot))`. The call site at `:1538` passes the `workspaceRoot` already
computed at `:1531`, so a component's own `vite.config.*` and the workspace-root `vite.config.*`
are both read as text through the existing no-execution `ts.createSourceFile` +
`findViteConfigObject` path (`:835-928`) — M71's contract that the file is never imported and
never runs is unchanged for either read. When `workspaceRoot === projectRoot` the second read is
skipped entirely: single-package projects get byte-identical output to today, one file read, one
parse.

`resolve.alias` entries: parsed from each layer with the existing loop (`:878-908`); a key present
in the member's own `resolve.alias` wins outright, and a key present only at the workspace root is
appended. This is exactly chakra-ui's shape — the workspace-root `vite.config.ts` declares
`"@chakra-ui/react": resolve("packages/react/src")` once, at the root, and `packages/react` itself
declares no `vite.config.ts` of its own at all, so every root key is new. `ViteConfigData` gains a
`warnings: string[]` field (default `[]`): one `VITE_CONFIG_WORKSPACE_ROOT_ALIAS_WARNING(key,
replacement, configFile)` per root-only key that was merged in, appended into `configWarnings` at
the existing call site (`:1539-1543`) alongside the current `ignoredKeys` warning, so it reaches
`HarnessResult.warnings` through the path that already exists. Unlike the tsconfig case above, this
disclosure fires eagerly at config-merge time rather than on first use: a hand-written
`resolve.alias` object is a short, deliberately curated list (chakra-ui's root config declares
exactly one entry), not a generated `paths` map with dozens of patterns, so the noise argument that
justifies usage-triggering the tsconfig warning does not apply here.

`resolve.conditions`: `ViteConfigData` gains a `conditions: string[]` field (default `[]`). The
`resolve` object-literal branch (`:878-908`) gains a second inner check alongside the existing
`alias` one, reading a `conditions` property whose initializer is an array of string literals —
the installed Vite 6.3 `EnvironmentResolveOptions` type (`node_modules/vite/dist/node/index.d.ts:
2420-2425`) names this field `conditions`; there is no separate `customConditions` key in this
version, so the spec targets `resolve.conditions` only. Layering matches the alias rule: the
member's own `resolve.conditions`, if declared and non-empty, wins outright; otherwise the
workspace root's is used, with one `VITE_CONFIG_WORKSPACE_ROOT_CONDITIONS_WARNING(conditions,
configFile)` pushed into the same `warnings` field, because applying a condition set changes which
package export gets served for every bare import in the run, not just one aliased path — a bigger
effect than a single alias, and worth naming every time it is not the member's own choice. The
resulting array is forwarded verbatim into `createServer()`'s existing `resolve: { alias, dedupe }`
object (`:1683-1686`) as `resolve.conditions`, added only when non-empty. This is a pass-through to
Vite's own resolver, which already implements condition-aware `exports` selection correctly; the
harness's own local scanner (`resolveDirectoryEntry` / `conditionalEntry`, `:1873-1913`) is not
made condition-aware and keeps its existing fixed order (`import`, `module`, `browser`, `default`,
`require`) for the reason given in the next section.

### `120fps.setup.*` workspace-root fallback (`src/analyze.ts:2482`, `src/harness.ts:1258`)

`detectWrapper(projectRoot, framework)` (`src/harness.ts:1258-1269`) is unchanged: it still probes
exactly one directory for `WRAPPER_CANDIDATES` (`:1247-1252`) in framework-dependent order.
`resolveWrapPath` (`src/analyze.ts:2482-2497`), its only caller, gains a `warningsOut?: string[]`
fourth parameter — the same shape `resolveCssFiles` already takes as its third
(`src/analyze.ts:2452-2456`), placed consistently at the end. When `options.wrapPath` is unset and
`detectWrapper(projectRoot, framework)` finds nothing, `resolveWrapPath` now also tries
`detectWrapper(workspaceRoot, framework)`, with `workspaceRoot = findWorkspaceRoot(projectRoot)`
computed inside the function using the same default-parameter idiom as the previous two sections.
When that second probe is what finds the file, `resolveWrapPath` pushes one
`WRAPPER_FROM_WORKSPACE_ROOT_WARNING(wrapPath, projectRoot)` into `warningsOut` before returning
`{ wrapPath, wrapAutoDetected: true }` — chakra-ui-F2's finding is exactly that a wrapper placed at
the natural monorepo root produces total silence, identical to no wrapper existing at all; a
wrapper that loads from an unexpected level must say so, the same "attributable, not just working"
principle as the two sections above. `--no-wrap` and an explicit `--wrap <path>` are unaffected:
both branches return before either probe runs (`:2487-2493`).

The call site (`src/analyze.ts:2022`) currently reads `resolveWrapPath(options, projectRoot,
framework)`. It gains a fourth argument, a new `wrapWarnings: string[]` array declared next to
`frameworkWarnings` (`:2018`) and folded into `runWarnings`'s existing composition at `:2042`
(`[...frameworkWarnings, ...cssWarnings]` becomes `[...frameworkWarnings, ...cssWarnings,
...wrapWarnings]`), which already flows into `report.warnings` at `:2106-2107`. No new plumbing
beyond that array is needed.

### Workspace-package roots require a bare-specifier witness (`src/harness.ts:2008`)

**Confirmed mechanism** (not inferred): `scanExternalDeps` (`src/harness.ts:2008-2091`), for every
bare specifier with no matching alias, always collapses it to its package name and adds that name
— never the specifier actually written — to `externalPkgs` (`:2061-2066`):

```
const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
externalPkgs.add(pkg);
```

`externalPkgs` becomes `externalDeps`, which joins `stableInclude` (`:1599-1602`) and is passed
verbatim as `optimizeDeps.include` when the dev server boots (`:1687-1689`). Vite resolves every
`optimizeDeps.include` entry as its own module before pre-bundling it, which for a bare package
name means resolving that package's `"."` export or `main` field. `@calcom/ui`'s `package.json`
declares an `exports` map with only subpath keys (`./classNames`, `./components/*`, ...) and no
`"."` key at all; `@calcom/lib` has no `main` and no `exports`; `@calcom/embed-core`'s `main` points
at a `dist/` that does not exist pre-build. All three are workspace siblings actually imported only
by subpath (`@calcom/ui/classNames`, `@calcom/lib/hooks/useLocale`,
`@calcom/embed-core/embed-iframe`, each independently resolvable on disk), and the collapse step
manufactures a bare-root optimizer entry that nothing in the source ever wrote and that cannot
resolve — this is calcom-F1's crash, for all three package shapes, confirmed by reading each
`package.json` and re-deriving the exact code path.

This must not change how `externalPkgs` handles an ordinary npm dependency: `test/unit/import-
scanner-coverage.test.ts:103-107` already locks in that `swiper/css/pagination?inline` collapses to
`["swiper"]`, and that stays correct because `swiper`'s own package root resolves fine — the crash
is specific to a package whose root genuinely has no entry. The new rule is scoped to that
intersection: **a package name enters `externalPkgs` as a bare root only when something in the
scanned graph named it bare, or when it is not a workspace sibling** (ordinary node_modules
dependencies keep today's collapsing behavior unconditionally, avoiding any new filesystem probing
for the overwhelming majority of scanned packages).

`scanExternalDeps` gains a `workspaceRoot: string = findWorkspaceRoot(projectRoot)` trailing
parameter (its one caller, `:1553-1571`, already has `workspaceRoot` in scope at `:1531`). Two new
private helpers, same file: `resolvePackageDir(pkg, fromDir)` walks the node_modules resolution
chain the same way `isInstalledOnResolutionChain` already does (`src/project-model.ts:153-161`),
returning the first `<level>/node_modules/<pkg>` directory found, or `undefined`; `isWorkspaceSibling
(pkgDir, workspaceRoot)` calls `fs.realpathSync(pkgDir)` and returns true when the realpath sits
inside `workspaceRoot` and no path segment between them is `node_modules` — the standard signal
that an install is a symlink back into the monorepo's own source tree, not a hoisted external copy.
At the collapse site (`:2061-2066`): when `spec === pkg` (the specifier was already the bare root),
behavior is unchanged. When `spec !== pkg` (a subpath was written), resolve `pkg`'s directory from
`path.dirname(normalizedFile)`; if it is not found, or found but not a workspace sibling, behavior
is unchanged (`pkg` is added, covering every ordinary dependency including subpath-only ones like
`swiper`). Only when `pkg` is a workspace sibling **and** its own directory has no resolvable entry
— reusing `resolveDirectoryEntry` (`:1873-1893`) against that directory, the same manifest-then-
index logic already applied to local aliased targets — does the new behavior apply: `pkg` is not
added, and the literal `spec` (the subpath actually scanned, e.g. `@calcom/ui/classNames`) is added
in its place, once per distinct subpath.

The `BLOCKED` filtering loop (`:2074-2088`) compares `externalPkgs` entries against literal package
names (`"next"`, `"webpack"`, ...) and a `"@next/"` prefix. Because an entry can now be a subpath
string rather than a bare name, the loop's membership and prefix checks are applied to the
package-name portion re-derived from each entry with the same `@`-aware split already used to
compute `pkg`, not to the raw entry text, so the Next.js blocklist keeps matching correctly whether
an entry was retained as a bare name or substituted as a subpath.

No new warning accompanies this fix: the substituted specifier was never broken (`@calcom/ui/
classNames` always resolved on its own), so nothing needs to be disclosed as a fallback — only the
harness's own manufactured, unresolvable lookup is removed.

## Changed contracts

- `loadTsconfigAliases`: a member config that lacks a `paths` pattern the workspace-root config
  declares now gets that pattern as a fallback alias, tagged and disclosed on first use. Every
  existing case in `test/unit/tsconfig-aliases.test.ts` keeps its current output byte-for-byte,
  because every fixture there has `workspaceRoot === projectRoot`, making the fallback probe find
  the identical already-parsed file and merge an empty pattern-set difference.
- `readViteConfigData`: previously read only `projectRoot`'s `vite.config.*`; now also reads
  `workspaceRoot`'s (skipped when they are the same directory) and merges `resolve.alias` keys and
  `resolve.conditions` the member did not declare, each disclosed in a new `ViteConfigData.warnings`
  field. `publicDir` and the `ignoredKeys` set (`css.preprocessorOptions`, `plugins`, "a computed
  config object") are read from the member layer only — no finding motivates merging those from the
  root, and doing so is out of scope (see below).
- `resolveWrapPath`: previously probed only `projectRoot` for `120fps.setup.*`; now falls back to
  `workspaceRoot` when the member has none, disclosed via a new warning. A project with a wrapper at
  either level, or neither, keeps today's `wrapPath`/`wrapAutoDetected` output; only the previously-
  silent "root has one, member doesn't" case gains a warning where it previously gained nothing.
- `scanExternalDeps`: a workspace-sibling package whose own root has no resolvable entry and is
  never imported bare now contributes the subpath specifiers actually scanned to `externalDeps`
  instead of its unresolvable collapsed root name. A non-workspace-sibling package, or a workspace
  sibling that is imported bare anywhere in the graph, is unaffected — `test/unit/import-scanner-
  coverage.test.ts`'s existing assertions (including the `swiper` case at `:103-107`) are unchanged.

## Does NOT include

- Alias **target** validity — a `paths` entry pointing at a types-only file, a non-loadable entry,
  or any other question of whether a resolved path is a real runtime module. That is M77's contract
  (`M76-M83-MAP.md`: "M76 owns where alias sources come from and in what order. It does not change
  what an individual alias entry is allowed to point at").
- The wording or behavior of errors once a build has already failed. That is M79's.
- `baseUrl`-only workspace-root fallback (a member with `baseUrl` and no `paths`, and a workspace
  root with `paths` the member lacks). No field-test finding is shaped this way; extending the
  fallback to `baseUrl` without evidence would be guessing.
- Merging the workspace-root `vite.config.*`'s `publicDir`, `css.preprocessorOptions` presence, or
  `plugins` presence into the member's `ViteConfigData`. Only `resolve.alias` and
  `resolve.conditions` are layered, because those are the two chakra-ui-F3 needed.
- Making the harness's own local scanner (`resolveDirectoryEntry` / `conditionalEntry`) condition-
  aware. `resolve.conditions` is forwarded to Vite's real dev-server resolver, which already
  implements condition-aware `exports` selection; duplicating that logic in the scanner's own rough,
  optimizeDeps-oriented probe would be new surface area with no finding requiring it.
- Multiple `paths` targets per pattern: the first target still wins, unchanged from M69.
- Template-literal or computed dynamic import specifiers: unchanged from M69's non-goal.
- Parsing `pnpm-workspace.yaml` `packages:` globs or a `package.json` `workspaces` array to
  enumerate sibling package names by declaration. Workspace-sibling detection in the last section
  uses on-disk realpath containment instead — it answers "is this install a symlink back into the
  monorepo" directly, without needing to parse or match glob patterns.
- Any change to the general (non-workspace-sibling) subpath-to-package-root collapsing behavior in
  `scanExternalDeps`. This is the behavior `test/unit/import-scanner-coverage.test.ts:103-107`
  already locks in and it stays exactly as it is for every ordinary npm dependency.

## Acceptance

- A workspace member whose own `tsconfig.json` has no `paths` (or has `paths` that do not cover a
  given pattern), with a workspace-root `tsconfig.json` that declares that pattern: an import
  matching it resolves, and the run's warnings name the specifier, the pattern, and the root
  config's file path.
- A single-package project (`workspaceRoot === projectRoot`) produces identical alias output and
  warnings to today: the fallback probe finds the same config already parsed and merges nothing.
- A member `tsconfig.json` that already declares a pattern the workspace root also declares: the
  member's own target wins, and no fallback warning fires for that pattern, even if the member's
  target does not itself resolve.
- A member with no `vite.config.*` of its own and a workspace-root `vite.config.ts` declaring
  `resolve.alias`: the root's alias applies, and the run's warnings name the alias key and the root
  config file.
- A member `vite.config.ts` that already aliases a given key: the workspace root's entry for that
  same key is never applied and produces no warning.
- A workspace-root `vite.config.ts` declaring `resolve.conditions` with none declared at the member:
  the array reaches the dev server's own `resolve.conditions`, and the run's warnings disclose that
  the conditions came from the root config.
- A member `120fps.setup.*` file: found and used exactly as today, with no new warning.
- No `120fps.setup.*` at the member root and one at the workspace root: it is found, used, and
  disclosed by a warning naming the workspace-root path.
- No `120fps.setup.*` at either level: unchanged silent no-wrapper outcome.
- `--wrap <path>` and `--no-wrap` are unaffected by either wrapper probe.
- A workspace-sibling package whose `package.json` `exports` map has no `"."` key, imported only by
  subpath: the scanned subpath specifier(s) enter the harness's external-deps list, and the
  unresolvable bare package name does not.
- The same subpath-only sibling package also imported bare somewhere in the same graph: the bare
  name enters the list, matching today's behavior.
- An ordinary npm package imported only by subpath (`swiper/css/pagination?inline`) still collapses
  to its bare package name: `test/unit/import-scanner-coverage.test.ts`'s existing assertion is
  unchanged.
