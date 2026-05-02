---
kind: overview
status: approved
---

## Objective
`npx 120fps ./Button.tsx` → real-browser performance report. Zero config. No manual scenarios.

## Pipeline
1. **Prop extraction** — TS Compiler API (Bundler moduleResolution) → props interface → value generation. Recursively unwraps HOC chains (forwardRef/memo). Handles class components via heritage clause. Cap 64 combos via stratified sampling.
2. **Harness build** — Vite bundles HTML page importing target component (auto-detects named/default/class export). Symlinks project's node_modules into temp dir. Exposes `window.__120fps` control API.
3. **Browser** — Playwright headless Chromium. Persistent context. 4× CPU throttle.
4. **Exploration loop** — Per prop combo: mount→trace, DOM walk→discover interactables, exercise each N=10→trace, deepen expensive paths (P95>1.5× median), build state graph. Terminate: convergence / 200 nodes / 60s.
5. **Metrics** — CDP traces → paint, layout shifts, style recalcs, long tasks, frame timing, scripting, DOM count, heap delta.
6. **Report** — Terminal table + JSON. Scaling curve analysis.

## Modules
| module | role |
|---|---|
| prop-gen | TS Compiler API prop extraction + value generation |
| harness | Vite harness builder + dev server |
| discovery | DOM walker, ARIA pattern recognizer |
| explorer | Exploration loop, state graph builder |
| measure | CDP trace capture + duration parsing |
| metrics | Full CDP metric extraction, INP, scaling curves, calibration |
| report | Types, CV, verdict logic, terminal table formatting |
| analyze | Full pipeline orchestrator (`analyze()` + `buildReport()`) |
| cli | Entry point, arg parsing, exit codes |

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
- Finds: buttons, inputs (all types), textareas, selects, links (`a[href]`), `details > summary`, `[contenteditable]`, ARIA `[role]` widgets, `[tabindex]` (not -1), elements with inline event handler attributes
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
- `explore(harness, options?)` → `ExploreResult[]` (one per prop combo), each containing a `StateGraph`
- For each prop combo × each discovered interaction: exercise N=10 times, capture CDP trace (independent samples via remount+replay)
- After each interaction: DOM hash via FNV-1a of `#root` innerHTML → detect state change
- Build `StateGraph`: nodes = unique DOM states (by hash), edges = interactions with cost (median, P95, raw traces)
- Adaptive deepening: if P95 > 1.5× global median edge cost, add follow-up interactions to priority queue front
- Convergence: binary info gain per exploration; stop when last 10 all yield no new nodes/edges
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
- Fixed `parseTraceDuration` nested event double-counting via timestamp-based nesting stack; backward-compatible fallback for events without `ts` field
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
- CI mode: `--ci` → JSON-only output, exit code 1 if `report.pass === false`, exit 2 on usage errors
- New modules: `src/report.ts`, `src/analyze.ts`, `src/cli.ts`. See `specs/milestones/m6-cli-reporting.md`. 63 new tests (324 total).

**Post-M6 wiring**: GC between samples (`HeapProfiler.collectGarbage`) called before each sample in measure + explorer. Heap delta via `Runtime.getHeapUsage` collected per combo in `measureMount()`. Scaling curve computed across combos with ≥2 distinct DOM sizes. 329 tests.

## Risks
| risk | mitigation |
|---|---|
| TS Compiler slow on complex generics | Recursion depth cap 5; cache programs |
| Prop combo explosion | Cap 64, stratified sampling |
| Import fails (aliases, CSS) | Vite handles tsconfig paths, CSS, assets |
| Harness temp dir can't find deps | Symlink project's node_modules via junction |
| Exploration non-termination | 200 nodes, 60s, convergence check |
| Machine variance | 4× CPU throttle + calibration component |

## NFRs
- <60s for typical component (5 prop combos, 10 interactions).
- Zero config for typed React .tsx with tsconfig.json.
- No source file modification.
- Additive-only JSON schema across versions.
