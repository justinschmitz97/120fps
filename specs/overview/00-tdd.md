---
kind: overview
status: approved
---

## Objective
`npx 120fps ./Button.tsx` → real-browser performance report. Zero config. No manual scenarios.

## Pipeline
1. **Prop extraction** — TS Compiler API (Bundler moduleResolution) → props interface → value generation. Recursively unwraps HOC chains (forwardRef/memo). Handles class components via heritage clause. Cap 64 combos via stratified sampling.
2. **Harness build** — Vite bundles HTML page importing target component (auto-detects named/default/class/const export). Harness dir placed inside project root for natural dependency resolution. `scanExternalDeps` recursively follows imports (including tsconfig aliases) to pre-populate `optimizeDeps.include`. Auto-scale rendering: when props contain `__120fps_scaleN`, renders N instances. Exposes `window.__120fps` control API.
3. **Browser** — Playwright headless Chromium. Fresh browser per measurement phase. 4× CPU throttle.
4. **Exploration loop** — Per prop combo: mount→trace, DOM walk→discover interactables, resolve stress pattern per interaction (pointer-drag, keyboard-sweep, hover-sweep, open-close-10, multi-keystroke, rapid-toggle-10, or single-shot), exercise each N=10→trace, deepen expensive paths (edge P95 > 1.5× global median edge cost), build state graph. Terminate: convergence / 200 nodes / 60s.
5. **Metrics** — CDP traces → paint, layout shifts, style recalcs, long tasks, frame timing, scripting, DOM count, heap delta.
6. **Report** — Terminal table + JSON. Scaling curve analysis.

## Modules
| module | role |
|---|---|
| prop-gen | TS Compiler API prop extraction, auto-scaling prop detection |
| prop-gen-values | Value generation, stratified sampling, combo capping, delta pair generation, scaling combo generation |
| harness | Vite harness builder, dev server, scale export detection, auto-dep scanning (`scanExternalDeps`), tsconfig alias loading (`loadTsconfigAliases`), auto-scale rendering |
| discovery | DOM walker, ARIA pattern recognizer, portal probing |
| explorer | Exploration loop, state graph builder |
| measure | CDP trace capture, mount/unmount/rerender measurement, animation detection, GC, median/P95 utilities |
| metrics | Full CDP metric extraction, INP, scaling curves, calibration, cost attribution |
| report | Types (PropDelta, TimingWithCV, ComboReport, Report, ComponentTier, TierBudget, CostAttribution, CostBucket), CV, tier classification, verdict logic, default thresholds, tier budgets, terminal table formatting |
| stress-patterns | Stress pattern dispatch (including pointer-drag), step execution, ARIA sibling detection, drag target detection |
| composition | Auto-composition inference: prefix grouping, suffix taxonomy, template selection |
| analyze | Full pipeline orchestrator (analyze, buildReport), fixture detection (isFixturePath, detectFixture, hasScaleExport), auto-scale combo appending for raw components |
| cli | Entry point, arg parsing, exit codes |
| react-profiler | Framework detection, DevTools hook injection, profiler snapshot capture, memo/context/callback analysis, portal hygiene |
| budget | Budget config loading, baseline I/O, regression comparison, tolerance resolution |
| isolation | Isolated measurement types, churn degradation, memory leak detection, strictmode overhead |
| index | Barrel re-export of all public API |

## Stack
TypeScript, pnpm, Playwright, Vite, TS Compiler API, Node ≥20, vitest.

## Milestones

### M1 — harness + props (done)
Build harness from .tsx, serve via Vite, open in Playwright, extract props via TS Compiler API. See `specs/milestones/m1-harness-and-prop-extraction.md`. 89 tests.

### M2 — mount/unmount measurement (done)
CDP trace capture during mount/unmount across prop combinations. 4× CPU throttle, N=10 samples, median + P95. Auto-mount removed; caller controls lifecycle. Warmup runs (default 2) for JIT stabilization. 30s traceComplete timeout. Empty-array guards on median/P95. See `specs/milestones/m2-mount-measurement.md`. 57 new tests (146 total).

### M3 — interaction discovery (done)
**Goal**: Given a mounted component, walk the live DOM to find all interactive elements and categorize them.

**Builds on M2**: component is mounted with valid props, browser is open.

**Scope**:
- `discoverInteractions(page)` — single `page.evaluate()` DOM walk via TreeWalker
- Finds: buttons, inputs (all types), textareas, selects, links (`a[href]`), `summary`, `[contenteditable]`, ARIA `[role]` widgets, `[tabindex]` (not -1), elements with inline event handler attributes
- Recognizes ARIA widget patterns: accordion, tabs, menu, dialog, listbox, combobox, tree — annotates descriptors with `role` field
- Returns `InteractionDescriptor[]` with type (`click`|`type`|`select`|`focus`|`keyboard`|`hover`), CSS selector, tagName, label, optional role/inputType
- Deduplicates by element identity. Unique CSS selectors validated via `querySelector`.
- Traverses open shadow DOM. Skips `display:none`, `visibility:hidden`, `aria-hidden="true"`, `input[type=hidden]`.
- Deterministic: same DOM → same descriptors in document order.
- New module: `src/discovery.ts`. See `specs/milestones/m3-interaction-discovery.md`. 31 new tests (177 total).

**Does NOT include**: actually exercising the interactions (M4) or measuring them (M5).

### M4 — exploration loop (done)
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

### M5 — full CDP metrics (done)
**Goal**: Parse raw CDP traces into the complete metric taxonomy. Scaling curve analysis.

**Builds on M4**: raw traces from mount + interaction exercises.

**Scope**:
- `parseMetrics(events, options?)` → `CdpMetrics` with paint/layout/style-recalc counts and durations, scripting duration, totalDuration (nested-event-aware), long tasks (>50ms), frame timing + jank/dropped frame counts, layout shift score, INP estimation
- `computeINP(traces)` → max interaction-to-next-paint latency across trace sets
- `computeScalingCurve(points)` → `{ slope, intercept, r2, growthClass }` via least-squares regression with automatic classification (constant/linear/quadratic/exponential)
- `createCalibrationTrace(page, cdp)` → baseline `CdpMetrics` from known-cost operation (1000-element DOM insert + forced layout)
- `linearRegression(points)` → `{ slope, intercept, r2 }` utility
- `parseTraceDuration` uses timestamp-based nesting stack to avoid double-counting child events in `totalDuration`; backward-compatible fallback for events without `ts` field
- `TraceEvent` extended with optional `ts` and `args` fields
- `filterToMarks` option for `parseMetrics` to scope metrics to `performance.mark` window (`__120fps_start`/`__120fps_end`)
- New module: `src/metrics.ts`. See `specs/milestones/m5-cdp-metrics.md`. 51 new tests (261 total).

**Does NOT include**: reporting format (M6).

### M6 — CLI + reporting + calibration (done)
**Goal**: Ship the user-facing tool. Terminal output, JSON file, CLI entry point.

**Builds on M5**: full `Report` structure with all metrics.

**Scope**:
- `analyze(componentPath, options?) → Report`: full pipeline orchestrator (buildAndServe → calibration → measureMount → explore → report)
- CLI: `npx 120fps ./Component.tsx` — arg parsing (`--json`, `--ci`, `--samples`, `--threshold-mount`, `--threshold-interaction`, `--help`, `--version`), error handling, help text
- Terminal table: summary view (component name, machine summary, per-combo mount/unmount/DOM/interactions/scaling/verdict, top 3 slowest interactions per combo)
- JSON output: full `Report` object written to file (default: `120fps-report.json`), Map-to-object serialization
- Machine info: CPU model, cores, RAM, OS, Node version, Chromium version
- Calibration: `createCalibrationTrace` → normalize all timings as `relativeMount` / `relativeTiming` ratios
- CV: `computeCV(samples)` = stddev/|mean|×100; `TimingWithCV` extends `TimingResult` with `cv` + `unstable` (cv>15%)
- Verdicts: per-combo `pass`/`warn`/`fail` based on threshold checks + instability; `report.pass = no combo is "fail"`
- Exit code 1 on failure (all modes). `--ci` suppresses terminal table output. Exit 2 on usage errors.
- GC between samples (`HeapProfiler.collectGarbage`) called before each sample in measure + explorer. Heap delta via `Runtime.getHeapUsage` collected per combo in `measureMount()`. Scaling curve computed across combos with ≥2 distinct DOM sizes.
- New modules: `src/report.ts`, `src/analyze.ts`, `src/cli.ts`. See `specs/milestones/m6-cli-reporting.md`. 337 tests.

### M7 — composed fixtures (done)
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

### M8 — rerender measurement + parameterized scaling (done)
**Goal**: Measure prop-change rerender cost and scaling curves across parameterized item counts, closing the largest gap with production bench suites.

**Builds on M7**: fixture pipeline, full CDP metrics.

**Scope**:
- `measureRerender(harness, options?)` — CDP trace capture during `__120fps.rerender(newProps)`. Same N-sample, median/P95, CDP tracing, calibration, warmup as mount measurement. Opens own browser, iterates all combos.
- Per-combo rerender timing added to `ComboReport` as `rerender: TimingWithCV` (always present).
- Two rerender scenarios: (1) stable rerender (same props), (2) prop-change rerender (next combo's props; stored as `rerenderChange?: TimingWithCV` when >1 combo).
- Parameterized fixtures: fixture exports `scale(n: number) => JSX.Element` alongside `default`. Detection via `hasScaleExport()` regex with word boundary. Harness imports `scale` and dispatches via `__120fps_scaleN` prop.
- Default scale points: `[1, 5, 20, 50]`. Override via `--scale 1,10,100` CLI flag.
- Scaling curves computed for mount AND rerender across parameterized combos (`rerenderScalingCurve` on ComboReport).
- `--threshold-rerender <ms>` CLI flag (default: 8ms). Rerender exceeding threshold → verdict `fail`.
- `Report.thresholds.rerenderMs`, `ComboReport.rerenderScalingCurve`.
- See `specs/milestones/m8-rerender-scaling.md`. 34 new tests (413 total).

**Does NOT include**: portal-aware discovery (M9), drag interactions, or controlled state transitions driven by external test scripts.

### M9 — portal-aware discovery (done)
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

### M10 — interaction stress patterns (done)
**Goal**: Type-specific stress patterns dispatched by interaction type and ARIA role, exposing performance cliffs single-shot exercises miss.

**Builds on M9**: discovery categorizes descriptors with type and role.

**Scope**:
- New module `src/stress-patterns.ts`: `StressPattern`, `StressStep` types, `resolveStressPattern()` pure dispatch, `executeStressPattern()` runner, `findAriaGroupSiblings()`.
- Pattern library: rapid-toggle-10, keyboard-sweep, hover-sweep, open-close-10, multi-keystroke, single-shot (fallback).
- Sibling detection via ARIA container queries (`[role=tablist]`, `[role=listbox]`, etc.).
- Explorer integration: replaces single-shot exercise in trace capture.
- `StateEdge.stressPattern?` and `InteractionReport.stressPattern?` fields.
- Terminal table shows pattern name in parentheses after interaction label when not `"single-shot"`.
- Backward-compatible: components without ARIA roles get single-shot (identical to M9).
- See `specs/milestones/m10-interaction-stress-patterns.md`. 50 new tests (520 total: 371 unit + 149 e2e).

**Does NOT include**: custom user-defined stress patterns or pattern configuration.

### M11 — pairwise prop delta analysis (done)
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

### M12 — auto-scaling prop detection (done)
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

### M13 — tiered budgets (done)
**Goal**: Auto-classify components into tiers (T1-T4) based on DOM complexity, portals, and animations, then apply tier-appropriate performance budgets calibrated for 4x CPU throttle.

**Builds on M6** (verdict logic), **M9** (portal flag), **M8** (scaling curve), **M14** (animation detection).

**Scope**:
- `ComponentTier` type, `TIER_BUDGETS` constant, `classifyTier()` pure function.
- T1 (≤12 DOM, mount ≤14ms), T2 (≤40 DOM, mount ≤20ms), T3 (portal/animation, mount ≤30ms), T4 (>40 DOM, mount ≤50ms). Calibrated for 4x CPU throttle + HTML attribute prop-diffing overhead.
- `computeVerdict` updated with tier-aware budgets. `ComboReport.tier?`, `Report.tieredBudgets?`.
- `--flat-thresholds` CLI fallback. Explicit `--threshold-*` flags partially override.
- See `specs/milestones/m13-tiered-budgets.md`. 55 new tests (648 total: 499 unit + 149 e2e).

**Does NOT include**: custom tier definitions.

### M14 — animation detection (done)
**Goal**: Detect CSS animations and layout-affecting transitions in mounted components, replacing the `hasAnimation: false` placeholder from M13.

**Builds on M13** (tier classification with `hasAnimation` parameter), **M2** (mount measurement).

**Scope**:
- `detectAnimations(page)` in `src/measure.ts`: single `page.evaluate()` with three signals scoped to `#root` — Web Animations API (running animations), CSS `animation-name` declarations, layout-affecting CSS transitions (transform, opacity, height, width, max-height, max-width, all).
- `MountResult.hasAnimation?: boolean`. Detected on first sample per combo during `measureMount`.
- `buildReport()` reads `hasAnimation` from mount results, passes to `classifyTier()`.
- `ComboReport.hasAnimation?: boolean` set when tiered budgets active.
- `formatTable` shows `[anim]` suffix on verdict.
- Scoped to `#root` to avoid Vite overlay false positives. Portal animations outside `#root` excluded.
- See `specs/milestones/m14-animation-detection.md`. 39 new tests (687 total: 538 unit + 149 e2e).

**Does NOT include**: portal-rendered animations outside `#root`, hover-only transition detection override.

### M15 — pointer drag stress pattern (done)
**Goal**: Add a `pointer-drag` stress pattern for sliders, color pickers, and drag-based components — the only genuine performance gap between 120fps and hand-written bench suites.

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

### M16 — cost attribution (done)
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

### M17 — auto-composition (done)
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

### M18 — React optimization detection (done)
**Goal**: Auto-detect React-specific optimization issues (memo bailouts, context fan-out, callback identity pressure, portal orphans, per-component render attribution) via React DevTools profiler hook injection. Closes the ~30% gap with hand-written bench suites.

**Builds on M2** (mount measurement), **M5** (CDP traces), **M6** (report), **M8** (rerender).

**Scope**:
- Framework auto-detection: `detectFramework(entryContent)` scans harness entry for `react-dom` import. `--framework react|vanilla|auto` CLI flag (default: `auto`).
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

### M19 — Next.js shim layer (done)
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

### M20 — scaling curves (done)
**Goal**: Dedicated `--curve` mode that measures mount/rerender across scale points (1,2,5,10,20,50,100) and reports growth classification (constant/linear/quadratic/exponential) with R² fit quality.

**Builds on M8** (parameterized scaling), **M5** (scaling curve computation), **M12** (auto-scaling prop detection).

**Scope**:
- `--curve [prop:type]` CLI flag. Auto-detect scaling prop or explicit `prop:array|number`.
- `CurveReport` type with per-point timings, mount/rerender scaling curves, growth class.
- Curve mode runs instead of normal combo pipeline. Scale points: `[1,2,5,10,20,50,100]`.
- `Report.curveReport?` field. Terminal table shows per-point mount/rerender timings, regression line, growth class.
- `--no-curve` disables auto-activation. Mutually exclusive with `--matrix` and `--isolate`.
- See `specs/milestones/m20-scaling-curves.md`. 49 new tests (1011 total: 862 unit + 149 e2e).

**Does NOT include**: custom scale point lists in curve mode, multi-prop curve sweeps.

### M21 — prop variation matrix (done)
**Goal**: `--matrix` mode measures mount/rerender for every individual prop value against a baseline combo, producing a cost matrix showing per-prop-value performance impact.

**Builds on M1** (prop extraction), **M11** (delta pairs), **M8** (rerender measurement).

**Scope**:
- `--matrix` CLI flag. Generates matrix combos: baseline + one combo per unique prop value.
- `MatrixReport` type with `MatrixCell[]` per-prop-value entries (mount/rerender timing, delta from baseline).
- `Report.matrixReport?` field. Terminal table shows prop×value cost matrix.
- `--no-matrix` disables auto-activation. Mutually exclusive with `--curve` and `--isolate`.
- See `specs/milestones/m21-prop-variation-matrix.md`. 74 new tests (1085 total: 936 unit + 149 e2e).

**Does NOT include**: cross-prop interaction effects, matrix mode for fixtures.

### M22 — budget CI (done)
**Goal**: Persistent baselines and per-component budget configuration for CI regression detection. `--budget` mode saves/loads baselines and fails on regressions.

**Builds on M6** (CLI, report), **M13** (tiered budgets).

**Scope**:
- `120fps.config.json`: per-component budget overrides, default tolerances, component-specific tolerances.
- `120fps-baseline.json`: persistent per-component baselines (mount, rerender, interaction, unmount, domCount, tier, timestamp).
- `compareBaseline()` regression detection: mount±10%, rerender±15%, interaction±15%, unmount±20%. CV>15% metrics get WARN not FAIL.
- `--save-baseline`, `--check`, `--budget` (shorthand for `--ci --check`), `--no-baseline` CLI flags.
- `Report.baseline?` field with regressions/improvements arrays.
- Budget resolution precedence: CLI flags > per-component config > defaults config > tier budgets.
- New module: `src/budget.ts`. See `specs/milestones/m22-budget-ci.md`. 64 new tests.

**Does NOT include**: baseline diffing across branches, GitHub PR comment integration.

### M23 — isolated measurements (done)
**Goal**: Independent micro-benchmarks for each lifecycle phase (mount, rerender, unmount, memory, strictmode), comparable to hand-authored vitest bench suites.

**Builds on M8** (rerender), **M2** (mount), **M5** (CDP tracing), **M13** (tiered budgets).

**Scope**:
- `--isolate <phases>` CLI flag (comma-separated: mount, rerender, unmount, memory, strictmode, all).
- Mount isolation: mount-to-first-paint excluding unmount. Rerender isolation: stable (same props), prop-change, churn (10 cycles with degradation ratio).
- Memory stability: repeated mount/unmount cycles, heap growth per cycle, leak detection (>1KB/cycle).
- StrictMode comparison: interleaved normal/strict sampling, overhead percentage, `doubleInvokeClean` (≤110%).
- `--memory-cycles <N>` override (default 20). Mutually exclusive with `--curve` and `--matrix`.
- `Report.isolation?` field with per-phase results. New module: `src/isolation.ts`.
- See `specs/milestones/m23-isolated-measurements.md`. 63 new tests (1085 total: 936 unit + 149 e2e).

**Does NOT include**: isolation modes combined with curve/matrix, concurrent phase execution.

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
- Zero config for typed React .tsx with tsconfig.json.
- Supports optional fixture files for composed components and parameterized scaling.
- No source file modification.
- Additive-only JSON schema across versions.
