---
kind: overview
status: approved
---

| term | definition |
|---|---|
| PropSchema | One prop's type info: `{ name, kind, values, required }`. Kind is `"boolean"|"string"|"number"|"union"|"array"|"function"|"reactnode"|"object"|"unknown"`. Used by `detectScalingProps` for auto-scaling detection. |
| PropCombination | `Record<string, unknown>`. Concrete prop key-value set for one render. |
| Stratified sampling | When cartesian product >64, select combos covering each value ≥1× while capping total. Seeded PRNG (42) fills remaining budget. |
| HarnessResult | `{ url, server: ViteDevServer, componentPath, harnessDir, cleanup }`. Return value of `buildAndServe()`. |
| Control API | `window.__120fps`: `mount(props)`, `unmount()`, `rerender(props)`, `getContainer()`. Harness exposes these for CDP-driven measurement. |
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
| 4× CPU throttle | Playwright CPU slowdown for cross-machine comparability. |
| Scaling curve (parameterized) | For fixtures with `scale(n)` export: measurements at default scale points `[1, 5, 20, 50]`. For raw components (no fixture, no composition): scale combos `[1, 5, 20, 50]` always appended to prop combos via `__120fps_scaleN`. For non-parameterized runs: scaling curves computed across combos with ≥2 distinct DOM node counts. |
| TimingWithCV | Extends TimingResult with `cv: number` and `unstable: boolean` (cv>15%). |
| CV | Coefficient of variation: `stddev / |mean| × 100`. Measures timing stability across samples. |
| ComponentTier | `"T1" \| "T2" \| "T3" \| "T4"`. Auto-classification based on DOM complexity, portals, and animations. |
| TierBudget | `{ mountMs, rerenderMs, interactionMs }`. Per-tier performance budget thresholds. |
| TIER_BUDGETS | Constant: T1 (14/10/250ms), T2 (44/30/300ms), T3 (60/36/350ms), T4 (80/48/400ms). Calibrated for 4x CPU throttle with real-world Radix/React framework overhead. |
| classifyTier | `classifyTier(info)` → `ComponentTier`. Pure function: portal or animation → T3, ≤10 DOM → T1, ≤40 DOM → T2, else → T4. `hasScaling` parameter accepted but ignored. |
| ComboReport | Per-prop-combination report: `{ comboIndex, props, mount, unmount, rerender, rerenderChange?, domNodeCount, heapDelta, interactions: InteractionReport[], scalingCurve: ScalingCurve | null, rerenderScalingCurve?, relativeMount, verdict, tier?, hasAnimation?, costAttribution?, reactOptimizations? }`. |
| Report | Top-level output: `{ version: 1, timestamp, componentPath, componentName, machine, calibration, combos: ComboReport[], thresholds, pass, fixturePath?, fixtureAutoDetected?, propDeltas?, autoScalingProp?, autoScalingReason?, tieredBudgets?, autoComposition?, compositionTree? }`. |
| Thresholds | Pass/fail gates: `{ mountMs: 50, interactionMs: 400, relativeMount: 2.0, rerenderMs: 16 }` (defaults). Overridden by tier budgets when active. |
| DEFAULT_THRESHOLDS | Exported constant from `report.ts` with the default threshold values. |
| Verdict | Per-combo classification: `pass` (within thresholds, stable), `warn` (within thresholds, unstable CV>15% or rerenderChange exceeds budget with tier budgets), `fail` (exceeds any threshold). When tiered budgets active: mount/rerender/interaction use per-tier budget; rerenderChange exceeding 1.5× rerender budget produces `warn` (not `fail`); relativeMount exceeding threshold produces `warn` (not `fail`). |
| ScalingPropMatch | `{ schema: PropSchema, kind: "numeric" | "array", reason: string }`. One auto-detected scaling-eligible prop. |
| detectScalingProps | `detectScalingProps(schemas)` → `ScalingPropMatch[]`. Detects array/numeric props suitable for auto-scaling sweeps. Priority: items-like array > plain array > named numeric > shorthand numeric. |
| generateScalingCombos | `generateScalingCombos(schemas, match, scalePoints)` → `PropCombination[]`. Generates combos with scaling prop set to each scale point, other props at anchor values. |
| AnalyzeOptions | `{ samples?, cpuThrottle?, warmupRuns?, seed?, jsonPath?, ci?, thresholds?, fixturePath?, scalePoints?, skipDeltas?, skipAutoScale?, skipAttribution?, skipAutoCompose?, skipReactAnalysis?, framework?, flatThresholds? }`. Configuration for `analyze()`. |
| BuildReportInput | `{ componentPath, componentName, machine, calibration, mounts, explores, heapDeltas, thresholds, fixturePath?, fixtureAutoDetected?, rerenders?, flatThresholds?, explicitThresholds?, skipAttribution?, propDeltas?, autoScalingProp?, autoScalingReason?, autoComposition?, compositionTree?, reactAnalysis? }`. Input to `buildReport()`. |
| CliArgs | `{ componentPath?, fixturePath?, jsonPath, ci, samples?, thresholdMount?, thresholdInteraction?, thresholdRerender?, scale?, noDeltas?, noAutoScale?, noAttribution?, noAutoCompose?, noReactAnalysis?, framework?, flatThresholds?, help, version, error? }`. Parsed CLI arguments. |
| analyze() | Full pipeline orchestrator: harness → calibration → mount → rerender → explore → report → JSON. |
| Fixture | User-authored `.fixture.tsx` file that default-exports a composed React scene for measurement. Bypasses prop extraction; scene is self-contained with representative children and state. |
| Rerender | Prop-driven re-render via `__120fps.rerender(props)`. Measured as stable (same props) and change (different props). `ComboReport.rerender` is always present. |
| Scale function | Optional `export function scale(n: number) => JSX.Element` in a fixture file. When detected, pipeline calls it at each scale point to produce multiple combos with increasing item counts. |
| Scale points | Array of integers `[1, 5, 20, 50]` (default) controlling how many instances to render. For fixtures with `scale()`: calls scale function. For raw components: renders N instances via `__120fps_scaleN`. Override via `--scale`. |
| scanExternalDeps | `scanExternalDeps(componentPath, projectRoot, aliases)` → `string[]`. Recursively follows local imports (relative and tsconfig-aliased) to discover all transitive external package dependencies. Results fed to Vite `optimizeDeps.include` to prevent reload races. |
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
| Stress pattern library | Seven patterns: pointer-drag, keyboard-sweep, hover-sweep, open-close-10, multi-keystroke, rapid-toggle-10, single-shot (fallback). Pointer-drag has highest dispatch priority. |
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
| ReactOptimizations | `{ memoBailout, memoBailoutComponents?, contextFanOut, contextFanOutComponents?, callbackIdentityDeltas?, portalOrphans?, renderAttribution? }`. React-specific optimization findings per combo. |
| FiberInfo | `{ name, renderCount, actualDurationMs, selfDurationMs, descendantCount }`. Per-fiber profiler data from React DevTools hook. |
| ProfilerSnapshot | `{ fibers: Map<string, FiberInfo>, commitCount }`. Snapshot of fiber render state at a point in time. |
| ProfilerDiff | `{ rerenderFibers: { name, renderCountDelta }[] }`. Diff between two profiler snapshots. |
| RenderAttribution | `{ component, renderCount, totalDurationMs, selfDurationMs }`. Per-component render cost breakdown. |
| CallbackIdentityDelta | `{ propName, deltaMs }`. Cost difference between stable and fresh function reference for a prop. |
| detectFramework | `detectFramework(entryContent)` → `"react" \| "vanilla"`. Scans harness entry for `react-dom` import. |
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
| hasReactWarning | `hasReactWarning(opts)` → `boolean`. True if any finding warrants warn verdict (memoBailout, contextFanOut, portalOrphans > 0, callbackIdentityDelta > 2ms). |
| generateProbeEntry | `generateProbeEntry(opts)` → `string`. Generates probe-entry.tsx with context wrapper and callback identity control for React analysis. |
| runReactAnalysis | `runReactAnalysis(harness, options)` → `Map<number, ReactOptimizations>`. Separate-pass orchestrator: opens browser with profiler hook, runs all React-specific detections per combo. |
| detectNextJs | `detectNextJs(projectRoot)` → `boolean`. Checks `package.json` for `next` in dependencies or devDependencies. |
| SHIM_MODULES | Constant array of `{ module, shimFile }` entries mapping 6 Next.js modules to shim filenames: next/image, next/dynamic, next/link, next/navigation, next/headers, next-video/player. |
| buildShimAliases | `buildShimAliases(hasNextJs)` → `Array<{ find: RegExp, replacement: string }>`. Returns Vite resolve aliases mapping Next.js modules to shim files. Empty when `hasNextJs` is false. |
| Next.js shims | Lightweight replacement modules in `dist/shims/` that render native HTML equivalents (img, a, video, React.lazy) instead of Next.js components. Activated automatically when target project depends on `next`. Disabled via `--no-shims`. |
