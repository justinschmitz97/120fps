---
kind: milestone
status: draft
tests:
  - test/e2e/crash-warning-survival.test.ts
  - test/unit/harness-crash-warnings.test.ts
  - test/e2e/unhandled-build-failure.test.ts
  - test/e2e/unbuilt-workspace-package.test.ts
  - test/e2e/config-evaluation-fail-fast.test.ts
  - test/unit/css-preprocessor-declared-vs-installed.test.ts
  - test/unit/hints-captured-error.test.ts
  - test/unit/curve-render-error-hint.test.ts
---

# M79: diagnostics survive the failure path

## Goal

The harness already computes the right diagnosis for most of the failures the field test hit —
which preprocessor global is missing, which style engine is unsupported, which package a
workspace never built — and discards it at exactly the moment a crash makes the user need it
most. This milestone makes four structural fixes so a failure reports the cause the tool already
found, instead of a generic message that is often factually wrong. Fix 1 alone (warnings
surviving the crash path) improves the error text in most of the field test's blocked
repositories at once, because the crash path is shared: every repo that reaches
`buildAndServe`/`analyze()` and then throws currently loses whatever it had already computed,
regardless of which specific misdiagnosis follows.

Closes: twenty-F3, twenty-F1, shadcn-ui-F2, ant-design-F1, ant-design-F5, taxonomy-F1,
chakra-ui-F1, base-ui-F2, dub-F1, mantine-F1 (message quality only), excalidraw-F3.

## Scope

### 1. Computed warnings survive the crash path

Two independent places already accumulate diagnostic strings in a local array, and both drop the
array on the throw path today.

**1a. `buildAndServe` (`src/harness.ts:1413-1754`).** `buildWarnings` (`harness.ts:1697`,
`[...transformWarnings, ...new Set(configWarnings)]`, later appended to at `:1714`) is attached
to the returned `HarnessResult` only on the success path (`harness.ts:1752`,
`...(buildWarnings.length > 0 ? { warnings: buildWarnings } : {})`). The `bootServer()` catch
(`harness.ts:1719-1724`) throws a fresh `Error(VITE_START_FAILED(...))` and the "no listening
address" throw (`harness.ts:1731`) does the same — neither carries `buildWarnings`, even though
everything that feeds it (`VITE_CONFIG_IGNORED_WARNING` at `:1539-1543`, `styleTooling.warnings`
at `:1608`, `transformWarnings` at `:1619-1627`) is already computed by the time either throw
fires.

Fix: both throw sites attach the warnings computed so far to the thrown `Error` as a `warnings:
string[]` own property (`Object.assign(new Error(VITE_START_FAILED(...)), { warnings:
buildWarnings, cause: err })`), instead of only the message text. Nothing before `buildWarnings`
exists (`harness.ts:1427-1459`: wrapper validation, the Vue SFC-produces-no-component check,
`assertReactDomClient`) has anything to attach — those throw before any warning has been
computed, so they are unchanged.

**1b. `analyze()`'s outer try/catch (`src/analyze.ts:2166-2420`).** `runWarnings` is declared at
`analyze.ts:2042`, outside the `try`, so it survives into the `catch` at `:2408` — this is the
same scoping M48 already uses for `transformHits` (declared at `:2040`, read at `:2412-2414`).
`harness.warnings` is folded into `runWarnings` immediately after a successful `buildAndServe`
call (`analyze.ts:2246`, `if (harness.warnings) runWarnings.push(...harness.warnings)`), **before**
`enterHarnessPage()` runs (`analyze.ts:2279`) — so by the time a later readiness-timeout throw
happens (`analyze.ts:2258-2270`, via `enrichTimeoutError`), the computed warnings are already
sitting in `runWarnings`, in scope at the catch block, and are dropped anyway: the catch only
special-cases `transformHits`, then does `throw err` (`analyze.ts:2408-2415`).

This exact sequence is twenty-F3: `buildAndServe` succeeds (Vite boots, `VITE_CONFIG_IGNORED_WARNING`
and `UNSUPPORTED_STYLE_ENGINE_WARNING` both land in `runWarnings` via `harness.warnings`), the SCSS
`@include` of an unreplicated global mixin then kills module evaluation, the readiness gate times
out, and the catch block never looks at `runWarnings` before rethrowing.

Fix: generalize the catch block's existing special case. On any error, format `runWarnings`
(deduplicated, same array `attachHarnessContext` would have used on success) plus any `warnings`
carried on the error itself (from 1a, or from a rethrow elsewhere) into one block appended to the
error's message, and rethrow that instead of the bare `err`. This **subsumes** the current
`transformHits`-only special case: `transformHits`'s own warnings are already pushed into
`runWarnings` at `analyze.ts:2218`, so `transformFailureNote(transformHits)`
(`analyze.ts:2412-2414`) becomes redundant with the generalized append and is removed as a call
site (the exported function itself is unchanged — see Changed contracts). Changed contract: the
appended text switches from `transformFailureNote`'s hand-written framing ("The measured graph
imports files this harness cannot compile: ...") to the same `[transform:<code>] ...` lines every
other warning already uses, for every warning class, not only transforms.

**Design choice: error property, not a CLI-side drain.** The milestone asks for one of "an error
type carrying the accumulated warnings" or "a drain the CLI reads on the catch path." Chosen:
**the thrown error carries the warnings.** `src/cli.ts` has three independent call sites that
reach a component run (`explainProps` at `:960-967`, `compareAgainstRef` at `:1006-1013`, the
main sweep's `runOne` at `:1039-1052`), and all three already do nothing but call
`formatCliError(err, process.env.DEBUG)` (`cli.ts:670-680`), which prints `err.message` verbatim.
A CLI-side drain would need new state threaded through `analyze()`'s internals and visible to
`cli.ts` on every one of those three paths even when the call throws before returning anything;
attaching the data to the error itself needs no new plumbing anywhere in `cli.ts`; `formatCliError`
needs zero changes because the warnings are already inside `err.message` by the time it runs. This
also matches the one existing precedent in this exact function (`transformFailureNote`),
generalized rather than replaced by a new mechanism.

### 2. Build failures must not escape the CLI's handler

Confirmed via source: no `process.on("unhandledRejection", ...)` or `process.on("uncaughtException",
...)` exists anywhere in `src/` (grepped). `main()` is invoked at `cli.ts:1307-1308` with no
`.catch()`. The sweep loop's own `try`/`catch` (`cli.ts:1038-1052`) only catches what the awaited
`runOne(...)` promise itself rejects with; it cannot catch a rejection from a promise Vite's own
dependency pre-bundler never attaches to that chain. Vite's `optimizeDeps` scan phase is fire-and-forget
by design (it must not block `server.listen()`), so an unresolvable entry in `stableInclude`
(`harness.ts:1599-1602`, `optimizeDeps: { include: stableInclude }` at `:1687-1689`) can fail
*after* `bootServer()`'s own `await created.listen()` (`harness.ts:1691`) has already resolved and
`buildAndServe`'s try (`:1698-1724`) has already exited successfully. Node's default
`--unhandled-rejections=throw` then converts that rejection into a process-terminating uncaught
exception, printing the raw esbuild `Error: Build failed with 1 error` object and its internal
stack, ending in the `Node.js vXX.X.X` footer — exactly the ant-design-F1 and shadcn-ui-F1
transcripts (`ERROR: Could not resolve "./version"`; `Cannot read file
"apps/v4/node_modules/@types/react": Incorrect function.`). Confirmed against `--help`'s own
documented table (`cli.ts:744-747`): `2 setup error: bad flag, missing file, harness or browser
failure` is the correct bucket; the observed exit code in both field-test transcripts was 1
(Node's uncaught-exception default), which the same table documents as "a verdict failed" —
wrong on both counts.

Fix: install `process.on("unhandledRejection", handler)` and `process.on("uncaughtException",
handler)` once, before `main()` is invoked (near `cli.ts:1301-1308`). `unhandledRejection` is the
one the evidence traces directly to (Node converts the fire-and-forget optimizer rejection into
this event before its default handler escalates it); `uncaughtException` is added alongside it as
the synchronous counterpart, since esbuild's own internal errors are plain `throw new Error(...)`
(`esbuild/lib/main.js:1467`, quoted verbatim in both transcripts) and nothing rules out a build
reaching that path via a synchronous callback outside any promise. The handler:

- Guards against firing twice (`process.exit` does not stop already-scheduled work synchronously).
- Writes `formatCliError(err, process.env.DEBUG)` to stderr — same formatting every other error
  path already uses, so a raw stack only appears under `DEBUG` (`cli.ts:661-680`), never by
  default.
- Calls `process.exit(2)`, matching the documented "harness or browser failure" bucket.

### 3. A failure must name its real cause, not a downstream symptom

**3a. Unbuilt workspace package (ant-design-F1, twenty-F1, dub-F1, mantine-F1 — wording only).**
`VITE_START_FAILED` (`harness.ts:191-193`) wraps whatever Vite/esbuild reported, verbatim, with no
inspection of *what* failed to resolve. Vite's own message (`Failed to resolve entry for package
"X". The package may have incorrect main/module/exports specified in its package.json.`) blames a
workspace-internal package's `package.json` fields when those fields are correct and the real
problem is that the package was never built (twenty-shared's `dist/` is `.gitignore`d and produced
by an Nx target 120fps never runs; chakra's own `packages/react` ships a `dev`-condition-only
export deliberately pointing at unbuilt `src/`; the same shape recurs in dub and mantine per the
map's routing).

Fix: before wrapping the raw message in `VITE_START_FAILED`'s catch site
(`harness.ts:1719-1724`), extract the package name from Vite's `Failed to resolve entry for
package "([^"]+)"` shape and check whether it names an unbuilt workspace member:

1. Resolve the package's directory from `projectRoot`'s `node_modules`, walking ancestors the
   same way `isInstalledOnResolutionChain` already does (`project-model.ts:153-161`, currently
   private — export it, or add a thin wrapper that returns the directory instead of only a
   boolean).
2. `fs.realpathSync` that directory. A workspace-linked package is a symlink whose real path sits
   under `workspaceRoot` and outside any `node_modules` segment; an ordinary third-party
   dependency's real path always contains one. This is the discriminator between "internal,
   possibly-unbuilt package" and "a genuinely broken external dependency," which the milestone
   scopes this fix to.
3. Read that package's own `package.json`; resolve `exports["."]` (string, or the `default`/
   `import`/`require` condition), falling back to `module`, then `main`.
4. If none of those fields point at a file that exists on disk, the package is unbuilt: compose a
   message naming the package, the missing path, and that it needs a build step — not that its
   `package.json` is wrong.
5. Anything that does not match this shape (not a workspace member, or its entry exists) falls
   through to today's unchanged `VITE_START_FAILED(harnessDir, err.message)`.

This is a diagnosis of an existing failure, not a new preflight check (M78 owns checks that run
*before* the harness build starts; this runs inside the existing catch, after Vite has already
failed).

**3b. Config-evaluation throws fail fast and name the throwing module (taxonomy-F1).**
`enterHarnessPage` (`analyze.ts:2258-2270`) and `enterHarness` (`measure.ts:378-397`) both `await
page.waitForFunction(..., { timeout: 30000 })` (inlined at `analyze.ts:2266`; the named constant
`HARNESS_READY_TIMEOUT_MS` at `measure.ts:360` is not reused there — pre-existing, not part of
this fix, noted for whoever touches this next) and catch only the timeout, via
`enrichTimeoutError` (`page-errors.ts:162-175`). A synchronous throw during module evaluation
(taxonomy: `next.config.mjs:3` → `env.mjs`'s `createEnv()`) fires `page.on("pageerror", ...)`
almost immediately (`page-errors.ts:74-78`, which is also where `segmentFatal` is set), but
nothing races that event against the 30-second gate: the run waits out the full timeout before
`enrichTimeoutError` ever reads what `capture.errors` already had within the first second, and the
resulting message leads with "did not become ready within timeout" — a perf-sounding headline for
a cause that is not a perf issue — with the real error demoted to a sub-bullet.

Fix:

- `attachPageErrorCapture` (`page-errors.ts:65-123`) gains a way for a caller to be notified the
  instant a `pageerror` fires — a fatal, uncaught exception is unambiguous evidence the harness
  will never become ready, unlike `console.error` (which stays bucket-only and non-fatal, matching
  the existing "dev warnings must never gate a verdict" rule at `page-errors.ts:5-8`, `:79-83`).
  First hit wins, matching this codebase's existing "first hit wins" precedent (`harness.ts:1246`,
  `project-model.ts:48-51`).
- `enterHarnessPage`/`enterHarness` race `page.waitForFunction(...)` against that fatal signal.
  When the fatal signal wins, throw immediately instead of waiting out the remaining timeout.
- The thrown message leads with the page error, not "did not become ready within timeout": reuse
  `enrichTimeoutError`'s detail construction (the same `capture.summary()` text) under a different
  lead sentence for this path, so a genuine hang (nothing captured, timeout fires) and an early
  fatal throw (something captured almost instantly) read as two different failures, which they
  are.
- Name the throwing module: capture `err.stack`, not only `err.message`, at the fatal `pageerror`
  listener for this fail-fast path only (bucket recording via `record()` stays message-keyed,
  unchanged, so dedup/cap behavior at `page-errors.ts:32-63` is untouched). Best-effort extract the
  first source-file frame from the stack (a file with a JS/TS/Vue extension) and prepend it to the
  fail-fast message when found. This is a suspect-naming heuristic in the same spirit as
  `detectLocalProviderModule` (`preflight.ts:173-183`, "the point is to name a suspect, not to
  prove it"), not a guarantee — a minified or source-mapless stack yields no module name and the
  message falls back to the page-error text alone.
- Surface the remedy the tool already owns: `readEnvDefines` (`harness.ts:962-990`) reads
  `.env`/`.env.local` (`ENV_FILES`, `harness.ts:931`) at the workspace and member levels and
  forwards only `NEXT_PUBLIC_*`/`VITE_*`-prefixed keys (`ENV_DEFINE_PREFIXES`, `harness.ts:930`)
  as Vite `define`s — `process.env` itself is defined as `{}` (`harness.ts:984`), so nothing from
  the invoking shell's own environment ever reaches the page. Add a way for `readEnvDefines`'s
  caller to know whether it found any env file at all (a sibling boolean check reusing the same
  `ENV_FILES`/level-walk, or a return-shape change). When a fatal page error fires and no
  `.env`/`.env.local` exists at either level, append one line naming the convention (env files
  only, keys must be `NEXT_PUBLIC_*`/`VITE_*`-prefixed, the invoking shell's own environment is
  not read). Document the same fact in `--help` (`cli.ts:693-760`; currently no `.env` mention at
  all — grepped, zero hits — and in `README.md`, also zero hits): this behavior exists in source
  today and is undocumented anywhere a user would find it before hitting the failure.

**3c. Declared-versus-installed for CSS preprocessors (twenty-F3's false positive;
excalidraw-F3).** Two separate warning sites both collapse "declared in package.json" and
"actually installed" into one boolean, in opposite directions:

- The `css-preprocessor` transform recognizer (`preflight.ts:87-91`) has **no availability check
  at all** — it fires for every `.scss`/`.sass`/`.less`/`.styl` import unconditionally, regardless
  of whether the preprocessor is installed, declared-but-not-installed, or genuinely absent. It is
  absent from `SUPPORTED_TRANSFORM_PLUGINS` (`harness.ts:1158-1169`: svgr, vanilla-extract, vue) —
  Vite's own built-in CSS pipeline resolves `sass`/`less`/`stylus` directly, it is never loaded as
  a Vite plugin object — so `loadableTransforms` (`analyze.ts:2210-2212`) can never exclude it, and
  `PROJECT_TRANSFORM_WARNING` (`preflight.ts:562-565`, `owner: "a CSS preprocessor (Vite needs
  sass/less/stylus installed in the project)"`) always fires. This is twenty-F3's false positive:
  `sass-embedded` was installed and successfully invoked in the same crash's own stack trace, and
  the tool said to install it anyway.
- `isPackageAvailable` (`project-model.ts:165-172`) returns `true` when `isPackageDeclared`
  (`:133-139`, package.json only) is `true`, *before* checking whether the package resolves on
  disk (`isInstalledOnResolutionChain`, `:153-161`). `CSS_PREPROCESSOR_MISSING_WARNING`
  (`harness.ts:386-391`) is gated through `preprocessorFor` (`:372-377`), which calls
  `isPackageAvailable` — so a package declared in `package.json` but never actually installed
  (a bare clone, a partial install) is treated as available, and the one message that does check
  says "install `sass`" to a project whose `package.json` already lists it. This is excalidraw-F3.

Fix: both sites need a three-way answer instead of a boolean — resolvable (on disk, regardless of
declaration), declared-but-not-resolvable, or neither. Export a thin wrapper around the existing
private `isInstalledOnResolutionChain` (e.g. `isPackageInstalled`, `project-model.ts:153-161`) so
callers can ask "is it actually there" independently of "is it declared." Reuse it in both places:

- `preflight.ts`'s `css-preprocessor` recognizer gains the extension-to-package mapping
  `PREPROCESSOR_PACKAGES` already has privately in `harness.ts:355-360` (export it, or duplicate
  the four-entry table next to `TRANSFORM_RECOGNIZERS` — it is stable and small). The consumption
  site (`analyze.ts:2210-2218`, `transformHits` filter) excludes a `css-preprocessor` hit from
  `transformHits` entirely when its package is actually installed — no warning at all, which is
  the correct outcome for twenty's `JsonDisplay.tsx`-adjacent components and, going forward, for
  Button/Chip/TabButton/MenuItem once fix 1 also lets the real cause
  (`VITE_CONFIG_IGNORED_WARNING`) reach the user instead of this false one.
- When the package is declared but not installed, both `PROJECT_TRANSFORM_WARNING` and
  `CSS_PREPROCESSOR_MISSING_WARNING` switch to wording that says so ("declared in package.json but
  not installed; run your package manager's install"), instead of "needs `sass`... installed" —
  which remains the correct wording only for the genuinely-neither case.

This does not touch `recognizeTransform`'s return shape (`preflight.ts:104-109`,
`test/unit/project-transforms.test.ts:98-99` keeps asserting `code: "css-preprocessor"`
unchanged) — the fix is entirely in how the hit is filtered and worded downstream, not in
detection.

### 4. Remediation hints read the captured error

**4a. The provider guess ignores the error it already captured (base-ui-F2).** `extraHintLines`
(`hints.ts:193-196`) maps every entry of `report.providerCandidates` to `PROVIDER_HINT_LINE`
whenever `renderError` is in the hint set — unconditionally, without reading `combo.pageErrors`
(`report.ts:162`), the exact text the tool already captured and already prints via
`appendPageErrors` (`report.ts:746-761`) two sections above the hint. Base UI's `render`-prop
crash text ("The `render` prop was provided an invalid React element...") names its own cause
precisely; the auto-hint still guesses `CompositeRootContext`/`TabsRootContext`/
`DialogRootContext` — a different wrong guess per component, always following "imports a Context
hook" from the preflight walk (`preflight.ts:164-171`) regardless of what actually threw.

Fix: gate the provider hint on the captured error text, not only on `renderError` +
`providerCandidates` both being non-empty. Only emit `PROVIDER_HINT_LINE` entries when at least
one captured page-error message (`combo.pageErrors` for combo mode; the new curve-mode field from
4b) matches a provider/context-shaped signature (`/provider|context/i` against the message text —
deliberately loose, since the goal is withholding a wrong guess, not proving a right one). When no
captured message mentions a provider or context at all, the provider hint is withheld entirely:
the reader already has the real captured text from `appendPageErrors`, and a wrong guess on top of
a correct disclosure is worse than no guess.

**4b. Curve mode has no path to the `renderError` hint at all (chakra-ui-F1).**
`hintsForReport` (`hints.ts:142-179`) only inspects `report.combos` (`:145`) to detect a render
error (`combo.renderHealth === "error"`, `:155`). Curve mode always sets `combos: []`
(`analyze.ts:996`) and reports through `report.scalingCurveReport` instead. `runCurveMode`
(`analyze.ts:910-1009`) already detects a broken scale point correctly (`brokenPoints`,
`:974-976`: `domNodeCount === 0 && pageErrors?.fatal`) and pushes `CURVE_RENDER_ERROR_WARNING`
(`:977-984`, `analyze.ts:2444-2445`) into `runWarnings` — a well-worded, accurate string — but it
never becomes anything `hintsForReport` or the curve table (`formatCurveOutput`,
`report.ts:963-999`) can see structurally: it is prose inside `report.warnings`. The only thing
`hintsForReport` checks for curve mode is `curveReport?.domFlat` (`hints.ts:169`, set
unconditionally by `isDomFlat` at `analyze.ts:965-968` whenever no scale point moved the DOM,
crash or not), which produces the wrong hint ("check that the prop actually drives what renders")
for a run that crashed, not one whose prop genuinely doesn't affect the DOM. Dialog only shows the
correct `FAIL [render error]` + `--wrap` behavior because prop-combo mode's `renderHealth`
mechanism reaches it and curve mode's does not — not because curve mode is healthy.

Fix: `ScalingCurveReport` (`report.ts:197-214`) gains a structural field for broken points (e.g.
`renderErrorPoints: number[]`, the scale-point `n` values, plus the page-error text already
computed via `renderDrain(broken.pageErrors!)` at `analyze.ts:981`), populated in `runCurveMode`
at the same point `CURVE_RENDER_ERROR_WARNING` is already pushed (`analyze.ts:974-984`), so the
two stay in sync by construction rather than by convention.

- `hintsForReport` adds `renderError` to `found` when this field is non-empty, and feeds its
  page-error text into 4a's captured-error gate the same way `combo.pageErrors` does.
- `hintsForReport` suppresses `domFlat` when `renderError` is already present for the same report:
  a page that threw on every scale point is not evidence the scaling prop fails to drive
  rendering, and `domFlat`'s hint text is actively wrong in that case per the chakra-ui-F1
  evidence.
- `formatCurveOutput` (`report.ts:963-999`) marks a broken row's `Growth` cell (or appends a
  `[render error]` tag to the row, mirroring `renderHealthMarks`'s bracket convention exactly,
  `report.ts:733-742`) so the terminal table stops printing a bare `WARN`/`FAIL` for a row that
  crashed, matching what combo mode already does.

## Changed contracts

- **Exit code for an uncaught harness/build failure changes from 1 to 2.** Today an esbuild/Vite
  failure that escapes as an unhandled rejection or uncaught exception gets Node's default exit
  code (1) with a raw stack trace; per `cli.ts:744-747` exit 1 is documented as "a verdict
  failed," which is wrong for a setup/harness failure. After fix 2, the same failure is caught by
  the new `process.on` handlers, formatted through `formatCliError`, and exits 2 ("setup error:
  bad flag, missing file, harness or browser failure"). This is user-visible and CI-visible: a
  consumer scripting on exit code per the documented contract now correctly routes this failure to
  "setup error" instead of "verdict failed." Grepped `test/` for `Incorrect function`, `Build
  failed with`, `unhandledRejection`, `uncaughtException`, and `Failed to resolve entry for
  package` — zero hits, so no existing test pins the old exit-1 behavior; this is new coverage,
  not a changed assertion.
- **`PROJECT_TRANSFORM_WARNING` for CSS preprocessors becomes conditional on availability.**
  Today it fires unconditionally for any `.scss`/`.sass`/`.less`/`.styl` import, because
  `preflight.ts:87-91`'s `css-preprocessor` recognizer performs no availability check and the code
  is absent from `SUPPORTED_TRANSFORM_PLUGINS` (`harness.ts:1158-1169`). After 3c, the warning is
  withheld when the preprocessor package resolves on disk, and reworded when it is declared but
  not installed. `test/unit/project-transforms.test.ts:98-99` (`recognizeTransform("./theme.scss")
  ?.code === "css-preprocessor"`) is the only existing test that touches this recognizer, and it
  asserts the recognizer's classification only — untouched by this fix, since the change is
  entirely in how `analyze.ts:2210-2218` filters and words the hit, not in detection. No existing
  test asserts the warning reaching `report.warnings`/a crash message when the package is
  installed, so this is new coverage, not a changed assertion.
- **Warnings accumulated before a failure now reach the user on the throw path.** Today a crash
  after one or more warnings were already computed (preprocessor-config-ignored,
  unsupported-style-engine, project-transform, etc.) produces an error containing only the
  immediate cause. After fix 1, every warning already computed by the time of the throw is
  appended to the same message, so error output for such a crash grows by one line per warning.
  Existing tests that assert on crash-message substrings via `.toContain`/`.toMatch` on the
  specific cause continue to pass, since that substring remains present; no existing test asserts
  an exact, full error string for a crash that carried computed warnings (grepped for exact-match
  assertions on `VITE_START_FAILED`/`did not become ready` output — none found), so no existing
  test requires a change, but any new test written against this milestone must not assert message
  length or exact equality.
- **`transformFailureNote`'s call site changes; the exported function does not.**
  `analyze.ts:2412-2414`'s `transformHits`-only special case is removed in favor of the
  generalized `runWarnings` append (which already contains every `transformHits` warning via
  `PROJECT_TRANSFORM_WARNING`, pushed at `analyze.ts:2218`). `transformFailureNote` itself is
  unchanged and still exported; `test/unit/project-transforms.test.ts:158-164` and
  `test/unit/virtual-module-diagnosis.test.ts:89`, which call it directly, continue to pass. Its
  framing text ("The measured graph imports files this harness cannot compile: ...") no longer
  appears in a thrown error's message; the per-hit `[transform:<code>] ...` lines do, in the same
  format every other warning class now uses.
- **Curve mode gains a hint/table capability it never had, not a changed one.** Before this
  milestone, `hintsForReport` could never add `renderError` for a curve-mode report (`combos` is
  always `[]` in that mode) and `formatCurveOutput` had no per-row error marker. No existing test
  asserts the absence of `renderError`/`[render error]` in curve-mode output, so this is additive:
  a report that previously produced a bare `domFlat` hint for a crashed run now produces
  `renderError` instead, and `domFlat` is suppressed for that same report — see 4b.

## Does NOT include

- New preflight checks that run before the harness builds (install presence, react-dom
  resolution, `--explain-props`/`--no-preflight` gate parity) — M78.
- Resolution behavior: where alias sources come from, what a resolved target is allowed to point
  at, layered workspace-root fallback — M76/M77.
- Stylesheet *selection* (which file gets injected, `CSS_FALLBACK_WARNING`,
  `CSS_IMPORT_SKIPPED_WARNING`) — M82. This milestone only touches the wording of the
  preprocessor-*availability* message once a stylesheet is already selected.
- Composition/disclosure of what was rendered (M80) or prop-schema synthesis (M81).
- Parity between a flag and what ran, report self-consistency — M83.
- Retrying or working around any of the underlying failures. Every fix below is diagnostic: it
  names the cause faster and more accurately, it does not make a broken build succeed.
- Browser/dev-server process cleanup on the new `unhandledRejection`/`uncaughtException` path
  (behavior 2). No existing `process.exit()` call site in `cli.ts` performs it either (e.g.
  `cli.ts:1002`, `:1012`, `:1048`); this milestone does not change that.

## Acceptance

- A fixture project whose harness boots successfully (a real warning gets computed — e.g. a
  `vite.config.ts` with `css.preprocessorOptions` the harness cannot honor) and then throws during
  readiness (an unrelated synchronous page error): the final CLI error text contains the
  originally-computed warning, not only the timeout/crash message.
- A fixture whose dependency-optimizer scan fails inside esbuild after the dev server has already
  started listening (an `optimizeDeps.include` entry that cannot resolve, reached only through the
  background scan, not the entry file's own transform): the CLI exits 2, prints no raw Node stack
  trace or esbuild internals by default (`DEBUG` unset), and does print one under `DEBUG=120fps`.
- A workspace fixture (two packages, lockfile at the root) where the importing package's
  `package.json` `main`/`exports` target does not exist on disk: the error names the package and
  states it needs a build step, not that its `package.json` fields are wrong.
- A fixture whose entry-adjacent config module throws synchronously during evaluation: the run
  fails in well under 30 seconds, the error leads with the thrown message (not "did not become
  ready within timeout"), names the throwing module when its stack yields one, and — when no
  `.env`/`.env.local` exists in the fixture — names that convention.
- A fixture importing a `.scss` file where the preprocessor package is installed: no
  preprocessor-related warning appears. A second fixture where it is declared but not installed:
  the warning says "declared ... not installed," not "needs ... installed."
- A combo-mode fixture whose render error text has nothing to do with a provider or context: no
  `--wrap`/provider hint is emitted, even though `providerCandidates` is non-empty from an
  unrelated import in the same file.
- A curve-mode fixture whose every scale point renders zero DOM nodes because the page threw: the
  report's `FAIL` carries a `[render error]` mark, `hintsForReport` includes `renderError`,
  `formatHints` emits the `--wrap` line when the captured text is provider-shaped, and `domFlat`
  is absent from that same report.
