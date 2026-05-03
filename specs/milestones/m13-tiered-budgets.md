---
kind: milestone
status: done
tests: [test/unit/tiered-budgets.test.ts, test/unit/tiered-budgets-harden.test.ts]
---

## Purpose

Flat thresholds (mount 50ms, rerender 16ms, interaction 400ms) treat a 3-node `<Badge>` the same as a 200-node data table. Simple components pass with room to spare while complex ones fail for structural reasons. M13 auto-classifies components into tiers based on DOM complexity, portal usage, and animations — then applies tier-appropriate budgets calibrated for 4x CPU throttle. A warning on a primitive component signals a real problem, not threshold miscalibration.

## Builds on

M6 (verdict logic: `computeVerdict`, `DEFAULT_THRESHOLDS` in `report.ts`). M9 (portal flag on `InteractionDescriptor` and `InteractionReport`). M8 (scaling curve on `ComboReport`).

## Contract

### MUST

- Add `ComponentTier` type: `"T1" | "T2" | "T3" | "T4"` in `src/report.ts`.
- Add `TierBudget` type: `{ mountMs: number; rerenderMs: number; interactionMs: number }`.
- Add `TIER_BUDGETS: Record<ComponentTier, TierBudget>` constant (calibrated for 4x CPU throttle):
  - T1 (primitive): `{ mountMs: 14, rerenderMs: 10, interactionMs: 200 }`.
  - T2 (composite): `{ mountMs: 20, rerenderMs: 12, interactionMs: 250 }`.
  - T3 (portal/motion): `{ mountMs: 30, rerenderMs: 14, interactionMs: 300 }`.
  - T4 (heavy): `{ mountMs: 50, rerenderMs: 16, interactionMs: 400 }`.
- Add `classifyTier(info: { domNodeCount: number; hasPortal: boolean; hasScaling?: boolean; hasAnimation: boolean }): ComponentTier` pure function. Classification rules (first match wins):
  - T3: has portals OR has animations.
  - T1: domNodeCount ≤ 12.
  - T2: domNodeCount ≤ 40.
  - T4: everything else (domNodeCount > 40).
  `hasScaling` parameter is accepted but ignored — tier is per-combo based on that combo's domNodeCount.
- `computeVerdict` updated: accepts optional `tierBudget?: TierBudget`. When provided, tier-specific thresholds override flat thresholds for mount, rerender, and interaction checks. `relativeMount` threshold (2.0× calibration) remains unchanged.
- Explicit CLI `--threshold-*` flags partially override tier budgets for the specified metric only. Other metrics use tier budgets.
- `ComboReport` extended with `tier?: ComponentTier`. Set when tiered budgets are active.
- `Report` extended with `tieredBudgets?: boolean` flag.
- Tiered budgets enabled by default.
- `--flat-thresholds` CLI flag to revert to M6 flat thresholds. `CliArgs.flatThresholds?: boolean`, `AnalyzeOptions.flatThresholds?: boolean`.
- Terminal table: tier shown in verdict column as `PASS (T1)` or `FAIL (T4)`.
- Portal detection for classification: `combo.interactions.some(i => i.portal === true)`.
- Scaling detection: `combo.scalingCurve != null || combo.rerenderScalingCurve != null`. Does not affect tier classification.
- Animation detection: `hasAnimation` read from `MountResult.hasAnimation` (implemented in M14). Animated components classified as T3 regardless of DOM count.

### MUST NOT

- Remove flat thresholds. They remain as the `--flat-thresholds` fallback.
- Change threshold semantics: thresholds are still "median exceeds X → fail".
- Break `--ci` mode. Exit codes unchanged: 0 = pass, 1 = fail, 2 = usage error.
- Change `Report.version` (remains 1 — tiered budgets are additive).

### Invariants

- `classifyTier` is pure: same inputs → same tier.
- Every `ComboReport` has exactly one tier when tiered budgets are active.
- A combo passing under flat thresholds may fail under tiered budgets (tighter T1/T2 budgets). Intentional.
- A combo failing under flat thresholds also fails under tiered budgets (T4 budgets match flat defaults; T1-T3 are tighter).
- `--threshold-mount 20` + tiered budgets: mount uses 20ms for all tiers, rerender/interaction use tier budgets.
- `--flat-thresholds` produces no `tier` field on combos.
- All existing tests must account for tiered verdict changes where applicable.

## Design

### Tier classification

```
classifyTier(info):
  if info.hasPortal or info.hasAnimation:
    return "T3"
  if info.domNodeCount <= 12:
    return "T1"
  if info.domNodeCount <= 40:
    return "T2"
  return "T4"
```

`hasScaling` accepted but ignored — each combo classified by its own domNodeCount.

### Verdict integration

In `buildReport()`, for each combo:

```
const hasPortal = combo.interactions.some(i => i.portal);
const hasAnimation = mount.hasAnimation ?? false;
const tier = classifyTier({ domNodeCount, hasPortal, hasScaling: false, hasAnimation });
const tierBudget = TIER_BUDGETS[tier];

// Apply explicit CLI overrides on top of tier budget
const effectiveBudget = {
  mountMs: explicitMount ?? tierBudget.mountMs,
  rerenderMs: explicitRerender ?? tierBudget.rerenderMs,
  interactionMs: explicitInteraction ?? tierBudget.interactionMs,
};

combo.tier = tier;
combo.verdict = computeVerdict(combo, thresholds, { tierBudget: effectiveBudget });
```

### Terminal table

```
#    Mount    Rerender  Unmount  DOM   Interactions  Scaling   Verdict
---  -------  --------  -------  ----  ------------  --------  ----------
0    0.82ms   0.31ms    0.15ms   8     2             -         PASS (T1)
1    3.50ms   1.20ms    0.45ms   45    12            linear    WARN (T4)
```

### CLI

`--flat-thresholds` disables tier classification entirely. `classifyTier` is not called, and M6 flat thresholds apply to all combos. `ComboReport.tier` is omitted.

### Tracking explicit overrides

`analyze()` tracks which thresholds were set via CLI (not just defaulted). This allows partial override: `--threshold-mount 10` sets mount but lets rerender/interaction use tier budgets.

## Test count

55 new tests (36 unit + 19 unit-harden). 499 total.
