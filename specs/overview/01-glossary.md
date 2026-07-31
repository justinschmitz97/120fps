---
kind: overview
status: approved
---

| term | definition |
|---|---|
| PropSchema | One prop's type info: `{ name, kind, values, required }`. Kind is `"boolean"|"string"|"number"|"union"|"array"|"function"|"reactnode"|"object"|"unknown"`. Used by `detectScalingProps` for auto-scaling detection. |
| PropCombination | `Record<string, unknown>`. Concrete prop key-value set for one render. |
| Stratified sampling | When cartesian product >64, select combos covering each value ≥1× while capping total. Seeded PRNG (42) fills remaining budget. |
| HarnessResult | `{ url, server: ViteDevServer, componentPath, harnessDir, cleanup, component: ComponentIdentity, nextJsShims?, wrapPath?, wrapRelative?, cssFiles?, reactCompiler? }`. Return value of `buildAndServe()`. |
| ComponentIdentity | `{ relative, name, isDefaultExport }`. The component the entry mounts, carried on `HarnessResult` so the React probe entry does not re-parse the generated entry. On the composed path, `name` is the composition root. |
| Control API | `window.__120fps`: `mount(props)`, `mountWrapperOnly()`, `unmount()`, `rerender(props)`, `getContainer()`, plus `viewport` when the provider wrapper exports one. Harness exposes these for CDP-driven measurement. |
| Provider wrapper | User-authored module default-exporting a `{ children }` component, rendered around the component under test so context-dependent components mount. Resolved from `--wrap <path>` or auto-detected as `120fps.setup.{tsx,jsx,ts,js}` at the project root; disabled with `--no-wrap`. Imported before the component so its top-level side effects (CSS import, `data-theme`) run first. |
| renderTree | Entry-template helper `(el) => root.render(wrap ? createElement(wrap, null, inStrict(el)) : inStrict(el))`. Single render site per entry; every mount/rerender/scale path routes through it, so a wrapper applies once even to an auto-scale fan-out. `renderTreeHelper(wrapRelative, strict?)` emits the StrictMode form only for the two measurement templates; the React probe entry keeps the plain one. |
| `__120fpsInStrict` | Entry-template helper wrapping the tree in `React.StrictMode` when the page URL carries `?strict=1`, and returning it untouched otherwise. Nests inside the provider wrapper, so the measured double-invoke cost is the component's rather than the providers'. Named to avoid the `__120fpsWrap` prefix, which an entry without a wrapper must never contain. |
| detectWrapper | `detectWrapper(projectRoot)` → `string \| undefined`. Probes `120fps.setup.tsx`, `.jsx`, `.ts`, `.js` in that order; first file hit wins. |
| WrapperReport | `{ path, autoDetected, overheadMs, domNodes }` on `Report.wrapper`. `path` is projectRoot-relative posix. `attachWrapperReport()` sets it and appends warnings when `overheadMs >= 1` or `domNodes > 0`. |
| measureWrapperOverhead | `measureWrapperOverhead(page, cdp, samples)` → `{ overheadMs, domNodes }`. 2 discarded warmups, then per sample: GC → traced `mountWrapperOnly()` + double-rAF → untraced `unmount()`. `domNodes` is the wrapper-only node delta, clamped to ≥ 0. |
| applyWrapperViewport | `applyWrapperViewport(page)`. Reads `window.__120fps.viewport` in the browser and applies it via `page.setViewportSize` after the readiness gate, before throttle and warmup. Non-numeric or non-positive values are ignored. |
| Stylesheet injection | Global stylesheets emitted as side-effect imports at the top of the generated entry, ahead of the React, wrapper, and component imports. Resolved from `--css <path,...>` or auto-detected by `detectGlobalCss`; disabled with `--no-css`. Root-absolute specifier inside `projectRoot`, `/@fs/<abs>` outside it. `index.html` is never touched. |
| detectGlobalCss | `detectGlobalCss(projectRoot)` → `string \| undefined`. Probes `app/globals.css`, `app/global.css`, `src/app/globals.css`, `src/app/global.css`, `src/styles/globals.css`, `styles/globals.css`, `src/index.css`, `src/global.css` in that order; first existing file wins; directories are skipped. Returns at most one file. |
| resolveCssFiles | `resolveCssFiles(options, projectRoot)` → `{ files, autoDetected }` with absolute paths. `noCss` wins over explicit paths and skips their validation. Explicit paths resolve against `process.cwd()`, dedupe by resolved path keeping first position, and suppress detection; an empty explicit list falls through to detection. Missing → `Stylesheet not found: <path>`; non-file → `Stylesheet is not a file: <path>`. |
| cssImportSpecifier | `cssImportSpecifier(cssFile, projectRoot)` → `string`. Posix specifier for the entry import: `/<relative>` when the file is inside `projectRoot`, `/@fs/<absolute>` otherwise (drive letter preserved, spaces kept). |
| CssReport | `{ files: string[], autoDetected: boolean }` on `Report.css`. `files` are projectRoot-relative posix paths in injection order. Absent when nothing was injected. Rendered by `formatTable` as a `Stylesheets:` header line and passed to `buildEnvFingerprint` as `css`. |
| detectTailwindVite | `detectTailwindVite(projectRoot)` → `boolean`. Checks `package.json` dependencies/devDependencies for `@tailwindcss/vite`. |
| loadTailwindVitePlugin | `loadTailwindVitePlugin(projectRoot)` → `Promise<unknown[]>`. Resolves and imports `@tailwindcss/vite` from the project's own `node_modules` via `createRequire(projectRoot + "/")` and calls its default export. Any failure writes one stderr warning and returns `[]`. Only called when injection is active. A project `postcss.config.*` still runs alongside it. |
| React Compiler transform | `@vitejs/plugin-react` added to the harness Vite config with `babel.plugins: [[<project-resolved babel-plugin-react-compiler>, {}]]`, so a project that ships compiled code is measured compiled. Added if and only if the transform is active, appended after M25's Tailwind plugin. `--react-compiler` forces it on, `--no-react-compiler` off, otherwise `detectReactCompiler` decides. |
| detectReactCompiler | `detectReactCompiler(projectRoot)` → `boolean`. True iff `babel-plugin-react-compiler` is a key of `dependencies`, `devDependencies` or `peerDependencies` in `<projectRoot>/package.json`. Missing, unparseable or non-object manifests, and non-object dependency sections, read as absent. `next.config.*` is never parsed. |
| resolveReactCompiler | `resolveReactCompiler(projectRoot)` → `{ pluginPath?, version? }`. Resolves `babel-plugin-react-compiler` through `createRequire(projectRoot + "/")` so the project's own copy is used. `version` comes from the first `package.json` above the resolved entry, and only when its `name` matches. Any resolution failure returns `{}`. |
| ReactCompilerState | `{ detected, active, version?, pluginPath?, warning? }` on `HarnessResult.reactCompiler`. Carries at most one warning, so the disabled note and the resolution note can never both reach a report. Forced on with nothing resolvable throws `babel-plugin-react-compiler not found in <projectRoot>` before the harness directory is created. |
| loadReactCompilerPlugin | `loadReactCompilerPlugin(pluginPath)` → `Promise<unknown[]>`. Dynamically imports `@vitejs/plugin-react` (a 120fps dependency) and calls it with the compiler path as a babel plugin. Dynamic so an uncompiled run never loads `@babel/core`. |
| reactCompilerRuntimeDeps | `reactCompilerRuntimeDeps(projectRoot)` → `string[]`. `["react/compiler-runtime"]` when the project resolves it, else `[]`. Added to `optimizeDeps.include` while the transform is active: compiled output imports that module, and leaving it undeclared makes Vite re-optimize and full-reload on the first page load. |
| ReactCompilerReport | `{ active, detected, version? }` on `Report.reactCompiler`. Present whenever the compiler was detected or ran. `formatTable` prints `React Compiler: active (v<version>)` only when `active`. |
| Settle gate | `settleStyles(page, harness)`. Armed by `needsStyleSettle` when stylesheets are injected or a provider wrapper is active. Awaits `document.fonts.ready` bounded by `FONT_SETTLE_TIMEOUT_MS` (5000), then forces one layout and waits two rAF ticks; returns whether fonts settled. Runs in all five browser sessions after `applyWrapperViewport` and before CPU throttling. A missing `document.fonts` skips straight through. A timeout is non-fatal: `analyze()` appends `FONT_SETTLE_WARNING` to `Report.warnings`. |
| HARNESS_NAV_WAIT | `"domcontentloaded"`. Navigation wait for every harness `page.goto`. Readiness is `window.__120fps`; the `load` event is unusable because a stylesheet whose webfont never answers keeps it pending. |
| enterHarness | `enterHarness(page, cdp, harness, errorCapture, { label, cpuThrottle?, search? })`. The session preamble: navigate to `harness.url + search` → `window.__120fps` readiness gate (30s, `enrichTimeoutError` with `label`) → `applyWrapperViewport` → `settleStyles` → `Emulation.setCPUThrottlingRate`. Re-runnable, so a pass that navigates mid-session repeats all of it. |
| runHarnessSession | `runHarnessSession(harness, options, body)`. Launches a browser, opens a page with error capture and a CDP session, runs `enterHarness`, then calls `body(page, cdp, enter)` and closes the browser in `finally`. `enter(search?)` re-navigates within the same page. |
| reactJsxRuntimeDeps | `reactJsxRuntimeDeps(projectRoot)` → `string[]`. `react/jsx-runtime` and `react/jsx-dev-runtime` when the project resolves them, else `[]`. Added to `optimizeDeps.include`: Vite transforms the generated entry with the automatic JSX runtime, and leaving the import undeclared makes Vite optimize and full-reload on the first page load of a cold project, destroying the execution context mid-measurement. |
| InteractionType | `"click" | "type" | "select" | "focus" | "keyboard" | "hover"`. Categorizes how an element is exercised. |
| InteractionDescriptor | `{ type: InteractionType, selector: string, tagName: string, label: string, role?: string, inputType?: string, portal?: boolean, triggeredBy?: string }`. One interactive element found by discovery. |
| DiscoverOptions | `{ probePortals?: boolean; remount?: () => Promise<void> }`. Passed to `discoverInteractions` to enable trigger-first portal probing. |
| InteractionReport | `{ selector, type, label, timing: TimingWithCV, relativeTiming, portal?: boolean, stressPattern?: string }`. Per-interaction entry in a `ComboReport`. |
| StateGraph | Directed graph. Nodes = unique DOM states (by hash). Edges = interactions with cost (samples, median, P95, traces). |
| StateNode | `{ id, depth, interactions: InteractionDescriptor[], pathFromRoot: PathStep[] }`. One DOM state in the graph. |
| StateEdge | `{ id, fromId, toId, interaction, samples, median, p95, traces, stressPattern? }`. Transition between two DOM states via an interaction. |
| PathStep | `{ interaction: InteractionDescriptor }`. One step in the path from graph root to a state node. |
| ExploreResult | `{ graph: StateGraph, comboIndex: number, props: PropCombination }`. Exploration output for one prop combo. |
| ExploreOptions | `{ samples?, maxNodes?, maxWallClockMs?, maxDepth?, cpuThrottle?, warmupRuns?, seed?, combos? }`. Configuration for `explore()`. |
| DOM hash | FNV-1a hash of `#root` innerHTML. Identifies unique DOM states in the state graph. |
| Convergence | Last 10 explorations all yield no new state nodes → stop. Binary check, not percentage. |
| Adaptive deepening | Edge P95 > 1.5× global median edge cost → explore resulting state at priority. |
| TraceEvent | `{ cat?, name?, dur?, ph?, ts?, args? }`. Single event from a CDP trace recording. |
| CDP trace | `Tracing.start/end` capture. µs-resolution: paint, layout, style recalc, scripting, frames. Collected via `Tracing.dataCollected` chunks. |
| CdpMetrics | Full metric extraction: paintCount/Duration, layoutCount/Duration, styleRecalcCount/Duration, scriptDuration, totalDuration, longTasks, frames, jankFrameCount, droppedFrameCount, layoutShiftScore, domNodeCount, heapDelta. |
| ParseMetricsOptions | `{ filterToMarks?: boolean }`. When true, scopes metrics to `__120fps_start`/`__120fps_end` performance marks. |
| TimingResult | `{ samples: number[], median: number, p95: number }`. Raw timing data from N measurement samples. |
| MountResult | Per-combo measurement: `{ comboIndex, props, mount: TimingResult, unmount: TimingResult, domNodeCount, heapDelta?, hasAnimation? }`. |
| detectAnimations | `detectAnimations(page: Page): Promise<boolean>`. Browser-side detection of CSS animations and layout-affecting transitions scoped to `#root`. Three signals: running Web Animations API animations, declared CSS `animation-name`, layout-affecting `transition-property` (transform, opacity, height, width, max-height, max-width, all) with non-zero duration. |
| RerenderResult | Per-combo rerender measurement: `{ comboIndex, props, stable: TimingResult, change?: TimingResult, changeToProps? }`. |
| MeasureOptions | `{ samples?, cpuThrottle?, combos?, warmupRuns? }`. Configuration for `measureMount()`. |
| MeasureRerenderOptions | `{ samples?, cpuThrottle?, warmupRuns?, combos? }`. Configuration for `measureRerender()`. |
| Nesting stack | Timestamp-based mechanism in `parseTraceDuration` that prevents double-counting child trace events within parent spans. |
| Long task | Scripting span >50ms. Detected from FunctionCall/EvaluateScript/v8.compile/v8.run trace events. |
| LongTask | `{ startTime: number, duration: number }`. One long task extracted from trace events. |
| FrameTiming | `{ timestamp: number, duration: number }`. One frame's timing from trace events. |
| Jank frame | Frame duration >16.67ms (1/60s). Indicates dropped frames. |
| INP | Interaction to Next Paint. Max latency between last user input event and next Paint event across all traces. |
| Layout shift | CLS-style score from LayoutShift trace events. Cumulative sum of per-shift scores. |
| ScalingCurve | `{ slope, intercept, r2, growthClass }`. Growth class: `"constant"|"linear"|"quadratic"|"exponential"`. Best-fit from linear/quadratic/exponential regression. |
| Calibration component | Known-cost reference (1000-element DOM insert + forced layout). Machine baseline → relative scoring. |
| CalibrationResult | `{ totalDuration: number, scriptDuration: number }`. Baseline from calibration trace. |
| MachineInfo | `{ cpu, cores, ramMb, os, nodeVersion, chromiumVersion }`. Collected at analysis start for cross-machine comparability. |
| EnvFingerprint | `{ shape: 1, cpu, cores, os, nodeVersion, chromiumVersion, cpuThrottle, samples, calibrationTotalDuration, calibrationScriptDuration, mode, css?, wrapper?, reactCompiler? }`. Persisted on `BaselineEntry.env`, describing the machine and configuration that produced the entry. `shape` versions the fingerprint independently of `Baseline.version`. Feature fields are omitted when inactive. |
| buildEnvFingerprint | `buildEnvFingerprint(input)` → `EnvFingerprint`. Records the run's effective `samples`/`cpuThrottle`, not CLI defaults. Omits `css` when empty, `wrapper` when absent, `reactCompiler` when undefined. |
| EnvMatch | `"identical" \| "normalizable" \| "incompatible" \| "unknown"`. How a baseline entry's environment relates to the current run. |
| classifyEnv | `classifyEnv(baseline, current)` → `EnvMatch`. Pure. No baseline fingerprint → `unknown`. Differing `mode`/`css`/`wrapper`/`reactCompiler` → `incompatible`. Matching `cpu`/`cores`/`os`/`chromiumVersion`/`cpuThrottle`/`samples` with calibration within 10% → `identical`. Otherwise `normalizable`. `nodeVersion` is never classified. |
| describeEnvDiff | `describeEnvDiff(baseline, current)` → `string[]`. Field-level difference text behind a classification, feature fields first. Empty for `identical`; `["baseline has no environment record"]` when the baseline has none. |
| envAdvisory | `envAdvisory(match, mismatches, policy)` → `{ warning?, fail }`. Single decision point for the environment warning and for `--baseline-env strict` check failure. |
| Calibration-normalized comparison | For a `normalizable` pair, each metric is divided by its own run's `calibrationTotalDuration` before the tolerance test, and a regression additionally requires a raw delta above 0.5 ms. Falls back to raw when either calibration value is not a finite positive number. |
| BaselineComparison | `{ hasBaseline, regressions, improvements, missingInteractions, envMatch, envMismatches }` on `Report.baseline`. `incompatible` yields empty regressions/improvements and never fails the run. |
| BaselineMetrics | `{ mount, rerender, unmount, domNodeCount, interactions, unstable: Set<string>, tier }`. What one run contributes to a baseline. The combo path builds it from `combos[0]`, the isolation path from `Report.isolation` with an empty interactions map; `applyBaselineWorkflow` consumes both. |
| Isolation phase | One of `mount`, `rerender`, `unmount`, `memory`, `strictmode`. Each runs as a self-contained browser pass; mount and unmount share one. `parseIsolationPhases(raw)` validates and expands `all` anywhere in the list, deduplicating into that canonical order. |
| selectIsolationCombos | `selectIsolationCombos(combos)` → `{ comboA, comboB, degenerate }`. Drops `__120fps_scaleN` combos, takes the first two that remain, and falls back to `{}` when none do. `degenerate` means fewer than two usable combos, so prop-change and churn measure stable rerenders and `Report.warnings` says so. |
| measureChurn | `measureChurn(harness, propsA, propsB, cycles, options?)` → `number[]`. Untimed mount with `propsA`, warmup, remount, then `cycles` traced `B`-then-`A` rerenders producing `cycles * 2` samples in execution order. No GC between iterations: accumulated pressure is the subject. |
| measureMemory | `measureMemory(harness, cycles, props, options?)` → `{ heapBefore, heapAfter, gcPressure } \| undefined`. 10 warmup cycles → forced GC → `heapBefore` → `cycles` mount/unmount → forced GC → `heapAfter`. `undefined` when `HeapProfiler.collectGarbage` is unavailable, which skips the phase with a warning. |
| measureStrictMode | `measureStrictMode(harness, props, options?)` → `{ normal, strict }`. Interleaved pairs, re-navigating to no query and to `?strict=1` and re-running the preamble before each sample, so both series see the same machine conditions. Navigation and warmup sit outside the traced window. |
| gcPressure | Count of the periodic checks (every 5 memory cycles) where a forced GC left the heap more than 10% above `heapBefore`. Zero for a component that releases what it mounts, all checks for one that retains them. Not a GC pause time. |
| Isolation verdict | `computeIsolationVerdict(isolation, mountBudgetMs)` → `pass`. False when the isolated mount median exceeds the budget, when `memory.leakSuspected`, or when `churnDegradation > 2.0`. `doubleInvokeClean: false` warns and never fails. Discovery does not run, so `hasPortal` is false and a portal component is tiered by DOM count alone; `--flat-thresholds`, `--threshold-mount`, or a config budget is the escape hatch. |
| BaselineEnvPolicy | `"strict" \| "normalize" \| "ignore"` from `--baseline-env` (default `normalize`). `strict` fails the check on anything but `identical`; `ignore` skips classification entirely and compares raw. |
| 4× CPU throttle | Playwright CPU slowdown for cross-machine comparability. |
| Scaling curve (parameterized) | For fixtures with `scale(n)` export: measurements at default scale points `[1, 5, 20, 50]`. For raw components (no fixture, no composition): scale combos `[1, 5, 20, 50]` always appended to prop combos via `__120fps_scaleN`. For non-parameterized runs: scaling curves computed across combos with ≥2 distinct DOM node counts. |
| TimingWithCV | Extends TimingResult with `cv: number` and `unstable: boolean` (cv>15%). |
| CV | Coefficient of variation: `stddev / |mean| × 100`. Measures timing stability across samples. |
| ComponentTier | `"T1" \| "T2" \| "T3" \| "T4"`. Auto-classification based on DOM complexity, portals, and animations. |
| TierBudget | `{ mountMs, rerenderMs, interactionMs }`. Per-tier performance budget thresholds. |
| TIER_BUDGETS | Constant: T1 (14/10/250ms), T2 (44/30/300ms), T3 (60/36/350ms), T4 (80/48/400ms). Calibrated for 4x CPU throttle with real-world Radix/React framework overhead. |
| classifyTier | `classifyTier(info)` → `ComponentTier`. Pure function: portal or animation → T3, ≤10 DOM → T1, ≤40 DOM → T2, else → T4. `hasScaling` parameter accepted but ignored. |
| ComboReport | Per-prop-combination report: `{ comboIndex, props, mount, unmount, rerender, rerenderChange?, domNodeCount, heapDelta, interactions: InteractionReport[], scalingCurve: ScalingCurve | null, rerenderScalingCurve?, relativeMount, verdict, tier?, hasAnimation?, costAttribution?, reactOptimizations? }`. |
| Report | Top-level output: `{ version: 1, timestamp, componentPath, componentName, machine, calibration, combos: ComboReport[], thresholds, pass, fixturePath?, fixtureAutoDetected?, propDeltas?, autoScalingProp?, autoScalingReason?, tieredBudgets?, autoComposition?, compositionTree?, nextJsShims?, scalingCurveReport?, matrixReport?, baseline?, isolation?, wrapper?, css?, reactCompiler?, warnings? }`. |
| Thresholds | Pass/fail gates: `{ mountMs: 50, interactionMs: 400, relativeMount: 2.0, rerenderMs: 16 }` (defaults). Overridden by tier budgets when active. |
| DEFAULT_THRESHOLDS | Exported constant from `report.ts` with the default threshold values. |
| Verdict | Per-combo classification: `pass` (within thresholds, stable), `warn` (within thresholds, unstable CV>15% or rerenderChange exceeds budget with tier budgets), `fail` (exceeds any threshold). When tiered budgets active: mount/rerender/interaction use per-tier budget; rerenderChange exceeding 1.5× rerender budget produces `warn` (not `fail`); relativeMount exceeding threshold produces `warn` (not `fail`). |
| ScalingPropMatch | `{ schema: PropSchema, kind: "numeric" | "array", reason: string }`. One auto-detected scaling-eligible prop. |
| detectScalingProps | `detectScalingProps(schemas)` → `ScalingPropMatch[]`. Detects array/numeric props suitable for auto-scaling sweeps. Priority: items-like array > plain array > named numeric > shorthand numeric. |
| generateScalingCombos | `generateScalingCombos(schemas, match, scalePoints)` → `PropCombination[]`. Generates combos with scaling prop set to each scale point, other props at anchor values. |
| AnalyzeOptions | `{ samples?, cpuThrottle?, warmupRuns?, seed?, jsonPath?, ci?, thresholds?, fixturePath?, scalePoints?, skipDeltas?, skipAutoScale?, skipAttribution?, skipAutoCompose?, skipReactAnalysis?, framework?, flatThresholds?, noShims?, curveMode?, matrixMode?, saveBaseline?, check?, noBaseline?, baselineEnv?, isolation?, wrapPath?, noWrap?, cssFiles?, noCss?, reactCompiler? }`. Configuration for `analyze()`. `isolation` is `{ phases: string[], memoryCycles? }`; an empty phase list throws. |
| resolveWrapPath | `resolveWrapPath(options, projectRoot)` → `{ wrapPath?, wrapAutoDetected }`. `noWrap` wins over an explicit `wrapPath`; a missing explicit path throws `Wrapper module not found: <path>`. |
| BuildReportInput | `{ componentPath, componentName, machine, calibration, mounts, explores, heapDeltas, thresholds, fixturePath?, fixtureAutoDetected?, rerenders?, flatThresholds?, explicitThresholds?, skipAttribution?, propDeltas?, autoScalingProp?, autoScalingReason?, autoComposition?, compositionTree?, reactAnalysis? }`. Input to `buildReport()`. |
| CliArgs | `{ componentPath?, componentPaths?, fixturePath?, jsonPath, jsonExplicit?, ci, samples?, thresholdMount?, thresholdInteraction?, thresholdRerender?, scale?, noDeltas?, noAutoScale?, noAttribution?, noAutoCompose?, noReactAnalysis?, framework?, flatThresholds?, noShims?, curve?, noCurve?, matrix?, noMatrix?, saveBaseline?, check?, budget?, noBaseline?, baselineEnv?, isolate?, memoryCycles?, noIsolate?, wrapPath?, noWrap?, css?, noCss?, help, version, error? }`. Parsed CLI arguments. |
| analyze() | Full pipeline orchestrator: harness → calibration → mount → rerender → explore → report → JSON. |
| Fixture | User-authored `.fixture.tsx` file that default-exports a composed React scene for measurement. Bypasses prop extraction; scene is self-contained with representative children and state. |
| Rerender | Prop-driven re-render via `__120fps.rerender(props)`. Measured as stable (same props) and change (different props). `ComboReport.rerender` is always present. |
| Scale function | Optional `export function scale(n: number) => JSX.Element` in a fixture file. When detected, pipeline calls it at each scale point to produce multiple combos with increasing item counts. |
| Scale points | Array of integers `[1, 5, 20, 50]` (default) controlling how many instances to render. For fixtures with `scale()`: calls scale function. For raw components: renders N instances via `__120fps_scaleN`. Override via `--scale`. |
| scanExternalDeps | `scanExternalDeps(entryPath, projectRoot, aliases)` → `string[]`. Recursively follows local imports (relative, tsconfig-aliased, shim-aliased) to discover all transitive external package dependencies. Run from the component and, when active, the provider wrapper; the union feeds Vite `optimizeDeps.include` to prevent reload races and on-demand optimize stalls inside measured samples. |
| loadTsconfigAliases | `loadTsconfigAliases(projectRoot)` → `Array<{ find: RegExp, replacement: string }>`. Parses `tsconfig.json` `compilerOptions.paths` into Vite-compatible resolve aliases. Handles JSON comments. |
| Portal | React `createPortal` content rendered into `document.body` outside `#root`. Discovered by walking body children that are not `#root` and not framework internals (SCRIPT, STYLE, LINK, NOSCRIPT). |
| Portal probing | Trigger-first discovery: exercise triggers with `aria-haspopup` to reveal gated portal content. Uses 2-rAF fast path + 2s MutationObserver slow path. |
| fnv1aHash | 32-bit FNV-1a hash function. Used for DOM state fingerprinting. Exported from `explorer.ts`. |
| createRng | `createRng(seed: number): () => number`. Seeded LCG PRNG for deterministic exploration ordering. |
| collectTrace | `collectTrace(cdp, action)`. Records CDP Tracing data around an async action. Returns `TraceEvent[]`. |
| linearRegression | `linearRegression(points: {x,y}[])` → `{ slope, intercept, r2 }`. Least-squares fit utility used by scaling curve analysis. |
| buildTimingWithCV | `buildTimingWithCV(samples)` → `TimingWithCV`. Wraps raw samples with median, P95, CV, unstable flag. |
| computeVerdict | `computeVerdict(combo, thresholds, options?)` → `"pass"|"warn"|"fail"`. Evaluates a combo against threshold gates. Optional `tierBudget` overrides flat thresholds for mount/rerender/interaction. |
| formatTable | `formatTable(report)` → `string`. Terminal-friendly summary table with combos, timings, interactions, verdicts. |
| buildReport | `buildReport(input: BuildReportInput)` → `Report`. Constructs the full report from raw measurements. |
| StressStep | `{ action: "click"|"type"|"fill"|"keyboard"|"hover"|"focus"|"select"|"pointer-drag", selector, key?, text?, repeat?, moveCount?, direction?: "horizontal"|"vertical" }`. One action within a stress pattern. |
| StressPattern | `{ name: string, steps: StressStep[] }`. Named sequence of stress steps applied to an interaction during measurement. |
| resolveStressPattern | `resolveStressPattern(descriptor, siblingSelectors?)` → `StressPattern`. Pure dispatch: selects pattern by role+type+context. |
| executeStressPattern | `executeStressPattern(page, pattern)` → `Promise<void>`. Runs stress steps in the browser with double-rAF settle between each. |
| findAriaGroupSiblings | `findAriaGroupSiblings(page, descriptor)` → `Promise<string[]>`. Queries ARIA container parents to find sibling selectors. |
| Stress pattern library | Seven patterns: pointer-drag, keyboard-sweep, hover-sweep, open-close-10, multi-keystroke, rapid-toggle-11, single-shot (fallback). Pointer-drag has highest dispatch priority. |
| isDragTarget | `isDragTarget(descriptor)` → `boolean`. Pure detection: `role="slider"`, `inputType="range"`, `ariaValueNow`, cursor in `DRAG_CURSORS` (grab, col-resize, row-resize). |
| DRAG_CURSORS | Set of CSS cursor values that trigger pointer-drag: `grab`, `col-resize`, `row-resize`. |
| CostAttribution | `{ buckets: CostBucket[], unattributed: number }`. Result of `attributeCost()`. |
| CostBucket | `{ source: string, durationMs: number, percentage: number, category: "user" \| "package" \| "react" \| "browser" }`. One cost bucket in attribution results. |
| attributeCost | `attributeCost(events: TraceEvent[])` → `CostAttribution`. Parses scripting trace events, resolves Vite-transformed URLs to source packages, applies nesting-aware deduplication, groups by source. |
| MountResult.mountTraces | `TraceEvent[][]`. Raw CDP trace events from each mount sample, preserved for cost attribution. |
| ExportInfo | `{ name: string, isDefault: boolean }`. One component export found by `extractExports`. |
| CompositionTree | `{ root: string, structure: CompositionNode[], repeatNode?: string, repeatCount: number }`. Auto-inferred nesting structure for multi-export components. |
| CompositionNode | `{ component: string, props: PropCombination, children: CompositionNode[] }`. Recursive tree node describing one component in the composed scene. |
| CompositionTemplate | `"item-based" \| "list-based" \| "portal-based" \| "flat"`. Template selected by suffix analysis. |
| inferComposition | `inferComposition(exports, schemas)` → `CompositionTree \| null`. Pure function: prefix grouping → suffix taxonomy → template construction. |
| extractExports | `extractExports(filePath)` → `ExportInfo[]`. TS Compiler API extraction of all PascalCase component exports. |
| extractAllProps | `extractAllProps(filePath)` → `Map<string, PropSchema[]>`. Per-export prop schema extraction. |
| compositionToJsx | `compositionToJsx(tree)` → `string`. Renders a CompositionTree as JSX source code. |
| ReactOptimizations | `{ memoBailout, memoBailoutComponents?, contextFanOut, contextFanOutComponents?, callbackIdentityDeltas?, portalOrphans?, renderAttribution?, durationsUnavailable?, compilerActive? }`. React-specific optimization findings per combo. `compilerActive` is set on every result when the React Compiler transform ran. |
| FiberInfo | `{ name, renderCount, actualDurationMs, selfDurationMs, descendantCount }`. Per-fiber profiler data from React DevTools hook. |
| ProfilerSnapshot | `{ fibers: Map<string, FiberInfo>, commitCount }`. Snapshot of fiber render state at a point in time. |
| ProfilerDiff | `{ rerenderFibers: { name, renderCountDelta }[] }`. Diff between two profiler snapshots. |
| RenderAttribution | `{ component, renderCount, totalDurationMs, selfDurationMs }`. Per-component render cost breakdown. |
| CallbackIdentityDelta | `{ propName, deltaMs }`. Cost difference between stable and fresh function reference for a prop. |
| detectFramework | `detectFramework(projectRoot)` → `"react" \| "vanilla"`. Checks project package.json for `react`/`react-dom` dependency; defaults to `"react"` when unreadable. |
| PROFILER_HOOK_SCRIPT | Injection script for `__REACT_DEVTOOLS_GLOBAL_HOOK__`. Injected via `Page.addScriptToEvaluateOnNewDocument` before React loads. Walks fiber tree on each commit. |
| injectProfilerHook | `injectProfilerHook(cdp)`. Injects profiler hook via CDP. |
| collectProfilerData | `collectProfilerData(page)` → `ProfilerSnapshot`. Reads `window.__120fps_profiler`. |
| resetProfilerData | `resetProfilerData(page)`. Clears collected profiler data. |
| diffSnapshots | `diffSnapshots(a, b)` → `ProfilerDiff`. Identifies fibers with increased render count. |
| detectMemoBailouts | `detectMemoBailouts(diff)` → `string[]`. Components that failed to bail out on identical-props rerender. Excludes Root/AppRoot. |
| detectContextFanOut | `detectContextFanOut(diff)` → `string[]`. Components that re-rendered on unrelated context change. Excludes Root/AppRoot/__120fpsContextProbe. |
| computeRenderAttribution | `computeRenderAttribution(snapshot, top?)` → `RenderAttribution[]`. Top-N components by selfDurationMs. |
| countBodyOrphans | `countBodyOrphans(page)` → `number`. Counts body children outside `#root`, excluding SCRIPT/STYLE/LINK/NOSCRIPT/Vite overlays. |
| computePortalOrphans | `computePortalOrphans(pre, post)` → `number`. Delta clamped to 0. |
| hasReactWarning | `hasReactWarning(opts)` → `boolean`. True if any finding warrants a warn verdict (memoBailout, contextFanOut, portalOrphans > 0, callbackIdentityDelta > 2ms). Under `compilerActive` a memo bailout alone does not warn — automatic memoization is the compiler's job — and the bailing components are printed as informational. |
| generateEntry | `generateEntry(opts)` → `string`. Generates the normal-path `entry.tsx`: injected stylesheet imports, react imports, optional wrapper import, component import, `renderTree`, control API. Byte-identical to the uninjected form when no stylesheets are given. |
| generateProbeEntry | `generateProbeEntry(opts)` → `string`. Generates probe-entry.tsx with the synthetic context probe and callback identity control for React analysis. The provider wrapper, when active, sits outside the context probe. |
| runReactAnalysis | `runReactAnalysis(harness, options)` → `Map<number, ReactOptimizations>`. Separate-pass orchestrator: opens browser with profiler hook, runs all React-specific detections per combo, and marks each result `compilerActive` when the harness ran the compiler transform. |
| detectNextJs | `detectNextJs(projectRoot)` → `boolean`. Checks `package.json` for `next` in dependencies or devDependencies. |
| SHIM_MODULES | Constant array of `{ module, shimFile }` entries mapping 6 Next.js modules to shim filenames: next/image, next/dynamic, next/link, next/navigation, next/headers, next-video/player. |
| buildShimAliases | `buildShimAliases(hasNextJs)` → `Array<{ find: RegExp, replacement: string }>`. Returns Vite resolve aliases mapping Next.js modules to shim files. Empty when `hasNextJs` is false. |
| Next.js shims | Lightweight replacement modules in `dist/shims/` that render native HTML equivalents (img, a, video, React.lazy) instead of Next.js components. Activated automatically when target project depends on `next`. Disabled via `--no-shims`. |
