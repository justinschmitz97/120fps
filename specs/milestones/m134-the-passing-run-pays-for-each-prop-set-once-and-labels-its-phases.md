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
  - test/unit/a-scale-probe-renders-what-the-component-needs.test.ts
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

9. **A scale probe renders a component the run never asked for** — the auto-scale combos are
   built as `{ __120fps_scaleN: n }` alone (`src/pipeline/modes/combo.ts:100`), so the N copies the
   harness entry fans out (`src/harness/entry.ts:417-422` for React, `:321-325` for Vue, both of
   which already spread whatever else the combo carries) receive no props at all. A component with a
   required prop then throws on every scale row while its real combos render. The verifier: dub
   `ui/shared/empty-state.tsx` under M133's `icon` synthesis renders 8 and 4 DOM nodes on combos 0
   and 1 and throws `Element type is invalid ... got: undefined` on all four scale probes
   (`logs/run7-lane-d/dub/m133-dub.log:29-70`).

## MUST

- **C1** The React analysis pass measures each distinct prop set once. Combos that produce the same
  `propCombinationKey` after the probe's own normalisation share one measurement, and the result is
  attributed to every combo that shares the key. The combo ids in the report, and the per-combo
  measurements, are identical to what the per-combo pass produced.
- **C2** The scale-point gate does not perform a measurement whose result is discarded. The smallest
  scale point is measured once, in the main batch, and the gate reads that measurement mid-batch, so
  the whole sweep stays in one session and the scaling curve carries no session boundary.
- **C3** The `calibration` phase contains calibration and nothing else. The work that follows it —
  wrapper overhead, session close, schema collection and combination generation — is its own labelled
  phase, `setup`; the scale gate C2 folds into the main batch is part of `mount`, and so is an
  isolated run's measurement. Every phase key is still present, phases remain disjoint, and they
  still sum to `total` exactly (M115 C1).
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
  - When the budget stops the phase, the run says so and names the flag, whether it refused a
    whole combo or cut one combo's share short; a stopped phase is not a failure.
  - The bound has one deliberate overrun. A combo that starts with less than ten seconds of budget
    left is given ten seconds anyway, so the phase can end up to ten seconds past the flag. A walk
    shorter than that reaches no second state, so the alternative is a combo that costs its
    bring-up and reports nothing; the run would rather overrun by a bounded amount and say so.
    Every such combo carries the truncation disclosure, and a combo that cannot start at all is
    refused outright rather than given the floor.
- **C7** A scale probe renders the component the way the run renders it. Each auto-scale combo
  carries the first measured combo's prop set beside `__120fps_scaleN`, and the harness entry mounts
  each of the N copies with that prop set, so a component with a required prop renders on its scale
  rows as it does on its prop rows. A run with no prop combos of its own — a fixture that exports its
  own `scale` — keeps the bare trigger. `__120fps_scaleN` still never reaches `ComboReport.props`;
  the base props do, because they are what the row measured.
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
  report shape or the number of rows the user sees. C7 changes what a scale row renders, never how
  many rows there are or which N each carries.
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
close, schema extraction and combination generation. `isolation:` classifies to `mount`, so an
isolated run's measurement is not charged to `setup`. `estimateRunCost` counts `setup` as fixed
cost; a baseline written before the key existed reads as `0` and keeps its old estimate. This
supersedes M115 C1's ten-key list, its gap rule for the interval after `calibration`, and C2's rule
that a `mode:` or `isolation:` label keeps the open phase; the notes sit in that spec at `:74-90`.

**The scale gate reads the batch it runs in.** `measureGatedScaleMounts` builds one combo list — the
prop combos, then the scale points in ascending order — and hands `measureMount` a `MountPassGate`.
The pass consults the gate before each combo; once the cheapest scale point has been measured, the
gate reads that measurement and, over `SCALE_PROBE_GATE_MS`, stops the pass there. One session
measures everything, so no session boundary lands between two points of the synthetic scaling curve,
and no mount is paid for twice. The result keeps `measureMount`'s sparseness: a combo nothing
measured stays a hole, and the caller reads `m?.heapDelta ?? 0`.

The probe's conditions changed with it, and `specs/overview/00-tdd.md:1038` records the new ones: it
is measured at position `propCombos.length` of the mount batch, warm, with the batch's
`warmupsForPosition` count rather than alone at position 0, and at `effectiveSamples` rather than 3
samples. `SCALE_PROBE_COST_WARNING` therefore quotes the median the report prints.

`effectiveSamples` derives from the planned combo count — the prop combos plus every configured
scale point — because the batch's sample count is fixed before the gate can decide. On a run whose
plan exceeds the 20-combo throttle threshold and whose gate then trips, the samples recorded are the
plan's, not the smaller kept set's; that count is part of the M53 environment fingerprint, so such a
run does not compare like-for-like against a pre-M134 baseline.

**A scale probe's props.** `measureGatedScaleMounts` spreads the first prop combo's props into
every scale combo, so `{ __120fps_scaleN: 5 }` becomes `{ ...propCombos[0], __120fps_scaleN: 5 }`.
The harness entry needed no change: both templates already strip the trigger key and spread the rest
into each copy (`src/harness/entry.ts:417-422`, `:321-325`), and the React analysis probe has no
`scaleN` branch at all, so it mounts the single instance those props describe. `propCombinationKey`
strips only the trigger, so the scale rows now share the first prop combo's key and its one
measurement rather than the empty set's. `buildReport` still lifts `__120fps_scaleN` out into
`scaleProbe` and leaves the rest as the row's `props`.

**The explore budget.** `exploreUnitWallClockMs` divides the phase budget across the units, clamps
the share to the unit's own default (60 s per combo, 30 s per curve point, 30 s per matrix cell)
above and to 10 s below, then to the phase budget itself, so `--explore-budget 5` yields 5 s and no
flag yields exactly the bound the run used before. `exploreRunOptions` builds those bounds plus
`observerTiming`, which is present only when the caller set `AnalyzeOptions.observerTiming`; no CLI
flag selects it. Combo, curve and matrix mode all route through it.

`explore()` starts its clock at the phase's start, so bring-up counts against the budget, and
refuses a new combo once `explorePhaseBudgetSpent`. `exploreComboWallClockMs` gives each combo the
smaller of its share and what the phase has left, floored at `MIN_EXPLORE_UNIT_WALL_CLOCK_MS` (or at
the share, when the share is already smaller) so a cut combo still reaches a second state. A combo
that gets less than its share says so through `EXPLORE_COMBO_TRUNCATED_WARNING`, which names
`--explore-budget`; a combo that never starts is covered by `EXPLORE_BUDGET_WARNING`, which names
the unit it stopped counting.

The floor is what C5's overrun clause records. A combo only starts while the budget is unspent, and
it then takes at most the floor, so the phase ends less than `MIN_EXPLORE_UNIT_WALL_CLOCK_MS` past
the flag — `exploreComboWallClockMs(15_000, 28_000, 30_000)` is `10_000`, not `2_000`. Dropping the
floor would trade that bounded overrun for combos that pay a bring-up and report nothing, so the
floor stays and the disclosure carries the cost.

## Verification

- **C1** — `test/unit/the-analysis-pass-measures-each-prop-set-once.test.ts`: six combos of which four
  normalise to the same key produce three measurements; every combo still appears in the result; over
  the combo lists the `m66-*` fixtures' own schemas generate, plus the four auto-scale points, the
  deduped pass and the per-combo pass return the same measurement under the same combo ids; two
  combos with genuinely different props are measured separately.
- **C2** — `test/unit/a-scale-probe-is-measured-once.test.ts`: the gate consumes the batch's own
  measurement; the whole sweep opens one batch; the smallest scale point appears in it exactly once;
  a refused sweep measures no larger point and returns the warning; a combo the pass could not
  measure stays a hole that the caller's `heapDelta` read survives.
- **C3** — `test/unit/every-phase-label-names-what-it-measured.test.ts`: a synthetic boundary stream
  containing `mode:` yields a `calibration` bucket holding only the calibration interval; the new
  bucket holds the remainder; all keys present; the keys sum to `total`; a run that never calibrates
  reports `0`.
- **C4** — `test/unit/the-memo-pass-runs-only-with-a-memo-fiber.test.ts`: a snapshot with no `isMemo`
  fiber runs no mount and no rerender and returns the empty result; a snapshot with one runs the pass
  and returns the same result as today; `fixtures/m66-no-memo.tsx` is the negative case.
- **C3** also — `test/unit/every-phase-label-names-what-it-measured.test.ts`: an `isolation:` label
  classifies to `mount`, and an isolated run's table charges its measurement there.
- **C5** — `test/unit/the-explore-budget-bounds-the-phase.test.ts` and
  `test/unit/a-single-combo-run-is-bounded-too.test.ts`: the per-combo budget derives from
  `--explore-budget`; a single combo that would run past the total budget is stopped before it starts
  and the run says which flag stopped it; the check runs before the first combo; a one-combo run under
  `--explore-budget 30` reports a budget of 30 s, not 60 s; curve mode's per-point bound is the phase
  budget divided across its points; `observerTiming` set by the caller reaches
  `src/analysis/exploration-loop.ts:203`; the default budget produces today's behaviour on a fixture
  that fits inside it.
- **C7** — `test/unit/a-scale-probe-renders-what-the-component-needs.test.ts`: every scale combo
  carries the first prop combo's props beside its `__120fps_scaleN`; a run with no prop combos keeps
  the bare trigger; over the schema of `fixtures/m134-required-icon/RequiredIcon.tsx`, whose `icon`
  prop is required and whose absence throws, every scale combo carries a defined `icon`; both
  generated entries spread the combo's remaining props into each of the N copies.
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

npx vitest run test/unit/the-analysis-pass-measures-each-prop-set-once.test.ts test/unit/a-scale-probe-is-measured-once.test.ts test/unit/a-scale-probe-renders-what-the-component-needs.test.ts test/unit/the-memo-pass-runs-only-with-a-memo-fiber.test.ts test/unit/every-phase-label-names-what-it-measured.test.ts test/unit/the-explore-budget-bounds-the-phase.test.ts test/unit/a-single-combo-run-is-bounded-too.test.ts --maxWorkers=2
# Test Files 7 passed (7) | Tests 59 passed (59)

npx vitest run test/unit --maxWorkers=2
# Test Files 2 failed | 389 passed (391)
# Tests 2 failed | 5434 passed | 1 skipped (5437)
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

The one-session gate, the explore floor and its disclosure, and the `isolation:` label were measured
again after they landed:

| Repo | Reads |
|---|---|
| commerce `components/label.tsx` (control) | exit 0, `pass: true`, 2 warnings, 6 combos, `mount: up to 6 combos x 3 samples`. All four scale probes measured in the one batch: `1=6.6 5=13.9 20=33.3 50=78.7` ms, the same shape as the pre-M134 build's `1=4.4 5=9.8 20=28.1 50=69.5`, with no step at the `n=1` to `n=5` boundary |
| commerce `components/label.tsx` `--isolate memory` | `calibration  (0:01)`, `setup  (0:01)`, `mode: isolation (memory)`, `isolation: memory`; `{"preflight":92,"build":1258,"calibration":171,"setup":1218,"mount":900,...,"total":3639}`, the keys summing to `total` exactly. The isolated measurement is charged to `mount`, not to `setup` |
| novu `src/components/primitives/toggle.tsx` | explore 17 995 ms inside the 30 s budget, `budget 15s each`, per-combo 1 293 ms and 16 287 ms, no combo's share cut and so no truncation disclosure, `pass: true`, 7 warnings |

C7 was measured on the component that found it, dub `ui/shared/empty-state.tsx`
(`E:/repositories/dub/apps/web`), A = `de41d6a`, B = this branch, same profile:

| Row | A | B |
|---|---|---|
| combo 0 | 8 DOM nodes, `warn` | 8 DOM nodes, `warn` |
| combo 1 | 4 DOM nodes, `pass` | 4 DOM nodes, `warn` |
| N=1 | 0 DOM nodes, `renderHealth: error`, `fail` | 9 DOM nodes, `pass` |
| N=5 | 0 DOM nodes, `renderHealth: error`, `fail` | 41 DOM nodes, `pass` |
| N=20 | 0 DOM nodes, `renderHealth: error`, `fail` | 161 DOM nodes, `pass` |
| N=50 | 0 DOM nodes, `renderHealth: error`, `fail` | 401 DOM nodes, `pass` |
| run | `pass: false`, exit 1, 9 warnings | `pass: true`, exit 0, 9 warnings |

The node counts are the component's own 8 nodes per copy plus the one wrapper the entry adds, so the
synthetic curve now measures N copies of what the report is about. commerce, the control, keeps its
shape: 6 combos, `pass: true`, the same 2 warnings, and scale probes at 6, 26, 101 and 251 DOM nodes
exactly as the pre-M134 build recorded them — its props are all optional, so carrying them changes
nothing it renders.

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
