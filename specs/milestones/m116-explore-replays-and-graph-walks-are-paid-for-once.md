---
kind: milestone
status: draft
tests:
  # Lane C
  - test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts
  # Lane A
  - test/unit/import-graph-walk-parses-each-file-once.test.ts
---

# M116: Explore replays and graph walks are paid for once

Lanes C (`src/explorer.ts`) and A (`src/preflight.ts`, `src/harness.ts`), per
`specs/milestones/M107-M117-MAP.md`. New work: no field-test finding, two measured levers.

## Purpose

A run repeats two pieces of work whose result cannot change between repetitions, and pays wall clock
for every repetition: explore replays an edge's path from the root once per timing sample even when
the pattern provably ends where it started, and the import graph is parsed up to three times per run
by `runPreflight` and walked twice more per build by `scanExternalDeps` — about 4N parses of the
shared modules across a sweep of N components. This milestone makes each of them cost once and
keeps every printed and serialized number the same: same verdict, same warnings, same interaction
rows, same preflight hits.

Closes: no finding ids. Run-5 evidence:
`C:\Projekte\120fps-fieldtest\remediation\perf-levers.md` (section 3 "Settle logic", section 4 "The
import-graph walk is re-run and never cached", levers B and C, lever D deferred) and
`C:\Projekte\120fps-fieldtest\remediation\timing-profile.md` (283 logged runs: real-run median 39 s,
P90 116 s, max 251 s; `--explain-props` median 7 s, max 92 s — every one of the 136 dry runs pays a
full import walk before it prints anything).

## Root causes (verified)

Line numbers below were read in this worktree (`C:\Projekte\120fps-m107`); where the map's number
differs, the map's number is named and the worktree's number is used.

1. **The path replay sits inside the sample loop.** The sample loop is `src/explorer.ts:684` (map:
   `:692`). Both bodies call `navigateToState` per sample: `src/explorer.ts:706` (observer path) and
   `src/explorer.ts:761` (trace path; map: `:759`). `navigateToState` (`src/explorer.ts:406`) mounts
   the component and replays every `pathFromRoot` step, each step followed by `waitForRender`
   (`src/explorer.ts:217-222`), a double rAF. Explore runs on the vsync context
   (`src/explorer.ts:465`, `pool.acquire(false)`), so a fence costs about one frame: an edge at depth
   d costs (d+1) fences per sample, and samples 2..`min(samples, 5)` pay it again.
2. **The code already proves samples 2..N start in the same state.** `src/explorer.ts:791-795`: for a
   state-invariant pattern the edge is a self-loop (`targetHash = item.stateId`, mirrored at `:730`),
   because the pattern ends where it started. Today exactly one pattern sets the flag: `scroll-sweep`
   (`src/stress-patterns.ts:138`, field declared at `src/stress-patterns.ts:20`), which bounds the win
   to edges whose interaction is a scroll.
3. **`runPreflight` parses the graph fresh on every call.** `parse` (`src/preflight.ts:331`) calls
   `ts.sys.readFile` plus `ts.createSourceFile` per reached file, and `runPreflight`
   (`src/preflight.ts:484`) builds its `seen`/`parents` sets per call. It runs up to three times per
   component: `src/analyze.ts:3305` (main walk), `src/analyze.ts:2185` (per composed JSX child),
   `src/analyze.ts:2375` (`--explain-props`).
4. **`scanExternalDeps` walks the same graph a second time, twice per build.**
   `src/harness.ts:4074`, reading each file with `fs.readFileSync` at `src/harness.ts:4107` (map and
   `perf-levers.md`: `:4084-4090`), called for the component at `src/harness.ts:3259` and for the
   wrapper at `src/harness.ts:3269`. A sweep of N components in one design system re-parses the shared
   modules about 4N times.
5. **Neither cost is visible in-product.** `graph.wallClockMs` is computed at `src/explorer.ts:874`
   and read nowhere (`grep -n wallClockMs src/*.ts` returns only `src/explorer.ts:87` and `:874`); the
   only wall clock printed is the per-component total (`src/cli.ts:1404` start, `:1443`
   `formatWallClock`). No `phaseTimings` field exists on `Report` yet — M115 adds it, and this
   milestone's evidence MUST depends on it.

## MUST

### Lane C (`src/explorer.ts`)

- C1 For an edge whose stress pattern is state-invariant, the path from the root is replayed once for
  that edge, before the first sample; samples 2..N run the pattern from the state the previous sample
  left. The edge still records `opts.sampleCount` samples.
- C2 The explore graph is unchanged by C1 on the fixtures: same node ids, same edge ids, same
  `targetHash` (`item.stateId`), same edge order, and every field of the report's `interactions` rows
  except `timing` and `relativeTiming` is identical to the per-sample-replay run: `selector`, `type`,
  `label`, `portal`, `stressPattern`, `steps`, and `timing.samples.length`
  (`src/report.ts:130-147`). `timing.median` moves only inside the noise band (`src/noise.ts`).
- C3 An edge whose pattern is not state-invariant replays the path per sample, exactly as today.
- C4 After a retry (`withFrameStarvationRetry` or a `withContextRetry` re-`enter()`), the path is
  replayed before the sample that follows: no sample is measured from a state a retry destroyed.
- C4b When a sample's pattern did not run every planned step (`stepsRun < stepsPlanned` or
  `budgetExhausted`), or the edge emitted `EXPLORE_STALLED_WARNING` (`src/explorer.ts:723`, `:782`),
  the path is replayed before the next sample: no sample is measured from a state a truncated pattern
  left. The unit test drives a fake whose pattern reports `budgetExhausted` on sample 2 and asserts a
  second navigation before sample 3.
- C5 The traced window still wraps only `executeStressPattern` (`src/explorer.ts:762-764`); the
  per-sample `tryCollectGarbage` (`src/explorer.ts:705`, `:760`) still runs per sample; explore keeps
  the vsync context and its per-combo budget, and an edge that spends the budget mid-samples
  still reports the samples it kept and prints `EXPLORE_STALLED_WARNING` with the same kept-sample
  count as the per-sample-replay arm (`src/explorer.ts:581`). How often a repeated warning prints is
  M117's, not this milestone's.

### Lane A (`src/preflight.ts`, `src/harness.ts`)

- A1 Within one process a source file is read and parsed at most once per (absolute path, `mtimeMs`,
  size, and whether an SFC compiler was supplied). A second walk over unchanged files returns a
  `PreflightResult` equal to the first — same hits, same kinds, same order, same parent chains — and
  issues no further read for those files. A walk that supplies an SFC compiler and a walk that does
  not never see each other's parse of a `.vue` file: on a Vue fixture the compiler-bearing walk
  reports the SFC's imports whether or not a compiler-less walk ran first, and the compiler-less walk
  reports none.
- A2 `scanExternalDeps` returns the same package list and writes the same values in the same order
  into every output channel it owns at the time of this change — `specifiersOut`, `warningsOut`,
  `extraAliasesOut`, and the `unresolvedExternals` M110 adds (I2) — cached or not. A walk with a
  different alias set, `projectRoot` or `workspaceRoot` reports what a first walk with those inputs
  reports, never the previous walk's list.
- A3 A file edited between two walks in one process is re-read: the second walk reports the edited
  file's imports (added hits appear, removed hits disappear) without any flag or restart.
- A4 In one process, an unchanged source file is read once in total across the `--explain-props` walk
  (`src/analyze.ts:2375`), the composed-child walks (`:2185`), the real run's walk (`:3305`) and every
  component of a directory sweep. No new flag, no on-disk state.

### Both lanes (evidence)

- E1 This spec's Verification section records, before approval, an interleaved same-window A/B for
  each change — 5 pairs per subject — reporting the median `phaseTimings.explore` (C1) and the median
  `phaseTimings.preflight` (A1-A4) from M115's field, plus the verdict and the warning list of both
  arms. A change whose A/B shows no win, or shows any difference in verdict, warnings or interaction
  rows, is reverted rather than shipped. A change is also reverted when any edge's
  `interactions[].timing.median` moves outside the noise band (`src/noise.ts`) between the arms — that
  is the evidence the pattern was not state-invariant (a virtualized list retaining its offset, a warm
  cache), per perf-levers.md lever B.

## MUST NOT

- Change any measured number: no cache read, memo write or timestamp inside `collectTrace`
  (`src/measure.ts`), and no change to calibration (M39 excludes calibration from reuse) or to the
  fresh-context-per-phase rule (M37: each phase's pages get a cold renderer).
- Hoist `tryCollectGarbage` out of the sample loop: sample independence stays as it is.
- Mark further patterns state-invariant (`rapid-toggle-11` ends where it started and carries no flag,
  `src/stress-patterns.ts:127`): the flag also decides `targetHash`, so setting it changes the graph.
- Change what either run sees: the dry run and the real run report the same preflight hits, in the
  same order, with the memo as without it (M100/M110 parity). A memo entry is never served to a walk
  whose inputs differ from the walk that produced it.
- Persist any parse or walk result across processes.
- Implement lever D (one driven session shared by the delta and scale-curve passes).

## Interfaces needed

- I11: producer lane C (M115, `src/report.ts` `Report.phaseTimings`, stamped in `src/analyze.ts`
  around `resolveProgressReporter`), consumer lanes C and A (M116, MUST E1). Shape: `phaseTimings`
  with numeric `explore` and `preflight` members in milliseconds per component, present in the JSON
  report. Without the field the A/B has only the per-component total (`src/cli.ts:1443`), which mixes
  both levers with browser noise. M116 reads the field; M116 does not write it.
- No other cross-lane interface: `runPreflight` and `scanExternalDeps` keep their signatures, and
  `src/explorer.ts` gains no new export.

Conflicts in `M107-M117-MAP.md`: C1 — A2's memo wraps `scanExternalDeps` after M107, M108 and M110;
C7 — A1's parse memo lands after M108's recognizers and M110's classifier; C10 — M115 publishes the
explore wall clock before C1's replay change.

## Verification

### Unit

- C1-C5 — `test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts`, in the style of
  `test/unit/explorer.test.ts`: a fake `Page` counting `__120fps.mount` evaluations and recorded
  interactions, driving one scroll edge (`scroll-sweep`, the only state-invariant pattern) with
  `sampleCount: 5`. Asserts one mount plus `pathFromRoot.length` exercises for that edge instead of
  five of each; five samples recorded; a click edge still mounts per sample; a fake that throws a
  context-loss error on sample 3 re-navigates before that sample's retry; the graph (node ids, edge
  ids, `targetHash`) equals the graph the same fake produces with per-sample replay.
- A1-A4 — `test/unit/import-graph-walk-parses-each-file-once.test.ts`, alongside
  `test/unit/preflight.test.ts`: new fixture `fixtures/shared-import-graph/` — two entry components
  (`a.tsx`, `b.tsx`) importing one shared chain (`shared/one.ts` to `shared/two.ts` to a
  hit-producing import), so the second walk hits the memo. Asserts: a spy on `ts.sys.readFile` counts
  each shared file once across two `runPreflight` calls; both results deep-equal; rewriting
  `shared/two.ts` and stamping a later mtime explicitly (`fs.utimesSync`, so the assertion does not
  depend on filesystem clock granularity) makes the third walk read it and report the new import; a
  file that did not exist at the first walk and exists at the second is read, not served as a cached
  miss; a `.vue` entry parses per compiler-supplied and compiler-less walk, each reporting its own
  imports; `scanExternalDeps` called twice with the same aliases returns equal lists and equal
  `specifiersOut`/`warningsOut` contents, and called with a different alias array re-walks.

### Corpus

Run through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs` against a scratch dist built from
this worktree, per the map's rule. Commands 1 and 2 are the `EVIDENCE.md` rows, verbatim.

1. Explore and walk subject (`EVIDENCE.md` row shadcn-admin-F2):
   `node run120.mjs --cwd /e/repositories-run5/shadcn-admin --out .../logs/shadcn-admin --label toolbar-remedy --timeout 1500 -- src/components/data-table/toolbar.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`
   Run as: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/shadcn-admin --out C:/Projekte/120fps-fieldtest/logs/shadcn-admin --label toolbar-remedy --timeout 1500 -- src/components/data-table/toolbar.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`
   (the row's `...` expanded).
   Expected after the fix: the same verdict line and the same warning lines as the pre-change arm, the
   same `interactions` rows in the JSON, and a lower `phaseTimings.preflight`. Explore moves only when
   the graph contains a `scroll-sweep` edge; the spec records how many edges used it, and states
   "explore unchanged (no state-invariant edge)" when there is none.
2. Unaffected control (`EVIDENCE.md` row calcom-R1):
   `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories/calcom --out C:/Projekte/120fps-fieldtest/logs/regression-calcom --label popover-matrix --timeout 900 -- packages/ui/components/popover/Popover.tsx --matrix --samples 3 --max-combos 4 --explore-budget 60 --no-deltas`
   Expected: reaches a report with the same verdict and the same warnings as before the change.
3. Sweep memo, derived from command 1 by replacing the file with its directory (derived, not a
   verbatim row): command 1 with `src/components/data-table` in place of
   `src/components/data-table/toolbar.tsx`. Expected: per-component `phaseTimings.preflight` falls
   after the first component, and each component's preflight hit list matches its single-file run.
4. Fixture A/B for E1: `fixtures/large-dom.tsx` (scrollable, produces `scroll-sweep` edges) and
   `fixtures/aria-menu.tsx` (click-driven, no state-invariant pattern: the control that must not
   move), 5 interleaved pairs each in one window, medians recorded here before approval.

Plus, per the map: the milestone's tests pass, both lanes' existing tests stay green (baseline
failures excepted), and `tsc --noEmit` is clean.

## Deferred

- **Lever D — one driven session shared by the delta and scale-curve passes**
  (`src/analyze.ts:1681`, `:1692`, `:1752`, `:1759`). M37 takes a fresh context per phase so each
  phase's V8 is cold; reuse changes absolute mount numbers that feed budgets and baselines. Reason to
  defer: the A/B that would falsify it (first-combo mount median outside the noise band) needs M115's
  numbers and a separate risk decision.
- **Marking more patterns state-invariant.** `rapid-toggle-11` returns to its start state, so the
  hoist would apply, and the flag also selects `item.stateId` as `targetHash`: setting it changes the
  state graph, which is a behaviour change, not a speed change.
- **The observer-timing path as the default** (`opts.observerTiming`). M52 closed with the trace path
  as the default after measurement; this milestone speeds both paths and changes neither default.
- **Cross-process caching of parses or walks**, and any cache keyed on a content hash instead of
  `mtimeMs`: staleness risk with no measured benefit over the in-process memo.
- **Explore's own bounds** (200 nodes, depth 4, 8 combos, per-combo budget,
  `src/explorer.ts:441-449`): unchanged here; changing them changes coverage, not repeated cost.
