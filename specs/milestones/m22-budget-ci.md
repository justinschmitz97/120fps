---
kind: milestone
status: done
tests:
  - test/unit/budget-config.test.ts
  - test/unit/budget-baseline.test.ts
  - test/unit/budget-cli.test.ts
  - test/unit/budget-report.test.ts
  - test/unit/budget-harden.test.ts
---

# M22 — budget CI

`120fps.config.json` + `120fps-baseline.json`, both at package root = nearest package.json ancestor of the component (M24 D7; monorepo → workspace pkg root, matches harness dep resolution). Entry keys `"./" + posix(relative(root, component))`. Precedence: CLI flags > per-component config > config defaults > TIER_BUDGETS. Both files optional — zero-config stays.

Non-obvious:
- Tolerances are PERCENTAGES (machine-independent-ish; M29 fingerprint completes the story): mount 10, rerender 15, interaction 15, unmount 20. Improvement = delta < −5%.
- Unstable metric (CV>15% AND stddev above the 0.5ms noise floor — M35) → warn, never regression-FAIL. Baseline interactions missing from current run → warn (missingInteractions), never FAIL.
- `--save-baseline` merge-writes (other components preserved); allowed on FAIL (intentional cost increases); never auto-created.
- `--budget` = `--ci --check`. `--ci` + baseline present ALSO exits 1 on regression even when absolute verdict passes (catches drift). `--ci --no-baseline` opts out.
- Unsupported baseline version → warn + ignore (null).
- Curve mode + baseline: only highest-N point checked.
- Recommend committing baseline to git.
