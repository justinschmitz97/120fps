---
kind: decision
status: approved
---

## Context

At d63537e `src/` is 26 flat files, 33,348 lines, plus `src/shims/`. Six files hold two thirds of
the code: `harness.ts` 7,215 lines with 25 responsibilities and 171 exports of which 27 are used by
other source files; `analyze.ts` 4,980 with a 911-line `analyze()`; `prop-gen.ts` 3,311 holding a
program cache, Vue prop parsing, candidate selection, a type classifier and a value synthesiser;
`report.ts` 2,203 interleaving the Report types, statistics and terminal formatting; `measure.ts`
2,099 with 97 exports of which 44 exist for tests alone; `cli.ts` 1,980 with a 469-line
`parseArgs()`.

The wave M107-M117 added 4,807 lines and no file. `harness.ts` grew by 1,950 lines and 89
declarations. Milestone tokens in comments went from 927 to 1,250. One runtime import cycle appeared
(`harness.ts:30-35` and `preflight.ts:19`, values both ways) beside four type-only cycles. The same
helper is written twice or three times in different files: `serializeProps` (explorer, measure,
react-profiler), `componentStem` (cli, prop-gen), a median (measure, report), a git-root walk (cli,
harness), a `node_modules` walk (harness, project-model), and two coefficient-of-variation formulas
with different divisors (report sample variance, noise population variance).

The cause is structural. Milestone maps assign lane ownership by file, so each remediation lands in
the nearest owned file, and the M107-M117 map had to serialise lane A because three milestones edit
the same 200 lines of `harness.ts`. Comments cite the milestone that introduced a line, so the code
carries history that git and the archived milestone specs already hold.

## Decision

1. **Directories by pipeline stage.** `src/cli`, `src/pipeline`, `src/analysis`, `src/browser`,
   `src/harness`, `src/props`, `src/project`, `src/report`, `src/shared`. Each directory has an
   `index.ts` that re-exports its surface. `src/index.ts` re-exports from stage indexes.
2. **Value imports point downward.** cli → pipeline → analysis → browser → harness → {props,
   project} → shared. `report` sits beside `harness`: everything above it may import it, it imports
   only `shared`. A value import against this order is a defect. Type-only imports are free in every
   direction except into `cli` and `pipeline`. Cross-directory value imports go through the target
   directory's `index.js`; imports inside a directory go to the file. A unit test parses every import
   in `src/` and enforces the order.
3. **A file has one responsibility and at most 800 lines.** The six large files split along their
   responsibility clusters (see the M118 map). A unit test ratchets the line cap with a shrinking
   allowlist.
4. **One helper per fact.** Path normalisation, JSON reading, the median and the CV live in
   `src/shared/`. The CV keeps the sample-variance divisor from M53; the noise probe's population
   formula is a separate, named function until a measurement shows the probe thresholds hold under
   the sample formula.
5. **Comments state the invariant.** No milestone numbers, no "used to", no "previously" in
   `src/`. History lives in git and `specs/milestones/`. A unit test ratchets the milestone-token
   count per file to zero.
6. **Warning text stays beside its emitter.** Constants move with the function that pushes them.
   Replacing string constants and `isXWarning` predicates with a structured diagnostic record is a
   later decision; `PropWarningRecord` (M114) is its seed.
7. **The public surface is curated.** `src/index.ts` exports the CLI's programmatic entry
   (`analyze`, its options, `buildReport`), the Report types, the CI formatters and the budget
   loader. Tests import stage indexes or files directly; they are not consumers of the package
   surface.
8. **Ownership by directory.** Future milestone maps assign lanes to directories. A lane never
   edits another lane's directory; a needed change is an interface request.

## Consequences

- Every test import path changes once. `dist/cli.js` becomes `dist/cli/main.js`; `package.json`
  `bin` follows. `dist/shims/` becomes `dist/harness/shims/`; the three shim-directory resolutions
  and the install-root resolution in `harness.ts` change with it.
- Specs cite `src/<stage>/<file>.ts`. The module table in `specs/overview/00-tdd.md` lists
  directories and their files.
- The eight `src/` files stored with CRLF are normalised to LF in a commit of their own before any
  move, so git rename detection sees the moves as renames.
- Type-only cycles are tolerated; runtime cycles are not. The harness/preflight cycle dissolves by
  placing transform detection and module resolution under `src/project/`.
- M118 executes this decision as a behaviour-preserving refactor: the unit suite before and after
  reports the same passing set.
