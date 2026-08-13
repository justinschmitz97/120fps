---
kind: milestone
status: done
tests:
  - test/unit/m37-browser-pool.test.ts
  - test/e2e/m37-pool.test.ts
---

# M37 — browser pool across phases and components

## Purpose

Every measurement phase launches its own Chromium (~0.4–1 s): `analyze`'s
calibration session, mount, rerender (plus a vsync browser when combos
animate), explore, react analysis, and each isolation phase. A single run
pays 5–8 launches; a 44-component sweep pays hundreds. Browser processes are
project-agnostic — what each phase actually needs fresh is the *page state*,
and a new browser context gives exactly that (its pages get their own
renderer process, so V8 starts as cold as in a fresh browser).

## Contract

- `createBrowserPool()` lazily holds at most two Chromium processes: one
  driven (`MEASUREMENT_BROWSER_ARGS`) and one vsync (plain). `acquire(driven)`
  launches on first use and caches; `closeAll()` closes both and makes
  further `acquire` throw; `stats().launched` counts real launches.
- With a pool, a measurement session gets a fresh browser context and page;
  `close()` closes the context, never the pooled browser. Without a pool,
  behavior is byte-identical to M35 (launch per session) — the pool is
  opt-in plumbing, not a semantics change.
- Measured numbers MUST be unchanged: a fresh context starts a fresh
  renderer process (cold V8, cold caches), which is the isolation the fresh
  browser provided. Warmup runs, throttle, GC, pacing, fences: untouched.
- `analyze()` creates a pool per run (or accepts one via
  `AnalyzeOptions.browserPool`) and threads it through mount, rerender,
  explore, react analysis, and isolation; it closes only pools it created.
- The CLI multi-component loop shares one pool across all expanded
  components — cross-component browser reuse falls out of the same plumbing.
- The begin-frame probe stays per session entry (it validates the new
  target); a pooled driven session whose probe fails falls back to a vsync
  *context* from the pool, warning as in M35. The pooled driven browser is
  left alive — a probe failure is about the target, not the process.

## Design

- `BrowserPool` lives in `measure.ts` next to `openMeasurementSession`,
  which gains an optional `pool`. The pool takes an injectable `launcher`
  for unit tests.
- `explore` and `runReactAnalysis` acquire the vsync browser (their plain
  launch was byte-equal to it) and open a context per pass.
- Isolation threads the pool through `IsolationRunOptions` and
  `PhaseOptions` into `runHarnessSession`.

## Limits

- Two driven pages pumping concurrently is untested territory; nothing in
  the pipeline runs two measurement sessions at once today, and the token
  scheduler that would (L6) is explicitly future work.
