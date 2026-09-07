---
kind: milestone
status: draft
tests:
  - test/unit/the-analysis-pass-measures-each-prop-set-once.test.ts
  - test/unit/a-scale-probe-is-measured-once.test.ts
  - test/unit/the-memo-pass-runs-only-with-a-memo-fiber.test.ts
  - test/unit/every-phase-label-names-what-it-measured.test.ts
  - test/unit/the-explore-budget-bounds-the-phase.test.ts
  - test/unit/a-single-combo-run-is-bounded-too.test.ts
---

# M134: the passing run pays for each distinct prop set once and labels its phases truthfully

Lane F (`src/analysis/react-profiler.ts`, `src/analysis/react-probe-entry.ts`,
`src/pipeline/modes/combo.ts`, `src/pipeline/modes/curve.ts`, `src/report/phases.ts`, the budget check
in `src/analysis/explorer.ts`, the phase-bucket boundaries in `src/pipeline/analyze.ts`).

## Purpose

Thirty-five run-7 repositories reached a report under
`--samples 3 --max-combos 2 --explore-budget 30 --no-deltas`. Their median run spends 7.7 s in
analysis (18.8 s at p90, 26.6 % of the run), 2.6 s in explore, 4.5 s in mount, 3.7 s in build, 3.4 s
in what the report calls calibration, and 2.0 s in rerender. Three of those numbers are paid for work
already done: the React analysis pass measures four identical `{}` prop sets four times, a scale-point
gate performs a full mount whose result is discarded, and a memo pass mounts and rerenders for every
combo even when the tree has no memo fiber. One of them is mislabelled: the "calibration" bucket is at
least 97 % not calibration. And `--explore-budget` does not bound the phase it names — a 30 s budget
produced a 31.6 s single combo, and curve mode reads no budget at all. After this milestone the run
measures each distinct prop set once, each phase label names what that phase measured, and
`--explore-budget` is a bound on the explore phase.

Evidence: `C:/Projekte/120fps-fieldtest/smoke/run7-FINDINGS.md` cluster 6 (S1-S5, plus the refuted
levers) and the per-repo timing rows in `smoke/run7-smoke1/RESULTS.tsv`.

## Root causes (verified)

The verifier for every item below: run-7 investigation (2026-09-06), refuted by default; logs and
profiles under `C:/Projekte/120fps-fieldtest/logs/run7-investigate/` and
`smoke/run7-smoke1/logs/<repo>/`.

1. **The React analysis pass measures identical prop sets repeatedly** — the per-combo loop at
   `src/analysis/react-profiler.ts:644-732` runs for all six combos, although the four auto-scale
   combos (`__120fps_scaleN`, generated at `src/pipeline/modes/combo.ts:94`, also used at `:115` and
   `:140`) are identical empty prop sets to the probe: `src/analysis/react-probe-entry.ts` has no
   `scaleN` branch and `src/analysis/react-profiler.ts:78-80` strips it. `propCombinationKey`
   (`src/analysis/react-profiler.ts:76`) already exists as the identity. The verifier: an interleaved
   A/B on umbrel (five pairs, Verification below) moves the analysis phase from a 14 315 ms median to
   13 419 ms, −6.3 %. The earlier estimate of 1 287 ms per scale combo (37 % of the phase) is refuted:
   the callback-identity pass, which dominates the per-combo cost, was already deduped by the same
   key, so a scale combo pays only the memo, context and attribution windows, and the rest of the
   phase is the probe page's own bring-up and Vite transform.
2. **A gate performs a full measurement and throws it away** — `gateScalePoints`
   (`src/pipeline/modes/combo.ts:82-102`) opens its own session and runs a full `measureMount` whose
   result is discarded; the file says so at `:81` ("remeasured in the main batch") and `:90` ("never
   reported"). The verifier: the same scale point is then measured again in the main batch, so the
   session bring-up and the measurement are both paid twice.
3. **The "calibration" bucket is not calibration** — `classifyPhaseLabel`
   (`src/report/phases.ts:36`, table at `:35-46`) has no `mode:` branch, so the bucket opened at
   `src/pipeline/analyze.ts:544` stays open until the next `mount:` boundary and absorbs wrapper
   overhead, `msession.close`, `getSchemas`, `generateCombinations` and the gate from item 2. The
   verifier: on umbrel the probe is 93 ms of a 3 227 ms bucket; on midday it is 43 ms of 16 166 ms.
   M115 C1 (`m115-…:74-79`) requires the phase keys to be disjoint and to sum to `total` exactly,
   which a new boundary satisfies.
4. **The memo pass pays for a tree with no memo fiber** — `src/analysis/react-profiler.ts:646-654`
   runs one mount, two rerenders and two collects per combo; the filter that decides whether anything
   is reportable is at `:194` (`.filter((f) => f.isMemo && isReportableComponent(f.name))`, inside
   `detectMemoBailouts` at `:192`), which runs after the work. The verifier: a snapshot with no
   `isMemo` fiber yields an empty result at a full pass's cost. M128 L6 rejected this gate for the
   *callback* pass only, on the ground that both its corpus targets had `reactCompiler.active: true`;
   the memo pass is a different pass with a different filter.
5. **`--explore-budget` does not bound the explore phase** — `exploreWallClockPerCombo`
   (`src/pipeline/modes/combo.ts:173-175`,
   `exploreCombos.length > 1 ? Math.max(10000, Math.floor(60000 / exploreCombos.length)) : 60000`) is
   hardcoded and ignores the flag; the total check (`src/analysis/explorer.ts:418`,
   `if (results.length > 0 && Date.now() - runStart >= totalWallClockMs) break;`) runs only *between*
   combos, so the first combo is unbounded; and curve mode passes a hardcoded
   `maxWallClockMs: 30000` (`src/pipeline/modes/curve.ts:97`) that no flag reaches. The verifier:
   novu's combo 2 ran 31.6 s against `--explore-budget 30`; calcom's curve mode ran 37.7 s. M116's
   MUST NOT (`m116-…:548-549`) left explore's own bounds unchanged on the ground that changing them
   changes coverage rather than repeated cost; that clause is superseded by C5 below, which makes the
   user's own flag the bound.
6. **The single-combo case makes the budget inert** — the `: 60000` branch of `:173-175` means a
   one-combo run is given 60 s per combo whatever the flag says, and `:418`'s
   `results.length > 0` guard means the check cannot fire before that combo ends. The verifier: every
   scaffold logs `explore: 1 combos, budget 60s each` under `--explore-budget 30` and records
   `exploreWallClockMs` between 60 496 and 73 844 ms on a one-prop `Greeting`
   (`smoke/run7-new1/scaffold-*.json`, flag `slow-explore` on five of them).
7. **The cheap sampling path exists and is unreachable** — `observerTiming` is declared at
   `src/analysis/exploration-loop.ts:80` and `src/analysis/explorer.ts:79`, read at
   `src/analysis/exploration-loop.ts:203` under the comment at `:202`
   (`// The observer path skips the per-sample trace lifecycle, which dominates the wall clock.`), and
   forwarded at `src/analysis/explorer.ts:433`. No caller anywhere in `src` ever sets it, so the path
   the code names as the answer to the dominant cost is dead.
8. **Curve mode's bound is per scale point, not per phase** — `src/pipeline/modes/curve.ts:97`'s
   `maxWallClockMs: 30000` applies to each of the six scale points. The verifier: rallly spent 185 s
   in curve mode, identically in all five mode runs (`smoke/run7-new1/rallly.json`, flags `slow-real`
   and `slow-explore`, real 207 s).

## MUST

- **C1** The React analysis pass measures each distinct prop set once. Combos that produce the same
  `propCombinationKey` after the probe's own normalisation share one measurement, and the result is
  attributed to every combo that shares the key. The combo ids in the report, and the per-combo
  medians on the fixtures, are identical to what the per-combo pass produced.
- **C2** The scale-point gate does not perform a measurement whose result is discarded. The smallest
  scale point is measured once, in the main batch, and the gate reads that measurement.
- **C3** The `calibration` phase contains calibration and nothing else. The work that follows it —
  wrapper overhead, session close, schema collection and combination generation — is its own labelled
  phase, `setup`; the scale gate C2 folds into the main batch is part of `mount`. Every phase key is
  still present, phases remain disjoint, and they still sum to `total` exactly (M115 C1).
- **C4** The memo pass runs only when the snapshot contains at least one `isMemo` fiber that
  `isReportableComponent` accepts. When it does not, the pass is skipped, the result is the same empty
  result it produces today, and the run reports the same thing it reports today.
- **C5** `--explore-budget` bounds the explore phase, and this supersedes M116's clause at
  `m116-…:548-549` that left explore's own bounds unchanged:
  - The per-combo budget is derived from `--explore-budget`, not from the hardcoded
    `Math.max(10000, 60000 / n)`. The flag bounds the phase and never extends it: a combo is never
    given more than explore's own per-combo default, so a run that passes no flag keeps the bound it
    had.
  - The total budget is checked *before* the first combo runs and between every pair of combos, so a
    single combo cannot exceed the phase budget.
  - A one-combo run is bounded too: the `: 60000` single-combo branch derives from the flag like every
    other, and the total check is evaluated before the first combo runs, not only after it.
  - Curve mode derives its bound from `--explore-budget` for the *phase*, and divides it across its
    scale points, instead of applying a hardcoded `maxWallClockMs: 30000` per point. Without the
    flag each point keeps the 30 s the sweep gave it.
  - `observerTiming` is reachable: the option is threaded from the caller through
    `src/analysis/explorer.ts:433` to `src/analysis/exploration-loop.ts:203`, so the path the comment
    at `:202` names can be selected. Whether it becomes a default is C6's measurement, not this
    clause.
  - When the budget stops the phase, the run says so and names the flag; a stopped phase is not a
    failure.
- **C6** The measured effect is recorded, not assumed. This milestone's Verification carries an
  interleaved A/B (five pairs, same window, same machine) of `phaseTimings.analysis` on umbrel and of
  `phaseTimings.explore` on novu. A change that does not produce a warning-free win is reverted; a
  win smaller than the acceptance row estimated is recorded with the estimate it refutes.

## MUST NOT

- **Cache or skip calibration.** The probe is 0.4 % of the run; it gates `relativeMount` and the
  `normalizable` comparison path, and M39 excludes calibration from reuse precisely because a single
  sample swings 20-40 % (`specs/overview/00-tdd.md:822`, `:840`). M116's MUST NOT already forbids it
  (`m116-…:153`, "no change to calibration (M39 excludes calibration from reuse)"), and it stays
  forbidden here.
- **Move the Vite cache to a tmpdir, or introduce a `cacheDir`.** Vite's cache already persists in
  `<root>/node_modules/.vite`, and no `cacheDir` exists in `src`; the lever was measured and refuted.
- **Skip the M121 stylesheet compile probe.** It performs the same transform the page then requests,
  so skipping it moves the cost rather than removing it, and M121 A4 requires the harness to compile
  each candidate before the page is opened (`m121-…:67-71`); A5 depends on its result.
- Change what a combo *is*: C1 deduplicates measurement, never the combo list, the combo ids, the
  report shape or the number of rows the user sees.
- Change a default: `--samples`, `--max-combos`, the trace-versus-observer path (M52), the cold
  session per phase (M37) and the begin-frame control path all stay as they are.
- Change `--explore-budget`'s default or its meaning as a *phase* budget. C5 makes the phase obey it;
  it does not reinterpret the number.
- Make `observerTiming` the default. M52 chose the trace path after measurement; C5 makes the option
  reachable and nothing more (M116's MUST NOT on that default stands).
- Reduce coverage to hit a number: C5 stops a phase at the user's own bound and says so; it never
  silently drops combos inside a budget that was not reached.

## Design

**One measurement per prop set.** `measureOncePerPropSet` (`src/analysis/react-profiler.ts`) keys the
per-combo loop by `propCombinationKey` and hands every combo that shares a key a copy of the one
result. The combo list, the combo ids and the report's rows are untouched.

**One window for attribution and the memo diff.** Both asked the probe for the same mount and
rerender, so the pass takes it once. The snapshot it produces is the render attribution and the memo
diff's first snapshot; `detectMemoBailoutsFromSnapshot` spends the second rerender only when
`snapshotHasMemoFiber` sees a memoized fiber the report would name. Attribution is read before the
callback arms rather than after them, which is the window the code already asked for.

**The `setup` phase.** `progress("setup")` fires the moment the calibration trace is read, and
`classifyPhaseLabel` also maps every `mode:` line onto it, so a run that reaches a mode without the
setup line still closes calibration. `setup` holds wrapper overhead, the calibration session's
close, schema extraction and combination generation. `estimateRunCost` counts it as fixed cost; a
baseline written before the key existed reads as `0` and keeps its old estimate.

**The scale gate reads the main batch.** `measureGatedScaleMounts` puts the smallest scale point in
the batch that measures the prop combos and gates the remaining points on the median that batch
reported, so the warning quotes the number the report prints. The remaining points are measured in a
second batch and renumbered onto the combo list; when the gate refuses them, that batch never opens.
The sample count is fixed from the planned combo count before the gate decides, so a gated and an
ungated run report the same samples per combo. The first deferred point opens a fresh session and
takes that session's warm-up, where before it sat mid-batch.

**The explore budget.** `exploreUnitWallClockMs` divides the phase budget across the units, clamps
the share to the unit's own default (60 s per combo, 30 s per curve point) above and to 10 s below,
then to the phase budget itself, so `--explore-budget 5` yields 5 s and no flag yields exactly the
bound the run used before. `explore()` starts its clock at the phase's start, refuses a new combo
once `explorePhaseBudgetSpent`, and hands each combo the smaller of its share and what the phase has
left. `exploreRunOptions` builds those bounds plus `observerTiming`, which is present only when the
caller set `AnalyzeOptions.observerTiming`; no CLI flag selects it.

## Verification

- **C1** — `test/unit/the-analysis-pass-measures-each-prop-set-once.test.ts`: six combos of which four
  normalise to the same key produce three measurements; every combo still appears in the result;
  medians and combo ids are byte-identical to the per-combo pass on the `m66-*` fixtures; two combos
  with genuinely different props are measured separately.
- **C2** — `test/unit/a-scale-probe-is-measured-once.test.ts`: the gate consumes the main batch's
  measurement; a run records exactly one measurement session for the smallest scale point; the gate's
  decision is unchanged for a fixture that previously failed it and one that previously passed.
- **C3** — `test/unit/every-phase-label-names-what-it-measured.test.ts`: a synthetic boundary stream
  containing `mode:` yields a `calibration` bucket holding only the calibration interval; the new
  bucket holds the remainder; all keys present; the keys sum to `total`; a run that never calibrates
  reports `0`.
- **C4** — `test/unit/the-memo-pass-runs-only-with-a-memo-fiber.test.ts`: a snapshot with no `isMemo`
  fiber runs no mount and no rerender and returns the empty result; a snapshot with one runs the pass
  and returns the same result as today; `fixtures/m66-no-memo.tsx` is the negative case.
- **C5** — `test/unit/the-explore-budget-bounds-the-phase.test.ts` and
  `test/unit/a-single-combo-run-is-bounded-too.test.ts`: the per-combo budget derives from
  `--explore-budget`; a single combo that would run past the total budget is stopped before it starts
  and the run says which flag stopped it; the check runs before the first combo; a one-combo run under
  `--explore-budget 30` reports a budget of 30 s, not 60 s; curve mode's per-point bound is the phase
  budget divided across its points; `observerTiming` set by the caller reaches
  `src/analysis/exploration-loop.ts:203`; the default budget produces today's behaviour on a fixture
  that fits inside it.
- **C6** — recorded below: five interleaved A/B pairs per repo, `phaseTimings` medians, and the
  decision.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus every existing test of the files this milestone edits
  (`test/unit/react-profiler*.test.ts`, `test/unit/callback-identity*.test.ts`,
  `test/unit/report-carries-phase-timings.test.ts`, `test/unit/total-line-breaks-down-by-phase.test.ts`,
  `test/unit/explore-combo-budget.test.ts`, `test/unit/explorer.test.ts`,
  `test/unit/scale-probes-are-not-prop-combos.test.ts`, `test/unit/scale-probe-transparency.test.ts`,
  `test/unit/curve-*.test.ts`, `test/e2e/callback-identity-harden.test.ts`), then the full unit suite
  once before the lane's final commit.

Recorded run of this milestone's verification (2026-09-07, `run7/lane-f`, Windows 11, the machine
reporting `hostile` under a concurrent smoke and two other lanes):

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
# clean

npx vitest run test/unit/the-analysis-pass-measures-each-prop-set-once.test.ts   test/unit/a-scale-probe-is-measured-once.test.ts   test/unit/the-memo-pass-runs-only-with-a-memo-fiber.test.ts   test/unit/every-phase-label-names-what-it-measured.test.ts   test/unit/the-explore-budget-bounds-the-phase.test.ts   test/unit/a-single-combo-run-is-bounded-too.test.ts --maxWorkers=2
# Test Files 6 passed (6) | Tests 43 passed (43)

npx vitest run test/unit --maxWorkers=2
# Test Files 2 failed | 370 passed (372)
# Tests 2 failed | 5214 passed | 1 skipped (5217)
# the two failures are the recorded pre-existing pair: prop-cap-ranking.test.ts and
# vue-setup-inject-evidence.test.ts
```

`phaseTimings.analysis` on umbrel (`E:/repositories-run6/umbrel/packages/ui`,
`src/components/ui/card.tsx`, `--samples 3 --max-combos 2 --explore-budget 30 --no-deltas`), five
interleaved pairs, A = `C:/Projekte/120fps-run7/dist` at `de41d6a`, B = this branch's `dist`:

| pair | A analysis ms | B analysis ms | A total ms | B total ms |
|---|---|---|---|---|
| 1 | 14 604 | 13 035 | 44 928 | 35 226 |
| 2 | 14 195 | 36 950 | 36 637 | 60 400 |
| 3 | 14 096 | 12 623 | 36 741 | 31 820 |
| 4 | 14 315 | 13 419 | 35 593 | 34 623 |
| 5 | 15 916 | 13 492 | 39 019 | 37 976 |
| **median** | **14 315** | **13 419** | **36 741** | **35 226** |

Analysis median ratio 0.937 (−6.3 %); pair 2's B run is a 37 s outlier on a machine that reported
`hostile` in every run. Both arms print the same five warnings, differing only in the noise figures
inside the `machine: hostile` text, and both report `pass: true` over the same six combos with the
same combo ids. The A/B does not reach the 25 % the milestone's acceptance row asked for, and the
reason is recorded under root cause 1: the lever's size was estimated from a per-scale-combo cost the
measurement refutes. C1, C2 and C4 stay: each is a MUST in its own right, the change is warning-free,
and it removes about 0.9 s of duplicated measurement per run.

Other recorded runs, all `--samples 3 --max-combos 2 --explore-budget 30 --no-deltas` unless the row
says otherwise, A = `de41d6a`, B = this branch, logs under
`C:/Projekte/120fps-fieldtest/logs/run7-lane-f/<repo>/`:

| Repo | Clause | A | B |
|---|---|---|---|
| midday `src/components/tables/invoices/skeleton.tsx` | C3 | calibration 20 780 ms, no setup phase | calibration 144 ms, setup 17 870 ms; phases sum to total exactly in both; exit 1 in both, 7 warnings in both |
| novu `src/components/primitives/toggle.tsx` | C5 | explore 32 930 ms, combo 2 alone 31 548 ms, `budget 30s each` | explore 18 078 ms, longest combo 16 399 ms, `budget 15s each`; `pass: true` and 7 warnings in both |
| scaffold-vite-react-ts `src/App.tsx` | C5 single combo | `explore: 1 combos, budget 60s each`, `exploreWallClockMs` 24 849 | `explore: 1 combos, budget 30s`, `exploreWallClockMs` 25 099; 5 warnings in both |
| rallly `src/components/pagination.tsx` `--curve` | C5 curve | explore 184 771 ms, total 205 760 ms | explore 32 748 ms, total 47 195 ms, `budget 10s each`, 3 of 6 points explored and said so; `pass: true` in both, all 6 curve points present |
| calcom `modules/apps/components/Slider.tsx` `--curve` | C5 curve | explore 39 773 ms, total 67 477 ms | explore 30 008 ms, total 55 309 ms; exit 1 and 5 warnings in both |
| linkwarden `components/ui/Loader.tsx` | deferred row | rerender 7 980 ms | rerender 8 118 ms; exit 1 and 1 warning in both. The rerender phase is not decomposed; the Deferred section records why |
| commerce `components/label.tsx` (control) | control | exit 0, `pass: true`, 2 warnings | exit 0, `pass: true`, the same 2 warnings, the same 6 combos. Per-combo verdicts shuffle between `pass` and `warn` in both directions across repeats of either build: the `unstable` flags move run to run on a `hostile` machine |

Corpus repros, through a `dist` built in `C:/Projekte/120fps-run7-lane-f`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/umbrel/packages/ui \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-f/umbrel \
  --label m134-umbrel-<a|b>-<n> --cli C:/Projekte/120fps-run7-lane-f/dist/cli/main.js \
  -- src/components/ui/card.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: phaseTimings.analysis at least 25 % lower than the pre-change build, interleaved A/B x5

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run5/midday/apps/dashboard \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-f/midday \
  --label m134-midday --cli C:/Projekte/120fps-run7-lane-f/dist/cli/main.js \
  -- src/components/tables/invoices/skeleton.tsx --samples 3 --max-combos 2 \
     --explore-budget 30 --no-deltas
# expected: the calibration bucket holds only calibration; phases disjoint and summing to total

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/novu/apps/dashboard \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-f/novu \
  --label m134-novu-<a|b>-<n> --cli C:/Projekte/120fps-run7-lane-f/dist/cli/main.js \
  -- src/components/primitives/toggle.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: the explore phase, first combo included, stays inside 30 s (baseline: combo 2 = 31.6 s)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories/calcom/apps/web \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-f/calcom \
  --label m134-calcom-curve --cli C:/Projekte/120fps-run7-lane-f/dist/cli/main.js \
  -- modules/apps/components/Slider.tsx --curve --samples 3 --explore-budget 30 --no-deltas
# expected: curve mode reads the budget and stays inside it (baseline 37.7 s)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run7/scaffold-vite-react-ts \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-f/scaffold-vite-react-ts \
  --label m134-single-combo --cli C:/Projekte/120fps-run7-lane-f/dist/cli/main.js \
  -- src/App.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: the log reads "explore: 1 combos, budget 30s" and exploreWallClockMs <= 30 000
#           (baseline: "budget 60s each", 60 496-73 844 ms, flag slow-explore)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run7/rallly/apps/web \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-f/rallly \
  --label m134-rallly-curve --cli C:/Projekte/120fps-run7-lane-f/dist/cli/main.js \
  -- src/components/pagination.tsx --curve --samples 3 --explore-budget 30 --no-deltas
# expected: the curve phase stays inside the budget across its scale points
#           (baseline: 30 s per point x 6 points = 185 s, identical in all five mode runs)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/linkwarden/apps/web \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-f/linkwarden \
  --label m134-linkwarden --cli C:/Projekte/120fps-run7-lane-f/dist/cli/main.js \
  -- components/ui/Loader.tsx --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: the rerender phase is decomposed in the phase table, or the spec records why it cannot
```

## Deferred

- **Per-sample rerender overhead.** linkwarden's rerender phase is 19.2 s, of which 97 % of the
  measured medians are the four scale probes (781 of 1 951 nodes); roughly 16 s is per-sample overhead
  the log does not decompose. Measuring it is a prerequisite to reducing it, and C6 does not cover it.
- **The mount bucket's session bring-up.** About 65 % of the mount bucket is session bring-up and
  preamble, paid six times per run (calibration session, scale gate, mount, rerender, explore, React
  probe; `src/browser/session.ts:74-100`). Sharing a driven session is lever D from M116, still
  deferred with its risk recorded, and C2 removes one of the six without touching the rest.
- **M128's L4 and L5** (a narrower trace category set; mounting once per probed prop instead of once
  per arm) stay deferred exactly as `m128-…:189-214` records them.
- **The callback-identity finding's instability.** M128 recorded that what the pass finds moves
  between runs; this milestone changes how long it takes, not what it means.
