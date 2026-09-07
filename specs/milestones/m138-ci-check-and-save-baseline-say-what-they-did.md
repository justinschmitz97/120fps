---
kind: milestone
status: draft
tests:
  - test/unit/every-report-reaches-the-ci-writers.test.ts
  - test/unit/a-reused-verdict-says-nothing-was-measured.test.ts
  - test/unit/a-baseline-is-written-where-it-is-told.test.ts
  - test/e2e/ci-artifacts-carry-the-run.test.ts
---

# M138: `--ci`, `--check` and `--save-baseline` say what they did and write where they are told

Lane I (`src/report/ci.ts`, `src/report/terminal-modes.ts`, `src/pipeline/verdict-reuse.ts`,
`src/report/baseline-io.ts`), plus two interface-scoped sites in other lanes' files: the `ciReports`
push in `src/cli/main.ts` (lane D owns that file — interface I11) and the baseline path resolution in
`src/pipeline/build-report.ts:456` and `:533-535` (lane D owns that file too — interface I13). Both
hunks are function-local and land after lane D's.

## Purpose

The three flags a developer reaches for when 120fps moves from a terminal into a pipeline all report
something other than what happened. Every `--report-md` written in run 7 says
`**PASS**: 0 components, 0 regressions` and every `--report-junit` says `tests="0"`, including the
thirteen runs that exited 1 — the array the writers read is never filled. A `--check` run that reused
a stored verdict prints a baseline comparison, an environment match and a fixture suggestion for a
measurement it did not take, drops every warning the original run produced, and spells the suggested
path with backslashes. And `--save-baseline` can only write into the project root, so the one flag
built for repeatable runs is the one that dirties the repository. After this milestone a CI artifact
carries the run's real verdicts, a reused verdict says it was reused, and a baseline goes where the
caller puts it.

Evidence: `C:/Projekte/120fps-fieldtest/smoke/run7-new1/` — the `--ci` / `--report-md` /
`--report-junit` artifacts of all 21 repositories (13 of 13 mismatches), the five repositories whose
`--check` run reused a stored verdict, and the `baseline-in-repo` flag on
`scaffold-vite-react-js`, `scaffold-vite-react-ts`, `scaffold-vite-react-swc-ts`,
`scaffold-create-vue`, `scaffold-vite-vue-ts`, `scaffold-rr7`, `scaffold-vite-shadcn`, `actual`,
`karakeep` and `anything-llm`.

## Root causes (verified)

The verifier for every item below: run-7 new-repo diagnosis (2026-09-06), refuted by default; logs
and artifacts under `C:/Projekte/120fps-fieldtest/smoke/run7-new1/logs/<repo>/`.

1. **The CI writers read an array nothing writes** — `ciReports` is declared at
   `src/cli/main.ts:235` and consumed at `:334-335`; no line pushes to it. The verifier: 13 of 13
   repositories produced `**PASS**: 0 components, 0 regressions` in markdown and `tests="0"` in
   JUnit, including runs whose process exit code was 1. A pipeline gated on those artifacts is gated
   on nothing.
2. **A reused verdict describes a measurement that did not happen** — the reuse gate is
   `src/pipeline/verdict-reuse.ts:85`, and `:120-140` constructs the returned report with
   `combos: []`, `regressions: []` and `envMatch: "identical"`. The verifier: the resulting terminal
   output claims `Baseline comparison: All metrics within tolerance: OK` and
   `Environment: identical: comparing raw timings` for a run that measured nothing; `warnings` is `[]`
   in 5 of 5 reused repositories, so every disclosure the original run made is lost; and the empty
   `combos` array reaches the "0 interactions found" branch at
   `src/report/terminal-modes.ts:199-208`, which suggests `Consider creating src\App.fixture.tsx` —
   a path with a Windows separator in a message meant to be pasted.
3. **A baseline entry recorded in another mode is passed over in silence** — the reuse probe builds
   its fingerprint with the mode hardcoded to `"combo"`, because no combo has been extracted when
   the gate runs; `featuresDiffer` (`src/report/budget.ts`) compares `mode`, so an entry recorded
   under any other mode fails `sameMachineIdentity` and the run re-measures without saying why.
   Two verifiers, both from controlled repros rather than correlation. First: a baseline entry whose
   `env.mode` is `curve` is passed over and the run measures again
   (`logs/run7-lane-i/scaffold-vite-react-js/m138-curve-entry-mode.log`). Second, and the reason the
   three curve repositories of `run7-new1` re-measured: only combo mode and isolation mode reach
   `applyBaselineWorkflow`, so a curve-mode run writes no baseline entry at all —
   `--save-baseline` on `rallly` produces no file at the named path
   (`logs/run7-lane-i/rallly/m138-curve-save.log`), and the following `--check` finds nothing to
   reuse. Whether curve mode should record a baseline is a separate contract; this milestone makes
   the entry that does exist speak.
4. **`--save-baseline` has no redirect** — the destination is built in
   `src/pipeline/build-report.ts:456` as `path.join(ctx.projectRoot, "120fps-baseline.json")` with no
   option consulted, and written at `:533-535` under `if (ctx.options.saveBaseline && metrics)`.
   `src/cli/main.ts:324` only pushes that filename onto the gitignore-hint list, and `README:141`
   documents the project-root location as the only behaviour. The verifier: ten repositories carry
   the smoke harness's `baseline-in-repo` flag, meaning the tool wrote a file into a repository it was
   told to measure, not to modify.

## MUST

- **C1** Every `Report` a run finishes reaches the CI writers. A `--report-md` or `--report-junit`
  artifact lists one row per measured component, and each row's verdict is the verdict the terminal
  printed for that component.
- **C2** The artifact and the process agree: a run that exits 1 does not produce an artifact whose
  headline is `**PASS**`, and a run that exits 0 does not produce one that reports a failure. The
  component count in the artifact equals the number of components the run reported on. A sweep that
  exits 1 while every component it finished passed — one threw before finishing a `Report` — carries
  one further JUnit testcase, named `120fps run`, whose failure says so; it is the only row in either
  artifact that is not a component.
- **C3** A run whose verdict was reused says so and describes nothing else. The terminal prints one
  sentence naming that the verdict was reused from the baseline and that nothing was re-measured,
  and prints no baseline-comparison line, no environment-match line, no interaction count, no mode
  line and no measurement-basis line. A count of combos measured or generated never appears on a run
  that measured and generated none.
- **C4** The "0 interactions found" hint never fires on a reused report. It fires only when a run
  measured a component and found no interaction.
- **C5** A path 120fps suggests in prose is written with `/` separators on every platform.
- **C6** A reused verdict carries the warnings of the run it reuses. A reused report's `warnings`
  array equals the stored entry's, so a disclosure is not lost by caching. A baseline file is
  editable text a reviewer commits, so the replay is bounded: at most ten entries, at most 300
  characters each, control characters replaced by a space, entries that are then empty dropped. A
  stored mode outside `combo | curve | matrix | isolation` is named `an unknown mode` rather than
  quoted.
- **C7** A baseline entry stored under a mode other than `combo` either matches the probe fingerprint
  of a run in that same mode, or the run states which stored mode it found and which mode its reuse
  check is in, and re-measures. Silence is not an option here. A run whose source fingerprint already
  differs says nothing about modes: the changed source is its own explanation.
- **C8** `--baseline-file <path>` names the file `--save-baseline` writes and `--check` reads, so a
  run need not write into the measured repository. The name was checked against the 46 entries of
  `KNOWN_FLAGS` (`src/cli/args.ts:62-109`): no `--*-file` flag exists, the only neighbouring name is
  `--baseline-env`, and the vocabulary is kebab-case with `<path>` placeholders for value flags
  (`--report-md <path>`, `--report-junit <path>`). It is documented in `--help` beside
  `--save-baseline` and `--check`. With the flag absent, the path is exactly today's
  (`<projectRoot>/120fps-baseline.json`) — the default does not change. One named file serves one
  project: entry keys are component paths relative to their own project root, so a sweep spanning
  two roots with `--baseline-file` is refused with exit 2 before anything is measured. A baseline
  that cannot be read — a directory, unparseable text — fails with a message naming the file.

## MUST NOT

- Change a verdict, a metric or a threshold. This milestone changes what is reported and where it is
  written, never what was measured.
- Change the markdown or JUnit schema M64 and the CI milestone fixed, beyond filling the rows that
  are empty today. The fold, the columns and the JUnit attribute names stay.
- Change the M39 reuse gate's *decision* (`optionsAllowVerdictReuse`, the fingerprint inputs, the
  explicit-mode rules). C7 is about a mode value that is hardcoded where the stored value belongs;
  it is not a new reuse policy.
- Write a baseline outside the caller's own path. C8 adds a destination the caller names; it does not
  add a search path, an environment variable or a cache directory.
- Suppress the reuse disclosure M39 already prints in the JSON report (`_(cached)_` in markdown, the
  reuse fields in JSON). C3 removes the *false* lines, not the true one.
- Print the reuse sentence for a run that measured.
- Edit `src/cli/main.ts` outside the `ciReports` push site (interface I11) or
  `src/pipeline/build-report.ts` outside the baseline path resolution at `:456` and `:533-535`
  (interface I13). Lane D lands first in both files.

## Verification

- **C1, C2** — `test/unit/every-report-reaches-the-ci-writers.test.ts`: a three-component run produces
  markdown with three rows whose verdicts equal the terminal's and JUnit with `tests="3"`; a
  zero-component run still produces the empty artifact it produces today; a run told it exits 1
  headlines a failure whatever its rows say, and its JUnit carries the `120fps run` row — which is
  absent when a reported component already carries the failure, and absent at exit 0. `test/e2e/ci-artifacts-carry-the-run.test.ts` measures a
  real component through the CLI: the artifacts carry one row and `tests="1"`, and a run forced over
  budget exits 1 with a `**FAIL**` headline and `failures="1"`.
- **C3, C4, C5, C6** — `test/unit/a-reused-verdict-says-nothing-was-measured.test.ts`: a reused report
  prints the reuse sentence, none of the forbidden lines, no `Mode:` line, no measurement basis and
  no `N measured` even when a replayed cap warning names a combo count, while a measured report still
  prints both header lines; a replayed warning is stripped of control characters, capped in count and
  in length, and dropped when nothing legible is left; a measured report with zero
  interactions still prints the fixture hint, and its suggested path contains no backslash on any
  platform; a reused report's `warnings` array equals the stored entry's, and a hand-edited entry
  whose `warnings` is not a list of strings neither crashes the run nor reaches the report.
- **C7** — same file: an entry whose `env.mode` is `curve` or `isolation` is passed over and the run
  names both modes on stderr before measuring again; a mode outside the four is named
  `an unknown mode` and never quoted into the terminal; an entry whose source fingerprint already
  differs is passed over in silence.
- **C8** — `test/unit/a-baseline-is-written-where-it-is-told.test.ts`: with `--baseline-file`, the
  baseline is written to the named path, read back from it by `--check`, and the project root is
  left alone; without it, the path is `<projectRoot>/120fps-baseline.json` exactly as today; a
  relative path resolves against the process cwd; the directories a named path needs are created;
  a second component merges into the named file; `--help` and the README options block name the
  flag; a destination that cannot be written, read or parsed fails with a message naming the path,
  while an absent file is still no baseline rather than an error; a verdict saved at the named path
  is reused from it and is not looked for at the project root; and the refusal text for a sweep
  spanning two project roots names both roots and what to do instead.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus `test/unit/ci-report*.test.ts`, `test/unit/baseline*.test.ts`,
  `test/unit/verdict-report-clarity*.test.ts`, `test/unit/fixture-harden.test.ts`,
  `test/e2e/cached-check.test.ts`, then the full unit suite once before the lane's final commit.

Recorded run of this milestone's verification, 2026-09-06 in `C:/Projekte/120fps-run7-lane-i`
(node 22.22.2, `pnpm install --frozen-lockfile`), on the branch `run7/lane-i` off
`feat/run7-remediation` at `0e75ce4`:

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
# exit 0, no output

npx vitest run test/unit/every-report-reaches-the-ci-writers.test.ts   test/unit/a-reused-verdict-says-nothing-was-measured.test.ts   test/unit/a-baseline-is-written-where-it-is-told.test.ts   test/unit/ci-report-surfacing.test.ts test/unit/ci-report-mode-rendering.test.ts   test/unit/baseline-env.test.ts test/unit/baseline-env-hardening.test.ts   test/unit/baseline-reachability.test.ts test/unit/baseline-reachability-hardening.test.ts   test/unit/baseline-slots.test.ts test/unit/baseline-version-warning.test.ts   test/unit/budget-baseline.test.ts test/unit/verdict-report-clarity.test.ts   test/unit/verdict-report-clarity-harden.test.ts test/unit/fixture-harden.test.ts --maxWorkers=2
# Test Files  15 passed (15)
#      Tests  405 passed (405)

npx vitest run test/e2e/ci-artifacts-carry-the-run.test.ts --maxWorkers=1
# Test Files  1 passed (1)
#      Tests  2 passed (2)      36.9 s

npx vitest run test/e2e/cached-check.test.ts --maxWorkers=1
# Test Files  1 passed (1)
#      Tests  7 passed (7)      69.9 s

npx vitest run test/unit --maxWorkers=2
# Test Files  2 failed | 342 passed (344)
#      Tests  2 failed | 4960 passed | 1 skipped (4963)      311.69 s
# The two failures are the run-7 baseline's own: prop-cap-ranking.test.ts
# ("variant and size survive the 32-prop cap") and vue-setup-inject-evidence.test.ts
# ("records why each specifier failed"). Against the recorded baseline of 341 files /
# 4921 tests, the deltas are exactly this milestone's three new unit files and their 42 tests.
```

Re-run on the merged wave-1 tree (`de41d6a`, lanes A, B, C, H and I merged) after the review fixes:

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json     # exit 0, no output

npx vitest run test/unit/every-report-reaches-the-ci-writers.test.ts   test/unit/a-reused-verdict-says-nothing-was-measured.test.ts   test/unit/a-baseline-is-written-where-it-is-told.test.ts --maxWorkers=2
# Test Files  3 passed (3)
#      Tests  61 passed (61)
# The same command against the pre-fix sources fails 11 of the new assertions
# (the mode and basis lines on a reused report, the JUnit run row, the four sanitizer
# bounds, describeStoredMode, the two loadBaseline messages, the two-root refusal text).

npx vitest run <14 neighbouring unit files> --maxWorkers=2      # 384 passed
npx vitest run test/e2e/ci-artifacts-carry-the-run.test.ts --maxWorkers=1   # 2 passed, 49.0 s
npx vitest run test/e2e/cached-check.test.ts --maxWorkers=1                 # 7 passed, 97.9 s

npx vitest run test/unit --maxWorkers=2
# Test Files  2 failed | 364 passed (366)
#      Tests  2 failed | 5190 passed | 1 skipped (5193)      589.25 s
# The same two baseline failures, no others.
```

Corpus re-run of the reuse path against the merged tree's `dist` (a baseline saved by a pre-merge
build no longer reuses: M131 changed the discovered stylesheet list, which is part of the
environment key, so the entry is re-saved first):

```
node .../run120.mjs --cwd E:/repositories-run7/scaffold-vite-react-js --label m138fix-save   -- src/App.jsx --save-baseline --baseline-file .../baselines/scaffold-vite-react-js.fix.json ...
# exit 1, 62 s, the baseline at the named path, the repository clean

node .../run120.mjs --cwd E:/repositories-run7/scaffold-vite-react-js --label m138fix-check   -- src/App.jsx --check --baseline-file .../baselines/scaffold-vite-react-js.fix.json ...
# exit 1, 2 s. The whole body after "Node v22.22.2, Chromium 147.0.7727.15":
#
#   Verdict reused from baseline, nothing re-measured (--no-cache measures fresh numbers).
#
#   Result: FAIL
#   [the save run's four warnings, verbatim]
#
# No "Mode: prop combos (0 measured of 32 generated)", no measurement-basis line, no combo table,
# no baseline comparison, no environment line, no fixture hint. The repository is still clean.

node dist/cli/main.js E:/repositories-run7/scaffold-vite-react-js/src/App.jsx   E:/repositories-run7/scaffold-vite-react-ts/src/App.tsx --check   --baseline-file .../baselines/shared.json --samples 2
# exit 2 before any measurement, nothing written at the named path:
#   Error: --baseline-file names one file, but this run spans 2 project roots
#   (E:\repositories-run7\scaffold-vite-react-js, E:\repositories-run7\scaffold-vite-react-ts) whose entries
#   are keyed by a path relative to their own root. Run each project separately, or drop
#   --baseline-file to write each project's own baseline.
```

Corpus repros, through a `dist` built in `C:/Projekte/120fps-run7-lane-i`, logs under
`C:/Projekte/120fps-fieldtest/logs/run7-lane-i/`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs   --cwd E:/repositories-run7/scaffold-vite-react-js   --out C:/Projekte/120fps-fieldtest/logs/run7-lane-i/scaffold-vite-react-js   --label m138-ci --cli C:/Projekte/120fps-run7-lane-i/dist/cli/main.js   -- src/App.jsx --ci      --report-md .../scaffold-vite-react-js/report.md      --report-junit .../scaffold-vite-react-js/report.xml      --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# exit 1, 94 s. report.md: "**FAIL**: 1 component, 0 regressions" and one row
# "| `src/App.jsx` | 32.76ms | 9.77ms | **FAIL** | - | preflight 0s, build 1s, ... |",
# the run's three warnings behind the Warnings fold. report.xml: tests="1" failures="1",
# one testcase name="src/App.jsx" whose failure body is
# "combo 0: mount 32.76ms, rerender 9.77ms: over budget for tier T4".
# Baseline at f54be55: "**PASS**: 0 components, 0 regressions" and tests="0", also at exit 1. (C1, C2)

node ... --label m138-save-baseline -- src/App.jsx --save-baseline      --baseline-file .../logs/run7-lane-i/baselines/scaffold-vite-react-js.json      --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# exit 1, 92 s. The 2139-byte baseline is at the named path;
# `git -C E:/repositories-run7/scaffold-vite-react-js status --porcelain` prints nothing.
# Baseline at f54be55: 120fps-baseline.json written into the project root. (C8)

node ... --label m138-check-reuse -- src/App.jsx --check      --baseline-file .../logs/run7-lane-i/baselines/scaffold-vite-react-js.json      --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# exit 1, 2 s. The whole body after the machine header:
#   Verdict reused from baseline, nothing re-measured (--no-cache measures fresh numbers).
#
#   Result: FAIL
#   [the save run's three warnings, verbatim]
# No combo table, no "Baseline comparison", no "Environment:", no "Consider creating";
# the repository is still clean. Baseline at f54be55: a comparison table, an environment
# match, "Consider creating src\App.fixture.tsx", and warnings: []. (C3-C6)

node ... --label m138-curve-entry-mode -- src/App.jsx --check      --baseline-file .../baselines/scaffold-vite-react-js.curve-mode.json ...
# The same entry with env.mode rewritten to "curve". exit 1, 96 s, first line of the run:
#   Warning: no verdict was reused: the stored baseline entry was recorded in curve mode
#   and this run's reuse check runs in combo mode, so the component is measured again.
# then a full measurement. (C7)

node ... --cwd E:/repositories-run7/rallly/apps/web --label m138-curve-save   -- src/components/pagination.tsx --save-baseline --baseline-file .../baselines/rallly.json ...
# exit 0, 203 s, "Mode: curve over "totalItems"". No file at the named path and none in the
# repository: only combo mode and isolation mode reach applyBaselineWorkflow, so a curve-mode
# run records no baseline entry at all.

node ... --cwd E:/repositories-run7/rallly/apps/web --label m138-curve-check   -- src/components/pagination.tsx --check --baseline-file .../baselines/rallly.json ...
# exit 0, 205 s, "Mode: curve over "totalItems"", "Result: PASS". With no stored entry there is
# no stored mode to name, so the run measures; C7 is exercised by m138-curve-entry-mode above.
# `git -C E:/repositories-run7/rallly status --porcelain` shows only the pre-existing
# " M pnpm-lock.yaml" it carried before these runs.
```

## Deferred

- **The exit-code redesign.** C2 makes the artifact agree with the exit code the tool already
  returns; what exit 1 covers is M133 C7's wording change and, beyond that, out of scope.
- **A baseline search path, an environment variable, or a shared cache directory.** C8 adds one
  caller-named destination; anything that finds a baseline the caller did not name is a new contract.
- **Reuse across machines.** M45 decides what "other machine" means; nothing here changes it.
- **The `README:141` sentence that calls the project root the only destination.** The README's fenced
  options block lists `--baseline-file` because a test holds it to `KNOWN_FLAGS`; the prose above it
  is the coordinator's, and follows C8 in the same batch as M133's README rewording.
- **A replayed warning is the saving run's, in that run's tense.** "measuring with no props" reads as
  a claim about a run that measured nothing. Rewording every disclosure for replay is a text pass
  across every warning the tool prints, not a caching fix.
- **A gitignore tip for a caller-named path inside the repository.** `--baseline-file` pointed at a
  path under the git root is not offered the hygiene hint the default path gets, because the tip is
  keyed on the baseline's conventional name.
- **Escaping a replayed warning for markdown.** The Warnings fold in `report/ci.ts` writes each
  warning as a list item without passing it through `escapeMdCell`, so a committed baseline can close
  the fold or open a heading in a CI artifact. The replay is stripped of control characters and
  bounded in size; the markdown escape belongs with the fold, whose other writers are equally
  unescaped today.
- **A baseline for curve mode and matrix mode.** Only combo mode and isolation mode reach
  `applyBaselineWorkflow`, so `--save-baseline` under an auto-activated curve records nothing and
  `--check` has nothing to compare. C7 makes the entry that does exist speak; whether these modes
  should record one at all is a contract of their own.
- **Whether curve-mode reuse is *desirable*.** C7 requires the run to reuse or to explain; if the
  evidence later shows curve entries should never be reused, the explanation branch already satisfies
  the contract.
