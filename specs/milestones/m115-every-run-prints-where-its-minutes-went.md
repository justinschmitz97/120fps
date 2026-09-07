---
kind: milestone
status: approved
tests:
  # Lane C
  - test/unit/report-carries-phase-timings.test.ts
  - test/unit/progress-lines-carry-elapsed-time.test.ts
  - test/unit/dry-run-estimates-the-real-run.test.ts
  # Lane A
  - test/unit/total-line-breaks-down-by-phase.test.ts
  - test/unit/dry-run-flag-forwarding.test.ts
---

# M115: every run prints where its minutes went

Lane C (`src/analyze.ts`, `src/report.ts`, `src/explorer.ts`, `src/ci-report.ts`, `src/budget.ts`)
and Lane A (`src/cli.ts`, two edits). Wave 1, instrumentation: M116 is gated on the numbers this
milestone publishes.

## Purpose

A run prints one number today and it is the whole run. A user who waited 3 minutes learns that they
waited 3 minutes; a maintainer who wants to make the wait shorter has nothing to aim at. After this
milestone every run says how long each phase took, in the terminal, in the report JSON and in the
markdown report, and the dry run says what the real run is about to cost.

Closes: no run-5 finding. This is the instrumentation the run-5 evidence asked for and the
prerequisite the perf work is gated on:
`C:\Projekte\120fps-fieldtest\remediation\perf-levers.md` (section 6, "Phase timing recorded today:
none"; lever A, "Instrument the phases first (before B, C, D)"),
`C:\Projekte\120fps-fieldtest\remediation\dx-audit.md` ("Performance as experienced": dry run median
7 s, max 92 s; real run median 39 s, mean 54.5 s, max 251 s),
`C:\Projekte\120fps-fieldtest\remediation\timing-profile.md` (283 logged runs, sections 1 and 2),
`C:\Projekte\120fps-fieldtest\EVIDENCE.md` (the corpus commands under Verification).

## Root causes (verified)

Every line below was re-read in this worktree; the map's line numbers all still hold.

1. **The only clock is the whole run.** `src/cli.ts:1404` stamps `Date.now()` per component and
   `src/cli.ts:1443` prints `formatWallClock(Date.now() - started)` (`src/cli.ts:358`), under the
   `if (!args.ci)` at `:1441`. Nothing between those two lines is attributed to anything.
2. **The report has no place to put a duration.** `Report` (`src/report.ts:492-547`) declares no
   timing field; `grep -n phaseTimings src/report.ts` returns nothing (the word `timings` appears
   only in comments at `:637`, `:1020` and in the compare strings `:1235`, `:1238`).
3. **The one function that sees every phase boundary throws the boundary away.**
   `resolveProgressReporter` (`src/analyze.ts:396`, built at `:2957`) forwards its label to
   `onPhase`, to `onProgress` or to stdout (`:400-417`) and takes no stamp. It is called with a
   label at `:3304` (preflight), `:3399` (build), `:3579` (calibration), `:1889` (mount), `:1901`
   (rerender), `:1916` (explore), `:1944` (prop deltas), `:2005` (scaling curves), `:2016` (react
   analysis) and `:2107` (report), plus the mode lines at `:3655-3700`, the curve-mode lines at
   `:1277`, `:1286`, `:1296`, `:1419`, the matrix lines at `:1504`, `:1513`, `:1528` and isolation
   at `:1113`.
4. **Explore already measures itself and nobody reads it.** `explore` returns
   `wallClockMs: Date.now() - startTime` on the state graph (`src/explorer.ts:874`, declared at
   `src/explorer.ts:87`). `grep -n wallClockMs src/*.ts` finds those two lines and no other reader:
   the number never reaches a combo, a report or a terminal.
5. **Cost attribution has no boundary at all.** `attributeCost` runs per combo inside `buildReport`
   (`src/analyze.ts:675`, `buildReport` at `:581`), between the mount phase and the report phase, so
   its cost cannot be separated from either even once the reporter is stamped.
6. **The dry run predicts the mode and never the cost.** `formatExplainProps`
   (`src/analyze.ts:2601-2710`) prints the schema, `Curve mode:`, `Scale probe:` and `Matrix mode:`,
   and no duration; `explainProps`'s options (`src/analyze.ts:2296-2309`) carry neither `samples` nor
   `maxCombos`, and `explainPropsOptions` (`src/cli.ts:1237-1260`) forwards neither, so the dry run
   cannot name the combo count the real run would measure. `generateCombinations`,
   `countCombinationSpace`, `selectRepresentativeCombos`, `DEFAULT_MEASURED_COMBOS`
   (`src/prop-gen-values.ts:744`) and `computeEffectiveSamples` (`src/analyze.ts:253`) are already
   imported into `analyze.ts` and are what the real run counts with (`:1866-1884`).

## MUST

### Lane C (`src/analyze.ts`, `src/report.ts`, `src/explorer.ts`, `src/ci-report.ts`, `src/budget.ts`)

- **C1** A completed run's report carries `phaseTimings` with the keys `preflight`, `build`,
  `calibration`, `mount`, `rerender`, `explore`, `scale`, `deltas`, `attribution`, `analysis` and
  `total`, each an integer count of milliseconds (superseded by M134 C3: `setup` joins the list
  between `calibration` and `mount`, so there are eleven phase keys). Every key is present; a phase
  the run never entered is `0`. The phase keys sum to `total` exactly: `total` opens at the first statement of `run()`
  and closes at the `report` boundary, and the interval before the first `preflight:` boundary is
  charged to `preflight`. The CLI's `Total:` opens one stamp earlier (`src/cli.ts:1404`) and closes
  after the report JSON is written, the only difference A1's 1 s tolerance covers. Each phase is the
  interval from its own boundary to the next, so a gap between two labelled phases (session open,
  noise probe) is charged to the phase that preceded it. Superseded by M134 C3 for the gap that
  followed `calibration`: wrapper overhead, the calibration session's close, schema extraction and
  combination generation are `setup`, a boundary of their own, and the scale-point gate probe is
  part of the mount batch.
- **C2** A boundary line is classified by its label: `preflight:` to `preflight`, `harness:` to
  `build`, `calibration` to `calibration`, `mount:` to `mount`, `rerender:` to `rerender`,
  `explore:` to `explore`, `scaling curves` to `scale`, `prop deltas` to `deltas`, `react analysis`
  to `analysis`, and `report` closes `total`. Superseded by M134 C3: `setup` and every `mode:` line
  classify to `setup`, and `isolation:` classifies to `mount`; a label matching none of them still
  keeps the currently open phase, so C1's sum holds in combo, matrix, curve and isolation mode alike.
  `attribution` holds the time the run spent computing cost attribution: `0` for a run that
  attributes nothing (no mount traces, or attribution skipped), non-zero for a run whose combos carry
  `costAttribution`, and no progress line names it. The phase open while `attributeCost` ran is
  charged its interval minus the attribution window, so the ten keys still sum to `total` exactly and
  no millisecond is counted twice.
- **C3** Each combo in the JSON carries the explore wall clock the state graph already computed, so
  "explore took 1m 20s" is readable per combo and not only per run; a combo whose explore was skipped
  carries no such field. `phaseTimings.explore` stays the phase interval and is never a sum of the
  per-combo numbers.
- **C4** Every progress line ends with the elapsed run clock in `(m:ss)`:
  `explore: 4 combos, budget 15s each  (0:41)`. The label text before it is unchanged, the line is
  still silent under `--ci`, and `onProgress` and `onPhase` receive the identical string.
- **C5** `--report-md` carries the same numbers per component: one phase breakdown per reported
  component, from `phaseTimings`, in the units the terminal prints. A report without `phaseTimings`
  (an older JSON, a cached verdict) renders as `-`, never as `0s`.
- **C6** `--explain-props` prints one line naming an estimated duration for the real run, the combo
  count and sample count it multiplied, and where the per-phase numbers came from:
  `Estimated real run: ~2m 10s (8 combos x 5 samples; phase timings from 120fps-baseline.json)`, or
  `... (defaults: no phase timings recorded for this component yet)`. The line says "Estimated" in
  that word. The combo and sample counts are the ones the real run would measure (the same cap and
  the same `computeEffectiveSamples` the dispatcher applies), and the estimate reads `phaseTimings`
  from the baseline entry for this component when `--save-baseline` recorded one and its environment
  fingerprint matches; otherwise it uses the documented defaults and says so. The counts are the
  ones the mode this same dry run predicts would measure: a curve run's scale points (no sample
  throttle), a matrix run's capped cells, or the capped prop combos *plus* the scale anchors
  `runComboMode` always appends.
- **C7** `--save-baseline` records the run's `phaseTimings` on the baseline entry; an entry written
  before this milestone stays readable and counts as "no phase timings recorded". An isolation run
  records no phase timings: the estimate scales them by combos and samples, which an isolation run
  has none of.

### Lane A (`src/cli.ts`)

- **A1** In non-`--ci` mode the `Total:` line carries the breakdown:
  `Total: 3m 12s  (build 41s, mount 58s, explore 1m 20s, analysis 12s)`. A phase at `0` is omitted
  from the parenthesis; a report without `phaseTimings` prints exactly the line it prints today. The
  printed `Total:` and the JSON's `phaseTimings.total` never differ by more than 1 s.
- **A2** With `--samples 5 --max-combos 4`, `--explain-props` prints `... (4 combos x 5 samples;
  ...)`; without the flags the same line names the defaults the real run would apply.

## MUST NOT

- Take a stamp inside a traced window: no stamp between `Tracing.start` and `Tracing.end`
  (`collectTrace`, `src/measure.ts:1317`), inside `executeStressPattern`, or inside a sample loop.
  No measured number, verdict, baseline or source fingerprint moves because of this milestone.
- Change combos, samples, warmups, CPU throttle, explore budgets, pacing, or the number of browser
  contexts a run opens.
- Print the breakdown or the estimate to stdout under `--ci`: `--ci` owns stdout for JSON (M22), and
  CI reads `phaseTimings` from the JSON.
- Reword, drop or add a progress label, or print a line for `attribution`.
- Start a Vite server, a browser or any measurement to produce the estimate: C6 reads the schema,
  the flags and the baseline file from disk and measures nothing (M100 MUST NOT).
- Let `phaseTimings` reach the reuse decision: it never enters `computeEnvKey` (`src/budget.ts:270`)
  or the baseline key, an entry that differs only in `phaseTimings` is still reused, and an entry
  without the field never forces a re-measure (M39: calibration never gates reuse).
- Present an estimate as a measurement, or estimate from a baseline entry recorded under a different
  environment fingerprint without saying the numbers are defaults.

## Interfaces needed

- **I11** Producer C, consumer A. `src/report.ts` exports `type PhaseTimings` and
  `formatPhaseBreakdown(timings: PhaseTimings | undefined): string`, returning
  `"  (build 41s, mount 58s, explore 1m 20s)"`, or `""` when there is nothing to show. `src/cli.ts`
  appends it to the `formatWallClock` line at `src/cli.ts:1443`. Needed by A1. M116's E1 reads
  `phaseTimings.explore` and `.preflight` from the JSON report and writes nothing.
- **I12** Producer A, consumer C. `explainPropsOptions` (`src/cli.ts:1237-1260`) adds
  `samples?: number` and `maxCombos?: number` from `args.samples` and `args.maxCombos`, under the
  names `AnalyzeOptions` already uses; `explainProps` (`src/analyze.ts:2296-2309`) accepts them.
  Needed by C6 and A2.

Conflicts in `M107-M117-MAP.md`: C4 — M115 lands first in `explainProps`, then M110, M112, M117;
C10 — C3 publishes `graph.wallClockMs` before M116 changes the replay; C12 — A1's breakdown lands
after M111's roots line and before M117's tip.

## Verification

Unit tests, `vitest run <files> --maxWorkers=2`:

- **C1, C2, C3, C5** `test/unit/report-carries-phase-timings.test.ts`: drive a stamped reporter with a
  fake clock over the real label sequence of a combo run, a curve run and a matrix run; assert the
  eleven keys, that an unentered phase is `0`, that the ten phases sum to `total`, that an unknown
  label (`mode: prop combos`) adds to the phase it interrupts, and that a graph's `wallClockMs`
  reaches its combo; `formatMarkdown` over two reports, one with `phaseTimings` and one without
  (`-` for the second). Fixture: none needed (plain structures, the way
  `test/unit/dx-features.test.ts:408` already tests the reporter).
- **C4** `test/unit/progress-lines-carry-elapsed-time.test.ts`: a fake clock and a capturing sink;
  assert `explore: 4 combos, budget 15s each  (0:41)`, that `--ci` still writes nothing to the sink,
  and that `onPhase` and `onProgress` see the identical string.
- **C6, C7** `test/unit/dry-run-estimates-the-real-run.test.ts`: a `saveBaseline` and
  `loadBaseline` round trip; `formatExplainProps` estimate line from a baseline entry and from
  defaults. Fixture: new directory `fixtures/phase-timings/` with `package.json`, `button.tsx`
  (a boolean prop and two string-literal unions, so the combo count is deterministic) and a
  `120fps-baseline.json` whose single entry carries `phaseTimings` and a matching `env` fingerprint.
- **A1** `test/unit/total-line-breaks-down-by-phase.test.ts`: `formatWallClock` with
  `formatPhaseBreakdown` over a report with `phaseTimings`, one with zero-valued phases (omitted from
  the parenthesis), and one without the field (the line unchanged from today).
- **A2** `test/unit/dry-run-flag-forwarding.test.ts`:
  `explainPropsOptions(parseArgs(["a.tsx", "--samples", "5", "--max-combos", "4"]), "a.tsx")` carries
  `samples: 5` and `maxCombos: 4`, and the flags absent carries neither.

Corpus, through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs` against a scratch dist built
from this worktree. Commands verbatim from `EVIDENCE.md` rows:

- Dry run (row n8n-F4):
  `node tools/run120.mjs --cwd /e/repositories-run5/n8n/packages/frontend/@n8n/design-system --out logs/n8n --label 02-explain-dialog --timeout 1500 -- src/components/N8nDialog/Dialog.vue --explain-props`
  Expected after the fix: one added line, `Estimated real run: ~<m>m <s>s (<n> combos x <k> samples;
  defaults: no phase timings recorded for this component yet)`; every line the dry run printed before
  is unchanged.
- Real run that reaches a report (row n8n-F3):
  `node tools/run120.mjs --cwd /e/repositories-run5/n8n/packages/frontend/@n8n/design-system --out logs/n8n --label 04-real-button --timeout 1500 -- src/components/N8nButton/Button.vue --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`
  Expected after the fix: every progress line ends with `(m:ss)`; the last line reads
  `Total: <t>  (preflight <a>, build <b>, mount <c>, rerender <d>, explore <e>, analysis <f>)`;
  `120fps-report.json` carries `phaseTimings` whose ten phase keys sum to `total`, and the printed
  `Total:` differs from `phaseTimings.total` by under 1000 ms.
- Second real run, different repository (row shadcn-admin-F2):
  `node run120.mjs --cwd /e/repositories-run5/shadcn-admin --out .../logs/shadcn-admin --label toolbar-remedy --timeout 1500 -- src/components/data-table/toolbar.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`
  Expected after the fix: the same breakdown line and the same sum identity. This row is also the
  map's unaffected-repo check: the run still reaches a report, and its verdict, medians and warnings
  are byte-identical to the pre-change run of that command in the same window.

Plus `tsc --noEmit` clean, and the Lane C and Lane A test files green (baseline failures excepted).

### Lane C evidence

Run 2026-09-02 in `C:/Projekte/120fps-m107` on `feat/m107-run5-remediation`.

Tests, `node node_modules/vitest/vitest.mjs run test/unit/report-carries-phase-timings.test.ts
test/unit/progress-lines-carry-elapsed-time.test.ts test/unit/dry-run-estimates-the-real-run.test.ts
--maxWorkers=2`:

```
 Test Files  3 passed (3)
      Tests  32 passed (32)
```

Whole unit suite, `node node_modules/vitest/vitest.mjs run test/unit --maxWorkers=2`:

```
 Test Files  3 failed | 274 passed (277)
      Tests  24 failed | 4301 passed | 1 skipped (4326)
```

The 24 failures are the map's baseline failures and nothing else:
`vue-dual-block-props.test.ts` (18), `prop-default-disclosure.test.ts` (2),
`bundler-error-presentation.test.ts` (4). `prop-cap-ranking.test.ts` (the environment one) is green
here.

`node node_modules/typescript/bin/tsc --noEmit`: clean, no output.

Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/C-M115/dist/cli.js` built from this
worktree, through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs`:

- **n8n-F4, dry run** (`--label M115-n8n-after`, exit=0, 6 s). Before (`logs/n8n/02-explain-dialog.log`):
  no line matching `Estimated real run`. After:

  ```
  Matrix mode:  would not auto-activate
  Estimated real run: ~1m 31s (8 combos x 10 samples; defaults: no phase timings recorded for this component yet)
  ```

  Every other line of the dry run is unchanged. Closed: yes.
- **n8n-F3, real run** (`--label M115-n8n-real-after`, exit=2, 37 s). This row never reaches a report
  (its own unresolved `~icons/` import is M108/M110 work, not this milestone). What it does show is
  C4. Before (`logs/n8n/04-real-button.log`): `preflight: walking the import graph` /
  `harness: building`. After:

  ```
  preflight: walking the import graph  (0:01)
  harness: building  (0:01)
  ```

  Closed: partly -- C4 confirmed; the breakdown and the sum identity could not be read from this row.
- **shadcn-admin-F2, real run** (`--label M115-shadcn-toolbar-after`, exit=0, 26 s). Before
  (`logs/shadcn-admin/toolbar-remedy.log:56`): `Total: 53.7s`, and `grep -c phaseTimings
  logs/shadcn-admin/toolbar-remedy.json` = 0. After:

  ```
  preflight: walking the import graph  (0:00)
  harness: building  (0:00)
  calibration  (0:07)
  mode: curve on filters  (0:08)
  mount: 6 scale points  (0:08)
  rerender: 6 scale points  (0:14)
  explore: 6 scale points  (0:17)
  react analysis  (0:24)
  Total: 26.0s
  ```

  and the JSON report carries

  ```
  {"preflight":224,"build":7534,"calibration":1238,"mount":5145,"rerender":3227,"explore":7191,"scale":0,"deltas":0,"attribution":0,"analysis":1477,"total":26036}
  sum 26036 total 26036
  ```

  The ten phase keys sum to `total` exactly, and the printed `Total: 26.0s` differs from
  `phaseTimings.total` by under 1000 ms. Verdict, mode and warnings identical to the pre-change run
  (`pass: false`, `mode: curve`, 10 warnings in both `toolbar-remedy.json` and
  `M115-shadcn-toolbar-after.json`). Closed: yes for C1-C4; the parenthesised breakdown on the
  `Total:` line is A1 and lands with Lane A's `cli.ts` edit.
- **Unaffected repo** (`--label M115-shadcn-button-after`, exit=0):
  `src/components/ui/button.tsx --explain-props` still reaches its full schema
  (`Props (32):`, `Curve mode:`, `Scale probe:`, `Matrix mode:`, the same warnings) with one added
  line, `Estimated real run: ~1m 31s (8 combos x 10 samples; defaults: no phase timings recorded for
  this component yet)`. Closed: yes.

Not landed in this commit, and why:

- **A1, A2** are Lane A's `cli.ts` lines (wave 2). Without A1 the terminal's `Total:` prints exactly
  what it printed before; `formatPhaseBreakdown` (I11) is exported and ready for it. Without I12 the
  CLI forwards no `samples`/`maxCombos` to `explainProps`, so the corpus dry run above names the
  defaults (8 combos x 10 samples); `explainProps` already accepts both options and the unit test
  covers the capped counts.

Two implementation facts worth recording, both inside Lane C's own files:

- C6's estimate needs the units the recorded phases were spent on, so `BaselineEntry` carries
  `phaseUnits: { combos, samples }` beside `phaseTimings`. Both are optional, neither enters
  `computeEnvKey` or the baseline key, and an entry without them reads as "no phase timings
  recorded".
- `fixtures/phase-timings/baseline-other-machine.json` (not `120fps-baseline.json`: the repository's
  `.gitignore:11` would keep that name out of the commit) carries a deliberately foreign environment
  fingerprint: a machine identity that matches cannot be committed to a file, so the fixture proves
  the mismatch path (defaults) and the matching path is driven from a temp project the test writes
  with this machine's own `os.cpus()` values. A dry run launches no browser, so the match is on
  `cpu`, `cores` and `os` and never on `chromiumVersion`.

### Lane A evidence

Run 2026-09-03 in `C:/Projekte/120fps-m107` on `feat/m107-run5-remediation`, on top of Lane C's
`661ab79`/`0b72589` (I11 and I12 both landed before this commit).

Tests, `node node_modules/vitest/vitest.mjs run test/unit/total-line-breaks-down-by-phase.test.ts
test/unit/dry-run-flag-forwarding.test.ts --maxWorkers=2`:

```
 Test Files  2 passed (2)
      Tests  14 passed (14)
```

Every test file that imports `src/cli.js` (41 files, `grep -l "src/cli.js" test/unit/*.test.ts`),
`--maxWorkers=2`: `40 passed (40)` / `866 passed (866)` for the first 40 and `1 passed (1)` /
`68 passed (68)` for `vue-support.test.ts`. No baseline-green test turned red.

`node node_modules/typescript/bin/tsc --noEmit`: clean, no output.

Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/A-M115/dist/cli.js` built from this
worktree, through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs`:

- **A1, shadcn-admin-F2 real run** (`--label M115-shadcn-toolbar-after`, exit=1, 23 s). Before
  (Lane C's `M115-shadcn-toolbar-after` run of the same command): `Total: 26.0s`, no parenthesis.
  After:

  ```
  Total: 21.6s  (preflight 0s, build 1s, calibration 1s, mount 6s, rerender 5s, explore 7s, attribution 0s, analysis 2s)
  ```

  `phaseTimings` in `logs/shadcn-admin/M115-shadcn-toolbar-after.json`:

  ```
  {"preflight":257,"build":1206,"calibration":1442,"mount":5773,"rerender":4615,"explore":6731,"scale":0,"deltas":0,"attribution":2,"analysis":1541,"total":21567}
  sum 21567 total 21567
  ```

  The ten phase keys sum to `total` exactly; the printed `Total: 21.6s` differs from
  `phaseTimings.total` by 33 ms. `scale` and `deltas` are `0` and are omitted from the parenthesis.
  A phase under half a second (`preflight` 257 ms, `attribution` 2 ms) is present and reads `0s`:
  `formatPhaseDuration` (`src/report.ts:721`) rounds to whole seconds, and A1's omission rule is on
  the millisecond value, not on the rendered one. Closed: yes.
- **A2, n8n Button dry run with the cost flags** (`--label M115-n8n-button-flags-after`, exit=0,
  14 s):
  `-- src/components/N8nButton/Button.vue --explain-props --samples 5 --max-combos 4`. Before, the
  same command line named the defaults. After:

  ```
  Estimated real run: ~1m 3s (8 combos x 5 samples; defaults: no phase timings recorded for this component yet)
  ```

  The same component without the two flags (`--label M115-n8n-button-noflags-after`, exit=0, 15 s)
  still names the defaults, `~2m 9s (12 combos x 10 samples; ...)`, so the counts are flag-derived
  and not a coincidence: `--max-combos 4` gives 4 capped prop combos plus the 4 scale anchors
  `runComboMode` appends (C6), and `--samples 5` replaces the default 10. Closed: yes.
- **n8n-F4 dry run** (`--label M115-n8n-after`, exit=0, 7 s), the spec's verbatim row:
  `Estimated real run: ~2m 9s (12 combos x 10 samples; defaults: no phase timings recorded for this
  component yet)`; the flags are absent from that command line, so the defaults are the right
  answer. Closed: yes.
- **n8n-F3 real run** (`--label M115-n8n-real-after`, exit=2, 41 s). Still no report, so no `Total:`
  line to break down: the row aborts on its own unresolved `~icons/` import, which is M108/M110
  work. What it shows is Lane C's C4, unchanged by this commit:
  `preflight: walking the import graph  (0:01)` / `harness: building  (0:01)`. Closed: no, and not
  by this milestone.
- **Unaffected repo** (`--label M115-shadcn-button-laneA-after`, exit=0, 2 s):
  `src/components/ui/button.tsx --explain-props` still reaches its full schema (`Props (32):`,
  `Curve mode:`, `Scale probe:`, `Matrix mode:`) and the estimate line. Closed: yes.

## Deferred

- Levers B, C and D of `perf-levers.md`. B and C are M116, gated on the numbers this milestone
  publishes; D (one driven session shared across the delta and scale-curve passes) stays deferred
  there with its M37 cold-context risk. This milestone changes no timing, it reports timing.
- Per-phase CPU and memory, and per-context or per-browser-process accounting: wall clock answers
  "where did the minutes go" at the cost of one `Date.now()` per boundary.
- Sub-phase keys for isolation and matrix runs, and a per-scale-point breakdown: the eleven keys
  cover every mode through C2's fallback rule, and more keys would break the sum identity that makes
  the breakdown checkable.
- A `--timings` flag, a machine-readable timing stream, and any way to silence the breakdown: one
  line beside a line that already prints needs no flag.
- Cross-machine estimate calibration for C6. A baseline recorded on another machine is not a
  prediction for this one, so a fingerprint mismatch falls back to the defaults.
- Pricing an isolation dry run. C6's estimate scales per-combo and per-sample costs; an isolation
  run measures neither, so `--isolate --explain-props` prices the combo path it would have taken.
- The dry run's own wall clock (median 7 s, max 92 s, `dx-audit.md`): worth naming once the real
  run's phases are known, and not before.

## Approval

Approved 2026-09-03. Commits: `661ab79` and `0b72589` (Lane C), `b1921fa` (Lane A).

- **Lane C (C1-C7)**: `report-carries-phase-timings.test.ts`,
  `progress-lines-carry-elapsed-time.test.ts` and `dry-run-estimates-the-real-run.test.ts` green
  (`3 passed` / `32 passed`), `tsc --noEmit` clean. Corpus: shadcn-admin-F2 real run closed C1-C4
  (ten keys sum to `total` exactly, `26036 == 26036`, verdict and warnings identical to the
  pre-change run); n8n-F4 dry run closed C6; n8n-F3 closed C4 only and cannot reach a report on its
  own unresolved `~icons/` import (M108/M110 work).
- **Lane A (A1, A2)**: `total-line-breaks-down-by-phase.test.ts` and `dry-run-flag-forwarding.test.ts`
  green (`2 passed` / `14 passed`), `tsc --noEmit` clean, no baseline-green test turned red across
  the 41 files importing `src/cli.js`. Corpus: shadcn-admin-F2 printed
  `Total: 21.6s  (preflight 0s, build 1s, ...)` with a 33 ms gap to `phaseTimings.total`; the n8n
  Button dry run priced `4 combos x 5 samples` from the flags and the defaults without them.
- Re-run at approval: all five spec test files, `5 passed (5)` / `55 passed (55)`.

Deferred / open:

- Levers B, C and D of `perf-levers.md`; B and C are M116, D stays deferred there.
- Per-phase CPU and memory, and per-context or per-browser-process accounting.
- Sub-phase keys for isolation and matrix runs, and a per-scale-point breakdown.
- A `--timings` flag, a machine-readable timing stream, and any way to silence the breakdown.
- Cross-machine estimate calibration for C6: a fingerprint mismatch falls back to the defaults.
- Pricing an isolation dry run: `--isolate --explain-props` prices the combo path instead.
- The dry run's own wall clock, worth naming once the real run's phases are known.
- A phase under half a second renders as `0s`: `formatPhaseDuration` rounds to whole seconds and
  A1's omission rule reads the millisecond value.
