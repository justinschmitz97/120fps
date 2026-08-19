---
kind: overview
status: approved
---

## Objective
`npx 120fps ./Button.tsx` (or `./Button.vue`) → real-browser performance report. Zero config. No manual scenarios.

## Pipeline
1. **Prop extraction**: TS Compiler API (Bundler moduleResolution) → props interface → value generation. Recursively unwraps HOC chains (forwardRef/memo). Handles class components via heritage clause. A `.vue` SFC's `<script setup>` block is served to the same program as a virtual `<sfc>.ts` in the SFC's own directory, and `defineProps<T>()` / `withDefaults(…)` read from there. Cap 64 combos via stratified sampling.
2. **Harness build**: Vite bundles HTML page importing target component. A renderer adapter keyed on the measured file's extension supplies the entry's imports, mount/unmount bodies and `renderTree`: React (`entry.tsx`, `createRoot`) or Vue (`entry.ts`, `createApp` over a `shallowRef` props object, `rerender` awaiting `nextTick`). The project's own `vite.config` is never loaded (`configFile: false`); aliases come from tsconfig `paths` and the shim table. (auto-detects named/default/class/const export). Harness dir placed inside the project's member root (workspace-aware via `resolveProjectModel`'s `memberRoot`/`workspaceRoot`) for natural dependency resolution across a monorepo install. `scanExternalDeps` recursively follows imports (including tsconfig and shim aliases) from the component and the provider wrapper to pre-populate `optimizeDeps.include`; the list is unioned with the project's existing dep-cache metadata (`unionCachedDeps`) so it converges to a stable superset and repeat runs keep Vite's dependency cache valid. The dev server runs with `server.watch: null`: nothing edits files mid-run, and the watcher's initial scan of a real repo stalls the first navigation by ~9s. Global stylesheets (`--css`, evidence-driven auto-detection layering the project's entry import graph over filename candidates over a bounded largest-stylesheet fallback, `--no-css`) are injected as side-effect imports ahead of everything else, so the project's PostCSS/Tailwind toolchain runs against the harness page. Optional provider wrapper (`--wrap`, auto-detected `120fps.setup.tsx`) is imported before the component and wraps every render via the entry's `renderTree` helper, which also applies StrictMode inside the wrapper when the page is loaded with `?strict=1`. A project that declares `babel-plugin-react-compiler` is served through `@vitejs/plugin-react` carrying that compiler, resolved from the project itself, so compiled code is measured compiled. Auto-scale rendering: when props contain `__120fps_scaleN`, renders N instances inside one wrapper. Exposes `window.__120fps` control API.
3. **Browser**: Playwright headless Chromium. Fresh browser per measurement phase. Every session enters through the same preamble: wait for `window.__120fps`, apply the wrapper viewport, run the style/font settle gate, then 4× CPU throttle. Lifecycle measurement sessions (mount, rerender, isolation, calibration/wrapper-overhead) run under begin-frame control with a frame pump (M35): frames are driven on demand, so the double-rAF fences cost ~2ms instead of two 60Hz vsync ticks. Explore and react-analysis sessions keep vsync pacing; combos that animate are re-measured under vsync (`pacing` field per combo).
4. **Exploration loop**: Per prop combo: mount→trace, DOM walk→discover interactables, resolve stress pattern per interaction (pointer-drag, keyboard-sweep, hover-sweep, open-close-10, multi-keystroke, rapid-toggle-11, or single-shot), exercise each N=10→trace, deepen expensive paths (edge P95 > 1.5× global median edge cost), build state graph. Terminate: convergence / 200 nodes / per-combo wall clock. Run-level bounds: at most 8 combos (first, last, evenly spaced) and 300s total; skipped combos are reported, never silent.
5. **Metrics**: CDP traces → paint, layout shifts, style recalcs, long tasks, frame timing, scripting, DOM count, heap delta.
6. **Report**: Terminal table + JSON. Scaling curve analysis.

## Modules
| module | role |
|---|---|
| prop-gen | TS Compiler API prop extraction bound to a resolved *target* component (`findComponentPropsType` collects candidates: name, declaration, exported, isDefault, source order: then `selectTargetCandidate` picks default export > file-stem match > first exported, with a self-consistency guard against a wrong follow), `normalizeComponentName` (shared stem-matching rule, also used by `harness.ts`), Vue `defineProps`/`withDefaults` extraction over a virtual-script program (`findDefineProps`, `applyWithDefaults`, `VirtualScripts`), auto-scaling prop detection, array/object/tuple value synthesis (`synthesizeElement`, depth- and cycle-capped, degenerate-marking), process-lifetime program cache (`createCachedProgram` internally; `resetExtractionCache`, `extractionCacheStats` test hooks), fingerprint file set (`projectSourceFiles`), shared config discovery (`createCompilerOptions` resolving via project-model's `findCompilerConfig`, bounded by `findWorkspaceRoot` for a real project and unbounded for a bare temp tree, so alias construction and prop extraction agree on which `tsconfig.json`/`jsconfig.json` governs; `allowJs: true` so a `.jsx` target under a project with no config or one that excludes JS still extracts, M69) |
| prop-gen-values | Value generation, stratified sampling (cap `MAX_COMBINATIONS` 64, raw space via `countCombinationSpace`), pool de-duplication (`dedupeCombos`, applied before any cap), combo capping, delta pair generation (cap `MAX_DELTA_PAIRS` 128, full space via `countDeltaPairSpace`), scaling combo generation, typed array filling (`fillArray`), prop matrix generation and pairwise cover (`generatePropMatrix`, `pairwiseCover`, `shouldAutoActivateMatrix`), matrix cell capping (`selectMatrixCombos`, anchor cell first then ascending Hamming distance) |
| project-model | Two-level project model (M68): nearest-manifest `memberRoot` + install-governing `workspaceRoot` (`resolveProjectModel`, `findWorkspaceRoot` walking upward from `memberRoot`, first `pnpm-workspace.yaml`/`workspaces`-field manifest/lockfile (`WORKSPACE_LOCKFILES`) wins, bounded to stop after a `.git`-holding ancestor, no hit → `memberRoot`), declared-vs-installed package presence (`declaredPackages`, `isPackageDeclared` (either root's manifest), `isPackageAvailable` (declared, or a `<level>/node_modules/<pkg>/package.json` probe via `workspaceLevels` from `memberRoot` up to `workspaceRoot`, deliberately not `require.resolve`)), shared tsconfig/jsconfig discovery (`findCompilerConfig`, walks upward bounded by an optional stop dir, forward-slashed absolute result, M69), Yarn PnP detection (`detectPnP`: `.pnp.cjs`/`.pnp.loader.mjs` at `workspaceRoot` or `process.versions.pnp`, M72), `findProjectRoot` (moved here from `harness.ts`, re-exported), `readProjectManifest` |
| harness | Vite harness builder, dev server, renderer adapter (`rendererFor`, `generateEntry` dispatching `generateVueEntry`/React, `vueRenderTreeHelper`, `vueComponentName`, SFC component check `sfcProducesComponent` + `SFC_NO_COMPONENT`), entry generation (`generateEntry`, `generateComposedEntry`), `detectComponentExport` (default export > stem match via `normalizeComponentName` > first exported, or an explicit `#ExportName` target that wins outright or fails naming the file's exports), scale export detection, auto-dep scanning (`scanExternalDeps`, recording a shim-alias-resolved bare specifier as imported via `resolveLocalImport`'s `viaShimAlias`), shim aliases tagged `isShim: true` (`buildShimAliases`, `SHIM_MODULES` now 10 entries incl. `next/script`/`next/head`/`next/router`/`next/font/local`, unshimmed-`next/*` disclosure via `unshimmedNextModules` + `UNSUPPORTED_NEXT_MODULE_WARNING`, M73), tsconfig/jsconfig alias loading (`loadTsconfigAliases`, config resolved via project-model's `findCompilerConfig` bounded by `findWorkspaceRoot`, `baseUrl`-only fallback, wildcard-shape and stale-alias warnings via `ALIAS_SHAPE_WARNING`/`BROKEN_ALIAS_WARNING`, M69), dev-server file-access allowlist (`fsAllowDirs`, cross-drive `extraDirs`), auto-scale rendering, provider wrapper resolution (`detectWrapper`), evidence-driven stylesheet discovery and injection (`discoverGlobalCss` layering the entry import graph (`findProjectEntry` + `entryStylesheetImports`, tsconfig-alias- and preprocessor-aware) over the filename-candidate layer (`detectGlobalCss`, extended `GLOBAL_CSS_CANDIDATES`) over a bounded `largestStylesheet` fallback, `validateCssFiles`, `cssImportSpecifier`, `cssImportBlock`, warnings `CSS_IMPORT_SKIPPED_WARNING`/`CSS_PREPROCESSOR_MISSING_WARNING`/`CSS_FALLBACK_WARNING`/`CSS_DROPPED_WARNING`, M71), style tooling resolution decoupled from whether a stylesheet was found (`resolveStyleTooling`: `detectTailwindVite`, `loadTailwindVitePlugin`, unreplicated-engine disclosure `detectUnsupportedStyleEngines` + `UNSUPPORTED_STYLE_ENGINE_WARNING`, workspace-inherited PostCSS config `findPostcssConfigAbove`), vite.config static-text data recovery (`readViteConfigData`: `publicDir`, `resolve.alias`, ignored-key disclosure via `VITE_CONFIG_IGNORED_WARNING`; never executed), browser `process.env` defines (`readEnvDefines`, `parseEnvFile`, `ENV_DEFINE_PREFIXES` `NEXT_PUBLIC_`/`VITE_` only), dep-cache-stable optimize list (`unionCachedDeps`), sweep server pool (`createServerPool`, `SWEEP_DEP_WARNING`, `HarnessResult.warnings`), React Compiler detection and transform (`detectReactCompiler`, `resolveReactCompiler`, `resolveReactCompilerState`, `loadReactCompilerPlugin`, `reactCompilerRuntimeDeps`), stale-dir hygiene (`sweepStaleHarnessDirs` for in-project `.120fps-harness-*`, `sweepStaleTmpDirs` for OS-tmp `120fps-*` leftovers older than 24h, run once per `createServerPool()`), dev-server start failure message (`VITE_START_FAILED`), harness-dir writability guard (`createHarnessDir`, `HARNESS_DIR_UNWRITABLE`, M73), React 18 boot gate (`assertReactDomClient`, `REACT_DOM_CLIENT_MISSING`, M73), cross-drive path handling (`isOutsideRoot`, `componentImportPath` routing an out-of-root component through `/@fs/`, `resolveWrapper`'s cross-drive rejection, M73) |
| discovery | DOM walker, ARIA pattern recognizer, portal probing |
| explorer | Exploration loop, state graph builder, run-level budget (`selectExploreCombos`, `EXPLORE_BUDGET_WARNING`) |
| measure | CDP trace capture, component DOM counting (`countComponentNodes`), session recovery (`CdpHolder`, `refreshCdpSession`, `withContextRetry`: retry-budget exhaustion raises `RETRY_BUDGET_EXHAUSTED_NOTE`, naming the environment over the component), inter-sample throttle suspension (`suspendThrottle`), driven frame pacing (`MEASUREMENT_BROWSER_ARGS`, `createFramePump`, `openMeasurementSession`, `rafFence` watchdog, per-combo `pacing`, vsync fallback for animated combos), mount/unmount/rerender measurement, shared session preamble (`enterHarness`, `runHarnessSession`), page actions (`mountAndWait`, `mountAndTrace`, `rerenderAndTrace`), wrapper overhead pass (`measureWrapperOverhead`), wrapper viewport application (`applyWrapperViewport`), style/font settle gate (`needsStyleSettle`, `settleStyles`, `HARNESS_NAV_WAIT`), settle-gate warning reporting (`reportFontSettle(settled, onWarning?)`, the one place `FONT_SETTLE_WARNING` is raised from, threaded through `enterHarness`'s and its callers' `onWarning`, M70), animation detection, GC, per-combo warmup planning (`warmupsForPosition`), median and type-7 P95 utilities |
| metrics | Full CDP metric extraction, INP, calibration, cost attribution (`attributeCost(traces: TraceEvent[] | TraceEvent[][])`: one window or a combo's per-sample windows, `buckets[].durationMs` the mean per window, `sampleCount`/`totalScriptingMs` on the result; `resolveSource` attributes from the LAST `node_modules/` segment so a pnpm store path (`node_modules/.pnpm/pkg@1.2.3/node_modules/pkg/...`) attributes to `pkg`, M67), scaling-curve fit and superlinear-promotion gates (`computeScalingCurve`, `growthExponent`, `SUPERLINEAR_MIN_EXPONENT`, `SUPERLINEAR_RESIDUAL_SHARE`, `isSuperlinearGrowth`) |
| report | Types (PropDelta, TimingWithCV, ComboReport incl. `inp?`/`scaleProbe?`/`pageErrors?`/`renderHealth?`, Report incl. `mode?`/`providerCandidates?`, ComponentTier, TierBudget, CostAttribution, CostBucket, CurveViolation, WrapperReport, CssReport, ReactCompilerReport, EnvFingerprint incl. `framework`, EnvMatch), sample-stddev CV, tier classification (`classifyTier`: portal/animation is a floor of T3, `max(sizeTier, T3)`, never an override), verdict logic, curve verdict + violation (`evaluateCurve`, `formatCurveViolation`), `ReportMode`/`deriveReportMode`, default thresholds, tier budgets, wrapper block + warnings (`attachWrapperReport`), terminal table formatting |
| stress-patterns | Stress pattern dispatch (including pointer-drag), step execution, ARIA sibling detection, drag target detection |
| composition | Auto-composition inference: prefix grouping, suffix taxonomy, template selection, trial-mount rollback (`shouldRollbackComposition`) |
| analyze | Full pipeline orchestrator (analyze, buildReport), fixture detection (isFixturePath, detectFixture, hasScaleExport), wrapper resolution (resolveWrapPath), workspace-aware fingerprint sources (`projectConfigFingerprintFiles(memberRoot, workspaceRoot?)`: tooling configs and lockfiles probed at the member root then the workspace root, so a root lockfile bump invalidates a member's baseline, M68), auto-scale combo appending for raw components, sample throttling shared by the combo and forced-matrix paths and their late re-measurements (`computeEffectiveSamples`, recorded in the environment fingerprint), truncation/notice disclosures (`STRATIFIED_SAMPLE_WARNING`, `DELTA_PAIR_CAP_WARNING`, `MATRIX_PAIRWISE_COVER_WARNING`, `MATRIX_AUTO_ACTIVATED_NOTICE`, `EFFECTIVE_SAMPLES_WARNING`) |
| cli | Entry point, arg parsing, exit codes, path expansion (`expandComponentPaths`, `isComponentFile`), root-shape-agnostic glob matching (`globToRegExp`/`globRoot`, the walked path normalized relative to `process.cwd()` before testing so an absolute or a relative `PathReader.walk` result matches alike, M67), report path resolution (`resolveReportPaths`, case-folded collision key so `Card.tsx`/`card.tsx` reports never overwrite each other on a case-insensitive filesystem, M67), Node version floor (`nodeVersionError`, `MIN_NODE_MAJOR` 22, checked in `main()` before `parseArgs`, exit 2, M72) |
| react-profiler | Framework detection (`detectFramework`, member manifest decides whenever it names a framework, else falls back to the workspace manifest and then the install probe; fails closed to `vanilla` plus `FRAMEWORK_MANIFEST_UNREADABLE` on an unreadable manifest; `SOLID_AND_REACT_DECLARED` warning when both are declared, M68/M72), react-dom identity and version guards before opening a browser (`resolveReactDomIdentity` via `createRequire(harnessDir)`, `isSupportedReactDomVersion` 16.5–19.x, `REACT_DOM_NOT_REACT_WARNING`/`REACT_DOM_VERSION_RANGE_WARNING`, empty result map with no browser launch on a non-react-dom identity, M72), DevTools hook injection, profiler snapshot capture, memo/context/callback analysis, portal hygiene |
| budget | Budget config loading with schema validation (`validateBudgetConfig`: numeric fields must be finite ≥ 0, unknown keys allowed) and workspace-aware resolution (`loadBudgetConfig` reads `120fps.config.json` from the member root, falling back to `workspaceRoot`; a member config still wins; baselines stay keyed at the member root alone, M68), baseline I/O (`BaselineMetrics`), regression comparison, tolerance resolution, environment fingerprint (`buildEnvFingerprint`, `classifyEnv`, `describeEnvDiff`, `envAdvisory`), source fingerprint (`computeSourceFingerprint`, `BaselineEntry.sourceFingerprint`/`pass`) |
| page-errors | Browser page-error capture (pageerror + console errors, plus M70 network-failure capture — `requestfailed` and `response` ≥400 feeding the same buckets, neither setting `segmentFatal`: a 404 or a 500 is not proof a render crashed) deduped by message (`message (×N)`, cap 20 distinct), per-combo drains (`drain()` → `{ messages, fatal, dropped }`, a segment reset per combo alongside the unchanged session-wide `errors`/`summary()`; `fatal` true only for an uncaught `pageerror`), navigation/timeout enrichment (`gotoWithErrorContext`, `enrichTimeoutError`), measurement-phase error context (`enrichPhaseError`, idempotent, phase/combo/component-prefixed) |
| isolation | Isolated measurement types, Vue strictmode refusal (`strictModeUnsupported`, `VUE_STRICTMODE_ERROR`), phase runners (`measureChurn`, `measureMemory`, `measureStrictMode`), phase orchestration (`runIsolationPhases`), combo selection, parity-aware churn degradation and dispersion (`churnParitySeries`, `buildChurnTiming`), memory leak detection, strictmode overhead, isolation verdict and baseline metrics, font-settle warning forwarding (`PhaseOptions.onWarning`/`IsolationRunOptions.onWarning`, `phaseSessionOptions` building each phase's `HarnessSessionOptions`, `runIsolationPhases` forwarding to all five measurement calls, M73) |
| preflight | Pre-harness import-graph walk (`runPreflight`, SFC-aware via an injected `vueCompiler`) for server-only/`use server`/async-component/Node-builtin hits, environment-level hard rejections checked once per run before the import-graph walk (M72: `"unsupported-framework"` when the project declares `solid-js` and neither `react` nor `react-dom`; `"yarn-pnp"` unconditionally via `detectPnP`, no mixed-repo exception), provider-hook detection (`PreflightResult.providers`: known provider-library imports plus local modules shaped like `createContext(` + `throw new Error`; `PROVIDER_LIBRARIES` now ten packages, M72 adding react-router/react-router-dom/@remix-run/react/gatsby/@tanstack/react-router/@tanstack/react-start; detection alone is silent, surfaced as `Report.providerCandidates` only when a render actually failed), project-transform recognition (`recognizeTransform`, `TRANSFORM_RECOGNIZERS`), dead-entry removal (`next/server-only` dropped from `SERVER_ONLY_PACKAGES`: never a real module, M72), failure and warning text (`preflightFailureMessage` reading a per-kind `HARD_REMEDY` table, `NODE_BUILTIN_WARNING`, `PROJECT_TRANSFORM_WARNING`, `PREFLIGHT_BYPASSED_WARNING`) |
| prop-presets | `<stem>.props.tsx\|ts` detection and loading (`detectPropPresets`, `loadPropPresets`), AST-literal value transport with `PresetRef` for non-literals, application to schemas (`applyPropPresets`), unknown-prop warning (`UNKNOWN_PRESET_PROPS_WARNING`) |
| noise | Machine-noise probing (`probeMachineNoise`, `NOISE_PROBE_SAMPLES`), run-level classification (`classifyNoise` → quiet/noisy/hostile), noise report assembly (`buildNoiseReport`), run warnings (`NOISY_RUN_WARNING`, `HOSTILE_RUN_WARNING`) |
| compare | `--compare` interleaved A/B measurement (`compareAgainstRef`) via a git worktree reference side, per-level `node_modules` linking from the repo root down to the measured workspace member (`nodeModulesLinkDirs`, `linkNodeModules`, so a pnpm workspace member's own `react`/`vue` resolves on the reference side too, M68), stale-worktree pruning before `git worktree add` (`pruneStaleWorktrees`, best-effort `git worktree prune`, clears a registration a hard-killed prior run left dangling, M70), sample-range comparison (`distinguishable`), option validation (`validateCompareOptions`), terminal formatting (`formatCompare`) |
| ci-report | Pure `Report` serializers for `--report-md` (`formatMarkdown`) and `--report-junit` (`formatJUnit`) |
| hints | Finding-to-remediation mapping (`HINTS`, `HintId`), per-report hint derivation (`hintsForReport`), terminal formatting (`formatHints`), measurement-basis line (`MEASUREMENT_BASIS_LINE`) |
| observers | Opt-in Event Timing / Long Animation Frame / layout-instability acquisition (`installObservers`, `beginObservedWindow`, `readObservedWindow`), slowest-interaction extraction (`observedInteractionMs`) |
| vue-sfc | Project-resolved SFC parser loading (`loadVueCompiler`, `VUE_SFC_SPECIFIERS`, `resetVueCompilerCache`), `<script setup>` extraction (`parseSfcScript`), virtual script naming (`virtualScriptPath`), `isVueFile`, `VUE_COMPILER_MISSING` |
| index | Barrel re-export of all public API |

## Stack
TypeScript, pnpm, Playwright, Vite, TS Compiler API, Node ≥22, vitest. React and Vue are peer/project concerns: neither runtime, nor `@vue/compiler-sfc`, nor `@vitejs/plugin-vue` ships with 120fps.

## Tests
Current suite: 3070 unit (1 POSIX-only case skipped on Windows) + 411 e2e (vitest; e2e drives real Chromium). Per-milestone "N new tests" notes below are historical; this line is the source of truth. Repo CI (`.github/workflows/ci.yml`, Node 22.x/24.x/26.x) runs `pnpm build` (tsc: type-checks and emits the `dist/shims` the nextjs-shim unit tests read) and the unit suite only: e2e is excluded there for the flakiness documented below. `pnpm test` and `pnpm test:unit` both run `vitest run test/unit/` (matching CI); `pnpm test:e2e` runs `vitest run test/e2e/`; `pnpm test:all` runs the full `vitest run`.

The e2e suite is flaky under full-suite parallelism: tests fail on contention (Vite's dep optimizer full-reloads mid-measurement, destroying the execution context; harness-building `beforeAll` hooks exceed their 10s budget) and every one of them passes in isolation. The failing set and the count both vary run to run, and the count tracks machine state more than code: paired runs of the same commit range from 3 to 7 failures. The count is also sensitive to how much work the suite carries: M57's own e2e file at 55s of browser time put the run at 11 failures against 3 with the file excluded, and trimming it to 37s brought the run back to 4: a new e2e file's wall time is a real cost to every other file. M30's context retry costs some of this, trading suite noise for single-component runs that survive the reload; a paired measurement put this tree at 12 against 7 for the commit before it. Files sharing a fixture project root also share `node_modules/.vite`, which is the main trigger; a per-harness `cacheDir` was tried and is worse, because losing dep reuse slows cold start enough to cause more reloads than it prevents. Unresolved.

vitest exports `NODE_PATH` into pnpm's hoisted store, so every installed package resolves from every directory inside a test process. Tests that assert a *failed* package resolution use `withProductionResolution` (`test/node-resolution.ts`) for synchronous calls, or a half-installed package (a manifest with a `main` that does not exist) when the call is async. An async function whose resolution attempts all happen before its first `await`: `loadVueCompiler`, `extractProps` on a `.vue` file: can be wrapped by the call and awaited outside it.

## Milestones

### M1: harness + props (done)
Build harness from .tsx, serve via Vite, open in Playwright, extract props via TS Compiler API. See `specs/milestones/m1-harness-and-prop-extraction.md`. 89 tests.

### M2: mount/unmount measurement (done)
CDP trace capture during mount/unmount across prop combinations. 4× CPU throttle, N=10 samples, median + P95. Auto-mount removed; caller controls lifecycle. Warmup runs (default 2) for JIT stabilization. 30s traceComplete timeout. Empty-array guards on median/P95. See `specs/milestones/m2-mount-measurement.md`. 57 new tests (146 total).

### M3: interaction discovery (done)
**Goal**: Given a mounted component, walk the live DOM to find all interactive elements and categorize them.

**Builds on M2**: component is mounted with valid props, browser is open.

**Scope**:
- `discoverInteractions(page)`: single `page.evaluate()` DOM walk via TreeWalker
- Finds: buttons, inputs (all types), textareas, selects, links (`a[href]`), `summary`, `[contenteditable]`, ARIA `[role]` widgets, `[tabindex]` (not -1), elements with inline event handler attributes
- Recognizes ARIA widget patterns: accordion, tabs, menu, dialog, listbox, combobox, tree: annotates descriptors with `role` field
- Returns `InteractionDescriptor[]` with type (`click`|`type`|`select`|`focus`|`keyboard`|`hover`), CSS selector, tagName, label, optional role/inputType
- Deduplicates by element identity. Unique CSS selectors validated via `querySelector`.
- Traverses open shadow DOM. Skips `display:none`, `visibility:hidden`, `aria-hidden="true"`, `input[type=hidden]`.
- Deterministic: same DOM → same descriptors in document order.
- New module: `src/discovery.ts`. See `specs/milestones/m3-interaction-discovery.md`. 31 new tests (177 total).

**Does NOT include**: actually exercising the interactions (M4) or measuring them (M5).

### M4: exploration loop (done)
**Goal**: Adaptive exploration that exercises discovered interactions, tracks state changes, and deepens into expensive paths.

**Builds on M3**: `InteractionDescriptor[]` from discovery. M2's trace capture for measurement.

**Scope**:
- `explore(harness, options?)` → `ExploreResult[]` (one per prop combo), each containing a `StateGraph`, `comboIndex`, and `props`
- For each prop combo × each discovered interaction: exercise N=10 times, capture CDP trace (independent samples via remount+replay)
- After each interaction: DOM hash via FNV-1a of `#root` innerHTML → detect state change
- Build `StateGraph`: nodes = unique DOM states (by hash), edges = interactions with cost (median, P95, raw traces)
- Adaptive deepening: if edge P95 > 1.5× global median edge cost, add follow-up interactions to priority queue front
- Convergence: binary info gain per exploration; stop when last 10 all yield no new nodes
- Hard limits: 200 nodes, 60s wall-clock, depth 4
- Seeded LCG PRNG (default seed 42) for deterministic interaction ordering
- Interaction exercise: Playwright API for standard selectors, `page.evaluate` fallback for shadow DOM (`>>>` selectors)
- Manages browser lifecycle internally (like `measureMount`)
- New module: `src/explorer.ts`. See `specs/milestones/m4-exploration-loop.md`. 33 new tests (210 total).

**Does NOT include**: full metric extraction (M5) or reporting (M6). M4 produces the state graph and raw traces.

### M5: full CDP metrics (done)
**Goal**: Parse raw CDP traces into the complete metric taxonomy. Scaling curve analysis.

**Builds on M4**: raw traces from mount + interaction exercises.

**Scope**:
- `parseMetrics(events, options?)` → `CdpMetrics` with paint/layout/style-recalc counts and durations, scripting duration, totalDuration (nested-event-aware), long tasks (>50ms), frame timing + jank/dropped frame counts, layout shift score, INP estimation
- `computeINP(traces)` → max interaction-to-next-paint latency across trace sets
- `computeScalingCurve(points)` → `{ slope, intercept, r2, growthClass }` via least-squares regression with automatic classification (constant/linear/quadratic/exponential/inconclusive): see the glossary `ScalingCurve` entry for the exact decision rule
- `createCalibrationTrace(page, cdp)` → baseline `CdpMetrics` from known-cost operation (1000-element DOM insert + forced layout)
- `linearRegression(points)` → `{ slope, intercept, r2 }` utility
- `parseTraceDuration` uses timestamp-based nesting stack to avoid double-counting child events in `totalDuration`; backward-compatible fallback for events without `ts` field
- `TraceEvent` extended with optional `ts` and `args` fields
- `filterToMarks` option for `parseMetrics` to scope metrics to `performance.mark` window (`__120fps_start`/`__120fps_end`)
- New module: `src/metrics.ts`. See `specs/milestones/m5-cdp-metrics.md`. 51 new tests (261 total).

**Does NOT include**: reporting format (M6).

### M6: CLI + reporting + calibration (done)
**Goal**: Ship the user-facing tool. Terminal output, JSON file, CLI entry point.

**Builds on M5**: full `Report` structure with all metrics.

**Scope**:
- `analyze(componentPath, options?) → Report`: full pipeline orchestrator (buildAndServe → calibration → measureMount → explore → report)
- CLI: `npx 120fps ./Component.tsx`: arg parsing (`--json`, `--ci`, `--samples`, `--threshold-mount`, `--threshold-interaction`, `--help`, `--version`), error handling, help text
- Terminal table: summary view (component name, machine summary, per-combo mount/unmount/DOM/interactions/scaling/verdict, top 3 slowest interactions per combo)
- JSON output: full `Report` object written to file (default: `120fps-report.json`), Map-to-object serialization
- Machine info: CPU model, cores, RAM, OS, Node version, Chromium version
- Calibration: `createCalibrationTrace` → normalize all timings as `relativeMount` / `relativeTiming` ratios
- CV: `computeCV(samples)` = stddev/|mean|×100; `TimingWithCV` extends `TimingResult` with `cv` + `unstable` (cv>15% AND stddev >0.5ms: M35's absolute noise floor)
- Verdicts: per-combo `pass`/`warn`/`fail` based on threshold checks + instability; `report.pass = no combo is "fail"`
- Exit code 1 on failure (all modes). `--ci` suppresses terminal table output. Exit 2 on usage errors.
- GC between samples (`HeapProfiler.collectGarbage`) called before each sample in measure + explorer. Heap delta via `Runtime.getHeapUsage` collected per combo in `measureMount()`. Scaling curve computed across combos with ≥2 distinct DOM sizes.
- New modules: `src/report.ts`, `src/analyze.ts`, `src/cli.ts`. See `specs/milestones/m6-cli-reporting.md`. 337 tests.

### M7: composed fixtures (done)
**Goal**: Support compound components (Accordion+Item+Trigger+Content) via user-authored fixture files that render a realistic composition.

**Builds on M6**: full pipeline.

**Scope**:
- Fixture detection: `*.fixture.tsx` input, `--fixture <path>` flag, or auto-detection of adjacent `<stem>.fixture.tsx`
- Fixture is a plain React file with a default export (no props, no 120fps imports)
- When fixture is used: skip prop extraction + combo generation, mount fixture scene as single combo `{}`
- Discovery + exploration + metrics run normally on the fixture's composed DOM
- `--fixture` separates measurement target (fixture) from metadata source (component path)
- Report records `fixturePath` and `fixtureAutoDetected`
- Terminal hint when 0 interactions found and no fixture exists
- `isFixturePath()` and `detectFixture()` exported from `src/analyze.ts`
- See `specs/milestones/m7-composed-fixtures.md`. 42 new tests (379 total).

### M8: rerender measurement + parameterized scaling (done)
**Goal**: Measure prop-change rerender cost and scaling curves across parameterized item counts, closing the largest gap with production bench suites.

**Builds on M7**: fixture pipeline, full CDP metrics.

**Scope**:
- `measureRerender(harness, options?)`: CDP trace capture during `__120fps.rerender(newProps)`. Same N-sample, median/P95, CDP tracing, calibration, warmup as mount measurement. Opens own browser, iterates all combos.
- Per-combo rerender timing added to `ComboReport` as `rerender: TimingWithCV` (always present).
- Two rerender scenarios: (1) stable rerender (same props), (2) prop-change rerender (next combo's props; stored as `rerenderChange?: TimingWithCV` when >1 combo).
- Parameterized fixtures: fixture exports `scale(n: number) => JSX.Element` alongside `default`. Detection via `hasScaleExport()` regex with word boundary. Harness imports `scale` and dispatches via `__120fps_scaleN` prop.
- Default scale points: `[1, 5, 20, 50]`. Override via `--scale 1,10,100` CLI flag.
- Scaling curves computed for mount AND rerender across parameterized combos (`rerenderScalingCurve` on ComboReport).
- `--threshold-rerender <ms>` CLI flag (default: `DEFAULT_THRESHOLDS.rerenderMs`, currently 16ms). Rerender exceeding threshold → verdict `fail`.
- `Report.thresholds.rerenderMs`, `ComboReport.rerenderScalingCurve`.
- See `specs/milestones/m8-rerender-scaling.md`. 34 new tests (413 total).

**Does NOT include**: portal-aware discovery (M9), drag interactions, or controlled state transitions driven by external test scripts.

### M9: portal-aware discovery (done)
**Goal**: Discover and exercise interactive elements rendered into portals (document.body), covering modal, popover, select dropdown, and sheet components.

**Builds on M8**: full rerender + scaling pipeline.

**Scope**:
- `discoverInteractions(page, options?)` DOM walk extended to cover `document.body` (not just `#root`), filtering out framework internals (SCRIPT, STYLE, LINK, NOSCRIPT, Vite overlays).
- Always-open portals: body children outside `#root` walked automatically. Elements marked `portal: true`.
- Trigger-first discovery: triggers with `aria-haspopup` attribute are exercised (click/focus). After trigger, new body children are walked for portal content. 2-rAF fast path + 2s MutationObserver slow path.
- `DiscoverOptions`: `{ probePortals?: boolean; remount?: () => Promise<void> }`. Explorer passes `probePortals: true` and a remount callback for initial state discovery only.
- `InteractionDescriptor` extended with `portal?: boolean` and `triggeredBy?: string`.
- `InteractionReport` gains `portal?: boolean`. Terminal table shows `[portal]` suffix.
- See `specs/milestones/m9-portal-discovery.md`. 33 new tests (470 total: 321 unit + 149 e2e).

**Does NOT include**: drag/continuous pointer interactions (pointer drag sequences for sliders, color pickers). Hover-triggered portals (tooltips) require `aria-haspopup` on the trigger element to be probed.

### M10: interaction stress patterns (done)
**Goal**: Type-specific stress patterns dispatched by interaction type and ARIA role, exposing performance cliffs single-shot exercises miss.

**Builds on M9**: discovery categorizes descriptors with type and role.

**Scope**:
- New module `src/stress-patterns.ts`: `StressPattern`, `StressStep` types, `resolveStressPattern()` pure dispatch, `executeStressPattern()` runner, `findAriaGroupSiblings()`.
- Pattern library: rapid-toggle-11, keyboard-sweep, hover-sweep, open-close-10, multi-keystroke, single-shot (fallback).
- Sibling detection via ARIA container queries (`[role=tablist]`, `[role=listbox]`, etc.).
- Explorer integration: replaces single-shot exercise in trace capture.
- `StateEdge.stressPattern?` and `InteractionReport.stressPattern?` fields.
- Terminal table shows pattern name in parentheses after interaction label when not `"single-shot"`.
- Fallback: descriptors that match no pattern rule (neither drag, sweep, portal, type, nor click) get single-shot. Click descriptors always get rapid-toggle-11 (odd click count so binary toggles end opposite their initial state, preserving M4 state discovery).
- See `specs/milestones/m10-interaction-stress-patterns.md`. 50 new tests (520 total: 371 unit + 149 e2e).

**Does NOT include**: custom user-defined stress patterns or pattern configuration.

### M11: pairwise prop delta analysis (done)
**Goal**: Isolate per-prop cost by measuring pairwise deltas (flip one boolean/enum prop, hold the rest constant).

**Builds on M1** (prop extraction) and **M8** (rerender measurement).

**Scope**:
- `generateDeltaPairs(schemas)` in `prop-gen-values.ts`: boolean, union, optional-object pairs. Anchor combo = first resolved value for each prop.
- `DeltaPair` type: `{ propName, baseCombo, flipCombo, baseValue, flipValue }`.
- Cap 128 delta pairs. Priority: booleans first, then unions sorted by value count ascending, then optional objects.
- `PropDelta` type in `report.ts`: `{ propName, baseValue, flipValue, mountDelta, rerenderDelta }`.
- `Report.propDeltas?` top-level array sorted by |mountDelta| descending. Reuse already-measured combos.
- Terminal "Prop Deltas (top 5)" section after combo table: `propName: base → flip  mount +Xms  rerender +Xms`.
- `--no-deltas` CLI flag → `CliArgs.noDeltas`, `AnalyzeOptions.skipDeltas`.
- See `specs/milestones/m11-pairwise-prop-delta.md`. 29 new tests (549 total: 400 unit + 149 e2e).

**Does NOT include**: deltas for function, reactnode, or unknown-kind props.

### M12: auto-scaling prop detection (done)
**Goal**: Auto-detect count-like props (arrays, numeric props named count/size/length/items) and generate scaling sweeps without manual fixtures.

**Builds on M8** (scaling infrastructure) and **M1** (prop extraction).

**Scope**:
- `ScalingPropMatch` type and `detectScalingProps(schemas)` in `prop-gen.ts`: items-like array > plain array > named numeric > shorthand numeric priority.
- `generateScalingCombos(schemas, match, scalePoints)` in `prop-gen-values.ts`: anchor combo with scaling prop set to each scale point.
- `analyze()` integration: after normal measurement, detects scaling props, generates scaling combos, measures mount+rerender, computes scaling curves.
- Manual `scale()` export always takes precedence. Auto-detection skipped in fixture mode.
- `Report.autoScalingProp?`, `Report.autoScalingReason?`.
- `AnalyzeOptions.skipAutoScale`, `CliArgs.noAutoScale`, `--no-auto-scale` CLI flag.
- Terminal table shows `(auto: propName)` suffix on scaling column when auto-detected.
- See `specs/milestones/m12-auto-scaling-prop-detection.md`. 44 new tests (593 total: 444 unit + 149 e2e).

**Does NOT include**: auto-detection of composed/nested component scaling (requires fixture).

### M13: tiered budgets (done)
**Goal**: Auto-classify components into tiers (T1-T4) based on DOM complexity, portals, and animations, then apply tier-appropriate performance budgets calibrated for 4x CPU throttle.

**Builds on M6** (verdict logic), **M9** (portal flag), **M8** (scaling curve), **M14** (animation detection).

**Scope**:
- `ComponentTier` type, `TIER_BUDGETS` constant, `classifyTier()` pure function.
- T1 (≤10 DOM), T2 (≤40 DOM), T3 (portal/animation), T4 (>40 DOM). Calibrated for 4x CPU throttle + HTML attribute prop-diffing overhead. Per-tier mount/rerender/interaction budgets are `TIER_BUDGETS` in `report.ts` (see the glossary), which is the source of truth as those numbers get retuned.
- `computeVerdict` updated with tier-aware budgets. `ComboReport.tier?`, `Report.tieredBudgets?`.
- `--flat-thresholds` CLI fallback. Explicit `--threshold-*` flags partially override.
- See `specs/milestones/m13-tiered-budgets.md`. 55 new tests (648 total: 499 unit + 149 e2e).

**Does NOT include**: custom tier definitions.

### M14: animation detection (done)
**Goal**: Detect CSS animations and layout-affecting transitions in mounted components, replacing the `hasAnimation: false` placeholder from M13.

**Builds on M13** (tier classification with `hasAnimation` parameter), **M2** (mount measurement).

**Scope**:
- `detectAnimations(page)` in `src/measure.ts`: single `page.evaluate()` with three signals scoped to `#root`: Web Animations API (running animations), CSS `animation-name` declarations, layout-affecting CSS transitions (transform, opacity, height, width, max-height, max-width, all).
- `MountResult.hasAnimation?: boolean`. Detected on first sample per combo during `measureMount`.
- `buildReport()` reads `hasAnimation` from mount results, passes to `classifyTier()`.
- `ComboReport.hasAnimation?: boolean` set when tiered budgets active.
- `formatTable` shows `[anim]` suffix on verdict.
- Scoped to `#root` to avoid Vite overlay false positives. Portal animations outside `#root` excluded.
- See `specs/milestones/m14-animation-detection.md`. 39 new tests (687 total: 538 unit + 149 e2e).

**Does NOT include**: portal-rendered animations outside `#root`, hover-only transition detection override.

### M15: pointer drag stress pattern (done)
**Goal**: Add a `pointer-drag` stress pattern for sliders, color pickers, and drag-based components: the only genuine performance gap between 120fps and hand-written bench suites.

**Builds on M10** (stress pattern dispatch + execution), **M3** (interaction discovery).

**Scope**:
- New `pointer-drag` pattern in `src/stress-patterns.ts`: pointerdown → 60 pointermove events across element bounding box → pointerup via Playwright `page.mouse` API.
- `isDragTarget(descriptor)` detection: `role="slider"`, `input[type=range]`, `aria-valuenow` presence, cursor heuristic (grab/col-resize/row-resize). Highest dispatch priority.
- `InteractionDescriptor` extended with `ariaValueNow?: boolean`, `ariaOrientation?: string`, `cursor?: string`. Populated in all DOM walkers.
- `StressStep` extended with `"pointer-drag"` action, `moveCount?: number` (default 60), `direction?: "horizontal" | "vertical"`.
- `inferAriaRole` maps `role="slider"` → `"slider"`.
- Horizontal sweep by default, vertical when `aria-orientation="vertical"`.
- See `specs/milestones/m15-pointer-drag-stress.md`. 38 new tests (725 total: 576 unit + 149 e2e).

**Does NOT include**: HTML5 drag-and-drop (dragstart/dragover/drop), scroll/wheel events, touch-specific events.

### M16: cost attribution (done)
**Goal**: Attribute scripting time to source packages and user code by parsing CDP trace call stacks, replacing manual "render each layer in isolation" bench approaches.

**Builds on M5** (CDP traces with call stacks), **M6** (report structure).

**Scope**:
- `attributeCost(events: TraceEvent[])` → `CostAttribution` exported from `src/metrics.ts`. Parses `FunctionCall`, `EvaluateScript`, `v8.compile` trace events.
- `CostAttribution`: `{ buckets: CostBucket[], unattributed: number }`.
- `CostBucket`: `{ source: string, durationMs: number, percentage: number, category: "user" | "package" | "react" | "browser" }`.
- URL resolution pipeline: strip query params, resolve `/@fs/` prefix, extract package name from `node_modules/` (including Vite pre-bundled `.vite/deps/` with underscore-to-scope mapping), classify react/react-dom/scheduler/jsx-runtime as `"react"`, project-relative paths as `"user"`, chrome-internal/native as `"browser"`.
- Nesting-aware deduplication: parent span duration reduced by child spans to prevent double-counting.
- `MountResult.mountTraces?: TraceEvent[][]` preserves raw trace events from `measureMount`.
- `ComboReport.costAttribution?` populated by `buildReport()` from mount traces.
- `formatTable()` shows "Cost breakdown (mount)" section with top-3 buckets per combo (source, duration, percentage).
- `--no-attribution` CLI flag → `AnalyzeOptions.skipAttribution` → `BuildReportInput.skipAttribution`.
- See `specs/milestones/m16-cost-attribution.md`. 48 new tests (773 total: 624 unit + 149 e2e).

**Does NOT include**: source-map-based line-level attribution, interaction trace attribution (mount-only for v1).

### M17: auto-composition (done)
**Goal**: Automatically infer how multi-export composed components nest (Accordion+Item+Trigger+Content), eliminating fixture files for the vast majority of compound components.

**Builds on M1** (TS Compiler API export extraction), **M7** (fixture pipeline as fallback).

**Scope**:
- `inferComposition(exports, schemas)` → `CompositionTree | null` in new module `src/composition.ts`.
- Two-phase inference: (1) prefix grouping to find root (root must be prefix of ALL other exports, shortest wins, case-insensitive), (2) suffix taxonomy to infer nesting via 16 suffix patterns.
- Four composition templates: item-based (Accordion), list-based (Tabs), portal-based (Dialog), flat (RadioGroup). Template selection: `*List`/`*Group` → list-based, `*Item` without `*List` → item-based, `*Portal`/`*Overlay` → portal-based, otherwise → flat.
- `ExportInfo` type: `{ name: string, isDefault: boolean }`. `CompositionTree`: `{ root, structure, repeatNode?, repeatCount }`. `CompositionNode`: `{ component, props, children }`.
- `extractExports(filePath)` and `extractAllProps(filePath)` added to `prop-gen.ts` using TS Compiler API.
- `buildAndServe` accepts optional `{ composition: CompositionTree }` to generate composed harness entry.
- `analyze()` integration: after prop extraction, if >1 component export and no fixture, calls `inferComposition`. Composed scene treated like fixture (single combo `{}`).
- `--no-auto-compose` CLI flag → `AnalyzeOptions.skipAutoCompose`. Manual fixture always takes precedence.
- `Report.autoComposition?`, `Report.compositionTree?`.
- `compositionToJsx(tree)` exported from `harness.ts` for JSX generation.
- See `specs/milestones/m17-auto-composition.md`. 60 new tests (833 total: 684 unit + 149 e2e).

**Does NOT include**: cross-file composition inference, sub-component prop combo generation, library-specific hardcoding, Phase 3 trial mount with error recovery (deferred).

### M18: React optimization detection (done)
**Goal**: Auto-detect React-specific optimization issues (memo bailouts, context fan-out, callback identity pressure, portal orphans, per-component render attribution) via React DevTools profiler hook injection. Closes the ~30% gap with hand-written bench suites.

**Builds on M2** (mount measurement), **M5** (CDP traces), **M6** (report), **M8** (rerender).

**Scope**:
- Framework auto-detection: `detectFramework(projectRoot)` returns `"react"` iff `react`/`react-dom` is in the project package.json dependencies/devDependencies/peerDependencies (default `"react"` when unreadable). `--framework react|vanilla|auto` CLI flag (default: `auto`).
- React DevTools profiler hook injection via `Page.addScriptToEvaluateOnNewDocument`. `PROFILER_HOOK_SCRIPT` captures per-fiber render counts and durations per commit via `onCommitFiberRoot`. No external dependencies.
- Memo bailout detection: mount → rerender same props → snapshot A → rerender same props → snapshot B → `diffSnapshots` → `detectMemoBailouts` returns components that failed to bail out.
- Context fan-out detection: probe entry wraps component in `__120fpsContextProbe` synthetic context provider → `forceContextUpdate()` → diff fiber renders → `detectContextFanOut` returns components re-rendering on unrelated context changes.
- Callback identity detection: probe entry `rerenderWithStableCallbacks()` / `rerenderWithFreshCallbacks()` measures stable vs fresh function reference rerender cost delta per function prop. Only flagged when delta >0.5ms. Warning at >2ms.
- Portal hygiene: `countBodyOrphans(page)` counts body children outside `#root`, excluding framework internals. `computePortalOrphans(pre, post)` returns delta clamped to 0.
- Per-component render attribution: `computeRenderAttribution(snapshot, top)` → top-5 most expensive components by self duration.
- `ComboReport.reactOptimizations?` field with all findings. Terminal "React Optimizations" section after cost breakdown.
- Separate pass architecture: `runReactAnalysis(harness, options)` runs in its own browser session after the main pipeline. No overhead on mount/rerender/explore measurements.
- Informational only (warn, never fail on its own). `--no-react-analysis` to skip entirely.
- New module: `src/react-profiler.ts`. See `specs/milestones/m18-react-optimization-detection.md`. 99 new tests (932 total: 783 unit + 149 e2e).

**Does NOT include**: Vue/Svelte/Solid adapters, source-map-based line-level attribution, automatic injection of React.memo fixes.

### M19: Next.js shim layer (done)
**Goal**: Lightweight Vite aliases replacing Next.js modules (`next/image`, `next/link`, `next/navigation`, `next/dynamic`, `next-video/player`, etc.) with browser-compatible shims so components mount without a framework server.

**Builds on M1** (harness build), **M6** (CLI).

**Scope**:
- `SHIM_MODULES` constant mapping module specifiers to shim implementations. `buildShimAliases(projectRoot)` returns Vite resolve aliases.
- `detectNextJs(projectRoot)` checks for `next` in `package.json` dependencies.
- Shims preserve DOM structure and prop forwarding (profiling stand-ins, not polyfills).
- Auto-enabled when Next.js detected. `--no-shims` CLI flag to disable.
- `ShimEntry` type exported from `harness.ts`.
- See `specs/milestones/m19-nextjs-shim.md`. 30 new tests (962 total: 813 unit + 149 e2e).

**Does NOT include**: Remix/Gatsby/other meta-framework shims, server component emulation.

### M20: scaling curves (done)
**Goal**: Dedicated `--curve` mode that measures mount/rerender across scale points (1,3,5,10,20,50) and reports growth classification (constant/linear/quadratic/exponential/inconclusive) with R² fit quality.

**Builds on M8** (parameterized scaling), **M5** (scaling curve computation), **M12** (auto-scaling prop detection).

**Scope**:
- `--curve [prop:type]` CLI flag. Auto-detect scaling prop or explicit `prop:array|number`.
- `CurveReport` type with per-point timings, mount/rerender scaling curves, growth class.
- Curve mode runs instead of normal combo pipeline. Scale points: `[1,3,5,10,20,50]`.
- `Report.curveReport?` field. Terminal table shows per-point mount/rerender timings, regression line, growth class.
- `--no-curve` disables auto-activation. Mutually exclusive with `--matrix` and `--isolate`.
- See `specs/milestones/m20-scaling-curves.md`. 49 new tests (1011 total: 862 unit + 149 e2e).

**Does NOT include**: custom scale point lists in curve mode, multi-prop curve sweeps.

### M21: prop variation matrix (done)
**Goal**: `--matrix` mode measures mount/rerender for every individual prop value against a baseline combo, producing a cost matrix showing per-prop-value performance impact.

**Builds on M1** (prop extraction), **M11** (delta pairs), **M8** (rerender measurement).

**Scope**:
- `--matrix` CLI flag. Generates matrix combos: baseline + one combo per unique prop value.
- `MatrixReport` type with `MatrixCell[]` per-prop-value entries (mount/rerender timing, delta from baseline). Cells are a pure projection of `report.combos`, so a cell verdict and the run-level `pass` derive from one computation.
- `Report.matrixReport?` field. Terminal table shows prop×value cost matrix, with an `Interact` column and every failing cell printed alongside the hottest.
- `--no-matrix` disables auto-activation. Mutually exclusive with `--curve` and `--isolate`.
- See `specs/milestones/m21-prop-variation-matrix.md`. 86 unit tests + 4 e2e.

**Does NOT include**: cross-prop interaction effects, matrix mode for fixtures.

### M22: budget CI (done)
**Goal**: Persistent baselines and per-component budget configuration for CI regression detection. `--budget` mode saves/loads baselines and fails on regressions.

**Builds on M6** (CLI, report), **M13** (tiered budgets).

**Scope**:
- `120fps.config.json`: per-component budget overrides, default tolerances, component-specific tolerances.
- `120fps-baseline.json`: persistent per-component baselines (mount, rerender, interaction, unmount, domCount, tier, timestamp).
- `compareBaseline()` regression detection: mount±10%, rerender±15%, interaction±15%, unmount±20%. Unstable metrics (CV>15% with stddev above the 0.5ms floor: M35) get WARN not FAIL.
- `--save-baseline`, `--check`, `--budget` (shorthand for `--ci --check`), `--no-baseline` CLI flags.
- `Report.baseline?` field with regressions/improvements arrays.
- Budget resolution precedence: CLI flags > per-component config > defaults config > tier budgets.
- New module: `src/budget.ts`. See `specs/milestones/m22-budget-ci.md`. 64 new tests.

**Does NOT include**: baseline diffing across branches, GitHub PR comment integration.

### M23: isolated measurements (done)
**Goal**: Independent micro-benchmarks for each lifecycle phase (mount, rerender, unmount, memory, strictmode), comparable to hand-authored vitest bench suites.

**Builds on M8** (rerender), **M2** (mount), **M5** (CDP tracing), **M13** (tiered budgets).

**Scope**:
- `--isolate <phases>` CLI flag (comma-separated: mount, rerender, unmount, memory, strictmode, all).
- Mount isolation: mount-to-first-paint excluding unmount. Rerender isolation: stable (same props), prop-change, churn (10 cycles with degradation ratio).
- Memory stability: repeated mount/unmount cycles, heap growth per cycle, leak detection (>1KB/cycle).
- StrictMode comparison: interleaved normal/strict sampling, overhead percentage, `doubleInvokeClean` (≤110%).
- `--memory-cycles <N>` override (default 20). Mutually exclusive with `--curve` and `--matrix`.
- `Report.isolation?` field with per-phase results. New module: `src/isolation.ts`.
- Execution pipeline delivered by M28. See `specs/milestones/m23-isolated-measurements.md`.

**Does NOT include**: isolation modes combined with curve/matrix, concurrent phase execution, interaction measurement inside isolation mode.

### M24: debt remediation (done)
**Goal**: Fix audit debt; no new product features beyond the unfulfilled M22 multi-path promise.

**Scope**: tsconfig reading unified on the TS API (`extends`/JSONC in harness aliases); export detection unified on a shared AST walker (`scanExports`) with selection order default > file-stem match > first PascalCase export; `--no-isolate` wired (overrides `--isolate`); `detectFramework(projectRoot)` reads package.json; `src/page-errors.ts`: harness-init timeouts now carry captured page errors; silent degradations warn (tsconfig parse errors, unsupported baseline version, missing baseline interactions via `BaselineComparison.missingInteractions`, zero-props hint via `Report.warnings`); config/baseline resolved from nearest package.json root with repo-relative keys; stale `.120fps-harness-*` dirs swept after 1h; multi-component CLI paths per M22; packaging/docs sync. See `specs/milestones/m24-debt-remediation.md`.

M25–M29 shipped in the order **M26 → M29 → M25 → M27 → M28**: wrapper first (unblocks context-dependent components, creates the shared `renderTree` helper and `HarnessResult.component`), environment fingerprint second (so later timing shifts land classified, not silent), stylesheets third (its settle gate also covers wrapper-imported CSS), compiler fourth, isolation execution last (builds on `renderTree` and the fingerprint's `mode`).

### M26: provider wrapper (done)
**Goal**: Render the component inside a user-authored provider chain so context-dependent components mount at all.

**Scope**:
- `--wrap <path>` / `--no-wrap` CLI flags; `AnalyzeOptions.wrapPath` / `noWrap`; `resolveWrapPath()`. Auto-detection of `120fps.setup.{tsx,jsx,ts,js}` at the project root, reported as `Report.wrapper.autoDetected`.
- Wrapper module contract: default-exported `{ children }` component; import-time side effects (stylesheet imports, `data-theme`) supported; optional `viewport` export applied via `applyWrapperViewport()` in every measurement session. Non-callable or missing default export → clear `buildAndServe` error, not a page-error timeout.
- Entry templates unified on a single `renderTree` helper (one `root.render(` per template), on the normal, composed, and React-probe paths. Auto-scale fan-out is wrapped once, not per instance.
- `HarnessResult.component` carries component identity; `runReactAnalysis` reads it instead of regex-scraping the entry (the wrapper import would otherwise be mistaken for the component).
- `scanExternalDeps` runs from the wrapper too, with tsconfig + shim aliases, union feeding `optimizeDeps.include`.
- `measureWrapperOverhead()` + `__120fps.mountWrapperOnly()` measure wrapper-only mount cost and DOM node delta; `Report.wrapper`, `attachWrapperReport()` warnings, `formatTable` header line.
- See `specs/milestones/m26-provider-wrapper.md`.

**Does NOT include**: async wrapper setup (MSW/data seeding), per-combo wrappers, Storybook `preview.tsx` parsing. Wrapper-imported CSS and fonts are covered by M25's settle gate, which arms whenever a wrapper is active.

### M29: baseline environment fingerprint (done)
**Goal**: Persist the machine and configuration behind every baseline entry so a comparison states which comparison it is doing.

**Scope**:
- `EnvFingerprint` (`report.ts`) on `BaselineEntry.env`: CPU, cores, OS, Node, Chromium, effective `cpuThrottle`/`samples`, both calibration durations, `mode`, and the feature fields `css` / `wrapper` / `reactCompiler`. Entry-level `shape: 1` versions it independently of `Baseline.version`.
- `classifyEnv` → `identical` / `normalizable` / `incompatible` / `unknown`; `describeEnvDiff` renders the field-level mismatches; `envAdvisory` decides warning text and strict-mode failure. All pure.
- `compareBaseline` takes the current fingerprint as a fifth argument: `identical`/`unknown` compare raw, `normalizable` compares calibration-normalized with a 0.5 ms absolute floor, `incompatible` skips comparison without failing the run.
- `--baseline-env strict|normalize|ignore` (default `normalize`) → `AnalyzeOptions.baselineEnv`. `strict` fails the check on any non-`identical` classification; `ignore` restores pre-M29 raw comparison.
- `BaselineComparison.envMatch` / `envMismatches`; `formatBaselineSection` prints the environment line, the mismatch list, and a normalized-ratio block.
- Producers: `wrapper` from `Report.wrapper.path` (M26), `css` from `Report.css.files` (M25). `reactCompiler` (M27) and `mode: "isolation"` (M28) are declared and wired by those milestones.
- Baselines without `env` keep working through the `unknown` path. See `specs/milestones/m29-baseline-environment.md`.

**Does NOT include**: accurate cross-machine comparison, per-branch baseline history, tolerance retuning, separate script-duration normalization.

### M25: stylesheet injection (done)
**Goal**: Measure components against the stylesheet they actually ship with, and stop the first sample from absorbing style and font application cost.

**Scope**:
- `--css <path,...>` / `--no-css` CLI flags; `AnalyzeOptions.cssFiles` / `noCss`; `resolveCssFiles()`. Auto-detection via `detectGlobalCss(projectRoot)` over eight conventional paths, first file hit wins, at most one file. Explicit paths resolve against `process.cwd()`, dedupe, and suppress detection; `--no-css` wins over both.
- Injection as side-effect imports at the top of the generated entry: before the React, wrapper, and component imports: on the normal and composed paths (`cssImportBlock`, `cssImportSpecifier`). Root-absolute form inside `projectRoot`, `/@fs/` outside it. `index.html` untouched. `HarnessResult.cssFiles`.
- CSS toolchain: the project's own `postcss.config.*` runs because Vite's `root` is `projectRoot` (verified against `@tailwindcss/postcss`); `process.cwd()` is never changed. `@tailwindcss/vite` is loaded from the project's `node_modules` when listed and injection is active, with a single stderr warning on failure. A stylesheet that fails to compile reaches the user as a PostCSS message through the page-error capture: the harness runs with `server.hmr.overlay: false` so Vite logs the failure instead of rendering it into the DOM.
- Settle gate: `settleStyles(page, harness)` awaits `document.fonts.ready` bounded by 5000 ms, then one forced layout and two rAF ticks. Armed by `needsStyleSettle` when stylesheets are injected **or** a provider wrapper is active. One implementation, five call sites (`analyze`, `measureMount`, `measureRerender`, `explore`, `runReactAnalysis`), each after `applyWrapperViewport` and before CPU throttling. A font timeout appends `FONT_SETTLE_WARNING` to `Report.warnings` and continues.
- All harness navigations use `waitUntil: HARNESS_NAV_WAIT` (`"domcontentloaded"`); readiness is `window.__120fps`, not the `load` event, which a stalled webfont blocks indefinitely.
- `Report.css` (`{ files, autoDetected }`, projectRoot-relative posix) on the combo, curve, and matrix paths; `formatTable` header line; the same list wired into `EnvFingerprint.css` (M29), omitted when nothing was injected.
- See `specs/milestones/m25-stylesheet-injection.md`.

**Does NOT include**: theme selection, glob patterns in `--css`, CSS injection into the React probe entry, retuned tier budgets.

### M27: React Compiler awareness (done)
**Goal**: Measure a project that ships React Compiler output as it ships, and stop reporting the memoization it does automatically as a defect.

**Scope**:
- `detectReactCompiler(projectRoot)`: `babel-plugin-react-compiler` in `dependencies`/`devDependencies`/`peerDependencies`. Package presence is the only signal; `next.config.*` is never parsed.
- `resolveReactCompiler(projectRoot)` resolves the plugin through the *project's* `createRequire`, with the version read by walking up from the resolved entry. `resolveReactCompilerState()` folds detection, the flag, and resolution into `{ detected, active, version?, pluginPath?, warning? }` on `HarnessResult.reactCompiler`, carrying at most one warning.
- When active, `buildAndServe` appends `@vitejs/plugin-react` (a 120fps dependency, `^4.7.0`) configured with `babel.plugins: [[compilerPath, {}]]`, and adds `react/compiler-runtime` to `optimizeDeps.include` when the project resolves it. The plugin is present if and only if the transform is active; M25's `@tailwindcss/vite` keeps its place ahead of it.
- `--react-compiler` / `--no-react-compiler` → `AnalyzeOptions.reactCompiler` (`undefined` = auto-detect, `--no-` wins). Forced on with nothing resolvable fails the run with `babel-plugin-react-compiler not found in <projectRoot>` before any harness directory exists; auto-detected but unresolvable warns once on stderr, lands in `Report.warnings`, and measures uncompiled.
- `ReactOptimizations.compilerActive` is set on every combo result when the transform ran. `hasReactWarning` then ignores `memoBailout` alone; `contextFanOut`, `portalOrphans` and callback identity keep warning, and the bailing components print as informational.
- `Report.reactCompiler` (`{ active, detected, version? }`), a `React Compiler: active (v…)` header line, the disabled-by-flag warning, and `EnvFingerprint.reactCompiler: true` on save (omitted otherwise, so pre-M27 baselines stay comparable).
- See `specs/milestones/m27-react-compiler.md`.

**Does NOT include**: enabling the compiler for projects that do not use it, compiler diagnostics, `panicThreshold` or other compiler options, a compiled-vs-uncompiled comparison mode, babel for anything else.

### M28: isolation execution pipeline (done)
**Goal**: Complete M23: make `--isolate` measure.

**Scope**:
- Phase runners in `src/isolation.ts`: `measureChurn` (untimed mount, then 10 traced A→B→A alternations, no GC between them), `measureMemory` (10 warmup cycles → GC → heap → N cycles → GC → heap, with `gcPressure` sampled every 5 cycles), `measureStrictMode` (interleaved normal/strict pairs, re-navigating to `?strict=1` and back). `runIsolationPhases` orchestrates them plus `measureMount` (one pass serving both mount and unmount, `warmupRuns: 3`) and `measureRerender` over the selected combos.
- `measure.ts` gains the shared session preamble `enterHarness` (navigate → readiness gate → wrapper viewport → settle gate → CPU throttle) and `runHarnessSession`, now used by `measureMount`, `measureRerender` and every isolation pass, plus the page actions `mountAndWait`, `mountAndTrace`, `rerenderAndTrace`. `tryCollectGarbage` returns whether the CDP call succeeded.
- Both measurement entry templates read a `strict` query parameter and apply it inside `renderTree`, nesting StrictMode *inside* the provider wrapper. `renderTreeHelper(wrapRelative, strict?)` keeps the probe entry unchanged.
- `analyze()` branches on `options.isolation` after calibration and before the curve decision, runs no standard-pipeline stage, and returns a report with `combos: []` and `Report.isolation` populated. Verdict fails on mount over budget, `leakSuspected`, or `churnDegradation > 2.0`; `doubleInvokeClean: false` only warns.
- `parseIsolationPhases` is the CLI's single validator: `all` expands anywhere in the list, phases dedupe into canonical order, an empty list is a usage error.
- `--check`/`--save-baseline` hoisted into `applyBaselineWorkflow`, shared by the combo and isolation paths; isolation saves `mount`/stable `rerender`/`unmount`, `domNodeCount`, an empty interactions map, and `EnvFingerprint.mode: "isolation"`.
- `formatTable` renders `report.warnings` in all four output modes, not only the combo branch.
- `leakSuspected` raised from 1KB to 8KB/cycle with the memory phase warming up 10 cycles: the old threshold sat inside the measurement noise floor.
- `reactJsxRuntimeDeps` declares the automatic JSX runtime in `optimizeDeps.include`, removing a Vite full-reload race on the first measurement of a project.
- See `specs/milestones/m28-isolation-execution.md`.

**Does NOT include**: interaction measurement inside isolation mode, concurrent phase execution, isolation combined with curve/matrix, retuned tier budgets.

### M30: dogfooding remediation (done)
**Goal**: Fix the six defects that running 0.2.1 against six real React repos exposed.

**Scope**:
- `createServer` passes `configFile: false`. The target's own `vite.config` is never loaded: its plugins target its own Vite major (a rolldown `@vitejs/plugin-react` inside Vite 6 fails every transform with `Missing field 'moduleType'`), and its `server` options are not measurement-safe. Aliases keep coming from tsconfig `paths` and the shim table.
- `PropSchema.elementTemplate`: array props are generated from their element type via `synthesizeElement` (depth-capped at 3, unions take the first member, callables and property-less objects fall back to the string element). `fillArray` clones per element so each has its own identity. Used by `generateScalingCombos` and `resolveBaseValues`.
- `isDomFlat` + `SCALING_NO_EFFECT_WARNING`: a sweep whose DOM node count never changes sets `ScalingCurveReport.domFlat` and warns instead of presenting a growth class. Verdicts are untouched.
- Composition trial mount: `analyze` mounts the inferred scene once before calibration; zero elements inside `#root`, or a throw, rolls the harness back to the bare export, appends `COMPOSITION_EMPTY_WARNING`, and leaves `autoComposition`/`compositionTree` unset. The suffix taxonomy is unchanged.
- `explore` gains `totalWallClockMs` (300s) and `maxCombos` (8) with `selectExploreCombos` picking first, last and evenly spaced interior indices; skipped combos surface as `EXPLORE_BUDGET_WARNING`. Bounds exploration only, not the mount and rerender passes.
- Interaction budgets are per step: `InteractionReport.steps` carries `StressPattern.steps.length`, and `computeVerdict` compares `median / steps` against `interactionMs / REFERENCE_STEPS` (11, the step count of `rapid-toggle-11`, which the budgets were calibrated against). `timing.median` stays the aggregate; the table prints both.
- `isContextLostError` + `withContextRetry` re-enter the harness and retry once when the dependency optimizer reloads the page mid-sample, in `measureMount`, `measureRerender` and all three unprotected spots in `explore` (initial state, sample capture, state navigation). Retries are bounded per pass by a `RetryBudget` (default 2) so a broken environment fails fast instead of starving the machine; a consumed retry appends `CONTEXT_RETRY_WARNING`.
- See `specs/milestones/m30-dogfooding-remediation.md`.

**Does NOT include**: scoping `domNodeCount` to the component subtree, capping measured combos, library-specific composition knowledge, object-prop synthesis.

### M31: measurement semantics (done)
**Goal**: Fix the two numbers the whole report rests on.

**Scope**:
- `countComponentNodes(page)` replaces `document.querySelectorAll("*")` at all three call sites: elements inside `#root` plus every non-internal body child outside it, so portal DOM counts and the ~8 element chrome floor does not. Tier boundaries stay 10/40 and now count component nodes, which shifts small components a tier down.
- The standard pipeline's silent `slice(0, 16)` becomes a disclosed cap: `DEFAULT_MEASURED_COMBOS` (8), `--max-combos <n>`, representative selection via `selectRepresentativeCombos` (first, last, evenly spaced), and `COMBO_CAP_WARNING`. Curve, matrix and scaling combos are untouched.
- `EnvFingerprint.metrics` (`METRICS_REVISION` 2) makes a pre-M31 baseline `incompatible` rather than silently comparable. `shape` keeps its M29 field-versioning meaning; overloading it was tried and reverted.
- See `specs/milestones/m31-measurement-semantics.md`.

### M32: developer experience (done)
**Goal**: Remove the three frictions the dogfooding runs hit before any measurement started.

**Scope**:
- `expandComponentPaths` accepts files, directories and globs (`*` within a segment, `**` across depths), skipping tests, stories, fixtures, declarations and build directories. An argument matching nothing is a usage error. PowerShell does not expand globs, so this is the only way to run a directory on Windows.
- `--init-fixture` writes `<stem>.fixture.tsx` when auto-composition is rolled back, containing the attempted tree plus a `TODO` for exports it could not place. Never overwrites, never runs unasked.
- `describeMode(report)` prints one header line naming the mode and why it activated, in all four modes.
- `--explore-budget <seconds>` reaches M30's exploration budget; `--max-combos` reaches M31's cap.
- `resolveReportPaths(paths, explicitJsonPath?)` honours `--json` across many components (`out/perf.button.json`), superseding M24's ambiguity error, which directory expansion had made unreachable.
- See `specs/milestones/m32-developer-experience.md`.

### M33: frame-derived interaction budgets (done)
**Goal**: Justify the interaction budget instead of inheriting it, and count the unit correctly.

**Scope**:
- `countPatternEvents(pattern)` sums `moveCount ?? 1`, so `pointer-drag` counts 60 events rather than one step. Every other pattern already enumerated one step per event.
- `TierBudget.interactionStepMs` derived from frames under 4x throttle: T1 33 (one 120fps frame), T2 50, T3 67 (one 60fps frame), T4 100. `computeVerdict` compares cost per event. `REFERENCE_EVENTS` survives only to keep an explicitly supplied `--threshold-interaction` on its aggregate meaning.
- Validated against 39 measured interactions from the four dogfooding repos: plain components 5.7-22.8ms/event pass, drags 5.9-20.8 pass, a Button with a spinner 34-39 passes at T3, whole applications 45-206 fail.
- `CdpHolder` + `refreshCdpSession` replace the CDP session on retry, so a tracing timeout no longer corrupts the next attempt into `Tracing has already been started`.
- See `specs/milestones/m33-frame-budgets.md`.

### M34: profiler overhead reduction (done)
**Goal**: Cut the tool's own wall-clock against real repos without changing what is measured. Profiled against justinschmitz.de: badge.tsx (matrix path) 385→300s, accordion.tsx (composed path) 97→81s.

**Scope**:
- `domNodeCount`/`hasAnimation` read once per combo (first sample), not per sample and not in warmup: they are per-combo facts, and each read paid a `getComputedStyle` sweep under the 4× throttle.
- `suspendThrottle(cdp, rate, fn)`: per-sample GC runs unthrottled (24–31ms → ~10ms each across ~2500 GCs/run); the throttle is restored before every traced window, and the GC moved inside `withContextRetry` so a retried sample still GCs first. Warmup stays throttled. `METRICS_REVISION` bumped to 3: mount/unmount medians read up to ~6% higher without the ~30ms throttled idle before each trace, so pre-M34 baselines classify `incompatible`.
- `unionCachedDeps`: `optimizeDeps.include` unioned with the dep cache's `optimized` keys and sorted, so the per-component scan variation stops invalidating Vite's config hash (a full re-bundle costs ~10–16s, previously paid by every component of a sweep).
- `server.watch: null`: the watcher's initial scan (thousands of files in a Next.js `.next/`) saturated the fs threadpool at first navigation: 11.0s → 1.9s measured.
- The curve check keeps extracted schemas even without a scaling-prop match, removing a duplicate `extractProps` (~1.4s) on the matrix path.
- See `specs/milestones/m34-profiler-overhead.md`.

**Does NOT include**: merging mount+unmount into one trace per sample, unthrottling untraced setup mounts (phase-alignment hazard for entrance-animated components), cross-component server/browser reuse for multi-path sweeps.

### M35: vsync-free lifecycle measurement (done)
**Goal**: Remove the 60Hz frame-pacing floor from lifecycle sampling: ~66ms of every mount+unmount sample was vsync idle, not measurement.

**Scope**:
- Lifecycle measurement sessions (mount, rerender, isolation phases, `analyze`'s calibration/wrapper-overhead session) launch with `MEASUREMENT_BROWSER_ARGS` (`--enable-begin-frame-control --run-all-compositor-stages-before-draw`) and a continuous frame pump (`createFramePump`) drives the compositor via `HeadlessExperimental.beginFrame`; a double-rAF fence costs ~2ms instead of ~33ms. Frames still happen: driven, not scheduled: so every sample stays paint-inclusive at full N. The pacing flags, `--force-refresh-rate`, and CDP virtual time were all measured ineffective in headless Chromium; begin-frame control was the only mechanism that moved rAF pacing.
- `explore` and `runReactAnalysis` keep vsync pacing (INP estimate, frame timing, jank depend on real scheduling).
- Animated combos are re-measured entirely under vsync in a lazily-launched plain browser: animation cost is time-based, so driven frames change how much of it lands in the traced window. `measureRerender` takes `animatedComboIndices` (wired from the mount pass at every pairing); isolation phases run vsync when their mount pass detected animation. `MountResult.pacing` / `RerenderResult.pacing` (additive) record the pacing per combo.
- Begin-frame support is probed once at session entry; failure falls the pass back to a plain vsync browser with `FRAME_PUMP_WARNING`. Every rAF fence (and the style-settle fence) carries a 10s watchdog that converts frame starvation into a failed run.
- Coverage is invariant: same combos, samples, warmups, patterns, trace categories, GC and throttle placement.
- `METRICS_REVISION` is 4: interleaved A/B (n=30) measured mount ×1.030, rerender ×1.001 (inside the ±5% gate, CVs unchanged), unmount ×0.739: the ~33ms vsync window absorbed ~0.65ms of ambient frame work the ~4ms driven window does not. Pre-M35 baselines classify `incompatible`.
- See `specs/milestones/m35-vsync-free-measurement.md`.

**Does NOT include**: one trace per combo (per-sample trace lifecycle still stands), cross-component server/browser reuse, driven pacing for explore.

### M36: shared prop-extraction program (done)
**Goal**: Stop re-parsing `lib.d.ts` and the project's `node_modules` type graph on every `extractProps`/`extractAllProps` call (~0.5–1 s each on a real repo, several calls per run, × component count in a sweep).

**Scope**:
- Parsed source files cache for the process lifetime, keyed by options bucket + `(fileName, mtime, size)`: a changed file re-parses exactly itself. Programs chain via `oldProgram` within an options bucket (mirroring the LanguageService document registry).
- Outputs are contract-identical to the uncached path; no public API change. Test hooks: `resetExtractionCache()`, `extractionCacheStats()`.
- See `specs/milestones/m36-shared-extraction-program.md`.

### M37: browser pool (done)
**Goal**: Stop launching a Chromium per measurement phase (5–8 launches per run, hundreds per sweep): browsers are project-agnostic; a fresh browser *context* gives the page-state isolation a fresh browser gave (its pages get their own renderer process, cold V8).

**Scope**:
- `createBrowserPool()` in `measure.ts`: at most one driven + one vsync Chromium, lazily launched, injectable launcher for tests. With a pool, a measurement session owns a context; without one, behavior is unchanged (launch per session).
- Threaded through mount/rerender (`pool` option), `runHarnessSession`/isolation, `explore`, `runReactAnalysis`, and `analyze` (own pool per run, or `AnalyzeOptions.browserPool`). The CLI shares one pool across every component of a multi-path sweep.
- The begin-frame probe stays per session entry; a pooled probe failure falls back to a vsync context and leaves the pooled browser alive.
- The M35 unstable-flag consequence landed here too: `unstable` requires cv>15% AND stddev >0.5ms (`UNSTABLE_NOISE_FLOOR_MS`), because driven-pacing medians made relative CV explode on fast components, silently skipping their baseline comparisons.
- See `specs/milestones/m37-browser-pool.md`.

**Does NOT include**: concurrent measurement sessions (L6 token scheduler territory), cross-component Vite-server reuse (M38).

### M38: cross-component sweep server (done)
**Goal**: Stop booting a Vite server (and paying a cold first navigation) per component of a sweep: the server is per-project state: its root is projectRoot, every harness dir lives beneath it, and files created after boot are served on demand.

**Scope**:
- `createServerPool()` in `harness.ts` (`acquire(key, boot, include)` / `stats` / `closeAll`), keyed by `(projectRoot, cssFiles, wrapPath, compiler active, noShims)`. With a pool, `HarnessResult.cleanup()` removes the harness dir and never closes the server. Without one, behavior unchanged.
- `optimizeDeps.include` freezes at first boot (first scan ∪ dep cache, M34); a reused server missing a later component's dep appends `SWEEP_DEP_WARNING` to `HarnessResult.warnings` (new, additive; forwarded to `Report.warnings`): Vite discovers it on demand and M30's retry survives the reload.
- `AnalyzeOptions.serverPool` passes through to `buildAndServe` (including the composition-rollback rebuild); the CLI shares one pool across the sweep next to its M37 browser pool.
- See `specs/milestones/m38-sweep-server.md`.

**Does NOT include**: pre-scanning all sweep components before first boot.

### M39: fingerprint-based baseline reuse (done)
**Goal**: Skip re-measuring components whose sources and machine did not change: identical code in an identical environment redraws the same distribution, so a check-mode verdict cannot change.

**Scope**:
- `BaselineEntry.sourceFingerprint` + `BaselineEntry.pass` (additive), written on every `--save-baseline`. `computeSourceFingerprint(projectRoot, files, config)` in `budget.ts` (order-independent, content-hashed, missing files hash as missing); `projectSourceFiles()` in `prop-gen.ts` yields the measured file's TS import graph minus libs/external (rides the M36 cache). Fingerprint inputs: graph + wrapper + stylesheets + tailwind/postcss configs + first lockfile + a config string (css/wrap/compiler flags, samples, throttle).
- Reuse iff (`optionsAllowVerdictReuse` for the option-only half): check mode, no `--no-cache`/`--no-baseline`/`--save-baseline`, no explicit mode *enable* (`--matrix`/`--curve`/`--isolate`; a `false` from `--no-matrix`/`--no-curve` stays eligible: M54), `--baseline-env` at its default `normalize` (`ignore` asks for a raw comparison, `strict` for a hard verification: both measure), entry has fingerprint+pass+env, fingerprints match, and `sameMachineIdentity` holds: machine identity fields, throttle, samples, `METRICS_REVISION`, and the current run's real feature fields (hand-edited env records break reuse through `featuresDiffer`); probe mode is `"combo"`, so isolation baselines cannot satisfy a standard check. Calibration is deliberately excluded: a single sample swings 20–40% on a real machine (41.7 vs 57.3 measured within one sweep), and thermal drift changes measured values, never the verdict of unchanged code. The probe needs no page: it reads the pooled browser's version.
- Cached result: `Report.cached: true`, `pass` from the entry, `combos: []`, baseline block marked identical, terminal reuse line, JSON written. Measured on a trivial component: ~0.5s vs 2.7–7s.
- `--no-cache` CLI flag → `AnalyzeOptions.noCache`.
- See `specs/milestones/m39-fingerprint-reuse.md` and `specs/milestones/m54-baseline-reachability.md`.

**Does NOT include**: reproducing matrix/curve/isolation detail from cache, Tailwind cross-file content scanning in the fingerprint (lockfile+config hashes bound it; `--save-baseline` always measures).

### M40: measured-state integrity (done)
**Goal**: Never present a skeleton's mount cost as the component's. A component that fetches, suspends, or defers renders a fallback first, and a mount measurement over that scene is a real number about the wrong thing.

**Scope**:
- `ComboReport.measuredState: "settled" | "pending-network" | "late-mutation"` (additive), from `MountResult.measuredState`. Both signals → `pending-network`.
- Network signal: `installMeasuredStateProbe` wraps page `fetch`/`XHR.send` once per page in `enterHarness`, before anything mounts: not CDP's `Network` domain, whose event traffic would land inside traced windows and whose per-sample enabling would make the probing sample's conditions differ from the median. Monotonic request ids compared against a pre-mount watermark, so an earlier combo's hanging request does not flag the next.
- Mutation signal: `probeLateMutation` observes the component-node scope (`#root` subtree, body portal children, `document.body` at `childList` for late portals), holds `MEASURED_STATE_HOLD_MS = 120` of real time, disconnects. Animated combos hold without observing: animation mutates by design, and the network signal reads after the same window either way.
- Both probes run between traced windows, on the first sample of a combo only (M34's per-combo-fact rule).
- Non-settled combo → `MEASURED_STATE_WARNING` naming combo and signal. Never fails the run.
- `BaselineEntry.measuredState` (additive); a mismatch against the current run sets `BaselineComparison.measuredStateMismatch`, skips regression analysis, and warns. Absent on a pre-M40 entry means unknown, not changed: those compare normally. A reused M39 verdict repeats the disclosure.
- See `specs/milestones/m40-measured-state-integrity.md`.

- **Known limitation**: the watch is armed immediately after the fence, before the DOM-count and animation probes, but it cannot be armed inside the traced window (that would add measured cost), and trace collection takes a variable few hundred ms. So the window opens at a load-dependent offset, and a single brief mutation inside that offset reads as `settled`. False negatives are possible; false positives are not, and the network signal covers part of the same class independently.

**Does NOT include**: a `--settle` mode that measures the settled scene as a second data point, fiber-level Suspense detection, explore skipping non-settled combos (M52).

### M41: async wrapper setup (done)
**Goal**: Let the wrapper install request mocks and seed stores before first render, so a connected component measures its real scene instead of its skeleton. This is what turns M40's disclosure into an action.

**Scope**:
- Wrapper module MAY export `setup: () => void | Promise<void>`. `setupBlock(wrapRelative)` emits a top-level await ahead of the control API assignment on the standard, composed and probe entries: readiness implies setup completed. Raced against `WRAPPER_SETUP_TIMEOUT_MS` (15s); a rejection fails module evaluation, is captured by `page-errors.ts`, and reaches the run instead of a bare readiness timeout.
- Wrapper MAY export `teardown`, exposed as `__120fps.teardown()` and called once from `MeasurementSession.close()`: session-scoped, not per-unmount: `unmount()` runs once per sample inside the traced window, so per-unmount teardown would pollute the unmount measurement and dismantle the mocks later samples depend on. Best-effort (`runWrapperTeardown`).
- `setupApiBlock(wrapRelative)` appends `hasSetup`/`teardown` after the API assignment. Both blocks emit nothing without a wrapper, so a wrapper-less entry never references `__120fpsWrapModule` and never gains a top-level await.
- `Report.wrapper.hasSetup` (additive), read from the page's control API rather than parsed from source. `EnvFingerprint` unchanged: the wrapper file already feeds the M39 source fingerprint.
- The M40 network probe installs in `enterHarness`, after setup, so it wraps whatever `fetch` setup left behind and a stubbed request measures as the stub.
- See `specs/milestones/m41-async-wrapper-setup.md`.

**Does NOT include**: MSW service-worker registration (needs a spike against a real MSW project), per-combo or per-sample setup, `setup` arguments.

### M42: server-only import preflight (done)
**Goal**: A component whose graph reaches server-only code cannot mount in a browser, permanently. Fail in seconds naming the chain, instead of a deep Vite error or a readiness timeout minutes in.

**Scope**:
- `src/preflight.ts`. `runPreflight({ projectRoot, entries, componentName })` runs after prop extraction, before any harness directory or dev server exists. Entries: measured file + wrapper.
- Hard (throws): `server-only`/`next/server-only` import anywhere in the graph, a `"use server"` directive prologue, or the measured export being an async function component. Soft (`NODE_BUILTIN_WARNING`): a Node builtin reached through the graph: Vite may externalize it.
- Type-only edges never count (`import type`, or named imports whose specifiers are all `type`); a side-effect import is always runtime. The walk stops at `node_modules` and `.d.ts`.
- No type checker: `ts.createSourceFile` + `ts.resolveModuleName` under `projectCompilerOptions(entry)` (exported from `prop-gen.ts`), so tsconfig `paths` resolve as they do for extraction. BFS with a parent map reconstructs the chain shown in the message.
- `preflightFailureMessage` reports the first hit as `chain → specifier` plus the fix and the escape hatch. `--no-preflight` → `AnalyzeOptions.noPreflight` downgrades hard hits to `PREFLIGHT_BYPASSED_WARNING`; the soft warning is not suppressible.
- See `specs/milestones/m42-server-only-preflight.md`.

**Does NOT include**: `"use client"` downgrading descendant failures (unverified, and wrong in the direction that matters), showing every offending chain.

### M43: scroll & wheel stress pattern (done)
**Goal**: Exercise the one interaction class the tool never touched. A virtualized list's whole cost model lives in its scroll handler.

**Scope**:
- Discovery finds scroll containers: `overflow-y/x` of `auto|scroll|overlay` **and** content actually exceeding the box. `InteractionType` gains `"scroll"`; `InteractionDescriptor` gains `scrollAxis` (vertical wins when both scroll: that is the axis a wheel drives).
- `scrollAxis` is recorded on every overflowing container, but the `"scroll"` *type* is claimed only when nothing else does: never for native interactive tags, an ARIA role, or contenteditable. A scrollable listbox keeps its keyboard sweep.
- The document scrollport is a descriptor with selector `:root` when content overflows the viewport: a plain long list scrolls the document, not a container.
- `scroll-sweep`: highest-priority dispatch for `"scroll"`, `SCROLL_SWEEP_STEPS` (10) wheel ticks out and 10 back via `page.mouse.wheel`, ending at the initial offset. One step with `moveCount: 20`, so `countPatternEvents` bills each tick and the M33 per-event budget applies unchanged. Fixed count (budgets precede the sweep); tick distance `min(clientHeight * 0.8, range / 10)` computed in-page, so a 10-row list traverses its range and a 400,000px virtualized list stops after eight viewports.
- `StressPattern.stateInvariant` makes the explorer treat scroll edges as self-loops: cost recorded, DOM hash not consulted. Otherwise virtualized windowing mints one state node per scroll offset.
- `scroll-behavior` forced to `auto` while reading the container box: easing duration is not handler cost. Idempotent, not restored.
- See `specs/milestones/m43-scroll-stress.md`.

**Does NOT include**: touch/momentum emulation, scrollbar dragging, scroll-linked animation timelines, innermost-only dedupe for nested containers, a dedicated dropped-frame scroll column (M51).

### M44: representative prop data (presets) (done)
**Goal**: Let users supply real prop *values* without authoring a *scene*. Synthesized values mount but do not resemble production, and users who notice stop trusting every number.

**Scope**:
- `src/prop-presets.ts`. `<stem>.props.tsx|ts` adjacent to the component, auto-detected like a fixture. Default export maps prop names to a value or array of values; a bare value is a one-element pool. Never applies in fixture mode.
- Presets **replace** a prop's pool in `PropSchema.values`, so they flow into combos, deltas, matrix cells and curve/auto-scale anchors through one seam (`extractSchemas` in `analyze.ts`).
- **Transport** (the crux the draft left open): literal expressions: strings, numbers, booleans, null, undefined, negatives, and arrays/objects of them: are AST-evaluated and travel as real values, so deltas and matrix cells compare real data. Everything else (functions, JSX, calls) becomes `{ __120fps_preset, index }`, a position the entry substitutes at render time via `presetImportLine`/`presetResolverBlock`/`presetResolveStatement`, extending the `FUNCTION_MARKER` precedent. The module is parsed, never executed in Node.
- Substitution runs once at `mount` and once at `rerender`, not per render site, so scale fan-outs and composed scenes need no extra cases. A preset-less entry never references the module.
- `UNKNOWN_PRESET_PROPS_WARNING` for preset names that are not props. `Report.propPresets = { path, props }`. The preset file joins the M39 fingerprint: nothing in the component graph imports it.
- See `specs/milestones/m44-prop-presets.md`.

**Does NOT include**: TSDoc `@example` values, Storybook `args` import, preset sampling priority under the combo cap, per-value labels in report rows.

### M45: per-environment baselines & baseline workflow (done)
**Goal**: Stop laptops and CI runners colliding in one committed baseline. M29 classified the mismatch; M45 changes the model so it mostly stops occurring.

**Scope**:
- Baseline file version 2. Entries keyed `<component>#<envKey>`: composite keys, not nesting, so the map stays `Record<string, BaselineEntry>`, sorted keys still group by component, and branches touching different components merge textually.
- `computeEnvKey` digests machine identity: metrics revision, CPU, cores, OS, Chromium **major**, throttle, samples, mode, css, wrapper, reactCompiler. Excludes calibration (M39: a single sample swings 20–40%, so it would fragment slots by thermal luck) and the Chromium patch version.
- Save writes this environment's slot; check reads it. No slot → `selectBaselineEntry` falls back to the component's freshest other slot, sets `BaselineComparison.crossEnvironment`, warns `NO_ENV_BASELINE_WARNING`, and cannot fail the run. `--baseline-env ignore` opts out of all of that (the user asked for a raw cross-environment comparison and accepts failure); `strict` keeps its advisory.
- Version-1 files load: plain keys are rekeyed in memory into the slot their own `env` describes; entries without `env` land in a `legacy` slot, readable, never written.
- `BASELINE_SLOT_TTL_DAYS` (90): stale slots pruned on save, named in `PRUNED_SLOTS_NOTICE`. A slot with no `savedAt` predates M45 and is kept: absence is not age. The slot just written is never pruned.
- README gains the CI workflow recipe (save on main, check on PRs, skip-worktree for personal slots).
- Consequence: a combo and an isolation baseline no longer share a key, so M28's `incompatible` mode classification now arises only via the cross-environment fallback.
- See `specs/milestones/m45-baseline-environments.md`.

**Does NOT include**: `--env-name` aliases for heterogeneous CI fleets (needs a real fleet), an explicit `--prune-baselines`, per-component baseline files.

### M46: noise sentinel (done)
**Goal**: Tell the user when the run itself was untrustworthy. Perf CI dies the day a team gets its second false alarm, and nothing distinguished "my component regressed" from "my machine was busy".

**Scope**:
- `src/noise.ts`. `Report.noise = { level, signals }` on every run.
- Signals: `probeCv`/`probeMedianMs` from `NOISE_PROBE_SAMPLES` (7) runs of a fixed arithmetic loop: once per run, unthrottled, outside every traced window; `unstableFraction` from the CV flags the run already produced; `contextRetries` counted before warning dedup.
- Levels: `noisy` at probeCv > 15, unstableFraction >= 0.25, or any retry; `hostile` at probeCv > 30 or unstableFraction >= 0.5.
- Consequences: `noisy` warns and stops baseline **regressions** from failing the run (budget verdicts untouched: they are absolute); `hostile` skips baseline comparison entirely and sets `BaselineComparison.skippedNoisy`; `quiet` changes nothing.
- Thresholds are **derived, not invented**: 15% is the same bar `buildTimingWithCV` uses to distrust a metric, and hostile is twice it. The probe is deliberately not calibration: calibration feeds normalization and one sample of it swings 20–40% (M39); the probe asks whether the machine can repeat identical work identically, with enough samples to answer.
- The downgrade mirrors M22's unstable-metric downgrade: same philosophy, run-scoped instead of metric-scoped.
- See `specs/milestones/m46-noise-sentinel.md`.

**Does NOT include**: empirically fitted thresholds (needs paired quiet/loaded runs on two machines, interleaved), rAF-fence and GC-spread signals (would need per-sample bookkeeping inside the measurement loop), a distinct `hostile` exit code, per-combo localization.

### M47: volatile DOM normalization (done)
**Goal**: Stop the state graph chasing phantoms. A component rendering timestamps or random ids made every interaction look state-changing, inflating the graph toward its node cap and burning exploration budget on noise.

**Scope**:
- `probeVolatileRegions(page, gapMs?)` once per combo, before discovery and before the initial hash: two content fingerprints `VOLATILITY_PROBE_GAP_MS` (250) apart with no input. Differing paths are volatile.
- `computeDomHash` became a tree walk. Volatile subtrees drop text and attribute **values**; tags, element presence and attribute names stay: structural change through a volatile region still counts as state, content churn inside it does not. A path present in only one probe is structural and never marked volatile.
- Region identity is a structural address (`/TAG[index]` from `#root`), so a remount between samples maps to the same regions.
- State attribution only: discovery, cost measurement and DOM counts are untouched, and targets inside volatile regions stay exercisable.
- `ExploreResult.volatileRegions`, `StateGraph.volatilePaths`, and `VOLATILE_DOM_NOTICE` naming the combo: a component that renders non-deterministically is a finding in itself.
- In-page helpers are passed to `page.evaluate` as functions, not source strings: Playwright evaluates a string as an expression, so a stringified arrow returns the function instead of calling it.
- See `specs/milestones/m47-volatile-dom.md`.

**Does NOT include**: slow-tick volatility (a once-per-second clock beats the 250ms gap: accepted and documented), sharing the probe with M40's late-mutation signal, treating `class`/`style` as content outside volatile regions.

### M48: load-bearing project transforms (done)
**Goal**: Name the missing transform instead of failing deep inside Vite, and load the ones that can be loaded. The harness deliberately never reads the project's vite.config (M30); that is the right architecture and was the wrong error experience.

**Scope**:
- Diagnosis: `TRANSFORM_RECOGNIZERS` (SVGR, vanilla-extract, GraphQL, MDX, CSS preprocessors, Vue, Svelte), each with a stable `[transform:<code>]`, riding M42's preflight walk and never fatal. Recognizers receive the importing file, not just the specifier: vanilla-extract is imported as `./styles.css` while the file is `styles.css.ts`. `PROJECT_TRANSFORM_WARNING` fires only for transforms the harness will *not* apply; `transformFailureNote` is appended to whatever error ends the run.
- Passthrough: `SUPPORTED_TRANSFORM_PLUGINS` detected in the project manifest, resolved from the project's own `node_modules`, appended after the Tailwind and React Compiler entries, with `configureServer`/`configurePreviewServer`/`handleHotUpdate`/`hotUpdate` stripped. Load failure warns and continues. Active transforms join the M39 fingerprint (they change the code being measured, like `reactCompiler`) and appear as `Report.projectTransforms`. `--no-transforms` opts out.
- **The spike decided the support list.** A real workspace fixture with both plugins installed was driven end to end: SVGR compiles `.svg?react` into a mounted `<svg>`, vanilla-extract compiles `styles.css.ts` and its computed style reaches the page. Hook-stripping is sufficient isolation for both: the draft's doubt about vanilla-extract is resolved, and both ship.
- The spike also caught `resolvePluginFactory`: `mod.default ?? mod` fails for both packages (`vite-plugin-svgr` is CJS-interop double-wrapped, `@vanilla-extract/vite-plugin` has only a named export). Without it both looked unloadable, which mimics exactly the isolation failure the draft predicted.
- See `specs/milestones/m48-project-transforms.md`.

**Does NOT include**: transforms beyond the two spiked (the `[transform:<code>]` codes exist so the real distribution picks the order), `--vite-plugin`, loading the project vite.config, keying the M38 pool on transforms.

### M49: compare mode (interleaved A/B) (done)
**Goal**: Answer "did my change make it faster?" in one window. Sequential save-then-check puts the two runs in different thermal and contention windows, and the project's own benchmarking discipline exists because that lies.

**Scope**:
- `src/compare.ts` + `--compare <gitref>`. Reference side via `git worktree add --detach`; samples **interleave** per sample across the two sides over the same pooled browser. `runMountUnmount` measures both sides, so the code path is identical.
- Mount, unmount, DOM node count per combo. Combos come from the working tree's schema: the side the user is asking about.
- `distinguishable` compares sample **ranges**: only non-overlapping spreads say the difference outlived the noise. Not a t-test, by choice.
- No verdict, no exit code: compare informs a human; budgets and baselines own CI. Mutually exclusive with `--check`/`--save-baseline`/`--isolate`. Worktree removed on every exit path.
- **The reference side has no install of its own** (the draft's open question): the lockfile hashes of both sides must match (`DEPENDENCY_DRIFT_ERROR`), which is what makes linking the working tree's `node_modules` into the worktree sound: junction on Windows, symlink elsewhere.
- See `specs/milestones/m49-compare-mode.md`.

**Does NOT include**: rerender/curves per side, interactions, per-side wrapper/CSS disclosure, nested workspace installs, non-comparable one-sided props.

### M50: CI surfacing (done)
**Goal**: Put the regression in the PR, not in a log. Teams adopt perf CI when reviewers see it.

**Scope**:
- `src/ci-report.ts`, pure serializers over `Report` only: no measurement state, no filesystem, no network. 120fps emits what forges consume and never talks to a forge.
- `--report-md <path>`: verdict line + counts, one table row per component, regressions behind a `<details>` fold (so a thirty-component sweep fits a comment), footer with machine and M46 noise level, `_(cached)_` for M39 reuse. The baseline column distinguishes `skipped (noisy)` (M46), `other machine` (M45), worst regression, best improvement, or `no change`.
- `--report-junit <path>`: one testcase per component, failure body carrying the regression and budget numbers, XML-escaped. Every CI renders JUnit natively.
- Both written even when components failed: a summary that only appears on success is the one nobody needed.
- README ships the copy-paste GitHub Actions workflow (measure → step summary → sticky comment) rather than embedding forge integration.
- See `specs/milestones/m50-ci-surfacing.md`.

**Does NOT include**: `--report-prev` trend deltas (needs a report-storage story), forge API calls, resolving the JUnit-failure-plus-exit-1 double-reporting question.

### M51: report actionability (done)
**Goal**: The report named the finding but not the move. A correct diagnosis with no treatment leaves users without deep React perf background stuck.

**Scope**:
- `src/hints.ts`. Ten finding classes (`memoBailout`, `contextFanOut`, `callbackIdentity`, `portalOrphans`, `leakSuspected`, `churnDegradation`, `superlinearGrowth`, `budgetBreach`, `domFlat`, `measuredState`) each map to 2–3 lines naming an *action* plus a README anchor. `hintsForReport` derives them from the report alone: a hint is documentation attached to a diagnosis, never advice generated from inspecting code the tool did not measure.
- Printed once per run by every output mode (`appendHints`), after the findings, in a stable order. `Report.hints` carries ids, never prose, so wording changes without schema churn. Run-level rather than per-finding: same requirement, without threading an id through every finding interface.
- `MEASUREMENT_BASIS_LINE` in every report header: first-run users read 14ms and think their button takes 14ms in production.
- README gains the "which mode answers my question" decision table and one remediation section per anchor; `--help` gains the compressed mode table.
- The draft's copy criterion is enforced by test, not review discipline: every hint must match an imperative verb and must not use vague-advice phrasing, and every anchor is resolved against the README's real headings so a reworded section cannot orphan a hint.
- See `specs/milestones/m51-report-actionability.md`.

**Does NOT include**: cost-attribution package hints (too situational to template), a copy review round against dogfooding findings.

### M52: explore-phase observer rework (closed: premise falsified)
**Goal as stated**: explore dominates measured wall clock, and the cost driver was assumed to be the per-exercise CDP trace lifecycle.

**Outcome**: the acceptance measurement was run before switching anything, and it falsifies the hypothesis.
- Interleaved same-window A/B, 3 rounds per component: counter.tsx 0.98, aria-tabs.tsx 0.97, aria-listbox.tsx 0.84: mean ratio **0.93** against a ≤0.50 target. Coverage identical on all three, so the comparison is like for like.
- Direct phase measurement on counter.tsx (rapid-toggle-11, 4× throttle): remount+fence 34ms (4%), **executing the stress pattern 747ms (91%)**, CDP tracing 36ms (4%). At ~68ms per step the cost is the per-step settle under vsync: a double-rAF fence plus Playwright actionability checks plus React's render under throttle. Tracing was never the driver, and neither was remount-and-replay (the draft's named second-order lever).

**Decision**: do not switch: the numbers do not survive it, independent of what the baseline invalidation costs.
- The values were measured after the wall-clock A/B, and the observer path cannot express explore's cost metric. Same fixtures, interleaved, `samples: 5`: trace reports **0.51–0.98 ms/step**, observers report **0.00 ms/step on every edge** of aria-tabs.tsx and aria-listbox.tsx. Event Timing's `durationThreshold` minimum is 16ms per event: an order of magnitude above the per-step cost of a real component: so a fast interaction is not slow-and-cheap, it is invisible, and the median over samples is 0 even when an occasional window clears the floor (probed on aria-tabs: one window 16.00ms, the next two 0.00ms for the identical pattern).
- The other direction fails too: Chromium emits one entry per dispatch target, so 11 clicks on the slow fixture arrive as 62 entries (a pointerdown/pointerup/click trio plus one pointerenter per ancestor, all ending at the same presentation). Summing them reads 2720ms for a 1.5s window, so a window's *total* cost is not recoverable from Event Timing: only its slowest interaction is. `combo.interactions[].timing.median / steps` is the per-step number the tier budgets compare against, and no observer aggregate reconstructs it.
- Switching anyway would invalidate every stored baseline to buy a metric that reads 0.00ms/step for the components the tool is pointed at, taking interaction ranking, per-interaction scaling curves and regression comparison with it. Verdicts alone would survive, because the smallest per-step budget (33ms) sits above the 16ms floor.

**Scope shipped**: `src/observers.ts` as opt-in acquisition (`ExploreOptions.observerTiming`): Event Timing, LoAF and layout-instability, windows scoped by start time so a late entry cannot land in the next window, unsupported entry types degrading to absence rather than to zero. Verified coverage-identical. It earns its place on metrics the trace path cannot give: presentation-inclusive duration, input delay split from processing, LoAF script attribution per interaction. `observedInteractionMs` is deliberately the window's slowest interaction rather than a total, and `readObservedWindow` yields until a turn passes with no new entry, because an observer callback is queued after its frame presents and a read on the caller's own fence dropped the entry it was opened for.

**Where the next lever is**: the per-step settle, not the timing source. See `specs/milestones/m52-explore-observers.md`.

### M53: statistical honesty (done)
**Goal**: Printed numbers must mean what their labels say.

**Scope**:
- `computeP95` is the type-7 interpolated quantile (R/numpy default); glossary discloses that below n≈20 it is dominated by the slowest sample. Every combo: not just the first: gets an untraced warmup render on its own props (`warmupsForPosition`), removing the cold-start artifact from later combos' tails.
- `computeCV` uses sample stddev (n−1). The env fingerprint records the *effective* per-combo sample count; when throttled below the request, `EFFECTIVE_SAMPLES_WARNING` names both, and matrix missing-combo re-measurement uses the sweep's effective count.
- Churn degradation and churn `cv`/`unstable` are computed within one alternation parity (worse parity reported), never across the A/B prop mix. `computeScalingCurve` ranks all candidates by R² on raw y: the exponential fit is scored on back-transformed predictions.
- See `specs/milestones/m53-statistical-honesty.md`.

**Does NOT include**: rAF-driven animation detection (`getAnimations()` misses a raw rAF loop that never registers a Web Animations API `Animation`), noise-probe CV variance switch (both still deferred). Tier floor-vs-override for portal/animation components shipped in M64.

### M54: baseline reachability (done)
**Goal**: The baseline/verdict-reuse workflow must be reachable for matrix-eligible components and never silently no-op.

**Scope**:
- A matrix run given `--save-baseline`/`--check`/`--budget` pushes `MATRIX_BASELINE_WARNING` naming the limitation and the `--no-matrix` workaround: auto-activated and explicit `--matrix` alike.
- The M39 reuse gate (`optionsAllowVerdictReuse`) accepts explicit mode *disables* (`--no-matrix`/`--no-curve` → `false`); explicit enables still always measure; every other guard unchanged.
- `--no-cache` is in `KNOWN_FLAGS`; `--curve --matrix` is a usage error (exit 2, disable-wins resolves it); `resolveCurveOption`/`resolveMatrixOption` encode disable=false vs absent=undefined. README options block is drift-guarded by test.
- See `specs/milestones/m54-baseline-reachability.md`.

**Does NOT include**: matrix baseline participation (per-cell slots); the identical `--curve --save-baseline` no-op (deferred, same seam).

### M55: ci-report mode coverage (done)
**Goal**: `--report-md`/`--report-junit` compose with every mode, as README claims.

**Scope**:
- `reportMode(report)` dispatches both serializers: combo (standard/matrix, unchanged), cached, curve, isolation, and an explicit "no measurable data" fallback for unrecognized combo-less shapes.
- Curve rows show scale-point medians + growth class; isolation rows show per-phase medians with a markdown "Mode detail" fold; cached renders the reused verdict without fabricated timings. `worstVerdict` surfaces `warn` for all modes; JUnit `<failure>` bodies always carry the mode's breaching numbers, never the bare string `"failed"`.
- Failure lines reuse the pipeline's own predicates and constants (`computeCurveVerdict`, `LEAK_BYTES_PER_CYCLE`, `CHURN_DEGRADATION_LIMIT`) so serializer output cannot drift from what failed the run.
- See `specs/milestones/m55-ci-report-mode-coverage.md`.

**Does NOT include**: the isolation mount-budget number (not persisted on `Report`: reported by elimination, still deferred). `report.mode` shipped as a discriminator field in M64.

### M56: diagnostics & hygiene (done)
**Goal**: Four small frictions, each the odd one out in an otherwise disciplined codebase: a startup error with no cause, a fix-it error missing its fix, a code comment that should have been user-facing text, and an unbounded OS-tmp leak.

**Scope**:
- `VITE_START_FAILED(harnessDir, detail)` names both the harness dir and the underlying cause; `buildAndServe` wraps any boot failure (createServer/listen, pool `acquire`, including non-`Error` thrown values) and the no-listening-address fallback through it, chaining the original via `{ cause }`.
- The `--react-compiler` requested-but-unresolved error keeps its original substring (`${REACT_COMPILER_PACKAGE} not found in ${projectRoot}`, still asserted verbatim elsewhere) and appends the fix: install the package or drop the flag.
- `measure.ts`'s `withContextRetry` promotes the retry-budget-exhaustion code comment to `RETRY_BUDGET_EXHAUSTED_NOTE`, appended to the original error's message with `{ cause }` preserving the chain: states repeated dev-server reloads (environment), not the component, are the likely cause.
- `sweepStaleTmpDirs(baseDir = os.tmpdir())`: best-effort removal of this tool's own OS-tmp leftovers (`120fps-*` / `.120fps-*`, e.g. `120fps-ctx-*`, `120fps-memo-*`) older than 24h. Symlinks/junctions are never followed (dirent-level skip), non-matching and non-directory entries are untouched, per-entry failures are swallowed and do not stop the sweep, and removals are capped per call (`TMP_SWEEP_MAX_REMOVALS`) so a pathological population stays bounded: the remainder is picked up on the next sweep. Runs once per `createServerPool()` call (every real run passes through there), wrapped so it can never block or fail startup.
- `package.json`: `test` and `test:unit` both run `vitest run test/unit/` (matching CI); `test:e2e` runs `vitest run test/e2e/`; `test:all` retains the old default (`vitest run`).
- See `specs/milestones/m56-diagnostics-hygiene.md`.

**Does NOT include**: a distinct exit code or error class for retry-budget exhaustion (deferred: wants a CI-owner's perspective); page-error buffer cap changes (deferred: wants a real-world reproduction).

### M57: Vue support (done)
**Goal**: Mount and measure `.vue` SFCs, making the framework-neutral measurement spine reachable outside React.

Nine modules (`measure`, `explorer`, `discovery`, `stress-patterns`, `isolation`, `observers`, `noise`, `page-errors`, `ci-report`) contain no React reference and none were edited. What was React-bound is the entry template (`harness.ts`), prop extraction (`prop-gen.ts`), and `react-profiler.ts`.

**Scope**:
- `src/vue-sfc.ts`: the project's own SFC parser, resolved through `createRequire` and cached per lookup dir. `VUE_SFC_SPECIFIERS` tries `vue/compiler-sfc` before `@vue/compiler-sfc`: under pnpm only the subpath resolves from a project that merely declares `vue`. Unresolvable with a `.vue` target, `analyze` fails up front with `VUE_COMPILER_MISSING`. No fallback scanner: a hand-rolled top-level tag scan was measured against the real parser and read a `<script setup>` block that was inside an HTML comment.
- Prop extraction: the `<script setup>` block is served to the M36 program cache from memory as a virtual `<sfc>.ts` in the SFC's own directory (`VirtualScripts`), so relative imports and tsconfig `paths` resolve unchanged: measured, no resolution shim needed. The resolver serves any `<x>.vue.ts` whose `<x>.vue` exists, which is how `./Child.vue` type-checks and how `projectSourceFiles` returns the whole SFC graph (each virtual name collapsed back to its `.vue` file, so the M39 fingerprint moves when the component does). `findDefineProps` reads the call's type argument; `applyWithDefaults` moves a default to the front of `PropSchema.values`, which is what every anchor already reads (`values[0]`): one seam, no change to `prop-gen-values`.
- Renderer adapter: `rendererFor(path)` keys on the extension; `generateEntry` dispatches, React's template moved rather than rewritten. The Vue entry is `entry.ts` (no JSX), mounts via `createApp` over a `shallowRef` holding a plain props object: the component sees unproxied props and a new identity patches instead of remounting: wraps through the wrapper's default slot, and fans auto-scale out inside one element. `optimizeDeps.include`/`resolve.dedupe` are per renderer, because an unresolvable `react` include aborts server start in a Vue project. `vueComponentName` PascalCases the filename: Vue's kebab-case convention is not an identifier.
- **Scheduling**: `rerender()` awaits `nextTick()` before resolving. The double-rAF fence proves a frame presented, not that Vue's queue drained into it, and a wrong answer here reports implausibly fast rerenders rather than failing. An e2e test reads the DOM at the moment the promise resolves.
- `@vitejs/plugin-vue` joins `SUPPORTED_TRANSFORM_PLUGINS` (M48 machinery unchanged); the `vue` recognizer stays, so a project without the plugin keeps its named warning.
- `sfcProducesComponent` + `SFC_NO_COMPONENT`: the plugin imports a default export from any SFC that has a `<script>` block, so a block producing none fails module evaluation. Checked before the harness dir exists. An **empty** `<script setup>` counts as absent to the Vue compiler: the shape a wrapper is most naturally written in. A plain-object default export counts as a component, unlike React's `hasCallableDefaultExport`.
- `detectFramework` returns `"vue"`; `--framework vue`; a `.vue` file is measured as Vue whatever the flag says. `EnvFingerprint.framework` is omitted for React, so pre-M57 baselines keep their slot and stay comparable; a cross-framework pair classifies `incompatible`. `--isolate strictmode` on a `.vue` path is a usage error (`VUE_STRICTMODE_ERROR`): a Vue "strict" pass would re-measure the identical page and report a clean double-invoke. Preflight parses SFC script blocks and walks relative `.vue` edges. Auto-composition is skipped; `.fixture.vue` and `120fps.setup.vue` are recognized.
- See `specs/milestones/m57-vue-support.md`.

**Does NOT include**: Vue-specific optimization detection (the M18 analogue), Nuxt shims, Options API or non-`<script setup>` prop extraction (those SFCs mount and measure, they just carry no schemas), Vue 2, Svelte/Solid, auto-composition for Vue, aliased `.vue` specifiers in the preflight walk.

M58–M66 shipped the fixes a 2026-08-18 dogfood run against real repos found, in order: prop target binding first (everything downstream reads the wrong schema without it), then the two honesty passes it exposed (render health, prop synthesis), then the report-surface fixes (scale-probe identity, shim reporting, curve stability, verdict/report clarity), then the DX gaps that slowed diagnosing the rest, then attribution.

### M58: prop extraction binds to the target component (done)
**Goal**: Resolve props against the component the harness actually renders, not the first declaration that looks like it takes props.

**Scope**:
- `findComponentPropsType` collects every top-level component declaration as a candidate (name, declaration, exported, isDefault, source order) before choosing a target: the default export first (following `memo`/`forwardRef`/alias chains to the identifier behind it), then the export whose name matches the normalized file stem, then the first exported component. A non-exported declaration never wins while an exported one exists.
- Call wrappers around a function expression or a local identifier are unwrapped by the existing HOC walk (identifier follow capped at 8 hops); a `const F: FC<P>` or a default export wrapping an imported component is read off the value's own call signature, which the AST alone cannot see.
- Self-consistency guard: when the target's destructured parameter shares no key with its resolved props type, a candidate whose type does overlap is preferred instead.
- A resolved target with no bindable props type: while another declaration in the file has one: returns `[]` and warns naming the target and file, rather than silently returning the other declaration's schema. A target with no parameter at all is a propless component and warns nothing.
- `detectComponentName` (`analyze.ts`) delegates to `detectComponentExport` (`harness.ts`): the resolver the harness already uses to pick the rendered component, so report and harness name the same one.
- See `specs/milestones/m58-prop-target-binding.md`. 32 new tests.

**Does NOT include**: changes to Vue `defineProps` extraction, auto-scaling prop detection, or `extractAllProps`/`extractExports`.

### M59: render-health gate & always-on page-error surfacing (done)
**Goal**: Stop reporting a broken tree's mount timing as a passing measurement, and give every harness-entry timeout the page errors behind it.

**Scope**:
- `PageErrorCapture.drain()` → `{ messages, fatal, dropped }`: a segment reset per combo (same distinct-message dedupe and cap-at-20 retention as the session buffer), layered next to the unchanged session-wide `errors`/`summary()`. `measureMount`/`measureRerender` drain after each combo's samples onto `MountResult.pageErrors`/`RerenderResult.pageErrors`; `buildReport` merges both phases' drains into `ComboReport.pageErrors: string[]`.
- `ComboReport.renderHealth?: "error" | "empty"`, set only when `domNodeCount === 0`: `"error"` when the drain captured a fatal `pageerror` (forces verdict `fail`, overriding the tier verdict and the scale-combo pass exemption), `"empty"` when nothing fatal was captured (verdict follows budgets as usual: a legitimate null render). Only an uncaught page exception counts as fatal; `console.error` (React/Vue dev warnings) never does.
- `gotoWithErrorContext` wraps every harness `page.goto`: `enterHarness` (measure.ts), `enterHarnessPage` (analyze.ts), the React-analysis probe (react-profiler.ts), and the explorer's `enter` (explorer.ts): a navigation failure now carries the captured page errors instead of a bare timeout.
- `enrichPhaseError(err, { phase, comboIndex?, component? })` prefixes a harness crash with the phase in flight (mount/rerender/explore/attribution); idempotent and message-preserving, so `isContextLostError` and the retry budget keep matching.
- Curve mode has no combos: a scale point that rendered 0 DOM nodes with a fatal error warns naming the point and fails the run.
- See `specs/milestones/m59-render-health.md`. 70 new tests.

**Does NOT include**: per-scale-point `pageErrors` on `ScalingCurveReport` (curve mode gets the run-level warning only), isolation mode's session-wide enrichment gaining a per-phase slot, refusing to save a render-errored run's baseline.

### M60: prop synthesis honesty (done)
**Goal**: Stop silently degrading props the classifier gives up on, and stop presenting the degraded run as a measurement of the real component.

**Scope**:
- `classifyType` strips `null`/`void` next to `undefined` before deciding, which makes `VariantProps<typeof x>` (the shadcn/cva pattern) resolve to a `union` of its variant keys with no syntactic inspection of the `cva` call.
- A prop's value pool never contains a duplicate value; `generateCombinations` de-dupes before any cap, so `--max-combos` semantics are unchanged and `[undefined, undefined]` can no longer cartesian-double a combo.
- Tuples synthesize fixed-arity, per-position typed values (`kind` stays `"object"`: never a scaling candidate). Object props recurse one level at a time to a depth/property cap, cycle-safe. Intersections shape like the object they are; a union of object types keeps its first member's discriminant literal.
- `Date`/`RegExp` synthesize real instances (Playwright's evaluate serializer carries both). `Map`/`Set`/`WeakMap`/`WeakSet` cannot cross that serializer as real instances, so they travel as entry arrays instead of `{}` and mark the prop degenerate.
- A prop with no faithful value (class instance, `Promise`, empty pool on a required prop) keeps its degraded value, is marked `PropSchema.degenerate`, and is named once per file on stderr pointing at `<stem>.props.tsx`: suppressed once a preset exists, cleared per-prop by `applyPropPresets`.
- A computed props type (`ComponentProps<typeof X>`) that enumerates nothing warns naming the annotation instead of returning `[]` silently. Foreign properties are kept unless every declaration sits in a TS lib or React's own types (`aria-`/`data-` attributes always drop); local properties come first, capped at 32 with a stderr note when truncated.
- See `specs/milestones/m60-prop-synthesis-honesty.md`. 58 new tests.

### M61: scale-probe transparency & matrix combo cap (done)
**Goal**: Stop presenting the always-on synthetic scale probe as an ordinary prop combo, and make `--max-combos` bound matrix mode too.

**Scope**:
- `ComboReport.scaleProbe?: number` carries the probe's N; `__120fps_scaleN` no longer leaks into `ComboReport.props`. The main table's `#` column prints `×N copies` for a probe row.
- `buildReport` fits one scaling curve from the scale-probe combos alone (`{ n: scaleProbe, metric: mount.median }`) and attaches it only to those combos; `applyAutoScalingCurves` (the real detected-prop mechanism) attaches its own curve only to combos where `scaleProbe === undefined`. The two curves can never land on the same combo; the `Scaling` column labels each (`(synthetic copies)` vs `(auto: <prop>)`).
- `describeMode`'s combo count excludes scale probes, naming them separately (`+K scale probes`); a run with only scale-probe combos reads `Mode: scale probe (K points, no prop combos)`.
- `runMatrixMode` caps `matrixCombos` to `--max-combos` (default 8) via `selectMatrixCombos(combos, axes, max)`: the all-anchor base cell first, then cells at increasing Hamming distance from it, ties by generation order. `MATRIX_CELL_CAP_WARNING(kept, total)` discloses it.
- Before the full scale-point sweep, the cheapest requested point is measured alone (3 samples); over `SCALE_PROBE_GATE_MS` (80ms, T4's mount budget) only that point is kept and `SCALE_PROBE_COST_WARNING` states what was skipped and why: bounding the cost behind a 46.9s single-combo dogfood reproduction.
- See `specs/milestones/m61-scale-probe-transparency.md`. 39 new tests.

**Does NOT include**: gating `applyAutoScalingCurves`'s own probe cost (a different cost surface: a real prop's growth, not N sibling trees), CI-serializer labeling of scale-probe rows.

### M62: Next.js shim-usage reporting (done)
**Goal**: Fix `report.nextJsShims`, which was `undefined` for every project because a shim-redirected specifier resolved locally and never reached the branch that recorded it as imported.

**Scope**:
- `buildShimAliases` tags its entries `isShim: true`; `resolveLocalImport` returns `{ path, viaShimAlias } | null`, `viaShimAlias` true only when the alias that resolved the specifier locally was a shim alias: a project's own tsconfig `next/image` alias still shadows the shim (M19) and now correctly reports as not a shim hit.
- `scanExternalDeps` additionally records a bare specifier that resolved via a shim alias into its specifier set, alongside the existing unresolved-specifier recording. A specifier resolved via a non-shim alias is still never recorded, and `externalPkgs` (the `optimizeDeps.include` source) is unchanged: a shim-redirected specifier still resolves locally.
- See `specs/milestones/m62-shim-usage-reporting.md`. 16 new tests.

### M63: curve-fit stability & curve diagnostics (done)
**Goal**: Stop `--curve` flip-flopping between growth classes on unchanged code, stop mislabeling sub-linear growth as exponential, and name what a curve `FAIL` violated.

**Scope**:
- `linear` is the null class. A superlinear label (`quadratic`/`exponential`) needs both gates: `growthExponent(points) >= SUPERLINEAR_MIN_EXPONENT` (1): the log-log slope between the sweep's endpoints, so growth that is sub-linear in N cannot be reported as superlinear: and a fit gate, `1 - candidate.r2 <= SUPERLINEAR_RESIDUAL_SHARE * (1 - linear.r2)` (0.5): a candidate must still explain at least half the variance the linear fit leaves. Among admissible candidates the higher raw-y R² wins (M53's rule, unchanged); no admissible candidate keeps `linear`. `slope`/`intercept`/`r2` still describe the linear fit regardless of which class wins.
- `isSuperlinearGrowth(curve)` is the one predicate `hints.ts` reads; curve mode prints a `Growth:` line for every curve that predicate is applied to (mount and rerender), so a hint can never cite a class the screen doesn't show.
- `evaluateCurve(points, mountCurve, thresholds)` returns the verdict plus a `CurveViolation`: the growth class behind a superlinear fail, or a budget crossing naming the metric, its budget, `crossingN`, the measured median there, and `lastPassingN`: stored on `ScalingCurveReport.violation` and printed under `Result: FAIL` via `formatCurveViolation`.
- `--curve` requested explicitly but not activated (no array/list prop in the schema, a fixture run, a composed run) pushes `CURVE_NOT_ACTIVATED_WARNING(reason)`; the run still proceeds in its fallback mode. `--no-curve` and silent auto-detection stay silent.
- See `specs/milestones/m63-curve-fit-stability.md`. 60 new tests.

**Does NOT include**: making `rerenderCurve`'s growth class fail a run, `interactionCurves`/`domGrowth`/`heapGrowth` classes as `Growth:` lines, a `--curve prop:type` naming a prop absent from the schema warning.

### M64: verdict & report clarity (done)
**Goal**: Fix eight report defects, each a place where the output stated something untrue of the run it described.

**Scope**:
- The matrix compound-effect line reads "above additive expectation" only for a non-negative `compoundDelta`, "below additive expectation" for a negative one.
- A passing run with any `warn` combo or matrix cell prints one line under `Result: PASS` naming how many rows warned and that warnings don't fail the run.
- `HOSTILE_RUN_WARNING`/`NOISY_RUN_WARNING` no longer assert anything about a baseline; the baseline clause (`HOSTILE_BASELINE_NOTE`/`NOISY_BASELINE_NOTE`) is appended only when `report.baseline !== undefined`. `formatNoiseWarning(noise, baselineCompared)` prefixes the sentence with the classification and the probe signals behind it.
- `Report.mode?: ReportMode` (`"combo" | "curve" | "matrix" | "isolation"`), assigned once in `writeReportJson` before every JSON write. `deriveReportMode(report)` falls back to field-presence inference for a report or baseline entry written before the field existed; `describeMode` and `ci-report.ts`'s serializer dispatch both route through it rather than their own inference.
- The "React Optimizations" header and a combo's `Combo #N:` sub-heading print only when that combo has a finding to show.
- `detectAnimations` reports only `document.getAnimations()` entries whose effect target is inside `#root` and whose `playState !== "idle"`: a declared-but-idle Tailwind `transition-all` no longer counts as animation. `classifyTier` treats portal/animation as a **floor** of T3 (`max(sizeTier, T3)`), not an override, so a 2000-node animated table stays T4 and a 30-node animated panel is T3.
- The profiler hook resolves a fiber's name through `React.memo`/`forwardRef` wrappers, in any nesting order and depth-bounded, before falling back to `"Anonymous"`.
- `--help` documents the exit codes (0 pass / 1 verdict fail / 2 setup error), that `--json` becomes a per-component filename template on a multi-component run (the named path is never written), and that `--max-combos` does not bound matrix mode; a multi-component run prints the JSON files it wrote.
- See `specs/milestones/m64-verdict-report-clarity.md`. 105 new tests.

### M65: DX features (done)
**Goal**: Close five gaps every dogfooding worker hit independently before trusting, aiming, or waiting on a measurement.

**Scope**:
- `--explain-props`: resolves and prints the target component, the `file:line` of the declaration its schema bound to, every extracted prop (kind, required flag, value pool, degenerate reason), which prop would drive curve mode or why none would, whether matrix mode would auto-activate, and every extraction warning: no Vite, no browser, no file written. Takes precedence over every other mode flag. `extractPropsDetailed` (an `onWarning` sink parameter, in addition to the unchanged stderr-emitting `extractProps`) backs it.
- Progress heartbeat: one-line markers at pipeline phase boundaries (preflight, harness build, resolved mode, each measurement pass, report write) via `AnalyzeOptions.onProgress`, defaulted to a stdout writer by the CLI and suppressed under `--ci`. No spinner, no timer: every marker fires from a real pipeline point, so deterministic tests stay deterministic.
- `Total: <duration>` (`formatWallClock`) after every terminal report, suppressed under `--ci`.
- Preflight additionally records `PreflightResult.providers`: known provider-library imports (`next-intl`, `react-i18next`, `react-redux`, `@tanstack/react-query`, including sub-paths) and local hook modules shaped like `createContext(` plus a `throw new Error`. Detection alone changes nothing about a healthy run; when M59's render-health gate marks a combo `"error"` (or curve mode's run-warning equivalent fires), `report.providerCandidates` is set and the `renderError` hint names them.
- `<file>#ExportName` targets a specific export: split at parse time (a trailing `#Identifier` after an accepted component extension, so no real path fragment is mistaken for a target), binds M58's prop resolver to that export, disables auto-composition, and fails before any harness exists when the export doesn't exist: naming the file's actual component exports.
- `detectComponentExport` now compares the file stem to export names through the same normalization M58 introduced (`hotspot-image.tsx` → `HotspotImage`), replacing M58's H19.
- See `specs/milestones/m65-dx-features.md`. 71 new tests.

### M66: attribution honesty (done)
**Goal**: Fix two numbers whose printed labels didn't match what they measured.

**Scope**:
- `attributeCost(traces: TraceEvent[] | TraceEvent[][])` accepts either one trace window or a combo's per-sample windows; `buckets[].durationMs` is now the mean scripting time inside one mount, not the sum across every measured mount. `CostAttribution` carries `sampleCount` (windows folded in) and `totalScriptingMs` (the pre-division sum) alongside `buckets`/`unattributed`, so `sum(buckets) === totalScriptingMs / sampleCount` and the breakdown can never exceed the mount it describes. Both call sites (`analyze.ts`, `report.ts`) pass `mount.mountTraces` unflattened.
- The callback-identity probe mounts with the same cached callbacks the stable arm re-renders with: previously a freshly allocated no-op, which changed callback identity in both arms between mount and re-render and made the reported delta pure measurement drift. The two arms interleave by sample parity (stable-then-fresh / fresh-then-stable) rather than running as two separate blocks. A delta is reported only when it clears the machine's own scatter: `delta > max(0.5ms, spread(stable) + spread(fresh))`. `CallbackIdentityDelta` carries `stableMs`/`freshMs` behind the delta. A function React keeps referentially stable (`useReducer` dispatch, `useState` setter, a `useRef`-held callback) now produces no finding.
- See `specs/milestones/m66-attribution-honesty.md`. 42 new tests.

**Does NOT include**: skipping the callback-identity probe entirely for a prop typed `Dispatch<A>` (React guarantees it stable; would need `prop-gen.ts` type knowledge), attribution of interaction traces (open since M16), a `(mean of N mounts)` caption on the printed breakdown.

M67–M73 shipped a portability audit's findings: path-handling defects first, then the workspace-aware project model everything else builds on, then the two resolvers it made possible to unify (config, CSS), then diagnosability and unsupported-setup rejections, then the remaining boot-time guardrails.

### M67: CLI and attribution path correctness (done)
**Goal**: Fix three code-verified path-handling defects: rooted CLI globs matched nothing, a case-insensitive filesystem silently overwrote one of two same-named reports, and pnpm's nested store path misattributed every unbundled dependency's cost.

**Scope**:
- `expandComponentPaths`'s compiled glob (`globToRegExp`) is tested against the walked path normalized relative to `process.cwd()` first, so `src/**/*.tsx` matches whether `PathReader.walk` returns absolute paths (the production `nodePathReader`) or relative ones.
- `resolveReportPaths` case-folds the collision key while keeping the emitted filename's own casing, so `Card.tsx` and `card.tsx` reports never overwrite each other on NTFS/APFS.
- `resolveSource` (`src/metrics.ts`) attributes from the LAST `node_modules/` segment instead of the first, so a pnpm store path (`node_modules/.pnpm/pkg@1.2.3/node_modules/pkg/...`, scoped packages included) attributes to `pkg`; flat installs and Vite's `.vite/deps/` layout are unaffected (exactly one segment, so the switch is a no-op there).
- See `specs/milestones/m67-cli-attribution-path-correctness.md`. 9 new tests.

**Does NOT include**: `~/` expansion for CLI paths (deferred), any change to `src/harness.ts` or the react/package/user/browser cost taxonomy.

### M68: workspace-aware project model (done)
**Goal**: A component inside a workspace member should measure the same as one in a single-package repo. Every question about the project was answered by the nearest `package.json` alone, so a member that declares nothing inherited nothing.

**Scope**:
- New module `src/project-model.ts`: `memberRoot`/`workspaceRoot` two-level model (`resolveProjectModel`, `findWorkspaceRoot` walking upward, bounded at a `.git` ancestor), `declaredPackages`/`isPackageDeclared`/`isPackageAvailable` (declaration, or an install probe from `memberRoot` up to `workspaceRoot`), `findProjectRoot` moved here from `harness.ts` and re-exported.
- Detectors switched to the presence primitive: `detectNextJs`, `detectTailwindVite`, `detectProjectTransforms` (`isPackageAvailable`); `detectReactCompiler` stays declaration-only across both levels, because the compiler rewrites measured code and a hoisted transitive copy is not a statement the project ships it.
- `detectFramework` (`src/react-profiler.ts`): the member manifest decides whenever it names a framework (React wins a tie), else falls back to the workspace manifest and then the install probe; an unreadable/unparsable manifest now fails closed to `vanilla` plus a warning instead of defaulting to `react`.
- `--compare` links `node_modules` at every level from the repo root down to the member (`nodeModulesLinkDirs`/`linkNodeModules`), not just the repo root; `120fps.config.json` falls back from `memberRoot` to `workspaceRoot`; fingerprint sources (`projectConfigFingerprintFiles`) probe both levels; baselines stay keyed at `memberRoot` alone.
- Fixture: `fixtures/workspace-monorepo/` (pnpm workspace, a member declaring nothing of the shared tooling).
- See `specs/milestones/m68-workspace-project-model.md`. 85 new tests.

**Does NOT include**: Yarn PnP resolution, executing the project's `vite.config.*`, tsconfig path/alias resolution across workspace levels (M69), CSS discovery across workspace levels (M71), baselines at the workspace root.

### M69: unified config resolution and import-scanner hardening (done)
**Goal**: The harness should resolve a module the same way the project's own toolchain does, or say why it could not. Two resolvers disagreeing about which tsconfig governs, and a scanner blind to dynamic imports and non-`.ts` targets, were behind most "works in the app, 404s in the harness" reports.

**Scope**:
- `findCompilerConfig(startDir, stopDir?)` (`src/project-model.ts`): one upward walk for `tsconfig.json` then `jsconfig.json`, shared by `loadTsconfigAliases` (bounded by `findWorkspaceRoot`) and prop extraction's `createCompilerOptions` (bounded by the same root, unbounded for a bare temp tree).
- `baseUrl` with no `paths` now yields one alias per resolvable top-level entry (CRA-style bare imports); a wildcard-shape mismatch (`@/*` against a non-wildcard target) yields no alias plus `ALIAS_SHAPE_WARNING`; a stale alias target yields no `optimizeDeps.include` entry plus `BROKEN_ALIAS_WARNING` instead of a phantom package.
- `fsAllowDirs(memberRoot, workspaceRoot, aliases)`: the `server.fs.allow` list, `undefined` (Vite's own default) when every alias target is already inside `memberRoot`.
- Import scanner: dynamic `import()`/`require()` with a string-literal argument, `?query`-stripped specifiers, `.cjs`/`.cts`/`.json` resolution, directory imports via `package.json` `exports`/`main`; only source files are enqueued for further walking.
- `allowJs: true` in `createCompilerOptions` so a `.jsx` target under a project with no config, or one that excludes JS, still extracts.
- See `specs/milestones/m69-config-resolution-and-scanner.md`. 59 new tests.

**Does NOT include**: `baseUrl` fallback when `paths` is also present, template-literal/computed dynamic import specifiers, multiple `paths` targets per pattern, executing `vite.config.*`.

### M70: failure diagnosability plumbing (done)
**Goal**: A failure on an unconventional repo surfaced as a generic 30s timeout with no cause: a CSS 404 or preprocessor 500 killed module evaluation silently, three of four `settleStyles` call sites discarded the settled boolean, and a hard-killed `--compare` run left a dangling worktree registration forever.

**Scope**:
- `attachPageErrorCapture` (`src/page-errors.ts`) gains `requestfailed` and `response` ≥400 listeners feeding the same session/segment buckets the existing `pageerror`/`console` listeners write to; neither sets `segmentFatal`. `enrichTimeoutError`/`gotoWithErrorContext` name a 404'd URL in a timeout message with no changes of their own.
- `reportFontSettle(settled, onWarning?)` (`src/measure.ts`), the one place `FONT_SETTLE_WARNING` is raised from: threaded through `enterHarness`, `explorer.ts`'s `enter`, and `runReactAnalysis` (which writes straight onto the already-flushed `report.warnings`, since it runs after `ctx.attachHarnessContext`).
- `pruneStaleWorktrees(repoRoot)` (`src/compare.ts`): best-effort `git worktree prune` before `git worktree add`, clearing a registration a SIGKILL'd prior `--compare` run left dangling.
- See `specs/milestones/m70-failure-diagnosability.md`. 19 new tests.

**Does NOT include**: retrying or working around a 404/500, a new `PageErrorDrain` field, reordering `runComboMode`'s `attachHarnessContext` call, a periodic worktree sweep independent of `--compare`, wiring `onWarning` through `src/isolation.ts` (shipped in M73).

### M71: evidence-driven CSS discovery and vite.config data recovery (done)
**Goal**: Stylesheet discovery was a filename allowlist that missed a create-vite app, any `.scss` entry, or anything reachable only through the project's own entry module; `vite.config.*` was never read, so a moved `publicDir` or a literal `resolve.alias` was lost silently.

**Scope**:
- `discoverGlobalCss`: priority order, first layer to yield at least one validated file wins — explicit `--css`, then the entry import graph (`findProjectEntry` + `entryStylesheetImports`, tsconfig-alias-resolved, preprocessor-gated via `sass`/`less`/`stylus` availability), then the extended filename-candidate list (`GLOBAL_CSS_CANDIDATES`, now 18 entries), then a bounded `largestStylesheet` fallback that warns it guessed. Auto-detection can now inject more than one file, in import order.
- `resolveStyleTooling(projectRoot)` decouples the Tailwind plugin gate from whether a stylesheet was found, and adds unreplicated-styling-engine disclosure (`detectUnsupportedStyleEngines`: unocss, linaria, panda) and workspace-inherited PostCSS config discovery (`findPostcssConfigAbove`, verified against a gap in Vite's own `searchForWorkspaceRoot`).
- `readViteConfigData`: `vite.config.*` read as text and parsed with `ts.createSourceFile`, never imported or executed; recovers a literal `publicDir` and `resolve.alias` entries (merged after tsconfig aliases, before Next.js shims); an ignored key (`css.preprocessorOptions`, a non-empty `plugins` array, a non-literal value, an unreachable exported object) is named in one `VITE_CONFIG_IGNORED_WARNING`.
- `readEnvDefines`: `.env`/`.env.local` at the workspace root then the member root, only `NEXT_PUBLIC_*`/`VITE_*` keys defined as `process.env.<KEY>` in the browser, verified against Vite's own dev-mode `define` gap (`process.env` is otherwise undefined in client dev source).
- Fixture: `fixtures/vite-app/`.
- See `specs/milestones/m71-css-discovery-and-vite-config-data.md`. 102 new tests.

**Does NOT include**: executing/importing/bundling `vite.config.*`, `css.preprocessorOptions` passthrough, Nuxt's `css` array, CDN Tailwind/`twin.macro`, a deep walk of the entry's import graph past the entry file itself.

### M72: unsupported-setup detection and clear rejections (done)
**Goal**: A handful of unsupported setups failed with confusing errors instead of naming themselves: a Solid component died deep inside a React-flavored compile, a Yarn PnP install failed with a raw resolution error, an old Node binary was stopped only by an advisory `engines` field, and four routing/framework libraries threw context errors with no hint a missing provider was the cause.

**Scope**:
- `runPreflight` gains an environment-level check before the import-graph walk: a project declaring `solid-js` and neither `react` nor `react-dom` gets a hard `"unsupported-framework"` hit; a project declaring both gets a non-fatal `SOLID_AND_REACT_DECLARED` warning from `detectFramework` instead.
- `detectPnP(workspaceRoot)` (`.pnp.cjs`/`.pnp.loader.mjs`/`process.versions.pnp`): a hard `"yarn-pnp"` hit, unconditionally.
- `resolveReactDomIdentity(harnessDir)` + `isSupportedReactDomVersion` (`src/react-profiler.ts`): `runReactAnalysis` resolves `react-dom/package.json`'s own `name` before opening a browser; anything other than genuine `react-dom` (including an npm/pnpm alias to Preact) returns an empty result map with a warning and no browser opened; a resolved version outside 16.5–19.x still runs but additionally warns.
- `nodeVersionError(version)`/`MIN_NODE_MAJOR` (22): `main()`'s first statement, before `parseArgs`; exits 2 below the floor.
- `PROVIDER_LIBRARIES` gains six routing/meta-framework entries (react-router, react-router-dom, `@remix-run/react`, gatsby, `@tanstack/react-router`, `@tanstack/react-start`); `next/server-only` dropped from `SERVER_ONLY_PACKAGES` (never a real module).
- See `specs/milestones/m72-unsupported-setup-gates.md`. 33 new tests.

**Does NOT include**: rendering support for Solid/Svelte, full Yarn PnP resolution, JSDoc prop extraction for JS-only projects, a structured Playwright-missing-executable detector, any change to the `--no-preflight` bypass mechanism.

### M73: harness boot guardrails and Next.js shim coverage (done)
**Goal**: The remaining portability failures in `buildAndServe` surfaced as somebody else's error: a read-only project root failed with a raw `EACCES`, a React 17 project failed with an esbuild resolution dump, and a cross-drive `--wrap` path passed the root guard and then emitted an import specifier naming a directory that does not exist.

**Scope**:
- `createHarnessDir(projectRoot)`: preflights writability (`fs.accessSync(..., W_OK)`), wraps the real `mkdtempSync` too; any failure throws `HARNESS_DIR_UNWRITABLE` naming the directory, the in-root requirement, and the two ways out.
- `assertReactDomClient(projectRoot)`: resolves `react-dom/client` before the server boots; failure throws `REACT_DOM_CLIENT_MISSING` naming the required and found React versions. Vue runs never see the gate.
- `isOutsideRoot(target, root, platform?)`: the single cross-drive-safe predicate (`path.win32.relative` returns an absolute path with no `..` prefix across drives, which two call sites had read as relative). `componentImportPath` routes an out-of-root component through `/@fs/`; `resolveWrapper` now rejects a cross-drive `--wrap` correctly; `fsAllowDirs` gains an `extraDirs` parameter for the component's directory when `/@fs/` engages.
- Four more Next.js shims (`SHIM_MODULES` now 10 entries): `next/script`/`next/head` render null, `next/router` returns inert `useRouter` stubs, `next/font/local` returns an empty style object. `next/font/google` is deliberately never shimmed (unbounded named exports); any other unshimmed `next/*` import is named once via `unshimmedNextModules` + `UNSUPPORTED_NEXT_MODULE_WARNING`, never blocking.
- `PhaseOptions.onWarning`/`IsolationRunOptions.onWarning` close the M70 gap for isolated churn/memory/strictmode phases; `detectPnP` joins `src/index.ts`'s `project-model.js` export block.
- See `specs/milestones/m73-boot-guardrails-and-shims.md`. 42 new tests.

**Does NOT include**: server-component emulation, `next/cache` shims, `next/font/google`, Remix/Gatsby shims, rewriting the project's own imports.

## Risks
| risk | mitigation |
|---|---|
| TS Compiler slow on complex generics | HOC chains are naturally shallow; no depth cap needed in practice |
| Prop combo explosion | Cap 64, stratified sampling |
| Import fails (aliases, CSS) | Vite handles tsconfig paths, CSS, assets |
| Harness temp dir can't find deps | Harness placed inside project root for natural dependency resolution |
| Exploration non-termination | 200 nodes, 60s, convergence check |
| Machine variance | 4× CPU throttle + calibration component |

## NFRs
- <60s for typical component (5 prop combos, 10 interactions).
- Zero config for a typed React `.tsx`/`.jsx` or a Vue `.vue` SFC with tsconfig.json.
- Supports optional fixture files for composed components and parameterized scaling.
- No source file modification.
- Additive-only JSON schema across versions.
