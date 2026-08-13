---
kind: milestone
status: done
tests: [test/unit/rerender.test.ts, test/unit/rerender-harden.test.ts, test/e2e/rerender.test.ts, test/e2e/rerender-harden.test.ts]
---

# M8 — rerender + parameterized scaling

Rerender = dominant perf dimension (60%+ of hand bench surface). Two scenarios per combo: stable (same props — bailout path) and prop-change (next combo's props; last→first; `{}` for fixtures).

Non-obvious:
- Fixture named export `scale(n)` → combos at default [1,5,20,50] via `__120fps_scaleN` marker prop; harness dispatches to scale(n).
- `hasScaleExport` regex needs word boundary — `scaleItems`/`rescale` false-match otherwise.
- rerenderMs default 16, calibrated for 4x throttle.
- Scaling curve requires ≥2 distinct DOM sizes.
- Same tracing/warmup/samples as mount.
