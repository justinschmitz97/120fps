---
kind: milestone
status: approved
tests:
  # Lane C
  - test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts
  # Lane A
  - test/unit/import-graph-walk-parses-each-file-once.test.ts
  # End-game fix-up
  - test/unit/a-wedged-page-cannot-consume-the-whole-run.test.ts
  - test/unit/an-aborted-run-still-prints-its-roots-and-total.test.ts
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
- C4b When a sample's pattern did not run every planned step (`stepsRun < stepsPlanned`,
  `budgetExhausted`, or `stepsFailed > 0` — `executeStressPattern` swallows a step whose action
  throws and still counts it as run, so the failed-step count is the only signal for that case), the
  path is replayed before the next sample: no sample is measured from a state a truncated pattern
  left. `EXPLORE_STALLED_WARNING` ends the edge (`stalled = true; break;`), so it has no next sample
  and needs no reset. The unit test drives a fake whose pattern reports a failed step on sample 2 and
  asserts a second navigation before sample 3; no fake drives `budgetExhausted`, because the only
  state-invariant pattern carries one step.
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
  each change — 5 pairs per subject, or 3 where one pair costs minutes of wall clock, with the pair
  count stated in the record — reporting the median `phaseTimings.explore` (C1) and the median
  `phaseTimings.preflight` (A1-A4) from M115's field, plus the verdict and the warning list of both
  arms. A change whose A/B shows no win, or shows any difference in verdict, warnings or interaction
  rows, is reverted rather than shipped. A change is also reverted when any edge's
  `interactions[].timing.median` moves outside the noise band (`src/noise.ts`) between the arms — that
  is the evidence the pattern was not state-invariant (a virtualized list retaining its offset, a warm
  cache), per perf-levers.md lever B.

### Lane F (`src/measure.ts`, `src/analyze.ts`, `src/cli.ts`) — end-game fix-up

- F1 A measurement pass that produces no measurement at all for
  `MAX_CONSECUTIVE_DEGRADED_COMBOS` (3) combos in a row ends there. It warns through
  `options.onWarning`, naming the phase (`mount` or `rerender`) and how many combos of that pass it
  skipped, and the run still builds its report from the combos the pass did measure: an array with
  holes reaches `buildReport`, and every consumer of it reads the measured entries only.
- F2 A prop-delta pair is reported only when both sides measured both timings. A pair whose combo the
  mount pass never reached, or whose rerender the rerender pass omitted, is dropped rather than
  reported as a delta against a fabricated `0.00 ms`, on the standard path and the matrix path alike.
  A run whose every pair was dropped reports no `propDeltas` section rather than an empty one.
- F3 A run the watchdog aborts prints the abort sentence on stderr and, outside `--ci`, the roots
  line (M111 A4) and the `Total:` line (M115 A1) on stdout, then exits once with code 2 and prints
  no second error. Composing that stdout never prevents the abort: a failure while resolving the
  roots costs the roots line, not the abort.

## MUST NOT

- Shorten a pass that is still measuring. The bound in F1 counts only consecutive combos that
  produced no measurement at all after their retries, and a single measured combo resets it: a pass
  no combo of which starves measures every combo it was given, as before.
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
  `specifiersOut`/`warningsOut`/`extraAliasesOut`/`unresolvedExternals` contents, and called with a
  different alias array re-walks; a walk handed a dedupe set that already names a specifier does not
  shorten what a later walk with the same key and an empty set is told. `extraAliasesOut` is
  asserted equal across the two walks, but no fixture here produces a rescue alias (that needs a
  types-only workspace sibling), so the assertion covers the empty case only.

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

### Lane C evidence

Recorded 2026-09-02 from `C:\Projekte\120fps-m107` at `0b72589` + this lane's edit. Both A/B arms
were built from this worktree (`build-scratch.sh C-M116` and `C-M116-before`); the control arm is
the same dist with `replayPath`'s state-invariant early return disabled in
`scratch/C-M116-before/dist/explorer.js`, so the two arms differ in C1 and nothing else.

Unit, `node node_modules/vitest/vitest.mjs run
test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts --maxWorkers=2`:

```
 Test Files  1 passed (1)
      Tests  9 passed (9)
```

Lane regression, the 86 files under `test/unit/` that import `explorer.js`, `stress-patterns.js` or
`analyze.js` (`--maxWorkers=2`):

```
 Test Files  86 passed (86)
      Tests  1479 passed (1479)
```

`node node_modules/typescript/bin/tsc --noEmit`: clean, no output.

Before the change the same test file failed on the two counting assertions, for the right reason:
`AssertionError: expected 6 to be 2` (five per-sample mounts plus the initial one, where the edge
needs one) and `expected 7 to be 3` on the retry case.

#### A/B (E1), 5 interleaved same-window pairs per fixture

`--samples 5 --max-combos 4 --explore-budget 60 --no-deltas`, run alternately before/after in one
window, medians of `phaseTimings` from the JSON report (ms):

| fixture | arm | `explore` per pair | median | `preflight` median | verdict | warnings |
|---|---|---|---|---|---|---|
| `fixtures/large-dom.tsx` (one `:root` `scroll-sweep` edge) | before | 10120, 8581, 9316, 8830, 9965 | **9316** | 47 | PASS | 3 |
| `fixtures/large-dom.tsx` | after | 8545, 8299, 8294, 9226, 8719 | **8545** | 49 | PASS | 3 |
| `fixtures/aria-menu.tsx` (control, no state-invariant pattern) | before | 61925, 63244, 62091, 61683, 62587 | **62091** | 50 | PASS | 4 |
| `fixtures/aria-menu.tsx` | after | 61957, 62702, 60936, 62146, 63057 | **62146** | 50 | PASS | 4 |

`explore` on the scroll subject: **-8.3 %** (9316 ms to 8545 ms). The control moves +0.1 %
(62091 ms to 62146 ms), inside its own scatter: no state-invariant edge, nothing to hoist.
`preflight` is unchanged in both (lane A's memo is not in this arm), so the win is C1's alone.
The verdict and the warning list are identical between arms on both fixtures.

Interaction row, `fixtures/large-dom.tsx`, both arms, every pair: one row, `selector ":root"`,
`type "scroll"`, `label "document"`, `portal` absent, `stressPattern "scroll-sweep"`,
`timing.samples.length 5`. `timing.median` per pair, before: 17.49, 21.74, 20.58, 17.51, 16.27 ms
(mean 18.72, cross-run CV 11.1 %); after: 19.69, 18.15, 17.23, 20.17, 19.52 ms (mean 18.95, CV
5.8 %). The arm means differ by 1.3 %, inside `NOISE_CV_PERCENT` (15, `src/noise.ts:24`) and well
inside each arm's own scatter, so the pattern held its state-invariance: nothing to revert.

#### Corpus

Through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs` with
`--cli C:/Projekte/120fps-fieldtest/scratch/C-M116/dist/cli.js`.

1. shadcn-admin, `EVIDENCE.md` row shadcn-admin-F2, label `M116-shadcn-admin-after`
   (`-- src/components/data-table/toolbar.tsx --samples 5 --max-combos 4 --explore-budget 60
   --no-deltas`, `--timeout 1500`). Before (EVIDENCE.md): "toolbar.props.tsx remedy cannot supply a
   working TanStack Table stand-in". After, verbatim from the digest:
   `Result: FAIL [render error]`, `Total: 18.7s`,
   `phaseTimings {"preflight":221,...,"explore":6397,...,"total":18678}`, 10 warnings led by
   `⚠ vite.config.ts declares plugins, which the harness read but cannot honor: the project's Vite config is never executed`.
   No `scroll-sweep` in the report: explore unchanged (no state-invariant edge). The row's own
   finding is M112's remedy wording, not this milestone's; closed: no (out of lane C's scope). The
   before arm is lane A's to run with command 3: C1 is a no-op on this subject (no scroll-sweep
   edge), so no verdict, warning-list or `phaseTimings.preflight` comparison is claimed here; the
   arm comparison for C1 is `fixtures/large-dom.tsx` in the E1 table.
2. calcom control, `EVIDENCE.md` row calcom-R1, label `M116-calcom-after`
   (`-- packages/ui/components/popover/Popover.tsx --matrix --samples 3 --max-combos 4
   --explore-budget 60 --no-deltas`, `--timeout 900`). Before (EVIDENCE.md): "--matrix silently has
   no effect when auto-compose takes over". After: `Result: PASS`, `Total: 1m 13s`, 5 warnings, one
   combo with 2 interactions, both `open-close-10` — not state-invariant, so explore is unchanged
   here too (`phaseTimings.explore` 63977 ms against a 60 s budget). Reaches a report with the same
   verdict and warnings: control holds, closed: n/a.
3. Sweep memo (command 3) not run: its expectation is that per-component `phaseTimings.preflight`
   falls after the first component, which lane A's memo (A1-A4) produces. Lane A lands in wave 2;
   the command is left for that lane.
4. Unaffected repo, shadcn-admin `-- src/components/ui/button.tsx --explain-props`
   (label `M116-shadcn-admin-button-after`): still reaches its report,
   `Estimated real run: ~2m 9s (12 combos x 10 samples; defaults: no phase timings recorded for this component yet)`,
   `Dry run: nothing was measured, no report was written.`

C4b's `budgetExhausted` trigger is reachable only in the window between the sample loop's
`remainingWallClock()` guard and `executeStressPattern`'s own check (`src/stress-patterns.ts:189`),
which no deterministic fake reproduces; `scroll-sweep`, the only state-invariant pattern today,
carries a single step (`src/stress-patterns.ts:134-142`), so `stepsRun < stepsPlanned` is likewise
undrivable for it. The `stepsFailed > 0` trigger covers the case that does occur — a wheel step that
throws part-way leaves the container at an arbitrary offset — and the unit test drives it. The reset
is also covered by the retry test (`enterAndInvalidatePath`).

Plus, per the map: the milestone's tests pass, both lanes' existing tests stay green (baseline
failures excepted), and `tsc --noEmit` is clean.

### Lane A evidence

Recorded 2026-09-03 from `C:\Projekte\120fps-m107` at `755d26d` + this lane's edit. Both A/B arms
were built from this worktree (`build-scratch.sh A-M116` and `A-M116-before`); the control arm is
the same dist with the two memo reads disabled in `scratch/A-M116-before/dist/preflight.js`
(`parsedFiles.get`) and `.../harness.js` (`externalDepsWalks.get`), so the two arms differ in
A1-A4 and nothing else.

Unit, `node node_modules/vitest/vitest.mjs run
test/unit/import-graph-walk-parses-each-file-once.test.ts --maxWorkers=2`:

```
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

Lane regression, the 111 files under `test/unit/` that import `preflight.js` or `harness.js`
(`--maxWorkers=2`):

```
 Test Files  111 passed (111)
      Tests  1727 passed | 1 skipped (1728)
```

`node node_modules/typescript/bin/tsc --noEmit`: clean, no output.

Before the change the same test file failed on the two counting assertions, for the right reason:
`AssertionError: expected 2 to be 1` at the shared-chain read count (`a.tsx` read once per walk) and
the same message at `scanExternalDeps`'s entry read count.

#### A/B (E1), 5 interleaved same-window pairs per subject

`phaseTimings.preflight` in ms, alternating before/after in one window. Subject 1 is the single
component of corpus command 1; subject 2 is the 7-component sweep of corpus command 3, summed over
its per-component reports (the memo's subject is the shared chain, which only a sweep re-walks), 3
pairs there because one sweep pair costs 6 minutes of wall clock.

| subject | arm | `preflight` per pair | median | verdict | warnings |
|---|---|---|---|---|---|
| `src/components/data-table/toolbar.tsx` | before | 269, 301, 301, 243, 229 | **269** | FAIL [render error] | 10 |
| `src/components/data-table/toolbar.tsx` | after | 267, 248, 259, 262, 250 | **259** | FAIL [render error] | 10 |
| `src/components/data-table` sweep (sum of 7) | before | 1235, 1379, 1237 | **1237** | 7 reports | 3/6/9/4/3/10/3 |
| `src/components/data-table` sweep (sum of 7) | after | 1129, 1207, 1053 | **1129** | 7 reports | 3/6/9/4/3/10/3 |

`preflight` on the sweep: **-8.7 %** (1237 ms to 1129 ms), and **-3.7 %** on the single component
(269 ms to 259 ms), where only the dry-run, composed-child and real-run walks of one component share
the memo. Per component of the sweep, medians of 3 pairs (before / after, ms): bulk-actions 183/202
(the first component, nothing to reuse yet), column-header 132/119, faceted-filter 272/223,
pagination 145/114, toolbar 153/130, view-options 117/93, index 237/240. Every component after the
first falls except `index`, whose +3 ms sits inside its own scatter (before 230, 280, 237; after 255,
240, 217). The verdict and the warning list are identical between arms in all 10 single-component
runs and all 6 sweep runs; the only text that differs between two arms is the noise sentinel's own
measured number (`machine: hostile (probe CV 34%...)` before against `52%` after), which no memo
touches. `explore` is untouched in both arms (lane C's change is in both dists).

#### Corpus

Through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs` with
`--cli C:/Projekte/120fps-fieldtest/scratch/A-M116/dist/cli.js`.

1. shadcn-admin, `EVIDENCE.md` row shadcn-admin-F2, label `M116-shadcn-admin-after`
   (`-- src/components/data-table/toolbar.tsx --samples 5 --max-combos 4 --explore-budget 60
   --no-deltas`, `--timeout 1500`). Before (EVIDENCE.md): "toolbar.props.tsx remedy cannot supply a
   working TanStack Table stand-in". After, verbatim from the digest:
   `Result: FAIL [render error]`, `Total: 23.7s`,
   `component=DataTableToolbar path=src/components/data-table/toolbar.tsx mode=curve pass=false noise=hostile cached=false`,
   `warnings=10` led by
   `W vite.config.ts declares plugins the harness cannot honor: tanstackRouter, react, tailwindcss — the project's Vite config is never executed`,
   `phaseTimings.preflight` median 259 ms against the before arm's 269 ms (table above). Same verdict
   and same warning list as the before arm. The row's own finding is M112's remedy wording, not this
   milestone's; closed: no (out of lane A's scope).
2. calcom control, `EVIDENCE.md` row calcom-R1, label `M116-calcom-after`
   (`-- packages/ui/components/popover/Popover.tsx --matrix --samples 3 --max-combos 4
   --explore-budget 60 --no-deltas`, `--timeout 900`). Before (EVIDENCE.md): "--matrix silently has
   no effect when auto-compose takes over". After: `Total: 1m 15s`,
   `component=Popover path=packages/ui/components/popover/Popover.tsx mode=combo pass=true noise=hostile cached=false`,
   `warnings=8`, `combos=1`, `#0 verdict=warn domNodeCount=1 mount=11.5 rerender=4.3 interactions=2`.
   Reaches a report with the verdict the row records: control holds, closed: n/a.
3. Sweep memo, command 1 with `src/components/data-table` in place of the file, labels
   `M116-shadcn-admin-sweep-before`/`-after` plus pairs 2 and 3. After, verbatim from the digest:
   `Total: 11.2s`,
   `JSON: 7 per-component reports: C:\Projekte\120fps-fieldtest\logs\shadcn-admin\M116-shadcn-admin-sweep-after.bulk-actions.json, ...`.
   Per-component `phaseTimings.preflight` falls after the first component (medians above: 6 of the 7
   components are cheaper, the exception being the first one, which has nothing to reuse, and
   `index`, +3 ms inside its scatter), and each component's warning list in the sweep is identical to
   its arm-matched before run, `toolbar`'s among them (10 warnings, same order, same text as its
   single-file run of command 1). Closed: yes.
4. Unaffected repo, shadcn-admin `-- src/components/ui/button.tsx --explain-props`
   (label `M116-A-button-explain-after`): still reaches its report,
   `Estimated real run: ~2m 9s (12 combos x 10 samples; defaults: no phase timings recorded for this component yet)`,
   `Dry run: nothing was measured, no report was written.`

The memo is keyed on the walk's inputs and on the mtime and size of every file the walk read, so a
walk with a different alias set, `projectRoot` or `workspaceRoot` re-walks (A2) and an edited or
newly created file is read again (A3). Resolution probes into `node_modules` are not part of the
signature: a package installed mid-process would not invalidate an entry, which no run does and no
corpus repro exercises. Neither is a failed resolution: a specifier that resolved to no file leaves
no entry in the signature, so a source file created mid-process does not invalidate a walk entry
(no run creates one; `runPreflight` is immune, it redoes resolution per walk). Both memos are
bounded by the first-party import graph — neither walk parses `node_modules` (`src/preflight.ts:520`,
`src/preflight.ts:832`) — and both live for the process, so the retained set is the first-party files
one process walks.

### End-game fix-up evidence

Run 2026-09-03 in `C:\Projekte\120fps-m107`. Two defects the final corpus re-test recorded on
branch head `b1921fa` (`C:\Projekte\120fps-fieldtest\retest\midday.md`, rows midday-F1 and
midday-NEW1; log `logs/midday/final-midday-F1.log`, `"exit": 2, "seconds": 1269`). Both are older
than this milestone's lanes; they surface only once combos degrade, which no pre-wave-3 midday run
did.

Reproduction (before), scratch dist `scratch/F-M116/dist/cli.js` at `3360c58`, `DEBUG=120fps`:

    node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/midday --out C:/Projekte/120fps-fieldtest/logs/midday --label fixup-midday-1 --timeout 1500 --cli C:/Projekte/120fps-fieldtest/scratch/F-M116/dist/cli.js -- packages/ui/src/components/button.tsx

`logs/midday/fixup-midday-1.log`, exit 2 after 1272 s, reproducing both defects verbatim:

    prop deltas  (1:04)
    Error: packages/ui/src/components/button.tsx made no progress for 20 minutes; aborting the run, ...
    Error: Cannot read properties of undefined (reading 'props')
      at analyze (file:///C:/Projekte/120fps-fieldtest/scratch/F-M116/dist/analyze.js:3496:15)
      at async main (file:///C:/Projekte/120fps-fieldtest/scratch/F-M116/dist/cli.js:1375:28)

Observed during the stall (`Get-Process chrome-headless-shell`): one renderer at 100 % of a core for
the whole 20 minutes, started 2 minutes into `prop deltas`, and per-combo warnings for combos 22-40
("rAF fence starved", then "browser target closed"). The last progress line is `prop deltas`, so the
stall is the delta pass, not explore (explore finished at 0:29-1:04 in both arms).

Defect 2, root cause with file:line. `measureMount` (`src/measure.ts:1899`) and `measureRerender`
(`:1707`) allocate `new Array(combos.length)` and leave the slot of a combo that measured nothing
unset, so their result arrays are sparse; `for..of` yields `undefined` for a hole. The delta pass
iterates them at `src/analyze.ts:1742`, `:1746`, `:1806`, `:1809` (matrix mode at `:1643`, `:1654`),
and every midday delta combo from 22 on was omitted, so `m.props` read a hole. `animatedIndices`
(`src/analyze.ts:4437`) had already met the same holes and guards with `m?.`. Fixed by
`measuredOnly` (`src/measure.ts`), used at all six iterating consumers; the arrays keep their holes
because `buildCurveReport` (`src/report.ts:1740`) aligns them with its scale points by position.

Defect 2, the abort path. `watchdogAbortOutput` (`src/cli.ts`) now prints the roots line (M111 A4)
and the `Total:` line (M115 A1) on stdout beside the abort sentence, and the component's `catch`
returns once the abort fired, so `abortRun` owns the one error and the one exit (2) instead of a
second, unrelated error printing after it.

Defect 1, partial. `withFrameStarvationRetry` bounds one combo; nothing bounded a pass, so a wedged
renderer costs three retries per combo for every remaining combo. `createDegradedPassBound`
(`src/measure.ts`, `MAX_CONSECUTIVE_DEGRADED_COMBOS = 3`) ends a pass after three consecutive combos
that measured nothing, in both `runPass` bodies, and `measureStandardPropDeltas` no longer seeds an
unmeasured combo with a zero timing (a pair missing either side is dropped instead of reported as a
0.00 ms delta). This does not close midday-F1: with `--samples 10` a combo whose samples partly
survive is not "degraded", so the pass can still grind. Re-run
(`logs/midday/fixup-midday-2.log`, label `fixup-midday-2`, same command against
`scratch/F-M116-after`) reached `prop deltas (0:57)` and was still in that phase 9 minutes later
when the wall-time budget ended the attempt; the phases before it were unchanged and slightly
faster (`mount 0:03`, `explore 0:22`). Open: a wall-clock bound for the delta pass (or a per-combo
heartbeat) needs its own MUST, because it changes what a run measures. **midday-F1 is open**; the
lane ships F1-F3 above, not the wedged-run cure.

Review fix-up, second pass. The bound made holes ordinary but `buildReport` still iterated the raw
arrays (`for (const mount of input.mounts)`, and two `Array.prototype.find` calls, which visit holes
and call their predicate with `undefined`), so an abandoned pass would have ended in a TypeError one
frame later: all three now read `measuredOnly(...)`, as do the matrix path's rerender lookups. Only
the mount side of the delta pass had stopped fabricating: a combo whose mount measured but whose
rerender the pass omitted still carried `rerender: 0` and printed a delta against it. The map value
is now `{ mount: number; rerender?: number }` and both paths go through one exported
`propDeltasFromMeasured` (`src/analyze.ts`), which drops a pair missing either side or either
rerender. `watchdogAbortOutput` composes its stdout inside a `try`, so a `resolveProjectModel` throw
in the watchdog's timer callback can no longer skip `abortRun` (F3's second sentence), and the bound
stays silent when it trips on a pass's last combo, where it skipped nothing.

The pass-level tests are behavioural now, not source greps alone: `runBoundedPass` in
`test/unit/a-wedged-page-cannot-consume-the-whole-run.test.ts` drives the same bound over the same
`new Array(total)` results array the two `runPass` bodies write, and asserts the entries kept, the
warning delivered, and that `buildReport` over the resulting sparse array produces a report. The
source greps stay as the wiring backstop between that stand-in and the two real loops, which need a
browser (only `test/e2e` drives `measureMount`).

Tests (`node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2`):

    Test Files  2 passed (2)
         Tests  22 passed (22)

Both files fail on the pre-change tree at import (`createDegradedPassBound`, `measuredOnly` and
`watchdogAbortOutput` did not exist) and their source-wiring assertions fail against the old bodies.

The 40 `test/unit` files that import `src/measure.js` or `src/cli.js`:

    Test Files  40 passed (40)
         Tests  801 passed (801)

The 11 files that exercise the prop-delta pass:

    Test Files  11 passed (11)
         Tests  154 passed (154)

`node node_modules/typescript/bin/tsc --noEmit`: clean, no output.

Corpus control (unaffected repo, `scratch/F-M116-after`, label `M116-fixup-control`):

    node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/shadcn-admin --out C:/Projekte/120fps-fieldtest/logs/shadcn-admin --label M116-fixup-control --timeout 300 --cli C:/Projekte/120fps-fieldtest/scratch/F-M116-after/dist/cli.js -- src/components/ui/button.tsx --explain-props

`exit=0 seconds=2`, same `Props (32)` table, same warnings, and the M115 estimate line
(`Estimated real run: ~2m 9s`). Closed: yes.

No corpus run exercises F1 or F3. The watchdog budget has a floor no flag reaches
(`runWatchdogBudgetMs`, `src/cli.ts:184-187`: `max(exploreBudget + 10 min, 20 min)`), so forcing an
abort on the corpus costs a subject that stalls a phase for twenty minutes, and the pass bound needs
a renderer that wedges on demand -- midday's button wedged, and midday-F1 is open precisely because
the wedge was not reproduced on the after-tree. Both are covered by unit tests that execute the
behaviour (above), not by source text alone. A corpus repro stays owed with midday-F1.

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

## Approval

Approved 2026-09-03. Commits: `7593fbf` and `aefed17` (lane C), `3803efd` and `64bd812` (lane A),
`77abeb8` and `29852bd` (lane F end-game fix-up).

- Lane C (C1-C5): `test/unit/explore-replays-state-invariant-path-once-per-edge.test.ts` — 9 passed;
  lane regression 86 files / 1479 tests passed; `tsc --noEmit` clean. Corpus: command 1
  (shadcn-admin toolbar, `M116-shadcn-admin-after`) `Result: FAIL [render error]`, `Total: 18.7s`,
  no `scroll-sweep` edge, explore unchanged; command 2 (calcom control) `Result: PASS`,
  `Total: 1m 13s`, 5 warnings; command 3 deferred to lane A's wave; command 4 (`--explain-props`)
  reaches its dry-run report. E1 A/B, 5 interleaved pairs per fixture: `explore` -8.3 % on
  `fixtures/large-dom.tsx`, control `fixtures/aria-menu.tsx` +0.1 %, same verdict, same warnings,
  interaction-row medians inside the noise band.
- Lane A (A1-A4): `test/unit/import-graph-walk-parses-each-file-once.test.ts` — 8 passed; lane
  regression 111 files / 1727 passed, 1 skipped; `tsc --noEmit` clean. Corpus: command 1 same
  verdict and same 10 warnings as its before arm; command 2 (calcom control) holds; command 3
  (sweep) 7 per-component reports, per-component `phaseTimings.preflight` falls after the first
  component; command 4 reaches its report. E1 A/B: `preflight` -8.7 % on the 7-component sweep
  (3 pairs, one pair costs 6 minutes) and -3.7 % on the single component (5 pairs), verdict and
  warning list identical in all 16 runs.
- Lane F (F1-F3): `test/unit/a-wedged-page-cannot-consume-the-whole-run.test.ts` and
  `test/unit/an-aborted-run-still-prints-its-roots-and-total.test.ts` — 2 files / 22 tests passed;
  40 files / 801 tests and 11 files / 154 tests passed; `tsc --noEmit` clean. Corpus control
  (`M116-fixup-control`) `exit=0 seconds=2`, same `Props (32)` table and warnings. No corpus run
  exercises F1 or F3: the watchdog budget has a floor no flag reaches and the bound needs a
  renderer that wedges on demand, so both are held by unit tests that execute the behaviour.

Re-run at approval, the four files of `tests:`:

```
 Test Files  4 passed (4)
      Tests  53 passed (53)
```

### Deferred / open

- **midday-F1 open**: the pass-level bound (`MAX_CONSECUTIVE_DEGRADED_COMBOS`) does not cure a
  wedged renderer whose combos partly measure; a wall-clock bound (or per-combo heartbeat) for the
  delta pass needs its own MUST in a follow-up milestone. A corpus repro of F1/F3 stays owed with it.
- Lever D — one driven session shared by the delta and scale-curve passes.
- Marking further patterns state-invariant (`rapid-toggle-11`): the flag also decides `targetHash`,
  so it changes the state graph.
- The observer-timing path as the default (`opts.observerTiming`).
- Cross-process caching of parses or walks, and any cache keyed on a content hash instead of
  `mtimeMs`.
- Explore's own bounds (200 nodes, depth 4, 8 combos, per-combo budget).
