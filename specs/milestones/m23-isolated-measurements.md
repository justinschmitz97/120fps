---
kind: milestone
status: approved
tests:
  - test/unit/isolation-cli.test.ts
  - test/unit/isolation-calc.test.ts
  - test/unit/isolation-report.test.ts
  - test/unit/isolation-harden.test.ts
  - test/unit/m28-isolation.test.ts
  - test/unit/m28-isolation-harden.test.ts
  - test/e2e/isolation.test.ts
---

## Purpose

Real bench suites isolate specific lifecycle phases: mount-only timing (teardown excluded from measurement), rerender with prop variations (stable/changed/churn), unmount-only timing, memory stability via repeated mount/unmount cycles, and StrictMode double-invoke comparison. The default pipeline bundles all phases into one sweep. **Isolated measurement modes** capture each phase independently instead, producing micro-benchmarks comparable to hand-authored vitest bench suites.

## Builds on

M8 (rerender measurement: `measureRerender`). M2 (mount measurement: `measureMount`). M5 (CDP tracing). M13 (tiered budgets).

## Contract

### MUST

- `--isolate` CLI flag with comma-separated phases: `--isolate mount,rerender,unmount,memory,strictmode`. Without the flag, the standard combo pipeline runs unchanged.
- Each isolated mode measures ONLY its target phase, excluding setup/teardown cost from timing.

#### Mount isolation (`mount`)

- Measures mount-to-first-paint. No unmount included in timing.
- Warmup: 3 mount/unmount cycles discarded.
- Per sample: force GC → unmount → trigger mount → capture CDP trace through a double-rAF settle → record duration. Unmount is traced separately, after recording stops.
- The page is never re-navigated between samples: a fresh page per sample would discard JIT state and make isolated numbers noisier than the standard pass.
- Reports: `TimingWithCV` for pure mount.

#### Rerender isolation (`rerender`)

- Measures rerender cost after component is already mounted and stable.
- Three sub-modes measured automatically:
  1. **Stable rerender**: same props, exercises React bailout path. N rerenders, timing per rerender.
  2. **Prop-change rerender**: cycle through prop combinations. Timing per transition.
  3. **Churn rerender**: alternating between two prop sets rapidly (10 cycles). Tests state-update hot path under pressure.
- Mount happens in setup (not timed). Unmount happens in teardown (not timed).
- Reports:
  ```ts
  interface RerenderIsolation {
    stable: TimingWithCV; // same-props rerender
    propChange: TimingWithCV; // different-props rerender
    churn: TimingWithCV; // rapid alternating rerender (10 cycles)
    churnDegradation: number; // ratio of cycle-10 timing to cycle-1 timing (>1 = degrading)
  }
  ```

#### Unmount isolation (`unmount`)

- Measures teardown cost in isolation.
- Per sample: mount component (not timed) → wait for stable → trigger unmount → capture CDP trace → record duration.
- Reports: `TimingWithCV` for pure unmount.

#### Memory stability (`memory`)

- Repeated mount/unmount cycles to detect leaks.
- Procedure: 10 warmup mount/unmount cycles → force GC → record heap → (mount/unmount) × N → force GC → record heap. N = 20 by default, override via `--memory-cycles`. The warmup precedes the first reading so one-time allocation is not counted as growth.
- Reports:
  ```ts
  interface MemoryReport {
    cycles: number;
    heapBefore: number; // bytes
    heapAfter: number; // bytes
    heapGrowth: number; // bytes (after - before)
    heapGrowthPerCycle: number; // bytes / cycle
    leakSuspected: boolean; // heapGrowthPerCycle > 8192 (8KB/cycle)
    gcPressure: number; // GC invocations that failed to reclaim to within 10% of heapBefore
  }
  ```
- GC is forced through CDP `HeapProfiler.collectGarbage`; heap is read through `Runtime.getHeapUsage`. Chromium is launched without `--js-flags=--expose-gc`, so `gc()` is not available in the page.
- `gcPressure` samples every 5 cycles: force GC, read the heap, and count the check when the heap is still more than 10% above `heapBefore`. For a component that retains every mount all checks count; for one that releases none do.
- `leakSuspected` threshold: >8KB growth per cycle. Measured over 20 cycles at 4× throttle after the 10-cycle warmup, non-leaking components grow 2.2–2.4KB/cycle and a component that retains every mount grows ~200KB/cycle; the threshold sits between them. A 1KB/cycle threshold falls inside the noise floor and reports every component as leaking.

#### StrictMode comparison (`strictmode`)

- Measures the cost difference between normal mode and React StrictMode.
- Procedure: measure mount normally (N samples) → measure mount wrapped in `<React.StrictMode>` (N samples) → compute delta.
- The harness entry.tsx is modified to optionally wrap in StrictMode based on a query parameter.
- Reports:
  ```ts
  interface StrictModeReport {
    normalMount: TimingWithCV;
    strictMount: TimingWithCV;
    overhead: number; // percentage increase: (strict - normal) / normal * 100
    doubleInvokeClean: boolean; // overhead < 110% suggests proper cleanup
  }
  ```
- `doubleInvokeClean`: if StrictMode overhead is <10% above 2×, effects are cleaning up properly. If significantly > 2× (>120%), effects may have accumulation bugs.

### Terminal output

The combo table is replaced by one section per measured phase, after the usual machine header. Warnings and the baseline section follow the result line, as in every other mode.

```
120fps — Button
Machine: ...

Mount (isolated)
  Median: 0.82ms  P95: 1.1ms  CV: 8.2%

Rerender (isolated)
  Stable:      0.31ms (React bailout path)
  Prop-change: 0.45ms
  Churn (10x): 0.52ms (degradation: 1.15×)

Memory (20 cycles)
  Heap: 148KB → 152KB (+4KB, +0.2KB/cycle)
  Leak suspected: NO

StrictMode
  Normal mount:  0.82ms
  Strict mount:  1.58ms (overhead: +92.7%)
  Double-invoke clean: YES

Result: PASS
```

### Report extension

```ts
interface Report {
  // existing fields...
  isolation?: {
    mount?: TimingWithCV;
    rerender?: RerenderIsolation;
    unmount?: TimingWithCV;
    memory?: MemoryReport;
    strictMode?: StrictModeReport;
  };
}
```

### CLI

- `--isolate <phases>` — comma-separated list: `mount`, `rerender`, `unmount`, `memory`, `strictmode`, or `all`.
- `all` expands to all five phases wherever it appears in the list. Phases are deduplicated and returned in the canonical order `mount, rerender, unmount, memory, strictmode`, so the same set parses identically however it was spelled. `parseIsolationPhases` is the single validator; the CLI reports its error text and rejects an empty list.
- `--memory-cycles <N>` — override default 20 cycles for memory mode.
- `--no-isolate` — disables isolation even when `--isolate` is present (explicit disable wins); no-op otherwise.
- `CliArgs.isolate?: string[]`.
- `CliArgs.memoryCycles?: number`.
- `AnalyzeOptions.isolation?: { phases: string[]; memoryCycles?: number }`.

### MUST NOT

- Change the default measurement pipeline. Without `--isolate`, behavior is unchanged.
- Run isolation modes in curve mode or matrix mode simultaneously. `--isolate` is mutually exclusive with `--curve` and `--matrix`. Error if combined.
- Skip warmup for isolated modes. Same warmup protocol as main pipeline.
- Report isolation results as `combos[]`. Isolation data goes into `Report.isolation`, separate from combo reports.

### Invariants

- Each phase pass owns its browser, matching every other measurement entry point, and uses the same CDP tracing and CPU throttle as the main pipeline. Mount and unmount share one pass.
- Every pass enters the harness through the same preamble: navigate with `HARNESS_NAV_WAIT` → `window.__120fps` readiness gate with `enrichTimeoutError` → wrapper viewport → style/font settle gate → CPU throttle.
- Memory mode forces GC via CDP before and after cycles. If GC forcing is unavailable, skip memory mode with a warning.
- StrictMode comparison uses paired samples (same machine conditions for both). Run interleaved: normal-strict-normal-strict... not all-normal-then-all-strict.
- Churn degradation ratio is computed from the last 3 samples divided by the first 3 samples of the 10-cycle run. Churn skips GC between iterations: accumulated pressure is what it measures.
- All existing tests pass unchanged.

## Design

### Harness modifications

Both measurement entry templates read a `strict` query parameter and apply it inside the single `renderTree` helper:

```tsx
const __120fpsStrict = new URLSearchParams(location.search).get("strict") === "1";
const __120fpsInStrict = (el: any) => __120fpsStrict ? createElement(StrictMode, null, el) : el;
```

StrictMode nests *inside* the provider wrapper — `wrapper(StrictMode(component))` — so the double-invoke cost measured is the component's, not the providers'. `measureStrictMode` navigates to `?strict=1` and back between pairs. The React probe entry shares `renderTreeHelper` but declares no strict binding and keeps the plain form.

### Combo selection

Isolation measures one prop combination: `combos[0]` from the standard generation path, or the single `{}` combo for fixture and composed runs. `__120fps_scaleN` combos are excluded. Prop-change and churn use `combos[1]`; without it both degenerate to `combos[0]` and `Report.warnings` gains a note.

### Integration with `analyze()`

`analyze()` branches on `options.isolation` after calibration and before the curve decision. It runs only the requested phases, never the standard sweeps, `explore`, `runReactAnalysis`, delta analysis, or auto-scaling. `Report.combos` is `[]`; `Report.calibration` is populated as usual.

Verdict: `pass = false` if the isolated mount median exceeds the resolved mount budget, or `memory.leakSuspected`, or `churnDegradation > 2.0`. `doubleInvokeClean === false` warns and never fails — double-invoke overhead is a React development-mode property.

## Decisions

1. **Fresh context per memory run.** Every phase pass owns a browser, so the memory phase measures a heap nothing else has touched.
2. **Churn count fixed at 10 cycles** (20 samples). Enough to separate a degrading rerender path from a constant one without inflating runtime.
3. **One browser per phase pass, not one shared session.** Launch cost sits outside every traced window, and self-contained passes match every other measurement entry point.
4. **`HeapProfiler.collectGarbage` is not deterministic enough for a 1KB/cycle threshold.** Warmup length dominates: measured over 20 cycles, non-leaking components report 13.6KB/cycle after 3 warmup cycles, 2.2KB after 10, and 0.8KB after 20, while a leaking component holds ~200KB/cycle throughout. The phase therefore warms up 10 cycles and the threshold is 8KB/cycle.

## Test count

The isolation contracts are enforced by `isolation-cli`, `isolation-calc`, `isolation-report`, `isolation-harden`, `m28-isolation`, `m28-isolation-harden` (unit) and `isolation` (e2e).
