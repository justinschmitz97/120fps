---
kind: milestone
status: approved
tests:
  - test/unit/isolation-cli.test.ts
  - test/unit/isolation-calc.test.ts
  - test/unit/isolation-report.test.ts
  - test/unit/isolation-harden.test.ts
  - test/unit/m28-isolation.test.ts
  - test/unit/m28-isolation-harden.test.ts
  - test/e2e/isolation.test.ts
---

# M23 — isolated measurements

`--isolate mount,rerender,unmount,memory,strictmode|all` (parseIsolationPhases = single validator; `all` expands anywhere, dedupe to canonical order). Mutually exclusive with --curve/--matrix. Report.combos=[]; results in Report.isolation; calibration still runs. `--no-isolate` wins.

One combo: combos[0] (fixture/composed → {}); prop-change + churn need combos[1], else degenerate to combos[0] + warning. Scale combos excluded. Mount warmup 3 (standard is 2). Never re-navigate between samples — fresh page discards JIT, makes isolated numbers NOISIER than standard pass.

Calibrated numbers (measured evidence — don't retune blindly):
- Leak threshold 8KB/cycle after 10 warmup cycles: over 20 cycles @4x, non-leaking components drift 2.2–2.4KB/cycle (noise floor), retain-every-mount ~200KB/cycle. Warmup dominates: 3 cycles→13.6KB/c apparent, 10→2.2, 20→0.8. A 1KB threshold flags everything.
- gcPressure: every 5 cycles force GC, count checks where heap still >10% above heapBefore (leak 4/4, clean 0/4; heapBefore 0 disables check).
- churnDegradation = mean(last 3)/mean(first 3) of 10 alternating-props cycles; fail >2.0. Churn deliberately skips GC — accumulation IS the measurement.
- StrictMode: interleaved paired sampling (normal,strict,normal,…; navigate ?strict=1 between pairs — same machine conditions). doubleInvokeClean = overhead <110%; warns, NEVER fails (dev-mode property).

Non-obvious:
- StrictMode nests INSIDE provider wrapper — wrapper(StrictMode(component)) — so double-invoke cost measured is the component's, not providers'.
- gc() unavailable in page (no --expose-gc); CDP HeapProfiler.collectGarbage; unavailable → skip memory phase + warning.
- One browser per phase pass (launch cost outside traced windows; matches every other entry point). Memory phase gets untouched heap.
- Verdict fail: mount median > resolved budget, or leakSuspected, or churnDegradation>2.0.

See m28 for execution pipeline details.
