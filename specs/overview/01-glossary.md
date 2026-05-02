---
kind: overview
status: approved
---

| term | definition |
|---|---|
| PropSchema | One prop's type info: name, kind, generated values, required flag. |
| PropCombination | Concrete prop key-value set for one render. |
| Stratified sampling | When cartesian product >64, select combos covering each value ≥1× while capping total. |
| Harness | Generated HTML+JS page importing target component. Built by Vite, exposes Control API. |
| Control API | `window.__120fps`: `mount(props)`, `unmount()`, `rerender(props)`, `getContainer()`. |
| InteractionDescriptor | `{ type: click|keyboard|hover|focus|type, selector, key?, text? }`. |
| StateGraph | Directed graph. Nodes = DOM states (by hash). Edges = interactions with cost. |
| DOM hash | Structural fingerprint: tags + attributes + text skeleton. Deduplicates states. |
| Convergence | Last 10 explorations all <5% info gain → stop. |
| Adaptive deepening | P95 > 1.5× median edge cost → explore resulting state. |
| CDP trace | `Tracing.start/end` capture. µs-resolution: paint, layout, style recalc, scripting, frames. Collected via `Tracing.dataCollected` chunks. |
| CdpMetrics | Full metric extraction from trace events: paint/layout/style-recalc counts+durations, scripting, long tasks, frames, jank, dropped frames, layout shift score, DOM count, heap delta. |
| MountResult | Per-combo measurement: mount/unmount `TimingResult` (samples, median, P95) + DOM node count. |
| TimingResult | `{ samples: number[], median: number, p95: number }`. |
| Long task | Scripting span >50ms. Detected from FunctionCall/EvaluateScript/v8.compile/v8.run trace events. |
| Jank frame | Frame duration >16.67ms (1/60s). Indicates dropped frames. |
| INP | Interaction to Next Paint. Max latency between last user input event and next Paint event across all traces. |
| Layout shift | CLS-style score from LayoutShift trace events. Cumulative sum of per-shift scores. |
| Calibration component | Known-cost reference (1000-element DOM insert + forced layout). Machine baseline → relative scoring. |
| 4× CPU throttle | Playwright CPU slowdown for cross-machine comparability. |
| Scaling curve | Measurements at item counts [1,5,20,50]. Linear regression → R² + growth class (constant/linear/quadratic/exponential). |
| Nested event fix | `parseTraceDuration` uses timestamp-based nesting stack to avoid double-counting child events in `totalDuration`. |
| Report | Top-level output structure: version, timestamp, machine info, calibration, combo reports, thresholds, pass boolean. |
| ComboReport | Per-prop-combination report: mount/unmount TimingWithCV, interactions, scaling curve, relative mount, verdict. |
| TimingWithCV | Extends TimingResult with coefficient of variation (cv) and unstable flag (cv>15%). |
| CV | Coefficient of variation: `stddev / |mean| × 100`. Measures timing stability across samples. |
| Verdict | Per-combo classification: `pass` (within thresholds, stable), `warn` (within thresholds, unstable CV>15%), `fail` (exceeds any threshold). |
| Thresholds | Pass/fail gates: mountMs (default 16), interactionMs (default 100), relativeMount (default 2.0× calibration). |
| analyze() | Full pipeline orchestrator: harness → calibration → mount → explore → report → JSON. |
