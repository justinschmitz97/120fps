---
kind: milestone
status: draft
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
  remaining copy keeps the surviving name.
- Combine a file move with a content edit in one commit. Moves are `git mv` plus import rewrites;
  splits and cleanups are separate commits.
- Touch `fixtures/` or change test titles.
- Introduce a new dependency.

## Verification

Recorded verbatim on approval:

1. `node node_modules/typescript/bin/tsc --noEmit` clean.
2. `npx vitest run test/unit --maxWorkers=2`: totals, compared with the baseline in the map.
3. `npx vitest run test/e2e/cli.test.ts test/e2e/shim-detect.test.ts test/e2e/baseline-env.test.ts --maxWorkers=1` green.
4. `rm -rf dist && node node_modules/typescript/bin/tsc && node dist/cli/main.js --help` exit 0.
5. `git log --stat` shows the move commit as renames (similarity ≥ 90% per file).

## Deferred

- A structured diagnostic record replacing warning-string constants and `isXWarning` predicates
  (ADR to follow; seed `PropWarningRecord`).
- Mirroring `src/` directories under `test/unit/`.
- Reconciling the two CV formulas (needs a measurement of the noise-probe thresholds).
- Shrinking `analyze()` below 200 lines by extracting its phases (the split moves the mode engines
  out; the orchestrator body stays).
