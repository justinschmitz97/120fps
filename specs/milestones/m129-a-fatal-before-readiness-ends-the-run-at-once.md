---
kind: milestone
status: draft
tests:
  - test/unit/page-errors.test.ts
  - test/unit/bundler-error-presentation.test.ts
  - test/unit/a-fatal-before-readiness-ends-the-wait.test.ts
  - test/unit/a-module-response-error-ends-the-wait.test.ts
  - test/unit/a-bundler-diagnosis-appends-to-the-timeout-report.test.ts
  - test/unit/every-navigation-carries-the-readiness-bound.test.ts
  - test/unit/a-virtual-namespace-import-is-refused-before-the-browser.test.ts
  - test/unit/a-stale-preprocessor-is-named-not-timed-out.test.ts
  - test/unit/an-unshimmable-next-module-is-refused-in-both-modes.test.ts
---

# M129: a fatal before readiness ends the run at once, with the bound it advertises

Lane A (`src/browser/page-errors.ts`, `src/browser/session.ts`, `src/harness/bundler-failure.ts`,
`src/project/preflight-gates.ts`, and the `presentBundlerFailure` call in `src/pipeline/phases.ts`,
the `page.goto` sites in `src/pipeline/analyze.ts` and `src/analysis/explorer.ts`, the post-probe
stylesheet entry in `src/harness/build.ts`).

## Purpose

Four of the fifty run-7 repositories spent 90 to 100 seconds waiting for a harness that had already
failed. taxonomy threw `env.mjs: Invalid environment variables` at about 3 seconds and the run ended
at 93; directus, twenty and n8n each answered a same-origin module request with a 500 in the first
seconds and each waited the full bound. When the wait finally expired, the message that named the
bound was replaced by a bundler diagnosis that did not, so the developer learned neither what failed
nor how long the tool had waited. After this milestone a fatal or a module-level server error before
readiness ends the run when it happens, the diagnosis is appended to the readiness report rather than
replacing it, every navigation carries the readiness bound instead of Playwright's 30 second default,
and the two gates that already know the run cannot succeed refuse before the browser starts.

Evidence: `C:/Projekte/120fps-fieldtest/smoke/run7-FINDINGS.md` cluster 1 (F1-F6),
`smoke/run7-smoke1/{taxonomy,directus,twenty,n8n,plane}.json`, and the per-repo logs under
`smoke/run7-smoke1/logs/<repo>/`.

## Root causes (verified)

The verifier for every item below: run-7 investigation (2026-09-06), refuted by default; logs under
`C:/Projekte/120fps-fieldtest/logs/run7-investigate/` and `smoke/run7-smoke1/logs/<repo>/`.

1. **A captured fatal is only consulted after the bound expires** — `waitForReadyOrFatal`
   (`src/browser/page-errors.ts:388-407`) races the readiness wait against a fatal that arrives
   *after* registration, and reads `capture.capturedFatal()` only in the catch arm that runs once the
   90 second deadline has passed. A module-eval throw that lands before `domcontentloaded` is already
   in the capture at t≈3 s and is not looked at again until t=90 s. The verifier: taxonomy exits 2 at
   93 s with the `env.mjs: Invalid environment variables` text that the capture held from second 3
   (`smoke/run7-smoke1/taxonomy.json`, real seconds 93); the existing test
   `test/unit/page-errors.test.ts:467` pins only the after-registration case, so nothing today
   asserts the before-registration one.
2. **A module-level HTTP error never ends the wait** — the `response` handler in
   `src/browser/page-errors.ts:146-171` records but does not arm a fatal; only `pageerror` sets one,
   and the comment at `:155` reasons about 404s. A 500 on a same-origin module URL (`?import`, or a
   `.ts`/`.tsx`/`.vue` path) means the transform failed and the module graph will never evaluate. The
   verifier: directus answers six `.yaml` module requests with 500 in the first seconds and waits the
   full bound (94 s); twenty and n8n do the same. Measured control: n8n with
   `FPS120_READY_TIMEOUT_MS=8000` finishes in 25 s with byte-identical refusal text, which shows the
   wait contributes nothing after the first error.
3. **The bundler diagnosis replaces the readiness report instead of appending to it** —
   `presentBundlerFailure` (defined at `src/harness/bundler-failure.ts:93`, called at
   `src/pipeline/phases.ts:483`; the matcher runs at `src/harness/bundler-failure.ts:249-263`)
   regex-matches the whole message, including the `Page errors:` block, and returns a replacement. M125's `It waited 90 s …` sentence is dropped.
   The verifier: n8n reports `VIRTUAL_NAMESPACE_IMPORT_ERROR` (`bundler-failure.ts:202`) and twenty
   reports `BUNDLER_IMPORT_UNRESOLVED_ERROR` (`:193`), and in both logs the readiness note is absent.
   The append shape already exists in the same file at `:135`.
4. **Three of four navigations carry no timeout** — `page.goto` at `src/browser/session.ts:77`,
   `src/pipeline/analyze.ts:475-477` and `src/analysis/explorer.ts:389` pass no `timeout`, so
   Playwright's 30 second default applies, while `src/analysis/react-profiler.ts:613-616` passes
   `readyTimeoutMs`. `gotoWithErrorContext` (`src/browser/page-errors.ts:433-446`) then prints the
   readiness headline without M125's raise-the-bound note, so the message advertises a bound the call
   did not use. The verifier: plane became a setup-error at 47 s under load (build plus a 30 s
   navigation) and the same target passed when re-run alone.
5. **The mute-readiness diagnosis names a sheet the probe already dropped** —
   `diagnoseMuteReadinessTimeout` (`src/harness/bundler-failure.ts:126-137`) reads the `Stylesheets:`
   decision line rather than the entry that survived the M121 compile probe
   (`src/harness/build.ts:440-443`). The verifier: plane's `real.log:19` names `styles/emoji.css` as
   the suspect while `:33` of the same log records that the probe dropped it.
6. **A virtual-namespace import is a soft recognizer, so the dry run and the real run disagree** —
   `hardKindForTransformCode` (`src/project/preflight-gates.ts:180-182`, reading
   `UNLOADABLE_FILE_TYPE_CODES` at `:177`) returns a hard kind for exactly two inputs: a code in
   `DATA_LOADER_CANDIDATES` (kind `unloadable-file-type`) and the code `babel-macro` (kind
   `unloadable-macro`). `virtual-module` (`~icons/`, `virtual:`, `unplugin-`) gets `undefined`, so it
   stays soft, so the dry run exits 0 with a warning while the real run refuses after the full bound.
   The verifier: n8n's `dry.log:51` carries the text of `UNRESOLVED_PREBUNDLE_ENTRY_WARNING`
   (`src/harness/deps-scan.ts:47-53`) and exits 0, while the real run exits 2 at 100 s. M110's parity
   rule says the dry run decides everything the real run decides from disk.
7. **A stale preprocessor produces no diagnosis at all** — the preprocessor recognizer at
   `src/harness/bundler-failure.ts:139` matches only
   `/Preprocessor dependency "([^"]+)" not found/`, so a preprocessor that *is* installed but too old
   to answer the API Vite calls falls through every recognizer and the run waits out the bound. The
   verifier: uptime-kuma installs sass 1.42.1, Vite 7 calls `compileStringAsync`, the dev server
   answers `[vite] Internal Server Error … sass.compileStringAsync is not a function`, and the run
   ends at 93 s with no diagnosis (`smoke/run7-new1/uptime-kuma.json`: class `setup-error`, exit 2,
   real 93 s, flags `stack-trace` and `dry-real-disagree`).
8. **An unshimmable Next runtime module is predicted and then not acted on** —
   `src/harness/shims.ts:36` carries the "imported but not shimmed" predictor, and M73 records that
   `next/font/google` is *deliberately* never shimmed (unbounded named exports). The dry run prints
   the predictor and exits 0; the real run fails in 5 s. The verifier:
   `smoke/run7-new1/scaffold-next-pages.json`, class `setup-error`, exit 2, real 5 s, flag
   `dry-real-disagree`. M110's parity rule is violated by a prediction the dry run makes and then
   does not act on.

## MUST

- **C1** A fatal page error that the capture holds at the moment `waitForReadyOrFatal` is entered
  ends the wait immediately, with the same message a fatal arriving later produces. A
  taxonomy-class fatal — a module-eval throw before `domcontentloaded` — ends the run within 5 s of
  the throw, and the refusal text is byte-identical to the text the 90 s path produced.
- **C2** A `response` event carrying a status of 500 or above for a same-origin URL that the harness
  requested as a module ends the readiness wait as a fatal, with a message that names the URL, the
  status, and that the module graph cannot evaluate without it. "Requested as a module" means the URL
  carries the `?import` query or ends in a module extension the harness serves (`.ts`, `.tsx`,
  `.js`, `.jsx`, `.mjs`, `.vue`, `.svelte`).
- **C3** C2 never fires for a status below 500, and never for a URL that
  `isHarnessInternalNoise` (`src/browser/page-errors.ts:73`) already classifies as the harness's own
  traffic. A module error that arrives while readiness is already resolving loses the race: readiness
  wins, and the run continues.
- **C4** A bundler diagnosis is appended to the readiness report, never substituted for it. The
  presented failure keeps the readiness sentence, keeps M125's `It waited <n> s …` note, and adds the
  diagnosis below it. `presentBundlerFailure` matches only the lead sentence of the message, not the
  `Page errors:` block, so a page error whose text happens to contain a bundler pattern does not
  become the diagnosis of the run. The kept report keeps the stack frames its page-error block
  carries; only frames inside 120fps's own installation are stripped, as they always were.
- **C5** Every `page.goto` in the run passes an explicit timeout equal to the readiness bound
  (`harnessReadyTimeoutMs()`, M125 C4), and `gotoWithErrorContext` prints the same
  raise-the-bound note the readiness timeout prints, naming `FPS120_READY_TIMEOUT_MS` and the bound
  it used.
- **C6** `diagnoseMuteReadinessTimeout` names as a suspect only a stylesheet that survived the M121
  compile probe. When the probe dropped every sheet, the diagnosis names no stylesheet and says the
  probe cleared them. The survivors are the `Stylesheets:` decision line minus every sheet the
  probe's own drop warnings name; both already reach `presentBundlerFailure` in `buildWarnings`,
  so the diagnosis needs no new argument and no other lane's field to be correct.
- **C7** An import into a virtual namespace that no transform 120fps loads claims is a hard preflight
  refusal before the browser starts, in the real run and in `--explain-props` identically (M110
  parity). The refusal names the importing file, the specifier, the chain from the measured
  component, and the plugin the project declares for that namespace when it declares one.
- **C8** A dev-server error whose text names a CSS preprocessor API that the installed preprocessor
  does not provide is diagnosed, not waited out. The diagnosis names the preprocessor, the version
  installed, the minimum version that provides the API, and `--no-css` as the way to run without it.
  Like C4, it is appended to the readiness report, never substituted for it.
- **C9** An import of a Next.js runtime module that 120fps does not shim and has decided never to
  shim (`next/font/google`, M73) is refused in the dry run with the same words and the same exit code
  as the real run. The predictor at `src/harness/shims.ts:36` becomes a decision instead of a
  forecast; an unshimmed `next/*` module that is merely *not yet* shimmed keeps today's non-blocking
  `UNSUPPORTED_NEXT_MODULE_WARNING` (M73).

## MUST NOT

- Extend the readiness bound, change its default (90000 ms) or change the wording M125 C1 fixed. This
  milestone changes when the wait ends, never how long it is allowed to run.
- End the wait on a 404, on a status below 500, on a cross-origin URL, or on harness-internal
  traffic. A missing optional chunk is not a failed run.
- End the wait on a module error that a subsequent successful readiness resolves. An optional
  `import().catch()` that answers 500 is the one shape that can produce a false fatal; the fatal is
  therefore armed with a short grace that a readiness resolution cancels.
- Replace a page-error remedy with a bundler diagnosis, or print two diagnoses for one failure.
- Change the healthy path: a harness that becomes ready costs no extra call, no added delay and no
  extra output line.
- Refuse a virtual-namespace import that a transform 120fps loads does in fact claim.
- Refuse an unshimmed `next/*` module that M73 left non-blocking on purpose. C9 covers only the
  modules M73 decided never to shim.
- Guess a preprocessor version. C8 reads the installed version from the package it resolved; when
  it cannot read one, it names the API and not a version.

## Verification

- **C1** — `test/unit/a-fatal-before-readiness-ends-the-wait.test.ts`: a capture pre-loaded with a
  fatal resolves `waitForReadyOrFatal` on entry, in under the test's own short bound, with the same
  message the after-registration path produces; a capture with no fatal still waits; the existing
  after-registration case in `test/unit/page-errors.test.ts:467` stays green.
- **C2, C3** — `test/unit/a-module-response-error-ends-the-wait.test.ts`: a same-origin `?import`
  URL with status 500 ends the wait and the message names URL and status; a `.vue` path with 500 does
  the same; 404, 302 and 499 do not; a cross-origin 500 does not; a URL matched by
  `isHarnessInternalNoise` does not; a 500 followed inside the grace by a readiness resolution
  produces a successful wait and no error.
- **C4** — `test/unit/a-bundler-diagnosis-appends-to-the-timeout-report.test.ts` and
  `test/unit/bundler-error-presentation.test.ts`: a timeout message whose `Page errors:` block
  contains `Failed to resolve import` keeps its readiness sentence and its `It waited` note and gains
  the diagnosis below; a lead sentence that matches `VIRTUAL_NAMESPACE_IMPORT_ERROR` is diagnosed; a
  bundler pattern that appears only inside the page-error block is not treated as the lead.
- **C5** — `test/unit/every-navigation-carries-the-readiness-bound.test.ts`: each `page.goto` call
  site is invoked with a `timeout` equal to `harnessReadyTimeoutMs()`; a navigation failure message
  names `FPS120_READY_TIMEOUT_MS` and the bound used.
- **C6** — extend `test/unit/bundler-error-presentation.test.ts`: a run whose probe dropped the only
  candidate sheet produces a diagnosis that names no sheet; a run with a surviving sheet names that
  sheet and not the dropped one.
- **C7** — `test/unit/a-virtual-namespace-import-is-refused-before-the-browser.test.ts`: a fixture
  importing `~icons/mdi/close` with no matching transform is a hard preflight hit; the dry run and
  the real-run gate return the same decision and the same text; an `unplugin-*` specifier that an
  installed package answers for is not recognized as virtual and is not refused (no supported
  transform serves a virtual namespace, so that is the reachable form of the exclusion).
- **C8** — `test/unit/a-stale-preprocessor-is-named-not-timed-out.test.ts`: a server error text
  naming `sass.compileStringAsync is not a function` produces a diagnosis naming sass, the installed
  version, the minimum and `--no-css`; the existing `Preprocessor dependency … not found` match is
  unchanged; an unrelated internal server error is not diagnosed as a preprocessor problem.
- **C9** — `test/unit/an-unshimmable-next-module-is-refused-in-both-modes.test.ts`: a fixture
  importing `next/font/google` is refused by the dry run and the real run with identical text and
  identical exit codes; a fixture importing an unshimmed-but-shimmable `next/*` module keeps the
  non-blocking warning in both modes.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus every existing test of the files this milestone edits
  (`test/unit/page-errors.test.ts`, `page-error-reaches-its-own-remedy.test.ts`,
  `readiness-timeout-names-the-wait-and-its-bound.test.ts`, `bundler-error-presentation.test.ts`,
  `import-cycle-preflight-hit.test.ts`, `harness-crash-warnings.test.ts`), then the full unit suite
  once before the lane's final commit.

Recorded run of this milestone's verification:

```
$ node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
(no output)

$ npx vitest run test/unit/a-fatal-before-readiness-ends-the-wait.test.ts \
    test/unit/a-module-response-error-ends-the-wait.test.ts \
    test/unit/a-bundler-diagnosis-appends-to-the-timeout-report.test.ts \
    test/unit/every-navigation-carries-the-readiness-bound.test.ts \
    test/unit/a-virtual-namespace-import-is-refused-before-the-browser.test.ts \
    test/unit/a-stale-preprocessor-is-named-not-timed-out.test.ts \
    test/unit/an-unshimmable-next-module-is-refused-in-both-modes.test.ts \
    test/unit/bundler-error-presentation.test.ts test/unit/page-errors.test.ts \
    test/unit/page-error-reaches-its-own-remedy.test.ts \
    test/unit/readiness-timeout-names-the-wait-and-its-bound.test.ts \
    test/unit/import-cycle-preflight-hit.test.ts test/unit/harness-crash-warnings.test.ts --maxWorkers=2
 Test Files  13 passed (13)
      Tests  190 passed (190)

$ npx vitest run test/unit --maxWorkers=2
 Test Files  2 failed | 346 passed (348)
      Tests  2 failed | 4978 passed | 1 skipped (4981)
# the two failures are the run-7 baseline pair, unchanged by this milestone:
#   test/unit/prop-cap-ranking.test.ts, test/unit/vue-setup-inject-evidence.test.ts
```

Corpus repros, each through a `dist` built in `C:/Projekte/120fps-run7-lane-a`
(`node node_modules/typescript/bin/tsc -p tsconfig.json`), run through
`C:/Projekte/120fps-fieldtest/tools/run120.mjs` with
`--out C:/Projekte/120fps-fieldtest/logs/run7-lane-a/<repo>`; logs are kept there.

```
taxonomy   E:/repositories/taxonomy  components/ui/label.tsx        93 s -> 4 s, exit 2
  Error: component harness failed before it became ready: env.mjs: Invalid environment variables. Page errors:
  (byte-identical to the lead sentence the 93 s path produced)

directus   E:/repositories-run5/directus/app  src/ai/components/ai-context-menu/empty-state.vue
                                                                    94 s -> 10 s, exit 2
  Error: component harness failed before it became ready: the dev server answered
  http://localhost:5175/@fs/E:/repositories-run5/directus/packages/system-data/src/fields/fields.yaml?import
  with 500: that module's transform failed, and the module graph the harness entry pulls cannot
  evaluate without it.

twenty     E:/repositories/twenty/packages/twenty-front  src/modules/ui/input/components/TextArea.tsx
                                                                    97 s -> 25 s, exit 2
  Error: component harness failed before it became ready: the dev server answered
  http://localhost:5173/@fs/E:/repositories/twenty/packages/twenty-shared/src/utils/applyDiff.ts with 500: …
  ../twenty-shared/src/utils/applyDiff.ts imports "@/utils/validation", which the dev server could not
  resolve to a loadable file. …
  (the diagnosis is appended below the report, which is the fail-fast one: with C2 the run no longer
  waits, so there is no `It waited` note to keep. The map's row predicted that note from the 90 s path.)

n8n        E:/repositories-run5/n8n/packages/frontend/editor-ui  src/app/components/Banner.vue
                                                                    100 s -> 25 s, exit 2
  Error: component harness failed before it became ready: the dev server answered
  http://localhost:5173/@fs/…/@n8n/design-system/src/components/N8nIcon/icons.ts with 500: …
  ../@n8n/design-system/src/components/N8nIcon/icons.ts imports "~icons/lucide/align-right", a module in
  the `~icons/` virtual namespace: … This repository declares unplugin-icons, …
  (`--explain-props` still exits 0: the `~icons/` edge lives in an unbuilt workspace sibling the
  preflight walk does not enter, which is M130 F7's change. C7 fires on every edge the walk reaches.)

uptime-kuma E:/repositories-run7/uptime-kuma  src/components/Tag.vue  93 s -> 4 s, exit 2
  Error: component harness failed before it became ready: the dev server answered
  http://localhost:5174/src/components/Tag.vue?vue&type=style&index=0&scoped=1b13cba6&lang.scss with 500: …
  src/components/Tag.vue needs a CSS preprocessor this project pins below what the dev server calls:
  Vite asks for compileStringAsync(), and sass 1.42.1 is installed and does not define it. Install
  sass 1.45.0 or newer where the measured package resolves it: npm install -D sass@latest. Or pass
  --no-css to measure without the stylesheet.

scaffold-next-pages  E:/repositories-run7/scaffold-next-pages  pages/index.tsx
  --explain-props: exit 0 -> exit 2 in 1 s; real run: exit 2 in 1 s; the two texts diff clean.
  Error: Cannot measure this component in a browser: pages/index.tsx imports next/font/google, a
  Next.js build-time module that 120fps does not shim and has decided never to shim: …
    pages/index.tsx → next/font/google

plane      E:/repositories-run6/plane/apps/web  core/components/rich-filters/filter-item/loader.tsx
                                                                    47 s -> 23 s, exit 0, Result: PASS

epic-stack (control)  E:/repositories-run5/epic-stack  app/components/ui/label.tsx
                                                                    25 s -> 25 s, exit 0, Result: PASS
  Same line count and the same warning set as the baseline log, except the machine-noise line, which
  measures the machine rather than the code.
```

## Deferred

- **n8n's dry run.** C7 refuses every virtual-namespace edge the preflight walk reaches. n8n's
  `~icons/` import lives in `@n8n/design-system`, an unbuilt workspace sibling the walk does not
  enter, so n8n's `--explain-props` still exits 0 while the real run refuses at 25 s on the module
  response instead. M130 F7 is the change that lets the walk see that edge; nothing in this
  milestone can reach it.
- **A module response error and `drain().fatal`.** C2 arms the readiness fatal only. The per-combo
  `fatal` flag stays what an uncaught exception sets, so no measurement's meaning changes.

- **The exit-code taxonomy.** The findings leave the meaning of exit 1 and exit 2 as it stands
  (M59 is explicit, and the JSON already carries `renderHealth`); M133 rewords the help text only.
- **plane's real stylesheet holder.** F5 fixes which sheet the diagnosis may name; it does not
  identify what actually held plane's page. That needs its own measurement.
- **Unifying the four navigation call sites behind one helper.** C5 gives them the same bound and the
  same note; folding them into one function crosses into lanes C and F.
- **uptime-kuma's own fix.** C8 diagnoses the stale sass; upgrading the project's sass is the
  developer's action, and 120fps never edits a target repository.
- **A per-phase wall-clock bound.** The readiness bound governs one wait; a bound on the whole run is
  a separate contract with its own failure mode.
