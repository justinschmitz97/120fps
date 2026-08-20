---
kind: milestone
status: draft
tests:
  - test/unit/tsconfig-aliases.test.ts
  - test/unit/import-scanner-coverage.test.ts
  - test/unit/cli-path-resolution.test.ts
  - test/unit/jsx-in-js-transform.test.ts
---

# M77: type-space is not runtime-space

## Goal

The harness treats a path TypeScript resolved as proof a module is loadable at runtime. It is
not: TypeScript's own module graph includes `@types/*` stubs, `.d.ts`-only packages, and imports
it elides entirely at emit time — none of which a bundler can load. Three defects share exactly
this confusion, and together they block measurement outright on shadcn-ui, material-ui, chakra-ui,
and twenty:

- The tsconfig-`paths`-to-alias builder (`src/harness.ts:2200-2203`, inside `loadTsconfigAliases`)
  turns every non-wildcard `paths` entry into an exact-match Vite alias with no check that the
  target is a loadable module. shadcn/ui's `apps/v4/tsconfig.json` declares `"react": ["./node_modules/@types/react"]`
  — an ordinary Next.js version-pinning idiom, not a shadcn quirk — and the alias then redirects
  React's own internal `require("react")` calls into a directory containing only `.d.ts` files.
  esbuild tries to read that directory as a file and dies with a raw Windows I/O error, uncaught,
  on every one of shadcn-ui's 5 profiled components (shadcn-ui-F1, P0).
- The import scanner (`scanExternalDeps`, `src/harness.ts:2008-2091`) collects every bare
  specifier whose local resolution fails into `externalPkgs`, which flows unfiltered into
  `stableInclude` (`src/harness.ts:1599-1600`) and then `optimizeDeps.include`
  (`src/harness.ts:1687-1689`). `import * as CSS from 'csstype'`, used only in type positions, is
  a real, un-erased import statement as far as the regex-based scanner is concerned, and
  `csstype`'s own `package.json` correctly declares `"main": ""` because it ships no runtime code.
  Vite's dependency optimizer tries to eagerly resolve every `optimizeDeps.include` entry at
  server boot, before any file is transformed or served, and aborts the whole harness when one
  entry has no loadable entry point. Reproduced three times across two packages: `csstype` in
  material-ui (material-ui-F2, P0) and chakra-ui (chakra-ui-F4, P1), and
  `@graphql-typed-document-node/core` (`"main": ""`) in twenty, reached through a codegen'd file
  (twenty-F2, P0).
- `ACCEPTED_COMPONENT_EXTENSIONS` (`src/cli.ts:1153`) admits only `.tsx`, `.jsx`, `.vue`, so
  material-ui's `.js`-with-JSX components — MUI's own authoring convention, hand-paired with a
  sibling `.d.ts` — are rejected before any file is even read (material-ui-F1, P1), and chakra's
  JSX-free `tabs.ts` (an Ark-UI wrapper module with zero JSX literals, hence legitimately `.ts`
  under standard TS convention) is rejected the same way (chakra-ui-F5, P1). `SOURCE_EXTENSIONS`
  (`src/harness.ts:1852`) already lists `.js` for internal graph walking, and
  `specs/decisions/0002-typescript-only-prop-inference.md:20` ("Untyped JS components: default
  props only") and `:26` (comparing runtime-form Vue to "an untyped JS React component") both
  presuppose `.js` is measured. Per `specs/README.md`, a spec-code mismatch is a bug; only the
  entry gate disagrees with its own ADR and its own internal scanner.

Closes: shadcn-ui-F1 (P0), material-ui-F1 (P1), material-ui-F2 (P0), chakra-ui-F4 (P1),
chakra-ui-F5 (P1), twenty-F2 (P0).

## Scope

### 1. Types-only `paths` targets never become a runtime alias (`src/harness.ts`)

`loadTsconfigAliases`'s non-wildcard branch (`src/harness.ts:2200-2203`) currently does:

```ts
const resolved = path.resolve(base, target).replace(/\\/g, "/");
aliases.push({ find: new RegExp(`^${escapeRegex(pattern)}$`), replacement: resolved });
```

This is the only branch that changes: the wildcard-prefix branch at `:2192-2195`
(`pattern.endsWith("/*") && target.endsWith("/*")`, e.g. `@/*` → `./src/*`) is untouched and its
guard is unaffected. That distinction is deliberate, not an oversight — see "why the prefix branch
is exempt" below.

Before the push, resolve `resolved` through `resolveTarget` (`src/harness.ts:1923`, module-private,
already used by `resolveLocalImport` to answer "does this local path load"): direct file with
extension, then `package.json` `exports`/`module`/`main` via `resolveDirectoryEntry`
(`src/harness.ts:1873-1893`), then an `index.<ext>` fallback over `EXTENSIONS`
(`src/harness.ts:1853`). If `resolveTarget(resolved)` returns `undefined`, the alias is skipped and
a new warning is pushed instead of the alias:

```ts
export function TYPES_ONLY_ALIAS_WARNING(pattern: string, target: string): string {
  return (
    `tsconfig path alias "${pattern}" -> "${target}" resolves to a location with no runtime entry ` +
    "(no package.json main/module/exports, no index file); the alias was skipped and " +
    `"${pattern}" resolves through normal node resolution instead`
  );
}
```

No separate `node_modules/@types/` substring check is needed: an `@types/*` package's
`package.json` declares none of `exports`/`module`/`main` (DefinitelyTyped convention) and ships
only `.d.ts` files, which are outside both `SOURCE_EXTENSIONS` and `EXTENSIONS`, so
`resolveTarget` already returns `undefined` for it by the same general rule. The warning message
should still read naturally for that case; wording is not required to special-case it.

**Why the prefix branch is exempt:** `@/*` → `./src/*` aliases a directory *prefix*, resolved by
Vite per request against whatever subpath follows — `./src/components/button` — never as a
single module load of `./src/` itself. A loadable-entry check has no meaning there: `./src` is a
directory of many files, not something with its own `main`. Applying this milestone's check to
that branch would incorrectly reject a directory of ordinary source files that has no `index.*`
of its own. heroui's `tsconfig.json` has exactly one `paths` entry, `"@/*": ["./src/*"]`, and did
**not** reproduce shadcn-ui-F1 — the control case that isolates the trigger to non-wildcard,
single-target aliases, not to `paths` usage in general.

### 2. A type-only import must not reach `optimizeDeps.include` (`src/harness.ts`, `src/project-model.ts`)

Two independent mechanisms; the second is primary.

**(a) Explicit `import type` / `export type` syntax — secondary, syntactic, catches nothing this
milestone's repros need but cheap and correct to add.** `STATIC_IMPORT_PATTERN`
(`src/harness.ts:1983-1984`) currently matches an `import type {...} from "x"` or
`export type {...} from "x"` clause exactly like a value import, because `.*?` after
`(?:import|export)\s` swallows the `type` keyword along with everything else. Add a negative
lookahead so a whole-clause type-only import is not matched at all:

```ts
const STATIC_IMPORT_PATTERN =
  /(?:^|\s)(?:import|export)\s+(?!type\s).*?from\s+["']([^"']+)["']|(?:^|\s)import\s+["']([^"']+)["']/gm;
```

A mixed clause (`import { type A, b } from "x"`) still matches and still scans `"x"`: `b` is a
real value import, so `"x"` genuinely needs runtime resolution. This is a per-occurrence match,
not a per-specifier one, so a file that imports the same package once as `import type {...}` and
separately as a real value import still gets it added to `externalPkgs` by the second statement —
correct, since that package really is needed at runtime in that file.

**(b) A resolvable-runtime-entry check before `optimizeDeps.include` — primary, needs no type
checker, and is what actually stops the crash.** The scanner is regex-based (M69), not a type
checker, and cannot see that `import * as CSS from 'csstype'` (material-ui) or
`import { TypedDocumentNode as DocumentNode } from '@graphql-typed-document-node/core'` (twenty,
inside a codegen'd file, not written as `import type` at all) are structurally type-only —
neither is syntactically marked, so (a) cannot catch either of the two P0 repros. Correctness
therefore depends on (b) alone.

The crash itself is traced, not inferred (this closes the "INFERRED (type-only-import half)" gap
noted in `EVIDENCE.md`): `scanExternalDeps` adds every bare specifier whose local resolution fails
to `externalPkgs` (`src/harness.ts:2061-2067`) unconditionally; `externalPkgs` becomes
`externalDeps` (`:1553-1572`), joins `stableInclude` (`:1599-1600`), and is handed to
`optimizeDeps: { include: stableInclude }` in the `createServer` call (`:1687-1689`). Vite's
dependency optimizer resolves every `include` entry eagerly at server boot — before any file is
transformed or served — so a `main: ""` package placed there aborts the whole harness before the
browser ever gets a chance to let esbuild's normal per-file TS-to-JS transform elide the
type-only import the way it would if `optimizeDeps` never forced it.

Add `installedPackageDir(pkg: string, fromDir: string): string | undefined` to
`src/project-model.ts`, next to `isInstalledOnResolutionChain` (`:153-161`): the same upward walk
(directory, then every ancestor to the filesystem root, skipping a `node_modules` basename as a
level), but returning `path.join(level, "node_modules", ...pkg.split("/"))` for the first level
where `isInstalledAt` is true, instead of a boolean.

In `scanExternalDeps`, after the existing `BLOCKED` filtering loop (`:2074-2088`), add one more
pass over the remaining `externalPkgs`: for each, call `installedPackageDir(pkg, projectRoot)`; if
it resolves to a directory and `resolveTarget(dir)` (the same primitive behavior 1 uses) returns
`undefined`, delete the package from `externalPkgs` and push a new warning:

```ts
export function TYPE_ONLY_PACKAGE_WARNING(pkg: string): string {
  return (
    `import "${pkg}" resolved to an installed package with no runtime entry ` +
    "(no package.json main/module/exports, no index file); the import is almost certainly " +
    "type-only and was excluded from the pre-bundle instead of aborting the harness"
  );
}
```

A package `installedPackageDir` cannot find at all (120fps's own directory walk misses it, e.g. a
`NODE_PATH`-only location) is left alone — this milestone only skips packages it has **proven**
lack a runtime entry, not ones it merely failed to locate; Vite's own resolution may still find
what 120fps's walk did not, and downgrading "not found" to "known non-loadable" would risk
dropping real packages 120fps cannot see.

**chakra-ui-F4's unexplained split (Button/Accordion crash 2/2, Badge/Table do not, same
`csstype` root cause per `EVIDENCE.md` and confirmed `import type` usage in all three
`styled-system` files that reference `csstype`):** not re-derived here — it would require reading
chakra-ui's exact per-component transitive import shape, which is out of this spec's fixture-only
evidence base. The fix is scoped so the split does not matter: the check above runs per
`scanExternalDeps` call, i.e. per component being measured, against whatever `externalPkgs` that
component's own scan produced. Whether 2 or 4 of the 6 components' scans currently surface
`csstype` as a bare specifier, every one of them now gets the identical skip-and-warn outcome
instead of a crash — the split stops being a P1 defect regardless of its cause, which is recorded
here as open, not resolved.

### 3. The entry gate accepts `.js` and `.ts` (`src/cli.ts`, `src/harness.ts`)

`ACCEPTED_COMPONENT_EXTENSIONS` (`src/cli.ts:1153`) widens from `[".tsx", ".jsx", ".vue"]` to
`[".tsx", ".jsx", ".vue", ".ts", ".js"]`. `hasAcceptedComponentExtension`'s regex
(`src/cli.ts:1158-1162`) widens to `/\.(tsx|jsx|vue|ts|js)$/`; its existing `.d.ts` guard (checked
first, unconditionally) is untouched and keeps excluding declaration files under the new `.ts`
branch exactly as it already does today.

**What happens for a file with no component:** extension alone is not enough for `.js`/`.ts` — a
new `hasComponentShape(filePath: string): boolean` (`src/cli.ts`, next to `isComponentFile`)
returns `true` immediately for `.tsx`/`.jsx`/`.vue` (no content read, zero behavior change for
already-accepted extensions), and for `.ts`/`.js` reads the file and returns
`scanExports(content, filePath).length > 0` — the same PascalCase-filtered export scan
`detectComponentExport` (`src/harness.ts:2265-2304`) already uses to name a component, imported
from `src/prop-gen.ts:1455` (already re-exported through `src/index.ts:232`, and `src/harness.ts:9`
already imports it, so this is not a new dependency edge). `isComponentFile`
(`src/cli.ts:1164-1174`) gains `&& hasComponentShape(posix)`. The explicit single-path branch of
`expandComponentPaths` (`src/cli.ts:1236-1244`) gains a second check after the extension check:
extension accepted but no component shape found returns a new, specific error instead of matches:

```ts
export function NO_COMPONENT_EXPORT_ERROR(filePath: string): string {
  return `${filePath} has no PascalCase-named export: 120fps could not find a component to measure in this file`;
}
```

This deliberately does **not** touch `detectComponentExport`'s own fallback
(`src/harness.ts:2294-2303`, "derive from filename, assume default export"), which is a locked,
tested contract (`test/unit/detect-component-export.test.ts:122-139`, e.g. `thing.tsx` with only
`export const helper = 1;` resolves to `{ name: "Thing", isDefaultOnly: true }`, not an error).
That fallback is extension-agnostic and stays exactly as it is for every accepted extension,
`.js`/`.ts` included, when a file is given a `#Export` target or otherwise reaches
`detectComponentExport` directly. The new `hasComponentShape` check is a **gate**, evaluated once,
before any harness work starts; it does not change what `detectComponentExport` does for a file
that already passed the gate. Directory/glob expansion needs no separate error path: a walk that
finds only non-component `.js`/`.ts` files (a `utils/` directory, say) simply contributes zero
matches, same as today's `SKIP_SUFFIX`/`SKIP_DIRS` exclusions, and falls through to the existing
`no component files matched "<arg>"` message (`src/cli.ts:1246-1256`, untouched).

**Companion fix, same behavior, different file — without it, F1 converts into a worse crash
instead of closing:** Vite's documented default `esbuild.include` is `/\.(m?ts|[jt]sx)$/`, which
does not match plain `.js`. `src/harness.ts`'s `createServer` call
(`:1648` `bootServer`, options object at `:1683-1690` alongside `resolve`/`optimizeDeps`) sets no
`esbuild` key today, confirmed by reading the whole options object — so a `.js` file containing
literal JSX (MUI's own convention: `packages/mui-material/src/Button/Button.js` contains real JSX,
not `React.createElement` calls) passes the widened gate and then fails at Vite's esbuild
transform with a JSX parse error, because `.js` never got the `'jsx'` loader. This is not the
type-space/runtime-space confusion this milestone is otherwise about; it is a second, independent
precondition for material-ui-F1 to actually close rather than move. Add
`esbuild: { loader: "jsx", include: <regex matching .js outside node_modules> }` to the
`createServer` options, scoped to non-`node_modules` `.js` (mirroring the same vendor/source
boundary `src/prop-gen.ts:1543` already draws: `if (/[\\/]node_modules[\\/]/.test(sf.fileName)) continue;`),
so a project's own `.js` components get JSX parsing and vendored `.js` dependencies keep the
default `'js'` loader (avoiding both the documented perf cost of blanket-widening and any risk to
already-passing `.js` dependency pre-bundling). `.ts` needs no change: TypeScript's grammar
forbids JSX in `.ts` (ambiguous with type-assertion syntax — `.tsx` exists exactly to lift that
ambiguity), and Vite's default `include` already covers `.ts`.

## Changed contracts

- The CLI's extension-rejection message (`src/cli.ts:1240`) changes its listed extensions from
  `.tsx, .jsx, .vue` to `.tsx, .jsx, .vue, .ts, .js` — a user-visible text change. No existing test
  asserts the literal string (confirmed: no match for "only measures" in `test/`).
- A `.js`/`.ts` file is now a legal argument, directory-walk match, and glob match, subject to the
  new `hasComponentShape` check; it never was before. A `.js`/`.ts` file with zero PascalCase
  exports now fails at the gate with `NO_COMPONENT_EXPORT_ERROR` (a new message) instead of being
  rejected on extension alone.
- A non-wildcard tsconfig `paths` entry whose target has no runtime entry point previously became
  an inert-but-present alias that crashed the harness; it now produces zero alias plus
  `TYPES_ONLY_ALIAS_WARNING`. `test/unit/tsconfig-aliases.test.ts:139-151` ("supports exact
  (non-wildcard) aliases") targets a real file (`./src/utils/index.ts`, written by the fixture) and
  is unaffected — `resolveTarget` resolves it directly.
- A bare specifier that resolves to an installed, `main`-less/`module`-less/`exports`-less package
  previously entered `optimizeDeps.include` and crashed harness boot; it now is excluded and
  `TYPE_ONLY_PACKAGE_WARNING` is added to `HarnessResult.warnings` instead.
- A whole-clause `import type`/`export type` from-specifier no longer contributes to
  `externalPkgs` or the local-file walk queue at all (previously identical to a value import).
- `.js` files outside `node_modules` are now parsed with the `'jsx'` esbuild loader inside the
  harness's Vite server; `.js` files under `node_modules` and all `.ts` files are unaffected.

## Does NOT include

- Config **discovery** order and workspace layering (which `tsconfig.json`/`vite.config` governs a
  member, and reading a workspace-root `vite.config.ts` a member doesn't reference) — M76 owns
  this; chakra-ui-F2 and F3 (wrapper detection and `@chakra-ui/react` resolution both missing the
  workspace-root `vite.config.ts`) are its findings, not this milestone's.
- Nx's inter-package build-dependency graph (twenty-F1, unbuilt `twenty-shared`) — a different root
  cause (no fallback for an unbuilt workspace sibling, not a type/runtime confusion) and not in
  this milestone's closes list.
- Error wording on a build that has already failed, and the exit-code contract for a harness
  crash — M79 owns the failure path itself (uncaught exceptions, exit code 1 vs. 2, warnings
  surviving a crash). This milestone prevents these three specific crashes from happening; it does
  not change what a still-possible harness crash looks like once reported.
- The curve-mode "bare `FAIL`, wrong hint" defect (chakra-ui-F1) and the dropped-render-error-tag
  mechanism — a `report.combos`/`scalingCurveReport` gap, unrelated to type-space vs. runtime-space.
- JSDoc-based prop extraction for JavaScript components — already excluded by M69's scope and no
  new reason found to widen it here; a `.js` component with no TS types still gets "default props
  only" per ADR 0002:20, unchanged by this milestone.
- `baseUrl`-derived aliases (`baseUrlAliases`, `src/harness.ts:2105-2138`) gaining the same
  loadable-entry check. None of this milestone's six closed findings involve `baseUrl`; a
  directory entry there can legitimately have no `index.*` of its own (subpaths are what get
  imported), so the check would need different semantics, not a copy of behavior 1's.
- Re-deriving chakra-ui-F4's Button/Accordion-vs-Badge/Table split from source; scoped as described
  in Scope §2 so the split's cause is irrelevant to the fix's correctness. Left open below.
- Any change to `resolveLocalImport`, `resolveTarget`, or `resolveDirectoryEntry`'s own resolution
  order — both new checks call them exactly as `resolveLocalImport` already does; the primitive
  itself is reused, not modified.

## Acceptance

- Fixture tsconfig with `paths: { "react": ["./node_modules/@types/react"] }` where that directory
  contains only a `package.json` with no `main`/`module`/`exports` and an `index.d.ts`: zero alias
  produced, one `TYPES_ONLY_ALIAS_WARNING` naming `"react"` and the target.
- Control fixture, same tsconfig also declaring `"@/*": ["./src/*"]` against a real `src/`
  directory: the `@/*` alias is still produced, unaffected by the sibling entry's rejection.
- Fixture package `csstype-like` with `package.json` `{ "main": "" }` and no `index.*`, imported as
  `import * as X from "csstype-like"` (value form) from a component: excluded from
  `scanExternalDeps`'s return value and from the harness's `optimizeDeps.include`; one
  `TYPE_ONLY_PACKAGE_WARNING` produced.
- Same fixture package imported as `import type { X } from "csstype-like"`: excluded from the
  scanner's specifier collection entirely (no warning needed — the scanner never attempted it).
- Same fixture package imported once as `import type` and once as a real value import in the same
  file: still ends up excluded (proven non-loadable) with `TYPE_ONLY_PACKAGE_WARNING`, not silently
  dropped for the wrong reason.
- A `.js` component file with a default-exported PascalCase function containing literal JSX:
  accepted by the gate, and mounts (esbuild `'jsx'` loader applies).
- A `.ts` component file with a PascalCase named export and zero JSX literals (the `tabs.ts`
  shape — factory-call components, no JSX): accepted by the gate.
- A `.js` file with only camelCase exports: rejected at the gate with `NO_COMPONENT_EXPORT_ERROR`,
  no harness build attempted.
- A `.d.ts` file: still rejected on extension exactly as today (unaffected by the `.ts` widening).
- Directory/glob expansion over a mixed folder of one real `.js` component and several camelCase
  `.js` utility files: only the component matches; the utility files contribute nothing and cause
  no error as long as at least one match exists.
