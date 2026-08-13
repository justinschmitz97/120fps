---
kind: milestone
status: done
tests:
  - test/unit/report.test.ts
  - test/unit/analyze.test.ts
  - test/unit/cli.test.ts
  - test/unit/report-harden.test.ts
  - test/e2e/analyze.test.ts
  - test/e2e/cli.test.ts
---

# M6 — CLI + reporting

analyze() orchestrates pipeline → Report version 1 (JSON round-trips losslessly). Verdict: fail = threshold exceeded; warn = CV>15% unstable within thresholds; report.pass = no combo fails.

Non-obvious:
- relativeMount = mount.median / calibration.totalDuration, threshold 2.0.
- Zero-duration calibration → throw (hard fail). Calibration runs before combos.
- --ci: JSON only, exit 1 fail / 2 usage error — no terminal formatting (CI-safe).
- No color dependencies, no config files required.
- Harness cleaned up on all exit paths.
