---
kind: milestone
status: done
tests:
  - test/unit/metrics.test.ts
  - test/unit/metrics-harden.test.ts
  - test/e2e/metrics.test.ts
  - test/e2e/metrics-harden.test.ts
---

# M5 — CDP metric taxonomy

parseMetrics: pure, single pass over ts-sorted events. Nesting stack — only top-level X-phase events count toward totalDuration (fixes double-count; fixed total ≤ old total).

Non-obvious:
- Scaling fit: <3 distinct n values → inconclusive (can't discriminate a growth model). Else slope≤0, or slope>0 with R²<0.5 → constant. Else best R² of linear (n), quadratic (n²), exponential (log y; needs all metrics>0).
- Calibration = 1000-span DOM insert + forced layout via offsetHeight, cleaned up after.
- INP = max EventDispatch(input-type) → next Paint gap across trace sets; none → 0.
- LayoutShift absent in some Chromium → 0. Heap delta may be negative (GC). DrawFrame absent when nothing renders.
- GC per sample via tryCollectGarbage; heap via Runtime.getHeapUsage before/after sample loop.
