---
kind: milestone
status: approved
tests:
  - test/unit/module-boundaries.test.ts
  - test/unit/module-ratchets.test.ts
---

# M118: the source tree says what each file is for

Executes ADR 0005 (`specs/decisions/0005-module-layout-by-pipeline-stage.md`). Plan and ownership:
`specs/milestones/M118-MAP.md`.

## Purpose

A maintainer or an agent opening `src/` finds the stage they need by directory name, reads a file
that has one responsibility, and changes it without touching the file another lane owns. A wave of
milestones can run three lanes in parallel by directory. A duplicated helper cannot drift, because
there is one. A comment describes the code beside it, not the milestone that wrote it.

## Root causes (verified at d63537e)

- `src/` is flat: 26 files, 33,348 lines; `harness.ts` 7,215 lines with 25 responsibility
  clusters; `analyze()` spans 911 lines (`src/analyze.ts:3557-4467`).
- M107-M117 added 4,807 lines and no file; `harness.ts` took 1,950 of them.
- A runtime import cycle: `src/harness.ts:30-35` imports four values from `preflight.ts`,
  `src/preflight.ts:19` imports two values from `harness.ts`.
- Duplicates: `serializeProps` in three files, `componentStem` in two (`src/cli.ts:1239`,
  `src/prop-gen.ts:1391`), median in two (`src/measure.ts:1298`, `src/report.ts:1837`), git-root
  walk in two (`src/cli.ts:1269`, `src/harness.ts:4234`), `node_modules` walk in two
  (`src/harness.ts:5311`, `src/project-model.ts:182`), CV in two with different divisors
  (`src/report.ts:783`, `src/noise.ts:51`).
- 1,250 milestone tokens in `src/` comments (927 before the wave).
- `src/index.ts` re-exports about 500 names; no test imports it; the README documents no
  programmatic API.

## MUST

- `src/` contains only the directories named in ADR 0005 plus `index.ts`; every source file sits in
  exactly one of them; `src/harness/shims/` keeps the shim files.
- Every value import between directories follows the order in ADR 0005 and targets the directory's
  `index.js`. `test/unit/module-boundaries.test.ts` parses every import under `src/` and fails on
  any violation; its allowlist of exceptions is empty when this milestone is approved.
- No file under `src/` exceeds 800 lines. `test/unit/module-ratchets.test.ts` holds the cap and a
  per-file allowlist that is empty when this milestone is approved.
- No comment under `src/` contains a milestone token (`M` followed by two or three digits as a
  word), "used to", "no longer", or "previously". The same ratchet test enforces it.
- No two files under `src/` define a top-level function with the same name. The same ratchet test
  enforces it.
- The helpers listed in the map's "Shared helpers" table exist once, in `src/shared/`, and every
  former copy is deleted.
- `src/index.ts` exports exactly the surface listed in the map's "Curated surface" table.
- `package.json` `bin` points at `dist/cli/main.js`; `npx 120fps --help` prints the help; the
  `dist/harness/shims/` files exist after `tsc` and every test that read `dist/shims/` reads the new
  path.
- The unit suite passes with the same set of passing tests as the baseline recorded in the map, and
  the e2e files named in the map's Verification section pass.
- `specs/overview/00-tdd.md` "Modules" lists the directories and files as they are after the move.

## MUST NOT

- Change any observable behaviour: report JSON, terminal output, exit codes, warning texts, file
  names written into a project (harness dirs, fixture scaffolds, baselines).
- Rename an exported identifier or change a signature, except to delete a duplicate whose one
  remaining copy keeps the surviving name. Coordinator-authorised exceptions, none on the package
  surface: the three `report/budget.ts` types whose names collided with different shapes in
  `report/types.ts` became `BudgetComparison`, `BudgetRegression`, `BudgetImprovement`
  (a9c8e8c); the file-private cli `componentStem`, which differs from the props one on a bare
  dotfile name, became `reportStem` (b777684).
- Combine a file move with a content edit in one commit. Moves are `git mv` plus import rewrites;
  splits and cleanups are separate commits.
- Touch `fixtures/` or change test titles.
- Introduce a new dependency.

## Verification

Recorded at 9ee7058 on 2026-09-04 (67 commits since d63537e, 9 of them merges), in the main
checkout:

1. `node node_modules/typescript/bin/tsc --noEmit` → exit 0, no diagnostics.
2. `npx vitest run test/unit --maxWorkers=2 --reporter=dot` → `Test Files 1 failed | 328 passed
   (329)`, `Tests 1 failed | 4803 passed | 1 skipped (4805)`, `Duration 255.72s`. The failure is the
   baseline one, `test/unit/vue-setup-inject-evidence.test.ts › a project the Vue compiler does not
   resolve from › records why each specifier failed`, `AssertionError: expected { __esModule: true,
   …(25) } to be undefined`. Baseline at d63537e: `1 failed | 4795 passed | 1 skipped`; the eight
   added tests are the two enforcing files. The suite needs `dist/` built first: eleven shim tests
   read `dist/harness/shims`.
3. `npx vitest run test/e2e/cli.test.ts test/e2e/shim-detect.test.ts test/e2e/baseline-env.test.ts
   --maxWorkers=1 --reporter=dot` → `Test Files 3 passed (3)`, `Tests 24 passed (24)`, `Duration
   133.22s`. Earlier at e094cf8 with `cli-path-expansion.test.ts` added: 4 files, 27 passed.
4. `rm -rf dist && node node_modules/typescript/bin/tsc` → exit 0; `dist/` holds
   `analysis browser cli harness pipeline project props report shared index.js index.d.ts`,
   `dist/harness/shims` 20 files; `node dist/cli/main.js --help | head -1` → `Usage: 120fps
   <component.tsx>[#ExportName] [more.tsx ...] [options]`, exit 0.
5. `git show --stat -M90% 663d6db | grep -c "=>"` → 35 (every moved file a rename);
   `git show --stat -M90% a87a8b8` → `src/{analysis => report}/metrics.ts | 0`.
6. `node dist/cli/main.js fixtures/button.tsx --explain-props` → exit 0, `Props (5)` table
   identical to the wave 2 snapshot in the map (label `"test"`; variant `"primary", "secondary",
   "ghost"`; disabled `true, false`; onClick and children `(no values)`).
7. `node -e "import('./dist/index.js')…"` → 12 runtime exports: `DEFAULT_THRESHOLDS HINTS
   TIER_BUDGETS analyze buildReport formatHints formatJUnit formatMarkdown hintsForReport
   loadBudgetConfig parseArgs validateBudgetConfig`.
8. `test/unit/module-boundaries.test.ts` and `test/unit/module-ratchets.test.ts`: 8 tests passed
   with every allowlist empty (`ALLOWLIST`, `LINE_CAPS`, `COMMENT_TOKENS`, `DUPLICATE_FUNCTIONS`).
   Structure: 116 `.ts` files under `src/` (analysis 8, browser 13, cli 8, harness 27 incl. 10
   shims, pipeline 15, project 11, props 15, report 11, shared 7, `index.ts`), 34,166 lines,
   largest file `pipeline/analyze.ts` 783.
9. Adversarial review by a non-implementer at e094cf8 (map, "Wave 4: review findings"): no
   runtime-reachable behaviour change; two false comment rewrites, one now-false comment and six
   stale path citations corrected in 9ee7058; one duplicate type removed there.

## Deferred

- A structured diagnostic record replacing warning-string constants and `isXWarning` predicates
  (ADR to follow; seed `PropWarningRecord`).
- Mirroring `src/` directories under `test/unit/`.
- Reconciling the two CV formulas (needs a measurement of the noise-probe thresholds).
- Shrinking `analyze()` further: the wave 2 split left it at about 560 lines delegating nine
  phases (`pipeline/phases.ts`); the mode dispatch and the harness build sequence still live in
  the body.
- Ratchet blind spots found in review: the cycle check is directory-level only (seven
  function-body-only sibling cycles exist and are safe); the duplicate-name check sees `function`
  declarations only; side-effect imports are not parsed.
- Source-reading tests whose haystack widened to the whole `pipeline/` tree
  (`a-wedged-page-cannot-consume-the-whole-run`, `an-aborted-run-still-prints-its-roots-and-total`)
  and two unbounded `slice` ranges (`matrix-transparency`, `isolation-orchestrate-harden`) should
  point at the single file that holds the asserted line.
- The comment cleanup rewrote every flagged comment; the unflagged remainder was not audited for
  stale claims.
