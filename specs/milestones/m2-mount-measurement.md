---
kind: milestone
status: done
tests:
  - test/unit/measure.test.ts
  - test/unit/measure-harden.test.ts
  - test/unit/measure-harden2.test.ts
  - test/e2e/measure.test.ts
  - test/e2e/measure-harden.test.ts
  - test/e2e/measure-harden2.test.ts
---

## Purpose
Measure mount and unmount performance of a React component across all prop combinations using CDP traces in a real browser with CPU throttling.

## Contract
### MUST
- `measureMount(harness, options?)` accepts a `HarnessResult` and returns `MountResult[]`
- Launches own Playwright browser, creates CDP session
- Enables CPU throttle via `Emulation.setCPUThrottlingRate` (default 4, configurable)
- Runs warmup (default 2 runs, configurable via `warmupRuns`) before measurement to stabilize JIT/module caches
- Auto-extracts props via `harness.componentPath` → `extractProps` → `generateCombinations`, or accepts `combos` override
- For each prop combination, N samples (default 10):
  - Mount: `Tracing.start` → `mount(props)` → double-rAF settle → `Tracing.end` → collect
  - Unmount: `Tracing.start` → `unmount()` → double-rAF settle → `Tracing.end` → collect
- Parses trace events: sums durations from `X`-phase complete events. Scripting = `FunctionCall` + `EvaluateScript` + `v8.compile` + `v8.run`. Durations in µs converted to ms.
- DOM node count: `document.querySelectorAll('*').length` after first mount
- Computes median (sorted middle) and P95 (`ceil(0.95 * N) - 1` index); returns 0 for empty arrays
- Function props serialized with marker string, reconstructed as noops browser-side
- `Tracing.tracingComplete` awaited with 30s timeout — rejects if trace never completes
- Trace data listener removed after each trace to prevent handler accumulation
- Browser cleaned up in finally block
- Harness no longer auto-mounts — caller controls mount via control API

### MUST NOT
- Discover or exercise interactions (M3/M4)
- Parse full metric taxonomy (M5)
- Output reports (M6)

### Invariants
- CPU throttle always enabled during measurement
- Trace capture wraps only the mount/unmount action, not harness startup
- Cleanup runs even if measurement throws

## Types

```typescript
interface MeasureOptions {
  samples?: number;       // default: 10
  cpuThrottle?: number;   // default: 4
  combos?: PropCombination[];
  warmupRuns?: number;    // default: 2
}

interface MountResult {
  comboIndex: number;
  props: PropCombination;
  mount: TimingResult;
  unmount: TimingResult;
  domNodeCount: number;
}

interface TimingResult {
  samples: number[];
  median: number;
  p95: number;
}
```

## Design

### Trace capture (`src/measure.ts`)
- `chromium.launch({ headless: true })` → own browser per call
- `page.context().newCDPSession(page)` → CDP session
- `Tracing.start` with `devtools.timeline,v8.execute` categories
- Collect chunks via `Tracing.dataCollected`, resolve on `Tracing.tracingComplete` (30s timeout)
- Listener cleanup: `cdp.off("Tracing.dataCollected", onData)` after each trace
- Double `requestAnimationFrame` fence for settle after mount/unmount
- `serializeProps`: replaces function values with string marker; browser-side reconstructs as `() => {}`

### Harness changes
- `HarnessResult.componentPath` added — absolute path to source component
- Auto-mount removed from generated `entry.tsx`
- All M1 e2e tests updated to explicitly call `mount({})` via `gotoAndMount` helper

## Open
- Trace event taxonomy varies across Chromium versions — current parsing is conservative
- Double-rAF may be insufficient for very heavy async components — may need `MutationObserver` fence in M4
