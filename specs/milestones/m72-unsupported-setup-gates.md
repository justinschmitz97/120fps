---
kind: milestone
status: approved
tests:
  - test/unit/preflight.test.ts
  - test/unit/react-profiler.test.ts
  - test/unit/workspace-root-discovery.test.ts
  - test/unit/dx-features.test.ts
  - test/unit/cli-error-and-flag-handling.test.ts
---

# M72: unsupported-setup detection and clear rejections

## Goal

A handful of setups are not supported today but do not say so: a Solid component passes the
CLI's extension gate and dies deep inside a React-flavored compile; a Preact-behind-`react`-alias
project runs the React fiber profiler against Preact internals and reports fiction; a Yarn PnP
install fails with a raw module-resolution error; an old Node binary is only stopped by the
`engines` field, which npx treats as advisory; and four common routing/framework libraries throw
confusing context errors with no hint that a missing provider is the cause. This milestone makes
each of these name itself before or in place of the confusing failure.

## Scope

### 1. Solid rejection (`src/preflight.ts`, `src/project-model.ts`)

`runPreflight` (`src/preflight.ts:319`) gains an environment-level check, run once per call before
the import-graph walk: if the project declares `solid-js` (`isPackageDeclared`, checked at
`projectRoot` and `findWorkspaceRoot(projectRoot)`) and declares neither `react` nor `react-dom`,
it pushes a new hard `PreflightKind` of `"unsupported-framework"`
(`src/preflight.ts:13-20`) with `chain` set to the measured entry and `specifier: "solid-js"`. A
project that declares both `react` and `solid-js` is not rejected: mixed repositories exist, and
the react tree is still measurable. That case instead gets a non-fatal warning from
`detectFramework` (`src/react-profiler.ts:119`, scope 2 below).

Both the `solid-js` check and its `react`/`react-dom` exception use `isPackageDeclared`, not
`isPackageAvailable`: a hard rejection is consequential enough to key on declaration only (the
declared-vs-available split from `specs/milestones/m68-workspace-project-model.md`), so a
transitive, hoisted `node_modules/solid-js` that nothing declares does not reject a Vue or vanilla
project, and the failure message's "declares solid-js" claim stays literally true. The same
standard applies symmetrically to the exception: a hoisted-but-undeclared `react` does not excuse
a project that genuinely declares `solid-js`.

The PnP check (below) has no analogous concern: `detectPnP` reads workspace-root-level install
artifacts (`.pnp.cjs`, `.pnp.loader.mjs`, `process.versions.pnp`), not a dependency's declared-vs-
resolvable status — there is no "declared" form of an install mechanism to key on instead.

`preflightFailureMessage` (`src/preflight.ts:470`) already throws through `analyze.ts:2225`
unmodified — this milestone does not touch `analyze.ts`, only extends the `HARD_CAUSE` and a new
per-kind `HARD_REMEDY` table that `preflightFailureMessage` reads instead of the previously
hardcoded "extract the client part" footer. The three existing kinds (`server-only`, `use-server`,
`async-component`) keep byte-identical output; `unsupported-framework` gets a Solid-specific
remedy naming that Solid is not supported.

### 2. Preact-behind-`react`-alias detection (`src/react-profiler.ts`)

`detectFramework` (`src/react-profiler.ts:119-139`) computes `workspaceRoot` unconditionally
(previously lazy) and, whenever it resolves to `"react"` and the project also has `solid-js`
available, calls `onWarning` with a new `SOLID_AND_REACT_DECLARED` message. Behavior for every
existing `detectFramework` test is unchanged: the refactor preserves the original own → shared →
available resolution order exactly.

`runReactAnalysis` (`src/react-profiler.ts:627`) gains an identity check before it launches a
browser: a new `resolveReactDomIdentity(harnessDir)` resolves `react-dom/package.json` via
`createRequire(harnessDir)` (Node's own resolution walks up from `harness.harnessDir`, which
`mkdtempSync`s directly under `projectRoot`, so it reaches the real install) and reads the
resolved package's own `name`/`version` fields — the only reliable signal, since an npm/pnpm alias
(`"react-dom": "npm:preact/compat"`) keeps the `react-dom` folder name on disk but not the
package.json's `name`. If the name is missing, unreadable, or not `"react-dom"` (including the
"cannot resolve at all" case, treated as unknown rather than assumed-Preact), `runReactAnalysis`
warns via `REACT_DOM_NOT_REACT_WARNING` and returns an empty result map without launching a
browser: no memo-bailout, context-fan-out, callback-identity, or render-attribution data for that
run. Mounting and every other measurement pass are untouched — they go through `harness.ts`, which
this milestone does not modify, and `createRoot` is Preact-compat-safe.

When the identity resolves to genuine `react-dom`, a coarse version-range guard
(`isSupportedReactDomVersion`, 16.5 ≤ version ≤ 19.x) warns via `REACT_DOM_VERSION_RANGE_WARNING`
when outside that range but does not skip the pass: `PROFILER_HOOK_SCRIPT`
(`src/react-profiler.ts:249`) hardcodes React's internal `WorkTag` numbers for that tested range,
and an out-of-range version may misreport rather than crash.

### 3. Yarn PnP rejection (`src/project-model.ts`, `src/preflight.ts`)

New `detectPnP(workspaceRoot)` in `src/project-model.ts`, probing `.pnp.cjs` and
`.pnp.loader.mjs` at `workspaceRoot` and `process.versions.pnp` (set by Yarn's own require hook
when 120fps itself runs under PnP). `runPreflight` calls it once per run, alongside the Solid
check in scope 1, and pushes a hard `"yarn-pnp"` hit when it returns true — unconditionally, no
mixed-repo exception (a PnP install is a resolution-mechanism problem, not a framework choice).

### 4. Node version floor (`src/cli.ts`)

New pure `nodeVersionError(version: string): string | undefined` and `nodeMajorVersion`, exported
from `src/cli.ts`. `main()` (`src/cli.ts:831`) calls `nodeVersionError(process.version)` as its
first statement, before `parseArgs`: below major 22 it writes `Error: Node 22+ required, found
<version>` to stderr and exits 2, matching every other usage-error exit code in `main()` (fixture
not found, wrapper not found, stylesheet not found, `--isolate` parse failure all exit 2; exit 1 is
reserved for a measured verdict failure at `src/cli.ts:981`).

### 5. Provider-library advisories (`src/preflight.ts`)

`PROVIDER_LIBRARIES` (`src/preflight.ts:114-119`) gains six entries, same shape as the existing
four (`package: representativeHookThatThrowsOutsideItsProvider`):

- `react-router`: `useNavigate`
- `react-router-dom`: `useNavigate`
- `@remix-run/react`: `useLoaderData`
- `gatsby`: `useStaticQuery`
- `@tanstack/react-router`: `useRouter`
- `@tanstack/react-start`: `useRouter`

No other change: `detectProviderImport`, `providerCandidateLabels`, and the render-error hint that
consumes them (`src/hints.ts`) already handle every entry generically by package name.

### 6. Dead entry removal (`src/preflight.ts`)

`SERVER_ONLY_PACKAGES` (`src/preflight.ts:9`) drops `"next/server-only"`: not a real module (Next
re-exports the real `server-only` package unchanged), so it could only ever match a typo. Importing
the literal string `"next/server-only"` no longer produces a hard `server-only` hit; it falls
through to ordinary module resolution like any other unresolvable specifier (a no-op, per the
existing `if (!resolved) continue` at `src/preflight.ts:423`).

## Does NOT include

- `src/harness.ts`, `src/analyze.ts`, `src/index.ts`: owned by a concurrent lane. No barrel export
  is added for any new symbol; all are consumed via direct module imports. If `index.ts` should
  re-export `resolveReactDomIdentity`, `isSupportedReactDomVersion`, `detectPnP`,
  `nodeVersionError`, or the new `PreflightKind`/message constants, that addition is listed for the
  coordinator to apply, not made here.
- Rendering support for Solid or Svelte components. Solid is rejected, never compiled.
- Full Yarn PnP support (a `.pnp.cjs`-aware resolver). PnP is rejected, never resolved through.
- JSDoc prop extraction for JS-only projects: known limitation, unchanged; a JS project still gets
  thinner prop inference than a TS one, silently.
- A structured-error-based Playwright-missing-executable detector: Playwright's own
  `Executable doesn't exist...` failure is a plain `Error`, not a distinguishable class or code
  (confirmed by reading `playwright-core`'s `registry/index.js`, the throw site) — nothing on
  `import("playwright").errors` covers it, only `TimeoutError`. `formatCliError`'s existing regex
  match stays as the sole detector.
- Any change to the `--no-preflight` bypass mechanism itself: it already applies uniformly to every
  hard `PreflightKind`, including the two new ones. Passing it past a Solid or PnP rejection still
  attempts (and still likely fails) the run; that escape hatch is deliberate and pre-existing.

## Acceptance

- A project with `solid-js` declared and no `react`/`react-dom`: `runPreflight` returns a hard
  `unsupported-framework` hit; `preflightFailureMessage` names Solid and does not print the
  server-boundary "extract the client part" remedy.
- A project with both `react` and `solid-js` declared: `runPreflight` returns no hard hit for
  either package; `detectFramework` still resolves `"react"` and calls `onWarning` once, naming
  both packages.
- A project with a transitive, hoisted `node_modules/solid-js` that no manifest (member or
  workspace) declares: `runPreflight` returns no `unsupported-framework` hit.
- A project that declares `solid-js` and no `react`/`react-dom`, but has a transitive, hoisted
  `node_modules/react`: `runPreflight` still returns the hard `unsupported-framework` hit — a
  hoisted-but-undeclared `react` does not grant the mixed-repo exception.
- A project whose resolved `react-dom/package.json` names anything other than `"react-dom"` (or
  fails to resolve): `runReactAnalysis` returns an empty map and warns, without opening a browser.
- A resolved `react-dom` version below `16.5` or `19.x` and above: `runReactAnalysis` still runs
  and additionally warns.
- A workspace root carrying `.pnp.cjs`, `.pnp.loader.mjs`, or a `process.versions.pnp` value: hard
  `yarn-pnp` hit, unconditionally.
- `process.version` below `v22`: `main()` exits 2 with a message containing "Node 22+" and the
  detected version, before any argument parsing or file access.
- `detectProviderImport` recognizes all ten `PROVIDER_LIBRARIES` package names, sub-paths
  included.
- Importing the literal specifier `"next/server-only"` produces no `server-only` hard hit.
