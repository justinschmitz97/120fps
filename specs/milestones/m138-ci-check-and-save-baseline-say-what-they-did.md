---
kind: milestone
status: draft
tests:
  - test/unit/ci-report.test.ts
  - test/unit/every-report-reaches-the-ci-writers.test.ts
  - test/unit/a-reused-verdict-says-nothing-was-measured.test.ts
  - test/unit/a-baseline-is-written-where-it-is-told.test.ts
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
3. **A curve-mode baseline entry appears never to be reused** — `src/pipeline/verdict-reuse.ts:107`
   builds the probe fingerprint with the mode hardcoded to `"combo"`, so an entry stored under
   `"curve"` cannot match it. The verifier, and the reason this is stated as *likely* rather than
   confirmed: the three repositories that re-measured under `--check` are exactly the three where
   curve mode auto-activated. The correlation is complete over a sample of three; the mechanism is
   read from the code, not from a controlled repro. Confidence: medium — this item's MUST is written
   so that it is satisfied either by reusing the entry or by saying why it cannot be.
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
  component count in the artifact equals the number of components the run reported on.
- **C3** A run whose verdict was reused says so and describes nothing else. The terminal prints one
  sentence naming that the verdict was reused from the baseline and that nothing was re-measured,
  and prints no baseline-comparison line, no environment-match line and no interaction count.
- **C4** The "0 interactions found" hint never fires on a reused report. It fires only when a run
  measured a component and found no interaction.
- **C5** A path 120fps suggests in prose is written with `/` separators on every platform.
- **C6** A reused verdict carries the warnings of the run it reuses. A reused report's `warnings`
  array equals the stored entry's, so a disclosure is not lost by caching.
- **C7** A baseline entry stored under a mode other than `combo` either matches the probe fingerprint
  of a run in that same mode, or the run states which stored mode it found and which mode it is in,
  and re-measures. Silence is not an option here.
- **C8** `--baseline-file <path>` names the file `--save-baseline` writes and `--check` reads, so a
  run need not write into the measured repository. The name was checked against the 46 entries of
  `KNOWN_FLAGS` (`src/cli/args.ts:62-109`): no `--*-file` flag exists, the only neighbouring name is
  `--baseline-env`, and the vocabulary is kebab-case with `<path>` placeholders for value flags
  (`--report-md <path>`, `--report-junit <path>`). It is documented in `--help` beside
  `--save-baseline` and `--check`. With the flag absent, the path is exactly today's
  (`<projectRoot>/120fps-baseline.json`) — the default does not change.

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

- **C1, C2** — `test/unit/every-report-reaches-the-ci-writers.test.ts` and
  `test/unit/ci-report.test.ts`: a three-component run produces markdown with three rows whose
  verdicts equal the terminal's and JUnit with `tests="3"`; a run with one failing component produces
  an artifact headline that is not `PASS` and an exit code of 1; a zero-component run still produces
  the empty artifact it produces today.
- **C3, C4, C5, C6** — `test/unit/a-reused-verdict-says-nothing-was-measured.test.ts` and
  `test/unit/terminal-modes.test.ts`: a reused report prints the reuse sentence and none of the three
  forbidden lines; a measured report with zero interactions still prints the fixture hint, and its
  suggested path contains no backslash on any platform; a reused report's `warnings` array equals the
  stored entry's.
- **C7** — extend `test/unit/verdict-reuse.test.ts`: an entry stored under `curve` is matched by a
  curve-mode run; an entry stored under `combo` is not matched by a curve-mode run, and the run says
  which mode it found and which it is in before re-measuring.
- **C8** — `test/unit/a-baseline-is-written-where-it-is-told.test.ts`: with `--baseline-file`, the baseline is
  written to the named path and read back from it by `--check`; without it, the path is
  `<projectRoot>/120fps-baseline.json` exactly as today; a relative path resolves against the process
  cwd; `--help` names the flag; an unwritable destination fails with a message naming the path.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus `test/unit/ci-report*.test.ts`, `test/unit/baseline*.test.ts`,
  `test/unit/verdict-reuse*.test.ts`, `test/unit/terminal-modes*.test.ts`,
  `test/e2e/baseline-env.test.ts`, `test/e2e/cli.test.ts`, then the full unit suite once before the
  lane's final commit.

Recorded run of this milestone's verification:

```
<filled by lane I: tsc result, the vitest invocations and their verbatim totals>
```

Corpus repros, through a `dist` built in `C:/Projekte/120fps-run7-lane-i`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run7/scaffold-vite-react-js \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-i/scaffold-vite-react-js \
  --label m138-ci --cli C:/Projekte/120fps-run7-lane-i/dist/cli/main.js \
  -- src/App.jsx --ci --report-md C:/Projekte/120fps-fieldtest/logs/run7-lane-i/scaffold-vite-react-js/report.md \
     --report-junit C:/Projekte/120fps-fieldtest/logs/run7-lane-i/scaffold-vite-react-js/report.xml \
     --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: the md shows 1 component with the terminal's verdict, the xml tests="1"
#           (baseline: **PASS**: 0 components, 0 regressions; tests="0")

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run7/scaffold-vite-react-js \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-i/scaffold-vite-react-js \
  --label m138-save-baseline --cli C:/Projekte/120fps-run7-lane-i/dist/cli/main.js \
  -- src/App.jsx --save-baseline \
     --baseline-file C:/Projekte/120fps-fieldtest/logs/run7-lane-i/scaffold-vite-react-js/baseline.json \
     --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: the repository is clean afterwards (git status --porcelain empty); the file is at the
#           named path (baseline: 120fps-baseline.json written into the project root)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run7/scaffold-vite-react-js \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-i/scaffold-vite-react-js \
  --label m138-check-reuse --cli C:/Projekte/120fps-run7-lane-i/dist/cli/main.js \
  -- src/App.jsx --check \
     --baseline-file C:/Projekte/120fps-fieldtest/logs/run7-lane-i/scaffold-vite-react-js/baseline.json \
     --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: the reuse sentence, no baseline-comparison table, no environment line, no
#           "0 interactions found" hint; the original run's warnings present

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run7/rallly/apps/web \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-i/rallly \
  --label m138-curve-reuse --cli C:/Projekte/120fps-run7-lane-i/dist/cli/main.js \
  -- src/components/pagination.tsx --check \
     --baseline-file C:/Projekte/120fps-fieldtest/logs/run7-lane-i/rallly/baseline.json \
     --samples 3 --max-combos 2 --explore-budget 30 --no-deltas
# expected: a curve-mode entry is reused, or the run names the stored mode and the current mode
#           before re-measuring (C7)
```

## Deferred

- **The exit-code redesign.** C2 makes the artifact agree with the exit code the tool already
  returns; what exit 1 covers is M133 C7's wording change and, beyond that, out of scope.
- **A baseline search path, an environment variable, or a shared cache directory.** C8 adds one
  caller-named destination; anything that finds a baseline the caller did not name is a new contract.
- **Reuse across machines.** M45 decides what "other machine" means; nothing here changes it.
- **The `--check` write of `120fps-baseline.json` documented at `README:141`.** The README wording
  follows C8 as a coordinator interface request, in the same batch as M133's README rewording.
- **Whether curve-mode reuse is *desirable*.** C7 requires the run to reuse or to explain; if the
  evidence later shows curve entries should never be reused, the explanation branch already satisfies
  the contract.
