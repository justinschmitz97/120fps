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
| explorer | Exploration loop orchestration |
| discovery | DOM walker, ARIA pattern recognizer |
| measure | CDP trace capture + parsing |
| report | Terminal table + JSON |
| cli | Entry point, args |

## Stack
TypeScript, pnpm, Playwright, Vite, TS Compiler API, Node ≥20, vitest.

## Milestones

### M1 — harness + props (done)
Build harness from .tsx, serve via Vite, open in Playwright, extract props via TS Compiler API. See `specs/milestones/m1-harness-and-prop-extraction.md`. 89 tests.

### M2 — mount/unmount measurement (done)
CDP trace capture during mount/unmount across prop combinations. 4× CPU throttle, N=10 samples, median + P95. Auto-mount removed; caller controls lifecycle. Warmup runs (default 2) for JIT stabilization. 30s traceComplete timeout. Empty-array guards on median/P95. See `specs/milestones/m2-mount-measurement.md`. 57 new tests (146 total).

### M3 — interaction discovery (pending)
**Goal**: Given a mounted component, walk the live DOM to find all interactive elements and categorize them.

**Builds on M2**: component is mounted with valid props, browser is open.

**Scope**:
- Walk DOM tree via `page.evaluate()`, find interactive elements: buttons, inputs, selects, textareas, links, `[role]` elements, `[tabindex]` elements, `[onclick]`/`[onkeydown]` elements
- Recognize ARIA widget patterns: accordion (`role=region` + trigger), tabs (`role=tablist/tab/tabpanel`), menu (`role=menu/menuitem`), dialog (`role=dialog` + trigger), listbox, combobox, tree
- Return `InteractionDescriptor[]` — each with type (click/keyboard/hover/focus/type), selector, and optional key/text
- Deduplicate (same element found via multiple selectors)
- Handle shadow DOM (if `shadowRoot` is open)
- New module: `src/discovery.ts`

**Does NOT include**: actually exercising the interactions (M4) or measuring them (M5).

### M4 — exploration loop (pending)
**Goal**: Adaptive exploration that exercises discovered interactions, tracks state changes, and deepens into expensive paths.

**Builds on M3**: `InteractionDescriptor[]` from discovery. M2's trace capture for measurement.

**Scope**:
- For each prop combo × each discovered interaction: exercise N=10 times, capture CDP trace
- After each interaction: re-walk DOM, compute DOM hash, detect state change
- Build `StateGraph`: nodes = unique DOM states (by hash), edges = interactions with cost (median, P95)
- Adaptive deepening: if P95 > 1.5× median edge cost across all edges so far, add follow-up interactions from resulting state to priority queue
- Convergence detection: rolling window of last 10 explorations, stop if all <5% information gain
- Hard limits: 200 nodes, 60s wall-clock, depth 4
- Seeded RNG for deterministic tie-breaking
- New module: `src/explorer.ts`

**Does NOT include**: full metric extraction (M5) or reporting (M6). M4 produces the state graph and raw traces.

### M5 — full CDP metrics (pending)
**Goal**: Parse raw CDP traces into the complete metric taxonomy. Scaling curve analysis.

**Builds on M4**: raw traces from mount + interaction exercises.

**Scope**:
- Parse trace events into `CdpMetrics`: paint count/duration, layout count/duration, style recalc count/duration, scripting duration, dropped frames, DOM node count, heap delta
- Long task detection (>50ms scripting spans)
- Frame timing analysis: frame durations, jank frames (>16.67ms)
- INP estimation: max interaction-to-next-paint latency
- Layout shift detection from `LayoutShift` trace events
- Scaling curve: run at item counts [1, 5, 20, 50] (for array/list props), linear regression → R² + growth class (linear/quadratic/exponential)
- Calibration component: known-cost reference, run first to establish machine baseline

**Deferred from M2**: Fix nested trace event double-counting in `parseTraceDuration` (sums all X-phase dur including nested children → inflated totalDuration). Add `performance.mark` bracketing for precise mount/unmount windows. Force GC between samples via `--js-flags=--expose-gc`. Wire `scriptDuration` from `ParsedDuration` into `CdpMetrics`.

**Does NOT include**: reporting format (M6).

### M6 — CLI + reporting + calibration (pending)
**Goal**: Ship the user-facing tool. Terminal output, JSON file, CLI entry point.

**Builds on M5**: full `Report` structure with all metrics.

**Scope**:
- CLI: `npx 120fps ./Component.tsx` — arg parsing, error handling, help text
- Terminal table: summary view (component name, mount time, top interactions, scaling class, pass/warn/fail thresholds)
- JSON output: full `Report` object written to file (default: `120fps-report.json`)
- Machine info collection: CPU, RAM, OS, Node version, Chromium version
- Relative scoring: calibration component result → normalize all timings as ratio
- CI mode: `--ci` flag, exit code 1 if any metric exceeds threshold, JSON-only output
- `analyze()` public API: programmatic entry point wrapping the full pipeline

**Deferred from M2**: Report coefficient of variation (CV) per timing; flag results with CV>15% as unstable.

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
