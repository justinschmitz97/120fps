---
kind: milestone
status: done
tests:
  - test/unit/cost-attribution.test.ts (24 tests)
  - test/unit/cost-attribution-report.test.ts (6 tests)
  - test/unit/cost-attribution-cli.test.ts (3 tests)
  - test/unit/cost-attribution-harden.test.ts (15 tests)
---

## Purpose

120fps treats components as black boxes. When mount takes 12ms, the user can't tell whether the cost is in Radix primitives, motion's AnimatePresence, their own render logic, or React internals. Hand-written bench suites solve this by rendering layers in isolation — labor-intensive and measures artificial scenarios that miss cross-layer interactions. CDP traces already contain call stacks with source locations. M16 parses these to attribute scripting time to source packages and user code automatically.

## Builds on

M5 (CDP trace capture with `TraceEvent` including `args` field). M6 (report structure, `ComboReport`).

## Contract

### MUST

- Export `attributeCost(events: TraceEvent[]): CostAttribution` from `src/metrics.ts`.
- `CostAttribution`: `{ buckets: CostBucket[], unattributed: number }`.
- `CostBucket`: `{ source: string, durationMs: number, percentage: number, category: "user" | "package" | "react" | "browser" }`.
- Source grouping rules:
  - `node_modules/<scope>/<pkg>` or `node_modules/<pkg>` → package name (e.g. `@radix-ui/react-accordion`, `motion`).
  - `react-dom`, `react`, `react/jsx-runtime`, `scheduler` → category `"react"`, grouped as single `"react"` bucket.
  - Paths inside the project root (not in node_modules) → category `"user"`, grouped by relative file path.
  - No source location or browser-internal → category `"browser"`, single `"browser"` bucket.
  - Unresolvable stacks → `unattributed`.
- Parse `args.data.url`, `args.data.fileName`, or `args.data.scriptName` from `FunctionCall`, `EvaluateScript`, `v8.compile` trace events. Fall back to `args.data.stackTrace.callFrames[0].url` when top-level fields are absent.
- Vite-transformed URLs: strip query params (`?v=`, `?t=`), resolve `/@fs/` prefix to absolute path, map back to project-relative or node_modules path.
- Duration: use `dur` field (microseconds → milliseconds). Apply same nesting-stack deduplication as `parseTraceDuration` to avoid double-counting parent spans.
- `CostBucket.percentage` = `durationMs / totalScriptingMs * 100`. Sum of all percentages + unattributed = 100.
- Add `costAttribution?: CostAttribution` to `ComboReport`.
- `buildReport()` calls `attributeCost` on mount traces for each combo.
- `formatTable()` shows top-3 cost buckets per combo when attribution data is present: `Cost: @radix-ui/react-accordion 42% | motion 31% | user 22%`.
- JSON report includes full `costAttribution` per combo.
- `--no-attribution` CLI flag → `AnalyzeOptions.skipAttribution` → skip attribution pass.

### MUST NOT

- Require source maps. Work from raw Vite-served URLs. Source maps would improve accuracy but are not required for v1.
- Add a separate trace capture pass. Attribution uses the same mount/interaction traces already captured.
- Change trace capture configuration (no additional CDP domains or categories needed — `devtools.timeline` already includes call stacks when `includedCategories` has `v8.execute`).
- Attribute layout/paint/style-recalc time to JS sources. Only scripting events have meaningful call stacks.
- Break existing tests or report format.

### Invariants

- `sum(buckets[].durationMs) + unattributed <= totalScriptingDuration` for the same trace.
- Components with zero scripting (pure CSS) produce empty buckets.
- Same traces → same attribution (deterministic).
- Attribution adds no extra browser interaction — pure trace post-processing.

## Design

### Trace event parsing

CDP `devtools.timeline` category includes `FunctionCall` events with structure:

```json
{
  "cat": "devtools.timeline",
  "name": "FunctionCall",
  "dur": 1500,
  "ts": 98234000,
  "args": {
    "data": {
      "url": "http://localhost:5173/node_modules/.vite/deps/@radix-ui_react-accordion.js?v=abc123",
      "functionName": "AccordionContent",
      "lineNumber": 42
    }
  }
}
```

### URL resolution pipeline

```
raw URL
  → strip query params (?v=, ?t=, ?hash=)
  → resolve /@fs/ prefix to absolute path
  → check if inside node_modules/
    → yes: extract package name (scoped or unscoped)
    → no: make project-relative path → "user" bucket
  → react/react-dom/scheduler → "react" bucket
  → no URL or chrome-internal → "browser" bucket
```

### Nesting deduction

Reuse the timestamp-based nesting stack from `parseTraceDuration`. When a child `FunctionCall` is nested inside a parent `FunctionCall`, only the child's duration is attributed to the child's source — the parent's attributed duration is reduced by the child's span. This prevents double-counting when React calls into Radix which calls into motion.

### Terminal output

After the existing combo table, when attribution is present:

```
Cost breakdown (mount)
  @radix-ui/react-accordion  4.2ms  42%
  motion                      3.1ms  31%
  src/accordion.tsx           2.2ms  22%
  react                       0.5ms   5%
```

Show top-3 for compact view. Full breakdown in JSON.

## Open questions

- Should we also attribute interaction traces, or mount-only for v1? Mount is the most actionable. Interaction attribution can follow if mount attribution proves useful.
- Should we merge sub-packages of the same scope? E.g. `@radix-ui/react-accordion` + `@radix-ui/react-collapsible` → `@radix-ui/*`? Probably not — per-package granularity is more useful for identifying which primitive is expensive.
- Vite dependency pre-bundling merges multiple packages into single `.vite/deps/` files. The URL becomes `@radix-ui_react-accordion.js` (underscore-joined). Need to reverse this mapping. Check if Vite exposes a deps metadata file we can read, or parse the munged filename.
