---
kind: milestone
status: done
tests: [test/unit/tiered-budgets.test.ts, test/unit/tiered-budgets-harden.test.ts]
---

# M13 — tiered budgets

Flat thresholds treat 3-node Badge like 200-node table. classifyTier per COMBO (that combo's domNodeCount + portal + animation; hasScaling accepted, ignored) → TIER_BUDGETS (see report.ts; calibrated for 4x throttle). Default on.

Non-obvious:
- Tier and flat budgets are independently calibrated (`TIER_BUDGETS` vs `DEFAULT_THRESHOLDS` in `report.ts`) and no longer coincide at any tier — a flat verdict and a tiered verdict on the same component can differ in either direction.
- Explicit `--threshold-*` overrides ONLY that metric; others keep tier budget (analyze tracks which flags were actually typed vs defaulted).
- relativeMount 2.0× check unchanged by tiers.
- `--flat-thresholds` reverts fully: classifyTier not called, no tier field, M6 flat thresholds.
- Portal signal = any interaction with portal:true; animation from MountResult.hasAnimation (M14).
- Exit codes unchanged; Report.version stays 1.
