---
kind: milestone
status: done
depends_on: [m2, m5, m6, m8]
tests:
  - test/unit/react-profiler.test.ts
  - test/unit/react-profiler-report.test.ts
  - test/unit/react-profiler-harden.test.ts
---

## M18 — React optimization detection

### Purpose

Close the ~30% gap between 120fps and hand-written React bench suites. Adds a React-specific analysis layer answering "are React optimizations working correctly" — memo bailouts, context fan-out, callback identity pressure, portal hygiene, and per-component render attribution.

Framework detection is automatic (`auto` by default). The React module activates when React is detected in the harness bundle. `--framework react|vanilla|auto` provides an escape hatch.

### Contract

**MUST:**

1. **Framework auto-detection**: `detectFramework(projectRoot)` checks the project package.json for a `react`/`react-dom` dependency (dependencies/devDependencies/peerDependencies). Returns `"react"` or `"vanilla"`; missing or unreadable package.json → `"react"`. `--framework vanilla` disables React analysis. `--framework react` forces it.

2. **React DevTools profiler integration**: `PROFILER_HOOK_SCRIPT` injected via CDP `Page.addScriptToEvaluateOnNewDocument` before React loads. `Page.enable` MUST be sent first — the injection silently no-ops while the Page domain is disabled, leaving every fiber snapshot empty. Stores data on `window.__120fps_profiler`. No React DevTools browser extension dependency.

   **Render counting**: `onCommitFiberRoot` walks the whole tree, so tree membership is not evidence of rendering. React double-buffers, so a fiber that took part in a render pass is a different object than it was last commit while a bailed-out subtree is reused by reference; `renderCount` increments only on identity change. A memo fiber is cloned even when it bails on equal props, so for `tag` 14/15 a render additionally requires that the child subtree was not reused. Fibers are keyed by tree path, not by `_debugID`/`index` (which collide across siblings).

3. **Memo bailout detection**: per combo, mount → rerender same props → snapshot A → rerender same props → snapshot B → `diffSnapshots(A, B)` → `detectMemoBailouts(diff)` returns the **memoized** components that re-rendered. A component without `React.memo` re-renders whenever its parent does — that is React working as designed, not a defect — so only a memoized component whose memoization was defeated is reported.

4. **Context fan-out detection**: probe entry wraps the component in a `__120fpsContextProbe` synthetic provider, and renders the component behind a `__120fpsStable` memo boundary so the provider's own re-render cannot cascade. Mount → snapshot A → `forceContextUpdate()` → snapshot B → `diffSnapshots(A, B)` → `detectContextFanOut(diff)` returns the components that re-rendered, which are only those that actually read the context, filtered per item 8.

5. **Callback identity detection**: for function-typed props, measures rerender cost with stable (cached) vs fresh (new arrow) references via probe entry's `rerenderWithStableCallbacks()` / `rerenderWithFreshCallbacks()`. Reports delta when > 0.5ms. `hasReactWarning` flags at > 2ms.

6. **Portal hygiene**: `countBodyOrphans(page)` counts body children outside `#root`, excluding SCRIPT, STYLE, LINK, NOSCRIPT, Vite overlays. `computePortalOrphans(pre, post)` returns delta clamped to 0.

7. **Per-component render attribution**: `computeRenderAttribution(snapshot, top)` returns top-N fibers by selfDurationMs with component name, renderCount, totalDurationMs, selfDurationMs.

8. **Reportable component names**: `detectMemoBailouts`, `detectContextFanOut`, and `computeRenderAttribution` all filter through one predicate. A name is reportable unless it is:
   - **probe scaffolding** — `Root`, `AppRoot`, or any `__120fps` prefix (bundlers suffix duplicate function names, so the match is by prefix, not exact name);
   - **a React Compiler memo-cache slot** — `/^_c\d+$/`. The compiler emits `_c1`, `_c2`, … as cache-index bindings that reach the fiber tree as names; they identify a slot, not a component the user wrote, so no action is possible on them. Names that merely start with `_c` (`_carousel`, `_c2x`) are the user's and stay.

   Both categories are harness or toolchain cost, not the user's components.

9. **Report integration**: `ComboReport.reactOptimizations?: ReactOptimizations`. Terminal "React Optimizations" section after cost breakdown shows: memo bailout components, context fan-out components, callback identity deltas, portal orphans count, render attribution top 3.

10. **Verdict integration**: memo bailout, context fan-out, portal orphans → warn only (never fail). Callback identity delta > 2ms → warn. `hasReactWarning(opts)` determines if verdict upgrade from "pass" to "warn" is needed.

11. **CLI flags**: `--no-react-analysis` → `skipReactAnalysis`. `--framework react|vanilla|auto` (default: auto).

**MUST NOT:**

- Depend on React DevTools browser extension.
- Modify user source code.
- Break pipeline for non-React components.

### Invariants

- `--framework vanilla` → `reactOptimizations` always undefined.
- `--framework auto` + no React in project package.json → same as vanilla, no errors.
- `--framework react` forces the React analysis pass regardless of detection (no error path).
- Profiler hook injection once per browser launch, not per navigation.
- React analysis runs as separate pass after main pipeline (no overhead on mount/rerender/explore measurements).

### Design

**Separate pass architecture**: All React-specific measurements run in a dedicated browser session using a probe entry (`probe-entry.tsx`) generated alongside the main `entry.tsx` in the same harness directory. The Vite server serves it automatically.

**Probe entry**: Generated by `generateProbeEntry(opts)`. Wraps the component in `__120fpsContextProbe` context provider. Exposes `forceContextUpdate()`, `rerenderWithStableCallbacks()`, `rerenderWithFreshCallbacks()` on `window.__120fps`.

**Orchestrator**: `runReactAnalysis(harness, options)` → `Map<number, ReactOptimizations>`. Opens browser with profiler hook → per combo runs memo bailout, context fan-out, callback identity, portal orphan, render attribution → returns results.

**Integration**: `analyze()` calls `runReactAnalysis` after `buildReport()`, attaches results to `report.combos[].reactOptimizations`, upgrades verdicts.

### Module layout

`src/react-profiler.ts` exports:
- Types: `FiberInfo`, `ProfilerSnapshot`, `ProfilerDiff`, `CallbackIdentityDelta`, `RenderAttribution`, `ReactOptimizations`, `ProbeEntryOptions`, `ReactAnalysisOptions`
- Pure functions: `detectFramework`, `diffSnapshots`, `detectMemoBailouts`, `detectContextFanOut`, `computeRenderAttribution`, `computePortalOrphans`, `hasReactWarning`
- Browser functions: `injectProfilerHook`, `collectProfilerData`, `resetProfilerData`, `countBodyOrphans`
- Generation: `generateProbeEntry`, `generateProbeHtml`, `PROFILER_HOOK_SCRIPT`
- Orchestrator: `runReactAnalysis`

Integration points:
- `analyze.ts`: `AnalyzeOptions.skipReactAnalysis`, `AnalyzeOptions.framework`, calls `runReactAnalysis` after main pipeline
- `harness.ts`: `HarnessResult.harnessDir` exposed for probe entry generation
- `report.ts`: `ComboReport.reactOptimizations?`, formatTable React Optimizations section
- `cli.ts`: `--no-react-analysis`, `--framework react|vanilla|auto`
- `index.ts`: barrel re-exports

99 new tests (783 total: 684 prior + 99 new).
