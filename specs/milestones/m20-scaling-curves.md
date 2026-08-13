---
kind: milestone
status: done
tests:
  - test/unit/curve-cli.test.ts
  - test/unit/curve-report.test.ts
  - test/unit/curve-build.test.ts
  - test/unit/curve-harden.test.ts
---

# M20 — curve mode

Multi-axis scaling sweep replaces the combo pipeline. Auto-activates when detectScalingProps matches (`--no-curve` off; `--curve <prop>:<array|number>` forces without detection). Default 6 points [1,3,5,10,20,50] — more points than M12 for regression fitting.

Non-obvious:
- Every dimension per point: mount/rerender/unmount/DOM/heap/interactions/attribution. Normal combos NOT produced; deltas implied off (curve IS the scaling analysis). M12 behavior remains for non-curve runs.
- Verdict: FAIL on super-linear growth or any point over tier budget; WARN when highest-N >75% of threshold.
- Interactions may appear/disappear across N (carousel nav at >1 slide): curve fit only for interactions present at ≥2 points; single-point ones reported un-fitted.
- Baseline check (M22): highest-N point only; lower points informational.
- Heap noise concern deferred to M23 isolated memory mode.
