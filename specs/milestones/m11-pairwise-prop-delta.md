---
kind: milestone
status: done
tests: [test/unit/delta.test.ts, test/unit/delta-report.test.ts, test/unit/delta-cli.test.ts, test/unit/delta-harden.test.ts]
---

## Purpose

120fps measures each prop combination independently. When a component has 5 boolean props yielding 32 combos, the user sees 32 rows of timings but cannot isolate which prop caused a cost spike. M11 generates pairwise delta combos for boolean and enum props — hold everything else constant, flip one prop, diff the timing — and reports "cost of prop X" as a delta. This turns a wall of numbers into actionable guidance: "spotlight adds +0.4ms mount overhead."

## Builds on

M1 (prop extraction: `PropSchema` with `kind` distinguishes boolean/union/string/number/etc.) and M8 (rerender measurement provides the rerender timing that delta analysis compares).

## Contract

### MUST

- Add `DeltaPair` type: `{ propName: string; baseCombo: PropCombination; flipCombo: PropCombination; baseValue: unknown; flipValue: unknown }`.
- Add `generateDeltaPairs(schemas: PropSchema[]): DeltaPair[]` in `src/prop-gen-values.ts`.
- Generate pairs for:
  - **Boolean props**: base has prop=false, flip has prop=true. All other props held at their first resolved value (the "anchor combo").
  - **Enum (union) props**: for each value V beyond the first, base has the first union value, flip has V. Skip self-pairs.
  - **Optional object props** (`kind === "object"` and `!required`): base has prop=undefined, flip has first object value.
- Cap total delta pairs at 128. Prioritize: booleans first, then unions sorted by value count ascending, then objects.
- Add `PropDelta` type to `src/report.ts`: `{ propName: string; baseValue: unknown; flipValue: unknown; mountDelta: number; rerenderDelta: number }`. `mountDelta` = flip.mount.median − base.mount.median. Positive = flip is slower.
- Add `propDeltas?: PropDelta[]` to `Report` (top-level, sorted by |mountDelta| descending).
- `analyze()` orchestrates: after normal combo measurement, generate delta pairs, measure each pair's base and flip combos (reuse already-measured combos where they match), compute deltas.
- Terminal table: "Prop Deltas" section after combo table. Each row: `propName: baseValue → flipValue | mount +Xms | rerender +Xms`. Top 5 shown, sorted by |mountDelta| descending.
- JSON report includes full `propDeltas` array.
- `--no-deltas` CLI flag to skip delta analysis entirely. Default: deltas enabled.
- `CliArgs.noDeltas?: boolean`, `AnalyzeOptions.skipDeltas?: boolean`.

### MUST NOT

- Change existing combo generation. Delta pairs are a separate measurement pass.
- Modify `PropSchema` or `extractProps`. Delta pairs consume existing schemas.
- Break existing report JSON consumers. `propDeltas` is additive.
- Measure deltas for function, reactnode, or unknown-kind props (no meaningful flip).

### Invariants

- Components with 0 boolean/enum/optional-object props produce `propDeltas: []`.
- Delta measurement uses the same samples/cpuThrottle/warmupRuns as the main measurement pass.
- Combos already measured in the main pass are not re-measured.
- All existing tests pass unchanged.

## Design

### Anchor combo

The "anchor combo" is each prop's first resolved value (index 0 from value generation). All props are held at their anchor value except the one being flipped.

### Delta pair generation

```
generateDeltaPairs(schemas):
  anchor = { prop.name: prop.values[0] for each prop }
  pairs = []
  for each schema:
    if kind === "boolean":
      pairs.push({ propName, base: anchor + {prop: false}, flip: anchor + {prop: true}, ... })
    if kind === "union":
      for each value V in schema.values[1..]:
        pairs.push({ propName, base: anchor + {prop: values[0]}, flip: anchor + {prop: V}, ... })
    if kind === "object" and !required:
      pairs.push({ propName, base: anchor + {prop: undefined}, flip: anchor + {prop: values[0]}, ... })
  cap at 128 by priority: booleans, unions (ascending value count), objects
  return pairs
```

### Analyze integration

After `measureMount()` and `measureRerender()`:

1. `const pairs = generateDeltaPairs(schemas)`.
2. Collect unique combos from all pairs. Deduplicate via `JSON.stringify`.
3. For each unique combo: check if it already exists in `mounts[]` (exact prop match). If yes, reuse. If no, measure it.
4. Compute `PropDelta` for each pair from the base/flip measurement results.
5. Attach sorted array to report.

### Terminal output

```
Prop Deltas (top 5):
  spotlight: false → true     mount +0.42ms  rerender +0.18ms
  variant: primary → ghost    mount +0.15ms  rerender +0.02ms
  disabled: false → true      mount -0.03ms  rerender +0.01ms
```

### CLI

`--no-deltas` suppresses the entire delta pass. Faster runs when deltas aren't needed.

## Test count

29 tests (9 unit + 7 report + 3 CLI + 10 harden).
