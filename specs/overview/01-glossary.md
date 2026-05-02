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
| CDP trace | `Tracing.start/end` capture. µs-resolution: paint, layout, style recalc, scripting, frames. |
| Calibration component | Known-cost reference shipped with 120fps. Machine baseline → relative scoring. |
| 4× CPU throttle | Playwright CPU slowdown for cross-machine comparability. |
| Scaling curve | Measurements at item counts [1,5,20,50]. Linear regression → growth class. |
