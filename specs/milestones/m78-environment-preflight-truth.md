---
kind: milestone
status: draft
tests:
  - test/unit/preflight.test.ts
  - test/unit/react-version-boot-gate.test.ts
  - test/unit/project-transforms.test.ts
  - test/unit/react-profiler.test.ts
  - test/unit/dx-features.test.ts
  - test/unit/bundler-preact-alias.test.ts
---

# M78: environment preflight tells the truth

## Goal

An environment that cannot be measured says why, accurately, before anything is built, and says
the same thing regardless of which entry path the user took (default run, `--matrix`,
`--explain-props`, `--no-preflight`). Four field-test repositories were misdiagnosed at the same
gate (`assertReactDomClient`, `src/harness.ts:256-262`) for four different real causes, and two dry
paths (`--explain-props`, `--no-preflight`) bypass checks the default path enforces. Closes
excalidraw-F1/F2/F3, solid-ui-F1/F3, pnp-app-F2/F3, preact-app-F2/F5, and reproduces
preact-app-F3 as a fixture. Confirms as regression-locked passes: pnp-app-F1, solid-ui's main
gate, preact-app-F1.

## Scope

### 1. Dependencies-not-installed preflight check

There is no `node_modules`-presence check anywhere in `src/`. Add one, in `runPreflight`
(`src/preflight.ts:348`), as a new hard kind checked before the Solid check and gated behind the
existing PnP check so a legitimate PnP project (which never has `node_modules` by design) is not
misdiagnosed as uninstalled:

```ts
// src/preflight.ts:374-391, replacing the PnP branch
if (detectPnP(workspaceRoot)) {
  hard.push({ kind: "yarn-pnp", chain: entryChain });
} else if (detectMissingInstall(projectRoot, workspaceRoot)) {
  hard.push({ kind: "not-installed", chain: entryChain });
}
```

`detectMissingInstall(memberRoot, workspaceRoot): boolean` is new, in `src/project-model.ts` next
to `detectPnP` (`:182-185`), and is the single source of truth this behavior and behavior 2 both
consult: `workspaceLevels(memberRoot, workspaceRoot).every((level) => !fs.existsSync(path.join(level, "node_modules")))`.
Directory existence only, mirroring `isInstalledAt`'s own `fs.existsSync` style
(`project-model.ts:126-127`); an empty-but-present `node_modules` is out of scope (no field-test
evidence for that shape).

`PreflightKind` (`src/preflight.ts:16-29`) gains `"not-installed"`. Because `HardKind` is
`Exclude<PreflightKind, "node-builtin" | "project-transform">` (`:511`) and `HARD_CAUSE` /
`HARD_REMEDY` are typed `Record<HardKind, string>` (`:513`, `:528`), the compiler forces both maps
to cover it:

```ts
"not-installed": "is measured in a project with no installed dependencies (no node_modules under it or its workspace root)",
```
```ts
"not-installed": "Run your package manager's install (npm install, yarn install, or pnpm install), then measure again.",
```

Unlike every other `HARD_REMEDY` entry, this one does not append "Pass --no-preflight to attempt
the run anyway": bypassing this specific check cannot succeed (there is nothing installed for the
harness to boot against), unlike the server-boundary/Solid checks it sits beside, which are
heuristics that can have false positives. `HARD_REMEDY` gains an `export` keyword so behavior 2
can reuse it verbatim.

**Compounding-note fix.** Excalidraw-F3 is not just F1/F2's misdiagnosis: the same run also
appended a "needs a CSS preprocessor" note to the wrong error. That note comes from
`transformFailureNote` (`src/preflight.ts:569-578`), appended by `runComboMode`'s outer catch
(`src/analyze.ts:2407-2415`) whenever `transformHits.length > 0`. `transformHits` is populated at
`:2213` before the preflight hard-check throws at `:2226`, so *any* preflight hard rejection today
gets this note glued on if the graph also touches an unloadable transform — a pre-build rejection
dressed up with a post-build-style hint. Fix: distinguish a preflight hard-rejection from a real
build/runtime failure at the throw site (`:2226`), e.g. a marker property or dedicated error type,
and skip the `transformFailureNote` append at `:2412` when the caught error carries it. This
applies uniformly to the existing PnP/Solid hard-hits too, not just the new one.

### 2. `assertReactDomClient` resolution-failure taxonomy

`assertReactDomClient` (`src/harness.ts:256-262`) wraps `resolve("react-dom/client")` in a bare
`try` and treats every failure as "version too old," with `readReactDomVersion`
(`:234-242`, also failure-swallowing) silently omitting the version when it can't read one either
— which is every uninstalled-repo case, since the two `try`s fail for the same reason. Four repos,
four different real causes, one wrong message each. Replace the catch body with a taxonomy, still
inside `assertReactDomClient` in `src/harness.ts` (it already imports `findWorkspaceRoot`,
`isPackageDeclared` from `project-model.js`, `:11-18`; add `detectPnP`, `detectMissingInstall`):

```ts
type ReactDomResolutionCause = "pnp" | "not-installed" | "not-declared" | "not-linked" | "outdated" | "unknown";

function diagnoseReactDomResolutionFailure(
  projectRoot: string,
): { cause: ReactDomResolutionCause; version?: string } {
  const workspaceRoot = findWorkspaceRoot(projectRoot);
  if (detectPnP(workspaceRoot)) return { cause: "pnp" };
  if (detectMissingInstall(projectRoot, workspaceRoot)) return { cause: "not-installed" };
  const version = readReactDomVersion(projectRoot); // the real require.resolve probe
  if (version !== undefined) return { cause: "outdated", version };
  if (isPackageDeclared("react-dom", projectRoot, workspaceRoot)) return { cause: "not-linked" };
  return { cause: "not-declared" };
}
```

The order matters and is deliberate: `readReactDomVersion`'s `require.resolve` success is checked
*before* `isPackageDeclared`, not after, because a package that genuinely resolves on disk with a
real (too-old) version is a version problem regardless of whether the project's own `package.json`
happens to list it — `isPackageDeclared` is only a useful discriminator once nothing resolved at
all. (`isPackageAvailable`, `project-model.ts:165-172`, is unsuitable here: it returns `true` from
declaration alone, which would misfile a declared-but-never-installed `react-dom` as "outdated"
instead of "not-linked".)

Message construction, one function per cause, all in `src/harness.ts` next to
`REACT_DOM_CLIENT_MISSING`:

- **`pnp`**: fresh cause sentence + `HARD_REMEDY["yarn-pnp"]` reused verbatim (imported from
  `preflight.js`) — closes solid-ui-F3 and pnp-app-F3, where `--no-preflight` bypasses the real PnP
  finding and this gate then fabricates a React-version problem instead.
- **`not-installed`**: fresh cause sentence + `HARD_REMEDY["not-installed"]` reused verbatim —
  closes excalidraw-F1/F2 as a backstop for the (rare, once behavior 1 ships) case where
  `--no-preflight` reaches this gate anyway.
- **`not-declared`**: if `isPackageDeclared("solid-js", projectRoot, workspaceRoot)` and neither
  `react` nor `react-dom` is declared, reuse `HARD_REMEDY["unsupported-framework"]` verbatim with a
  fresh cause sentence naming Solid — this is the second half of solid-ui-F3's fix and is the
  concrete mechanism for "says the same thing regardless of entry path": the `--no-preflight`
  path's final error and the default path's preflight rejection now share their remedy text.
  Otherwise: a generic "react-dom is not a dependency of this project (checked package.json at
  `<projectRoot>`[ and workspace root `<workspaceRoot>`]); point 120fps at a project that declares
  it, or install it here."
- **`not-linked`**: "react-dom is declared in package.json but was not found installed under
  `node_modules` from `<projectRoot>` up through `<workspaceRoot>`; the install may be incomplete,
  or this workspace member is not linked to it. Reinstall dependencies."
- **`outdated`**: today's `REACT_DOM_CLIENT_MISSING(projectRoot, version)` text, unchanged — this
  is the one true "upgrade react-dom" case and must not regress preact-app-F1's already-correct
  gate. Addendum (preact-app-F5): when `isPackageDeclared("preact", projectRoot, workspaceRoot)`,
  append "This project also declares preact; its `preact/compat/client.js` already implements a
  `createRoot`/`hydrateRoot` shim, but 120fps has no flag to mount through it, so upgrading
  react-dom is still the only supported path." Folds preact-app-F5 into this taxonomy rather than
  adding a separate check.
- **`unknown`**: defensive fallback for a resolvable-but-unreadable package (a broken `exports`
  map, a corrupted manifest) — "react-dom/client does not resolve from `<projectRoot>`, and 120fps
  could not determine why: react-dom appears to be installed but its version could not be read."
  Never says "upgrade": nothing was proven about the version.

### 3. Gate parity across entry paths

**`--explain-props` runs no preflight gate at all.** `explainProps` (`src/analyze.ts:1644-1706`)
calls `resolveProjectPaths` and `extractPropsDetailed` only; `runPreflight` and
`assertReactDomClient` never run on this path, which is why it exits 0 with a clean props table on
a Solid project (solid-ui-F1) and a PnP project (pnp-app-F2) that the default path rejects in ~1s.
The comment already at the call site (`src/cli.ts:952-953`, "Before every check that exists to
protect a measurement, because it never starts one") states the intended contract; the
implementation never enforced it.

Fix, inside `explainProps` before `extractPropsDetailed` (`:1656-1662`):

```ts
const workspaceRoot = findWorkspaceRoot(projectRoot);
const preflight = runPreflight({ projectRoot, entries: [resolvedPath], componentName });
if (preflight.hard.length > 0) {
  if (options.noPreflight) warnings.push(PREFLIGHT_BYPASSED_WARNING(preflight.hard));
  else throw new Error(preflightFailureMessage(preflight.hard));
}
if (rendererFor(resolvedPath) === "react") assertReactDomClient(projectRoot);
```

This is the same order the default path uses (`src/analyze.ts:2196-2228` then
`src/harness.ts:1459`): preflight's graph-walk hard-hits first (bypassable), then the
always-on react-dom gate (never bypassed by `--no-preflight` — see below), mirroring
`buildAndServe`'s own `if (renderer === "react") assertReactDomClient(projectRoot)`
(`src/harness.ts:1459`) fed by the same extension-only `rendererFor` (`:27-29`), so a `.vue` target
never hits it, at zero build cost (no harness dir, no dev server — matching `--explain-props`'s
existing "measures nothing" contract).

`explainProps`'s options type (`:1646`) gains `noPreflight?: boolean`, threaded from
`cli.ts:960-962`'s call site alongside the existing `target` forwarding, reading `args.noPreflight`
(already parsed at `cli.ts:381-384`, already threaded to the default path at `:1122`, never
threaded to `--explain-props` today). `formatCliError` + `process.exit(2)` already run identically
for both paths (`cli.ts:966`/`:1047-1051`), so once `explainProps` throws the same error type the
default path throws, exit code and message text match with no `cli.ts` changes beyond the one new
field passed in.

`PropsExplanation.warnings` (`:1639`) already prints under a "Warnings:" section
(`formatExplainProps`, `:1774-1778`), so the bypassed-hard-hit warning surfaces with no formatter
change.

**`--no-preflight` must not fabricate a diagnosis.** It legitimately skips the *hard* rejection for
`runPreflight`'s graph-walk kinds (`server-only`, `use-server`, `async-component`,
`unsupported-framework`, `yarn-pnp`, `not-installed`) — downgraded to
`PREFLIGHT_BYPASSED_WARNING`, unchanged from today (`src/analyze.ts:2222-2228`). It does not, and
must not, skip `assertReactDomClient`: that gate is not part of `runPreflight`'s hard set, runs
unconditionally in `buildAndServe` regardless of the flag, and behavior 2's taxonomy makes it an
independent backstop that reaches the same conclusion `runPreflight` already reached and got
overridden into a warning — so the final thrown error after `--no-preflight` still names PnP, or
Solid, or "nothing installed," never a fabricated React-version claim. This is what closes
solid-ui-F3 and pnp-app-F3 without adding new PnP/Solid awareness inside `--no-preflight`'s own
handling: the awareness already exists in behavior 2's taxonomy and simply isn't bypassable.

### 4. Preact bundler-alias coverage and disclosure

`resolveReactDomIdentity` (`src/react-profiler.ts:607-617`) reads the resolved `react-dom`
package's own `package.json` `name` field, which catches an npm/pnpm alias
(`"react-dom": "npm:preact/compat"`) because that install scheme physically places the aliased
package's files under the `node_modules/react-dom` folder name, so its own manifest legitimately
says `name: "preact"`. A bundler-level `resolve.alias` (Vite or webpack/Next.js) never touches
`node_modules`: the real `react-dom` package stays on disk unchanged, `name: "react-dom"`, so this
check is structurally blind to it — not a missed case, a different mechanism entirely. Verified
against the real field-tested `next.config.js`:

```js
webpack: (config, { dev, isServer }) => {
  if (!dev && !isServer) {
    Object.assign(config.resolve.alias, { react: 'preact/compat', 'react-dom': 'preact/compat' });
  }
  return config;
}
```
(`C:/Projekte/120fps-fieldtest/repos/preact-app/apps/dashboard/next.config.js`)

Two sub-mechanisms, because the two bundler shapes behave differently inside 120fps's own harness
today, and conflating them would overclaim:

**(a) Vite literal-path alias — a real mount-time data-integrity risk.** `readViteConfigData`
(`src/harness.ts:835-905`) already extracts `resolve.alias` from `vite.config.*`, and its output is
already merged into the harness's *own* Vite `resolve.alias` (`src/harness.ts:1544-1548`,
`alias = [...tsconfigAliases, ...viteConfig.aliases, ...shimAliases]`). So a Vite project whose
`vite.config.ts` aliases `react-dom` to a filesystem path that resolves into a `preact` package is
*actually mounted through Preact* by 120fps's own server, while both `assertReactDomClient` and
`resolveReactDomIdentity` keep checking the untouched real `react-dom` on disk and pass. This is
the literal shape of preact-app-F3's hypothesis, reproducible today via Vite (the field-tested repo
used webpack, but the risk generalizes).

Fix: `HarnessResult` (`src/harness.ts:112-127`) gains `viteAliases?: Array<{ find: RegExp; replacement: string }>`,
populated in `buildAndServe` from the `viteConfig.aliases` already computed at `:1538` (no
re-parsing). `resolveReactDomIdentity` gains a second parameter,
`bundlerAliases: Array<{ find: RegExp; replacement: string }> = []`: when an entry's `find` matches
the bare specifier `react-dom` (or `react-dom/client`), resolve the aliased file's nearest ancestor
`package.json` (same nearest-package-boundary walk `require.resolve` would use) and read its `name`
— the same identity signal `resolveReactDomIdentity` already trusts for the npm-alias case, fed
through a second path. A `name: "preact"` result short-circuits to the same
`{ name: "preact", version }` shape the npm-alias branch already returns, so
`runReactAnalysis`'s existing `reactDomIdentity.name !== "react-dom"` check
(`src/react-profiler.ts:730`) skips fiber analysis unchanged; `REACT_DOM_NOT_REACT_WARNING`
(`:636-644`) gains a source-aware branch naming "this project's vite.config.ts `resolve.alias`"
distinctly from the npm-alias wording, since the remedy differs (nothing to reinstall; the alias is
deliberate). `runReactAnalysis` (`:729`) passes `harness.viteAliases ?? []` as the new argument.

**(b) Webpack/Next.js bare-specifier alias — a disclosure gap, not a silent-wrong-analysis risk.**
`readViteConfigData`'s alias reader requires a filesystem-resolvable literal path
(`fs.existsSync(replacement)`, `:894-898`) and drops a bare package specifier like `'preact/compat'`
into `ignoredKeys` with no per-key detail. No reader exists at all for `next.config.js` /
`webpack.config.js`. Because 120fps applies neither shape to its own mount (see "Does NOT include"),
a project using this exact real-world pattern is *not* silently mismeasured the way (a) is: the
harness genuinely mounts real react-dom, so fiber analysis runs against what 120fps itself actually
executes. The gap is representativeness: the report never says the project's real, shipped build
swaps this component to Preact via a mechanism 120fps cannot evaluate (the `!dev && !isServer`
condition can't be resolved without running webpack).

Fix: new `detectBundlerReactDomAlias(projectRoot: string): { configFile: string; target: string } | undefined`
in `src/harness.ts`, probing `next.config.{js,mjs,cjs,ts}` then `webpack.config.{js,mjs,cjs,ts}`
(same probe-order pattern as `VITE_CONFIG_FILES`, `:745-752`), parsed via
`ts.createSourceFile` and never executed (same invariant as `readViteConfigData`). It walks the AST
for any object-literal property, in any object literal (a plain exported object, a
`Object.assign(...)` call argument, an assignment target), keyed by the string literal `"react-dom"`
with a string-literal value containing `"preact"` — matching the field-tested shape without
requiring proof of the surrounding `resolve.alias` structure. New
`BUNDLER_PREACT_ALIAS_WARNING(configFile: string, target: string): string`: "`<configFile>` aliases
react-dom to \"`<target>`\" for at least one build target 120fps cannot evaluate (the harness never
executes your bundler config); if that alias is active in production, this measurement runs the
real react-dom, not what your app ships." Wired as a run warning alongside
`NODE_BUILTIN_WARNING`/`PROJECT_TRANSFORM_WARNING` (`src/analyze.ts:2205`/`:2218`), gated to
`renderer === "react"`, and reached from `--explain-props` too via the same `runPreflight` call
added in behavior 3, so the disclosure is present on every entry path, not just the default run.

**Fixture split (preact-app-F3), matching the two sub-mechanisms above:**

- Vite variant: `vite.config.ts` aliasing `react-dom` to an existing file inside a `preact` package
  boundary, real `react-dom@>=18` installed. Acceptance: `resolveReactDomIdentity` returns
  `{ name: "preact" }`; `runReactAnalysis` returns an empty map and emits the source-aware warning
  — the "unconditional alias + react-dom>=18 clears both gates" combination, now caught rather than
  silently analyzed.
- Next.js/webpack variant: reproduces the real `next.config.js` shape verbatim (`Object.assign`
  inside a `webpack:` customizer, react-dom to `preact/compat`), `preact` declared, real
  `react-dom@>=18` installed. Acceptance: `detectBundlerReactDomAlias` finds it,
  `BUNDLER_PREACT_ALIAS_WARNING` is emitted on both the default run and `--explain-props`; fiber
  analysis still runs (documented as correct: 120fps genuinely mounts real react-dom here), but the
  report no longer stays silent about the divergence from what the project ships.

## Changed contracts

- `test/unit/react-version-boot-gate.test.ts:51-53` ("still refuses when no react-dom is installed
  at all") currently asserts `/React 18\+ required/` against a `tmpDir` with zero `node_modules` —
  exactly the excalidraw shape, and exactly the bug. It must assert the new `not-installed` message
  instead. Every other test in that file (the `18.3.1`-with-client pass, the `17.0.2`-no-client
  "outdated" case, both `REACT_DOM_CLIENT_MISSING` direct-call tests) traces cleanly through the
  new taxonomy unchanged: `installReactDom` always creates `node_modules/react-dom`, so
  `detectMissingInstall` is false and `readReactDomVersion` succeeds, landing on `outdated` with
  the existing message.
- `HARD_REMEDY` (`src/preflight.ts:528`) changes from module-private to exported.

## Does NOT include

- Warnings surviving an already-crashed build, uncaught build failures generally, or the
  harness-failure exit-code contract — M79 (`M76-M83-MAP.md:33-34`).
- Prop-schema correctness (`--explain-props`'s FilledButton/excalidraw-F4 wrong-schema finding) —
  M81, a synthesis defect independent of the gates this milestone adds in front of it.
- Executing the project's real `vite.config`, `next.config`, or `webpack.config` — the new
  Next.js/webpack alias reader (behavior 4) is text-parsed the same way `readViteConfigData`
  already is (`src/harness.ts:833-834`'s own stated invariant), never imported, never run.
  Detecting an alias's *target* through a fully general JS evaluator is out of scope; the reader
  matches the literal shape confirmed in the field-tested repo (an object-literal property or
  `Object.assign` argument keyed `"react-dom"` with a string-literal value), not arbitrary
  computed aliasing.
- Applying a bare-specifier bundler alias (`"react-dom": "preact/compat"`) to 120fps's own mount.
  `readViteConfigData`'s existing alias reader already requires a filesystem-resolvable literal
  path (`path.resolve(configDir, target)` + `fs.existsSync`, `src/harness.ts:894-898`) and drops
  bare specifiers into `ignoredKeys` today; this milestone does not widen that. See behavior 4's
  fixture split for why this matters to preact-app-F3's exact scope.
- Vue runtime-form prop disclosure and the `.js`/`.ts` entry gate — both flagged as pre-existing,
  out-of-lane items in `M76-M83-MAP.md:56-58`, owned by M80/M81/an ADR, not touched here.
- Regressing `--matrix`'s already-correct pass-through of the same gates (pnp-app, solid-ui both
  confirmed consistent) — no code change to `--matrix`'s wiring; behavior 1/2's fixes apply to it
  automatically since it shares `runComboMode`, and `test/unit/preflight.test.ts` locks the
  existing PnP/Solid hard-hits so this stays true.

## Acceptance

Every criterion below is checkable against a fixture project directory, not a cloned repository
(`M76-M83-MAP.md:54`).

- A project with a `package.json` declaring `react`/`react-dom` and no `node_modules` anywhere from
  the member up through the workspace root: default run rejects with the `not-installed` message
  before any harness directory is created; `--matrix` rejects identically;
  `--explain-props` rejects identically (same message, exit 2); `--no-preflight` downgrades to a
  warning naming the same fact, and the harness-build gate (behavior 2) independently reaches and
  throws the same `not-installed` cause, never a react-dom-version claim; the run's error contains
  no "needs a CSS preprocessor" or other transform note.
- A project with `react-dom` declared in `package.json` but no `node_modules/react-dom` anywhere
  reachable (an otherwise-populated `node_modules` present): `assertReactDomClient` throws the
  `not-linked` message, not "Upgrade react-dom."
- A project declaring `solid-js` and no `react`/`react-dom`, run with `--no-preflight`: the final
  error names Solid and reuses `HARD_REMEDY["unsupported-framework"]`'s exact remedy text, not a
  React-version claim.
- A `.pnp.cjs` marker fixture, run with `--no-preflight`: the final error names Yarn PnP and reuses
  `HARD_REMEDY["yarn-pnp"]`'s exact remedy text, not a React-version claim.
- A project with real `react-dom@17.x` installed and declared: default run and `--explain-props`
  both reject with the existing "React 18+ required (found react-dom v17...)" wording, unchanged
  wording, confirming no regression on preact-app-F1's already-correct gate; when `preact` is also
  declared, the message additionally names the `preact/compat/client.js` shim.
- The Vite-literal-alias-to-preact fixture: `resolveReactDomIdentity` identifies Preact through the
  alias, not the real `react-dom`'s own manifest; `runReactAnalysis` skips fiber analysis with a
  warning naming the `vite.config.ts` alias as the source.
- The Next.js/webpack-alias-to-preact fixture: `detectBundlerReactDomAlias` finds the alias and its
  warning appears in both the default run's report and `--explain-props`'s warnings list.
- A project with none of the above conditions (clean install, real react-dom 18+, no aliases): all
  four entry paths (default, `--matrix`, `--explain-props`, `--no-preflight`) proceed past every
  gate in this milestone with zero new warnings — regression lock for pnp-app-F1, solid-ui's main
  gate, and preact-app-F1's pass state.
