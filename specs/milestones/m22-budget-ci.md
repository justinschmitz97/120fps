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

## Purpose

M13 introduced tiered budgets with advisory verdicts. Real bench suites enforce hard thresholds that **fail CI** on regression — `applyBudgets({ tier: "T1" })` produces test assertions, not warnings. M22 upgrades 120fps budgets into a CI-grade regression gate: persistent baselines, per-component budget config, diff-against-baseline reporting, and exit codes that block merges on regression.

## Builds on

M13 (tiered budgets: `TIER_BUDGETS`, `classifyTier`, `computeVerdict`). M6 (CLI exit codes: 0=pass, 1=fail, 2=error). M8 (rerender measurement). M20 (scaling curves, if available).

## Contract

### MUST

- Add **budget config file** `120fps.config.json` (project root). Schema:
  ```ts
  interface BudgetConfig {
    defaults?: {
      tier?: ComponentTier; // override auto-classification
      mount?: number; // ms
      rerender?: number; // ms
      interaction?: number; // ms
      unmount?: number; // ms
    };
    components?: Record<string, ComponentBudget>; // keyed by relative path
  }

  interface ComponentBudget {
    tier?: ComponentTier;
    mount?: number;
    rerender?: number;
    interaction?: number;
    unmount?: number;
    scalingGrowth?: "linear" | "any"; // "linear" fails on super-linear
  }
  ```
- Load `120fps.config.json` from project root when present. CLI flags override config values.
- Add **baseline file** `120fps-baseline.json`. Schema:
  ```ts
  interface Baseline {
    version: 1;
    timestamp: string;
    entries: Record<string, BaselineEntry>; // keyed by relative component path
  }

  interface BaselineEntry {
    mount: number; // median ms
    rerender: number; // median ms
    unmount: number; // median ms
    domNodeCount: number;
    interactions: Record<string, number>; // label → median ms
    tier: ComponentTier;
  }
  ```
- `--save-baseline` CLI flag: after measurement, write/update `120fps-baseline.json` with current results. Merges with existing entries (other components preserved).
- `--check` CLI flag: compare current measurement against baseline. Report regressions. Exit 1 if any metric regressed beyond tolerance.
- **Regression tolerance**: configurable in `120fps.config.json`:
  ```ts
  interface BudgetConfig {
    tolerance?: {
      mount?: number; // percentage, default 10
      rerender?: number; // percentage, default 15
      interaction?: number; // percentage, default 15
      unmount?: number; // percentage, default 20
    };
  }
  ```
  A metric regresses when: `current > baseline * (1 + tolerance/100)`.
- `--ci` flag behavior updated:
  - Existing: exit 1 on verdict FAIL.
  - New: when baseline exists, ALSO exit 1 on regression (even if absolute verdict is PASS). This catches gradual drift.
  - `--ci --no-baseline` to skip baseline comparison in CI.
- Terminal output for `--check`:
  ```
  Budget check: Button (T1)
  
  Metric        Baseline    Current     Delta      Status
  -------       --------    -------     -----      ------
  Mount         0.82ms      0.95ms      +15.9%     REGRESSED (tolerance: 10%)
  Rerender      0.31ms      0.29ms      -6.5%      OK
  Unmount       0.15ms      0.14ms      -6.7%      OK
  Interaction   1.20ms      1.18ms      -1.7%      OK
  
  Result: FAIL (1 regression)
  ```
- Add `--budget` CLI flag as shorthand for `--ci --check` (the typical CI invocation).
- Multiple component paths: `npx 120fps ./Button.tsx ./Accordion.tsx` measures each component sequentially, accumulates verdicts, exits 1 if ANY fail. Each gets its own baseline entry.
- `Report` extended:
  ```ts
  interface Report {
    // existing fields...
    baseline?: BaselineComparison;
  }

  interface BaselineComparison {
    hasBaseline: boolean;
    regressions: Regression[];
    improvements: Improvement[];
  }

  interface Regression {
    metric: string;
    baseline: number;
    current: number;
    deltaPercent: number;
    tolerance: number;
  }

  interface Improvement {
    metric: string;
    baseline: number;
    current: number;
    deltaPercent: number;
  }
  ```
- Config loading: `loadBudgetConfig(projectRoot: string): BudgetConfig | null`. Returns null when file doesn't exist.
- Baseline loading: `loadBaseline(projectRoot: string): Baseline | null`.
- Baseline saving: `saveBaseline(projectRoot: string, entry: BaselineEntry, componentPath: string): void`. Merge-writes.

### MUST NOT

- Require a config or baseline file. 120fps works zero-config by default. Config/baseline are opt-in for CI usage.
- Change existing verdict logic. Tier budgets still produce PASS/WARN/FAIL. Baseline regression is an additional check on top.
- Auto-create baseline on first run. Baseline only written with explicit `--save-baseline`.
- Break existing `--ci` behavior for projects without baselines. No baseline → no regression check → same behavior as before.
- Make baseline comparison block when measurements are unstable (CV>15%). Unstable results produce a WARN, not a regression FAIL.

### Invariants

- `120fps.config.json` is optional. Missing file = all defaults.
- `120fps-baseline.json` is optional. Missing file = no baseline comparison.
- Component budgets in config override tier defaults for that specific component only.
- `--threshold-mount` CLI flag overrides both config and tier budgets.
- Precedence: CLI flags > `120fps.config.json` per-component > `120fps.config.json` defaults > TIER_BUDGETS.
- Baseline comparison uses percentage tolerance, not absolute ms — this makes it machine-independent.
- Unstable measurements (CV>15%) skip regression check for that metric (warn instead of fail).
- All existing tests pass unchanged.

## Design

### CI workflow (typical)

```yaml
# GitHub Actions example
- name: Performance baseline
  run: npx 120fps ./src/components/Button.tsx --budget

# To update baseline after intentional changes:
- name: Update baseline
  run: npx 120fps ./src/components/Button.tsx --save-baseline
```

### Config resolution

```
loadBudgetConfig(projectRoot):
  configPath = join(projectRoot, "120fps.config.json")
  if !exists(configPath): return null
  return JSON.parse(read(configPath))

resolveComponentBudget(config, componentPath, autoTier):
  perComponent = config?.components?.[relativePath]
  defaults = config?.defaults
  tier = perComponent?.tier ?? defaults?.tier ?? autoTier
  return {
    mountMs: perComponent?.mount ?? defaults?.mount ?? TIER_BUDGETS[tier].mountMs,
    rerenderMs: perComponent?.rerender ?? defaults?.rerender ?? TIER_BUDGETS[tier].rerenderMs,
    interactionMs: perComponent?.interaction ?? defaults?.interaction ?? TIER_BUDGETS[tier].interactionMs,
  }
```

### Baseline comparison

```
compareBaseline(baseline, componentPath, current):
  entry = baseline.entries[componentPath]
  if !entry: return { hasBaseline: false }
  
  regressions = []
  improvements = []
  
  for each metric in [mount, rerender, unmount]:
    delta = (current[metric] - entry[metric]) / entry[metric] * 100
    tolerance = config.tolerance[metric] ?? defaultTolerance[metric]
    if delta > tolerance:
      regressions.push({ metric, baseline: entry[metric], current: current[metric], deltaPercent: delta, tolerance })
    elif delta < -5:
      improvements.push({ metric, baseline: entry[metric], current: current[metric], deltaPercent: delta })
  
  return { hasBaseline: true, regressions, improvements }
```

### Multi-component invocation

```bash
npx 120fps ./Button.tsx ./Accordion.tsx ./Carousel.tsx --budget
```

Measures sequentially, shares browser instance across components. Final exit code = 1 if any component has regressions or FAIL verdicts.

### Interaction with M20 curve mode

When curve mode is active AND baseline exists, regression is checked at the highest scale point only (the "stress" data point). If the highest-N mount/rerender regressed, it's flagged. Lower scale points are informational.

## Open questions

1. Should baseline be committed to git? Decision: yes, recommend committing `120fps-baseline.json`. It's machine-normalized via percentage tolerance so cross-machine comparison works.
2. Should `--save-baseline` require all tests passing first? Decision: no — allow saving baseline even on FAIL to establish a new baseline after intentional cost increases.
3. Monorepo support: config/baseline per-package? Decision: defer. Config/baseline are always at `process.cwd()` (project root from which 120fps is invoked).

## Test count

64 tests: budget-config (12), budget-baseline (14), budget-cli (11), budget-report (6), budget-harden (21).
