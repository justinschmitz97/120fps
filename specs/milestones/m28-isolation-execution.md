---
kind: milestone
status: approved
tests: test/unit/m28-isolation.test.ts, test/unit/m28-isolation-harden.test.ts, test/e2e/isolation.test.ts
---

# M28 — isolation execution pipeline

## Purpose

Completes M23. `src/isolation.ts` held five pure builders and no browser code, `report.ts` could format a result nothing produced, and `AnalyzeOptions.isolation` was accepted and never read — so `--isolate` validated its input and then ran the standard pipeline. This milestone supplies the missing half: the phase runners, the harness support they need, and the wiring into `analyze()`. M23 now describes shipped behaviour; this file is archived with it.

## Non-goals

- Combining isolation with `--curve` or `--matrix` (already a usage error).
- Concurrent phase execution.
- Interaction measurement inside isolation mode. Isolation covers lifecycle phases only; `explore` does not run.
- Retuning tier budgets for isolated numbers.

## Contracts

### I1 — what "isolated" actually means

Stated plainly, because the difference from the standard pipeline is smaller than M23's prose implies:

- The standard pass already excludes unmount from the mount timing, already traces unmount separately, and already forces GC per sample.
- Isolation's real content is: (a) a focused pass per phase over a single combo with nothing else competing for browser state, (b) warmup of 3 mount/unmount cycles instead of 2, and (c) three measurements the standard pipeline does not make — churn, memory, StrictMode.
- MUST NOT re-navigate between samples. A fresh page per sample discards JIT state and would make isolated numbers noisier than the standard pass, defeating the purpose.

### I2 — combo selection

- Isolation measures exactly one prop combination: `combos[0]` from the standard generation path, or the single `{}` combo for fixture/composed runs.
- Prop-change rerender and churn need a second combination: `combos[1]` when it exists. When it does not, both degenerate to `combos[0]` and `Report.warnings` MUST gain `` `Only one prop combination available; prop-change and churn measure stable rerenders.` ``
- `__120fps_scaleN` combos are excluded from selection.

### I3 — phase passes

Each pass is self-contained and runs through `runHarnessSession`: `chromium.launch({headless:true})` → `newPage` → `attachPageErrorCapture` → `newCDPSession` → `enterHarness` (`goto` → `__120fps` readiness gate with `enrichTimeoutError` → wrapper viewport → M25's settle gate → `Emulation.setCPUThrottlingRate`) → warmup → sample loop → `finally` close. One browser per pass matches every existing measurement entry point (`measureMount`, `measureRerender`, `explore`, `runReactAnalysis`); M23 open question 3's shared-browser answer is superseded — launch cost sits outside every traced window, and self-contained passes are the codebase's established shape.

Passes, in phase order:

- **mount + unmount** — reuse `measureMount(harness, { combos: [combo], warmupRuns: 3, samples })`. It already GCs per sample, traces mount and unmount separately with double-rAF settles, and captures `domNodeCount`/`hasAnimation` on the first sample. The mount phase reports its `mount` samples, the unmount phase its `unmount` samples; when both are requested, one pass serves both. No new runner.
- **rerender** — stable and prop-change series via the existing `measureRerender` restricted to the selected combos (combo 0's stable + prop-change results); churn via `measureChurn(harness, propsA, propsB, cycles, opts): Promise<number[]>` — untimed `mount(propsA)`, then `cycles` iterations of traced `rerender(propsB)` followed by traced `rerender(propsA)`, producing `cycles * 2` samples in execution order. Fixed at 10 cycles. No GC between iterations — pressure accumulation is the thing being measured. The three arrays feed `buildRerenderIsolation`.
- **strictmode** — `measureStrictMode(harness, opts): Promise<{ normal: number[]; strict: number[] }>` — see I4.
- **memory** — `measureMemory(harness, cycles, opts): Promise<{ heapBefore; heapAfter; gcPressure }>` — see I5.

Sample counts come from `AnalyzeOptions.samples` (default 10), except churn (fixed) and memory (`memoryCycles`, default 20).

### I4 — StrictMode support

- Both entry templates MUST accept a `strict` query parameter:
  ```
  const __120fpsStrict = new URLSearchParams(location.search).get("strict") === "1";
  const __120fpsInStrict = (el) => __120fpsStrict ? createElement(StrictMode, null, el) : el;
  ```
  applied inside the single `renderTree` helper (M26, already landed). StrictMode wraps *inside* the provider wrapper — `wrapper(StrictMode(component))` — isolating the component's double-invoke cost from the providers'.
- The wrapping function is named `__120fpsInStrict`, not `__120fpsWrapStrict`: the latter contains `__120fpsWrap` as a substring, and M26's invariant "an entry generated without a wrapper never references `__120fpsWrap`" is asserted by substring search.
- `renderTreeHelper(wrapRelative, strict?)` emits the StrictMode form only when `strict` is true. The React probe entry (`generateProbeEntry`) shares the helper but defines no strict binding, so it keeps the default and its output is unchanged.
- `StrictMode` is imported from `react` in both templates unconditionally; the import is free when unused.
- `measureStrictMode` MUST use **interleaved paired sampling** — `normal, strict, normal, strict, …` — with a page navigation to `?strict=1` / no query between pairs, so both series see the same machine conditions (M23 invariant). Navigation cost is outside the traced block.
- `buildStrictModeReport(normalSamples, strictSamples)` consumes the two arrays unchanged.

### I5 — memory phase and GC availability

- Chromium is launched without `--js-flags=--expose-gc`, so `page.evaluate(() => gc())` is unavailable. The memory phase uses `tryCollectGarbage` (`HeapProfiler.collectGarbage`) and `Runtime.getHeapUsage`. M23's `--expose-gc` alternative is dropped.
- `tryCollectGarbage` returns `true` when the CDP call succeeded. Call sites that only want best-effort cleanup ignore it.
- Procedure: own browser like every pass (which satisfies M23 open question 1's fresh-context requirement) → readiness gate → throttle → warmup cycles → GC → `heapBefore` → `cycles` × (`mount(props)` + double-rAF + `unmount()`) → GC → `heapAfter`. Warmup precedes `heapBefore` so first-mount module and JIT allocations are not counted as growth.
- `gcPressure` is **the number of GC invocations that failed to reclaim to within 10% of `heapBefore`, sampled every 5 cycles**. It is measured, not stubbed: over 20 cycles a component that retains every mount scores 4 of 4 checks and one that releases scores 0. `heapBefore` of 0 disables the check rather than counting every sample.
- `leakSuspected` triggers above **8KB/cycle** and the memory phase warms up 10 cycles. M23's 1KB/cycle threshold sits inside the measurement noise floor and reports every component as leaking; evidence in M23's decision 4.
- `Runtime.getHeapUsage` failure degrades to `0`, matching `measureMount`'s existing handling; only GC unavailability skips the phase, because only that has a defined warning.
- If GC is unavailable, the memory phase is skipped, `Report.isolation.memory` stays undefined, and `Report.warnings` gains `` `Memory phase skipped: HeapProfiler.collectGarbage unavailable.` `` (M23 invariant).

### I6 — type bridge

- `measure.ts` returns `TimingResult` (`samples`/`median`/`p95`); `IsolationReport` requires `TimingWithCV`. Phase runners return raw `number[]` and `analyze` MUST convert via the existing `buildTimingWithCV`. No new timing type.

### I7 — analyze wiring

- When `options.isolation` is set, `analyze()` MUST branch before the curve decision and after combo generation, and MUST NOT run the standard pipeline stages — the all-combos `measureMount` sweep, the `measureRerender` sweep, `explore`, `runReactAnalysis`, delta analysis, auto-scaling. (The mount/unmount and rerender passes reuse the `measureMount`/`measureRerender` functions restricted to the selected combos — I3 — which is not the standard sweep.)
- It runs only the requested phases, in the order `mount, rerender, unmount, memory, strictmode`, populating `Report.isolation`. Because one pass serves both mount and unmount (I3), that pass runs once, at the position of the earlier of the two.
- An empty phase list is a usage error, from the CLI (`--isolate` with an empty or comma-only value) and from `analyze()` alike; isolation mode never produces an empty `Report.isolation`.
- `Report.combos` is `[]` in isolation mode. Any consumer that indexes `combos[0]` MUST be guarded — specifically the baseline paths.
- Calibration still runs; `Report.calibration` is populated as usual.
- `fixturePath`/`fixtureAutoDetected` and `autoComposition`/`compositionTree` are carried on the isolation report exactly as on the combo path: they describe what was measured, and isolation runs on fixtures and compositions.

### I8 — verdict

- `report.pass = false` iff any of:
  - isolated mount median exceeds the resolved tier budget for the component (tier via `classifyTier` from the mount pass's `domNodeCount` and `hasAnimation`, both already captured by `measureMount`; `hasPortal` is `false` — discovery does not run in isolation mode, so the portal signal does not exist. Consequence: a component whose T3 classification depends on portals gets a stricter tier here; `--flat-thresholds` or a config budget is the escape hatch);
  - `memory.leakSuspected`;
  - `rerender.churnDegradation > 2.0`.
- StrictMode `doubleInvokeClean === false` is a **warning**, not a failure — double-invoke overhead is a React development-mode property, not a shipped cost.
- With `--flat-thresholds`, the mount check uses `thresholds.mountMs` instead of the tier budget. Otherwise the budget comes from `resolveComponentBudget(config, component, tier)`, so `120fps.config.json` overrides apply; an explicit `--threshold-mount` wins over both, matching the combo path's `explicitThresholds` rule.
- With no mount phase requested there is no mount median and no tier signal, so only the memory and churn conditions can fail the run.

### I9 — baselines

- `--save-baseline` in isolation mode writes `mount`/`rerender` (stable)/`unmount` from the isolated phases, `domNodeCount` from the mount phase, and an empty `interactions` map.
- `--check` compares those metrics; `compareBaseline` already skips metrics whose baseline is `<= 0` and iterates only the recorded interaction keys, so an empty map is inert.
- Comparing an isolation baseline against a standard run (or the reverse) is not meaningful. M29 (already landed) handles this: the saved entry's `EnvFingerprint.mode` MUST be `"isolation"`, and `classifyEnv` classifies any cross-mode comparison `incompatible` — mismatch warning, no comparison, no failure (M29 E2/E3). This milestone adds no mode logic beyond passing the correct `mode` at save time.

### I10 — warnings reach the user

- `formatTable` renders `report.warnings` in all four output modes through a single `appendWarnings` helper, after the `Result:` line and before any baseline section. Pushing them only in the default combo branch — the isolation, curve, and matrix branches return early — would have made every warning this milestone produces invisible, and already hid them in curve and matrix output.

## Design notes

- Module placement: the three phase runners (`measureChurn`, `measureStrictMode`, `measureMemory`) and the phase orchestrator `runIsolationPhases` live in `src/isolation.ts`, the module named for isolated measurement. `measure.ts` owns the pieces they build on — `runHarnessSession` (launch → page → error capture → CDP → `enterHarness` → body → close), `enterHarness` (the navigate-and-prepare half, re-runnable for StrictMode's mid-session navigation), and the page actions `mountAndWait`, `mountAndTrace`, `rerenderAndTrace` — rather than growing three isolation-specific functions of its own. `measureMount` and `measureRerender` call `enterHarness` too, so the preamble has one implementation instead of five copies.
- The `--check` and `--save-baseline` blocks are hoisted into one `applyBaselineWorkflow(report, metrics, ctx)` used by both the combo path and the isolation path, because the isolation branch returns before the combo path's copy is reached. The combo path passes metrics derived from `combos[0]`; isolation passes them from `Report.isolation`.
- `formatIsolationOutput` already renders every field of `IsolationReport`; no formatter work beyond I10.
- `parseIsolationPhases` duplicated the validation the CLI did inline and was unreachable from it. Resolution: the CLI's inline validation is replaced by a call to `parseIsolationPhases`, which becomes the single validator and gains two behaviours — `all` expands wherever it appears in the list, and the result is deduplicated into the canonical phase order so the same set parses identically however it was spelled. The CLI catches its throw into `result.error` and rejects an empty result with the `--isolate` usage message.
- Churn deliberately skips GC so that degradation reflects real accumulation; the standard rerender pass keeps its per-sample GC.
- Out of contract but fixed here, because M28's own e2e surfaced it: Vite transforms the generated `.tsx` entry with the automatic JSX runtime, so the page imports `react/jsx-dev-runtime` although nothing declared it. Against a project whose optimizer cache is cold, Vite discovered it on the first page load, pre-bundled it, and full-reloaded — destroying the execution context inside `analyze()`'s own session roughly one run in three. `reactJsxRuntimeDeps(projectRoot)` now declares both runtime entry points in `optimizeDeps.include`, resolved from the project so React 16 (no automatic runtime) does not get an unresolvable include.

## Decisions

1. **Isolation honours `--samples`.** Per-phase variance did not call for separate counts; churn (fixed at 10 cycles) and memory (`--memory-cycles`) keep their own.
2. **`HeapProfiler.collectGarbage` is not deterministic enough for a 1KB/cycle threshold.** See M23 decision 4 for the measurements; the phase warms up 10 cycles and the threshold is 8KB/cycle.

## Verification

**Unit** — `parseIsolationPhases` expansion, canonical ordering and empty/invalid rejection, with the CLI asserted to report the parser's own error text verbatim; combo selection including scale-combo exclusion and degeneration; the options `runIsolationPhases` passes to `measureMount`/`measureRerender`, with the browser runners stubbed at `runHarnessSession`; the `buildTimingWithCV` bridge on every phase array; entry generation for the strict query in both templates and the unchanged probe entry; the three verdict conditions independently plus `doubleInvokeClean: false` not failing; warnings in all four `formatTable` branches; isolation baseline metrics, `mode: "isolation"`, cross-mode `incompatible`, and an empty interactions map staying inert.

**E2E** — `--isolate mount` populating only mount with `combos: []`; mount and unmount from one pass; `--isolate all` populating every phase; a leak fixture reaching `leakSuspected` and `pass: false` while a clean one does not; `gcPressure` scoring 4 of 4 for the leak and 0 for the clean control; a churn fixture exceeding 2.0 and failing while a constant-cost one stays under; StrictMode overhead above zero with `doubleInvokeClean` true for a well-behaved component and false for an accumulating effect; the degenerate warning on a fixture; explicit and flat mount thresholds; a churn target that throws mid-run completing without hanging; the isolation report surviving the JSON write; and a `--save-baseline` / `--check` round trip plus a cross-mode check classified `incompatible`.

Fixtures: `leaky-mount`, `churn-grow`, `churn-stable`, `churn-throws`, `strict-clean`, `strict-accumulate`.
