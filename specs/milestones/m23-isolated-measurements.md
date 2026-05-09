---
kind: milestone
status: done
tests:
  - test/unit/isolation-cli.test.ts
  - test/unit/isolation-calc.test.ts
  - test/unit/isolation-report.test.ts
  - test/unit/isolation-harden.test.ts
---

## Purpose

Real bench suites isolate specific lifecycle phases: mount-only timing (teardown excluded from measurement), rerender with prop variations (stable/changed/churn), unmount-only timing, memory stability via repeated mount/unmount cycles, and StrictMode double-invoke comparison. 120fps currently bundles all phases together. M23 adds **isolated measurement modes** that capture each phase independently, producing micro-benchmarks comparable to hand-authored vitest bench suites.

## Builds on

M8 (rerender measurement: `measureRerender`). M2 (mount measurement: `measureMount`). M5 (CDP tracing). M13 (tiered budgets).

## Contract

### MUST

- Add `--isolate` CLI flag with comma-separated phases: `--isolate mount,rerender,unmount,memory,strictmode`. Default (no flag): all phases measured as today.
- Each isolated mode measures ONLY its target phase, excluding setup/teardown cost from timing.

#### Mount isolation (`mount`)

- Measures mount-to-first-paint. No unmount included in timing.
- Warmup: 3 mount/unmount cycles discarded.
- Per sample: navigate to blank → trigger mount → capture CDP trace until stable → record duration. Unmount happens after recording stops.
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
- Procedure: force GC → record heap → (mount/unmount) × N → force GC → record heap. N = 20 by default, override via `--memory-cycles`.
- Reports:
  ```ts
  interface MemoryReport {
    cycles: number;
    heapBefore: number; // bytes
    heapAfter: number; // bytes
    heapGrowth: number; // bytes (after - before)
    heapGrowthPerCycle: number; // bytes / cycle
    leakSuspected: boolean; // heapGrowthPerCycle > 1024 (1KB/cycle)
    gcPressure: number; // total GC pause time during cycles (ms)
  }
  ```
- Uses CDP `Runtime.evaluate` with `--expose-gc` flag or `Performance.collectGarbage` CDP method.
- `leakSuspected` threshold: >1KB growth per cycle after 20 cycles suggests accumulation.

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

When `--isolate` is passed, table format changes to show isolated results:

```
120fps — Button (isolated: mount, rerender, memory, strictmode)

Mount (isolated)
  Median: 0.82ms  P95: 1.1ms  CV: 8.2%

Rerender (isolated)
  Stable:      0.31ms (React bailout path)
  Prop-change: 0.45ms (variant: primary → ghost)
  Churn (10x): 0.52ms (degradation: 1.15×)

Memory (20 cycles)
  Heap: 148KB → 152KB (+4KB, +0.2KB/cycle)
  Leak suspected: NO

StrictMode
  Normal mount:  0.82ms
  Strict mount:  1.58ms (overhead: +92.7%)
  Double-invoke clean: YES (< 2× expected)

Result: PASS (T1)
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
- `--isolate all` runs all 5 isolation modes.
- `--memory-cycles <N>` — override default 20 cycles for memory mode.
- `--no-isolate` — explicitly skip isolation (default behavior without the flag).
- `CliArgs.isolate?: string[]`.
- `CliArgs.memoryCycles?: number`.
- `AnalyzeOptions.isolation?: { phases: string[]; memoryCycles?: number }`.

### MUST NOT

- Change the default measurement pipeline. Without `--isolate`, behavior is unchanged.
- Run isolation modes in curve mode or matrix mode simultaneously. `--isolate` is mutually exclusive with `--curve` and `--matrix`. Error if combined.
- Skip warmup for isolated modes. Same warmup protocol as main pipeline.
- Report isolation results as `combos[]`. Isolation data goes into `Report.isolation`, separate from combo reports.

### Invariants

- Isolation modes use the same browser instance, CDP tracing, and CPU throttle as main pipeline.
- Memory mode forces GC via CDP before and after cycles. If GC forcing is unavailable, skip memory mode with a warning.
- StrictMode comparison uses paired samples (same machine conditions for both). Run interleaved: normal-strict-normal-strict... not all-normal-then-all-strict.
- Churn degradation ratio is computed from the last 3 samples divided by the first 3 samples of the 10-cycle run.
- All existing tests pass unchanged.

## Design

### Harness modifications

StrictMode comparison requires the harness to conditionally wrap in StrictMode. The entry.tsx template adds:

```tsx
const params = new URLSearchParams(location.search);
const Wrapper = params.get("strict") === "1" ? React.StrictMode : React.Fragment;

render(<Wrapper><Component {...props} /></Wrapper>, root);
```

The measure function navigates with `?strict=1` for StrictMode samples.

### Memory measurement via CDP

```
async measureMemory(page, harness, combo, cycles):
  await page.evaluate(() => gc?.()) // --expose-gc or CDP collectGarbage
  heapBefore = await getHeapUsage(cdpSession) // Runtime.getHeapUsage
  
  for i in 0..cycles:
    mount(combo)
    unmount()
  
  await page.evaluate(() => gc?.())
  heapAfter = await getHeapUsage(cdpSession)
  
  return { heapBefore, heapAfter, cycles }
```

CDP method: `Runtime.evaluate({ expression: "gc()" })` requires `--js-flags=--expose-gc` on Chromium launch. Alternative: `HeapProfiler.collectGarbage` CDP domain.

### Rerender churn measurement

```
async measureChurn(page, harness, propsA, propsB, cycles):
  mount(propsA) // not timed
  timings = []
  for i in 0..cycles:
    t = traceRerender(propsB)
    timings.push(t)
    t = traceRerender(propsA)
    timings.push(t)
  
  first3 = avg(timings[0..2])
  last3 = avg(timings[-3..])
  degradation = last3 / first3
```

### Integration with `analyze()`

```
if (options.isolation):
  // skip normal combo pipeline
  // run only requested isolation phases
  // build Report with isolation field populated
  // verdict from isolation: FAIL if mount exceeds tier budget OR leakSuspected OR churnDegradation > 2.0
```

## Open questions

1. Should memory mode run in a separate browser context to avoid cross-contamination? Decision: yes — fresh browser context per memory run to isolate heap.
2. Should churn count be configurable? Decision: fixed at 10 cycles for now. 10 is enough to detect degradation without excessive runtime.
3. Can all isolation modes run in a single browser session? Decision: yes, sequentially. Each mode gets a fresh page/context within the same browser.

## Test count

63 tests: isolation-cli (13), isolation-calc (19), isolation-report (9), isolation-harden (22).
