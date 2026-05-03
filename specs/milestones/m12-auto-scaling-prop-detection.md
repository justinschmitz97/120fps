---
kind: milestone
status: done
tests:
  - test/unit/auto-scale.test.ts
  - test/unit/auto-scale-cli.test.ts
  - test/unit/auto-scale-report.test.ts
  - test/unit/auto-scale-harden.test.ts
---

## Purpose

Scaling analysis requires the user to manually author a fixture with `export function scale(n)`. Most components that need scaling analysis have obvious "count-like" props: `count`, `items`, `options`, `rows`, numeric props named `*Count*`/`*Size*`/`*Length*`, or array-typed props. M12 auto-detects these props from the `PropSchema` and generates scaling sweeps at `[1, 5, 20, 50]` without any fixture authoring. This makes scaling curves zero-config for the common case.

## Builds on

M8 (scaling infrastructure: `computeScalingCurve`, scale points, `rerenderScalingCurve` on `ComboReport`). M1 (prop extraction: `PropSchema` with `name`, `kind`, `values`, `required`).

## Contract

### MUST

- Add `ScalingPropMatch` type: `{ schema: PropSchema; kind: "numeric" | "array"; reason: string }`.
- Add `detectScalingProps(schemas: PropSchema[]): ScalingPropMatch[]` in `src/prop-gen.ts`.
- Detection heuristic (each schema checked independently):
  - **Array with items-like name**: `kind === "array"` AND name matches `/items|options|data|children|entries|records|elements|list/i`. Reason: `"array prop with items-like name"`.
  - **Any array**: `kind === "array"`. Reason: `"array prop"`.
  - **Numeric by name**: `kind === "number"` AND name matches `/count|size|length|limit|max|total|depth|level|columns|rows|pages/i`. Reason: `"numeric prop name matches scaling pattern"`.
  - **Numeric catch-all**: `kind === "number"` AND name matches `/^n$|^num/i`. Reason: `"numeric prop"`.
- Priority when multiple matches: array with items-like name > any array > named numeric > catch-all numeric. Only the first match is used for scaling.
- Add `generateScalingCombos(schemas: PropSchema[], match: ScalingPropMatch, scalePoints: number[]): PropCombination[]` in `src/prop-gen-values.ts`.
  - For numeric matches: anchor combo with scaling prop set to each scale point value.
  - For array matches: anchor combo with array prop containing N string items (`["item-1", ..., "item-N"]`) at each scale point.
- When `detectScalingProps` returns matches AND no manual `scale()` export is detected AND no `--scale` flag was passed AND not in fixture mode:
  - `analyze()` uses the first matching prop.
  - Generates scaling combos for that prop at default points `[1, 5, 20, 50]`.
  - Measures mount + rerender at each scale point.
  - Computes scaling curve from results.
- `--scale` flag, when passed explicitly, overrides the default `[1, 5, 20, 50]` points for auto-scaling too.
- `--no-auto-scale` CLI flag to disable auto-scaling detection. `CliArgs.noAutoScale?: boolean`, `AnalyzeOptions.skipAutoScale?: boolean`.
- `Report.autoScalingProp?: string` — name of the auto-detected prop.
- `Report.autoScalingReason?: string` — human-readable reason.
- Terminal table: `Scaling: linear (auto: items)` when auto-detected.

### MUST NOT

- Change the manual `scale()` export contract from M8. Manual fixtures always take precedence.
- Generate scaling combos when the component has no scaling-eligible props.
- Break existing fixture-based scaling. Auto-detection is additive.
- Modify `PropSchema` or `extractProps`. Detection is a downstream consumer.
- Auto-scale in fixture mode (fixtures already handle their own composition).

### Invariants

- Components with no number/array props produce no auto-scaling combos.
- Auto-scaling combos are measured with the same CDP tracing, samples, cpuThrottle as normal combos.
- `computeScalingCurve` from M5 is reused without modification.
- Normal prop combos (from `generateCombinations`) are still measured. Scaling combos are an additional pass.
- All existing tests pass unchanged.

## Design

### Detection

```
detectScalingProps(schemas):
  matches = []
  for each schema:
    if kind === "array" and name matches ITEMS_PATTERN:
      matches.push({ schema, kind: "array", reason: "array prop with items-like name" })
    else if kind === "array":
      matches.push({ schema, kind: "array", reason: "array prop" })
    else if kind === "number" and name matches SCALING_NAME_PATTERN:
      matches.push({ schema, kind: "numeric", reason: "numeric prop name matches scaling pattern" })
    else if kind === "number" and name matches NUMERIC_SHORTHAND:
      matches.push({ schema, kind: "numeric", reason: "numeric prop" })
  sort by priority (items-array > array > named-numeric > catch-all)
  return matches
```

### Scaling combo generation

```
generateScalingCombos(schemas, match, scalePoints):
  anchor = { prop.name: prop.values[0] for each prop }
  combos = []
  for each n in scalePoints:
    combo = { ...anchor }
    if match.kind === "numeric":
      combo[match.schema.name] = n
    if match.kind === "array":
      combo[match.schema.name] = Array.from({ length: n }, (_, i) => `item-${i + 1}`)
    combos.push(combo)
  return combos
```

### Analyze integration

In `analyze()`, after determining combos and checking for manual scale:

```
if (!hasManualScale && !isFixture && !options.skipAutoScale) {
  const matches = detectScalingProps(schemas);
  if (matches.length > 0) {
    const match = matches[0];
    const points = options.scalePoints ?? [1, 5, 20, 50];
    const scaleCombos = generateScalingCombos(schemas, match, points);
    // measure and compute scaling curves
  }
}
```

### Report

- `Report.autoScalingProp` and `Report.autoScalingReason` recorded for transparency.
- Scaling combos contribute to `ComboReport.scalingCurve` and `ComboReport.rerenderScalingCurve` via the existing `computeScalingCurve` infrastructure.

## Test count

44 tests (24 unit + 20 unit-harden). 444 total.
