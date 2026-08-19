---
kind: milestone
status: approved
tests:
  - test/unit/react-profiler.test.ts
  - test/unit/measure.test.ts
  - test/unit/css-injection.test.ts
  - test/unit/gitignore-advisory.test.ts
---

# M74: environment advisories and font-load diagnostics

## Goal

Three findings from the portability audit go from silent to diagnosed: a plain-Preact project
resolves to `"vanilla"` with no signal that React-family analysis was skipped (D6); a 404'd or
decode-failed webfont settles silently because `document.fonts.ready` resolves regardless of
per-face failure, so fallback-font metrics carry no signal (B10); and the tool writes
`120fps-report*.json` / `120fps-baseline.json` into the user's repo with no gitignore awareness
(E5). Each becomes a warning or hint at the seam that already threads warnings through, with no
new failure mode and no file the tool did not already write.

## Scope

### 1. Preact advisory (`src/react-profiler.ts`)

`detectFramework` (`src/react-profiler.ts:127`) already computes `workspaceRoot` unconditionally
and already reads the manifest via `declaredPackages`/`isPackageAvailable` (M68/M72). It gains one
more check at the tail, after the existing Solid check and before `return resolved`: when
`resolved === "vanilla"` and `isPackageDeclared("preact", memberRoot, workspaceRoot)` (declared at
either the member or workspace manifest, matching the Solid check's declared-only standard), it
calls `onWarning` with a new `PREACT_UNSUPPORTED_WARNING(memberRoot)`, module-level export only
(the `SOLID_AND_REACT_DECLARED` precedent: not barrel-exported). The early "manifest unreadable"
return (`src/react-profiler.ts:131-134`) is untouched: an unreadable manifest cannot answer whether
preact is declared, so it keeps its own warning and never reaches the new check. `isPackageDeclared`
is imported from `./project-model.js` alongside the existing `declaredPackages`/`findWorkspaceRoot`/
`isPackageAvailable`/`readProjectManifest` imports; no change to `project-model.ts` itself.

### 2. Font-load-failure diagnostics (`src/measure.ts`)

`settleStyles` (`src/measure.ts:289`) returns `Promise<boolean>` today: whether `document.fonts
.ready` resolved inside the 5s bound. `fonts.ready` resolves even when individual `FontFace`
entries failed to load (404, decode error), so a component measured against its fallback font
produces no signal at all. `settleStyles` changes its return type to a
`{ settled: boolean; failedFamilies: string[] }` shape (name TBD at implementation, e.g.
`FontSettleResult`): after the existing ready-race and the existing double-rAF fence, one more
`page`-side step (inside the same `page.evaluate` callback, so it costs no extra round trip) walks
`document.fonts` (guarded the same defensive way the existing `fonts?.ready` check already is,
since a stubbed-`undefined` `document.fonts` is an existing test case) and collects the `family` of
every entry whose `status === "error"`, deduplicated. The early "gate inactive" return
(`needsStyleSettle` false) returns `{ settled: true, failedFamilies: [] }`.

`reportFontSettle` (`src/measure.ts:325`) changes its first parameter from `boolean` to the new
result shape and gains a second check: when `failedFamilies.length > 0` it additionally calls
`onWarning` with a new `FONT_LOAD_FAILED_WARNING(families)` (module-level export only, same
precedent as `PREACT_UNSUPPORTED_WARNING`). Every existing call site that already threads
`reportFontSettle(await settleStyles(page, harness), options.onWarning)` — `src/measure.ts:371`
(`enterHarness`), `src/react-profiler.ts:771`, and `src/explorer.ts:483` (unowned by this
milestone, unmodified, compiles unchanged because it only forwards the awaited value) — needs no
per-call-site edit; the seam already threads the richer result through.

`src/analyze.ts` has one call site that does not go through `reportFontSettle`: the `fontsSettled`
boolean at `src/analyze.ts:2037,2277,2162-2164` (set in `enterHarnessPage`, read later in
`attachHarnessContext` to push `FONT_SETTLE_WARNING` directly onto `report.warnings`). This
milestone replaces that manual pattern with `reportFontSettle(await settleStyles(page, harness!),
onWarning)` at the point `fontsSettled` was previously assigned, removing the `fontsSettled`
variable and the later manual push — `onWarning` (`src/analyze.ts:2048`) already dedupes into
`runWarnings`, which `attachHarnessContext` already merges into `report.warnings`
(`src/analyze.ts:2107-2108`), so both warnings reach the same report field through the one shared
path instead of two.

### 3. Gitignore advisory (`src/cli.ts`)

New pure functions in `src/cli.ts`: `findGitRoot(startDir)` walks up from `startDir` looking for a
`.git` entry, matching the walk shape of `project-model.ts`'s `findWorkspaceRoot` without depending
on that module; `gitignoreCoversFile(gitignoreContent, filename)` checks each non-comment,
non-blank line for a literal match, or a match against a pattern carrying exactly one `*`
(prefix/suffix around it) — deliberately not a gitignore glob engine (no `**`, character classes,
negation, directory-scoped rules), but wide enough to recognize `GITIGNORE_SUGGESTED_PATTERNS`
itself, so a user who already took the hint stops seeing it; a pattern with two or more wildcards
or another unsupported form produces an extra hint rather than a suppressed one.
`needsGitignoreAdvisory(gitRoot, writtenFilenames)` reads `.gitignore` at `gitRoot` (empty string
when absent — never created or written) and returns true when any written filename is uncovered.

`main()` (`src/cli.ts`, after the measurement loop, alongside the existing `jsonNotice` block) calls
this when `!args.ci`: `findGitRoot(process.cwd())`, and if found, builds `writtenFilenames` from
`reportPaths.map(path.basename)` plus `"120fps-baseline.json"` when `args.saveBaseline` is set, and
prints one `GITIGNORE_ADVISORY_HINT` line (naming `120fps-report*.json`, `120fps-baseline.json`,
`.120fps-harness-*`) to stdout when `needsGitignoreAdvisory` is true. `--budget` already implies
`--ci` (`src/cli.ts:267`), so it is suppressed there too. The hint is never routed through
`src/hints.ts`: that module's `HintId`/`HINTS` shape is Report-derived (per-combo/isolation/curve
findings with a README anchor); a repo-hygiene notice with neither a combo finding nor an anchor
does not fit it, so this follows the `formatJsonSplitNotice` precedent instead (a standalone,
`--ci`-gated notice printed alongside the run, not barrel-exported).

## Does NOT include

- `src/preflight.ts`, `src/project-model.ts`, `fixtures/`: owned by a concurrent lane.
- `test/e2e/compare.test.ts`: owned by a concurrent lane.
- Writing to the user's `.gitignore`. The advisory only ever reads it.
- A full `.gitignore` pattern engine (character classes, `**`, negation, directory-scoped rules).
  `gitignoreCoversFile` is literal-or-trailing-wildcard only, by design.
- Any change to `src/harness.ts`, `src/index.ts`: no barrel export is added for
  `PREACT_UNSUPPORTED_WARNING`, `FONT_LOAD_FAILED_WARNING`, or the gitignore-advisory functions,
  matching the existing `SOLID_AND_REACT_DECLARED`/`formatJsonSplitNotice` precedent of
  module-level-only exports for this class of warning/notice helper.
- Rejecting or gating a Preact project: it still measures, framework-agnostic; this is a warning,
  not a new hard preflight failure.
- Retrying or working around a failed font load. The component still measures with its fallback
  font; the warning only names that this happened.

## Acceptance

- A project that declares `preact` (member or workspace manifest) and neither `react`/`react-dom`
  nor `vue`: `detectFramework` still returns `"vanilla"` and calls `onWarning` once with
  `PREACT_UNSUPPORTED_WARNING`.
- A project that declares `preact` alongside `react`: `detectFramework` resolves `"react"` and does
  not call `PREACT_UNSUPPORTED_WARNING` (only the existing Solid check, if applicable, can fire).
- A project with neither `preact` nor any recognized framework declared: vanilla resolution
  produces no new warning (unchanged from before this milestone).
- `settleStyles` resolves `{ settled: true, failedFamilies: [] }` for the inactive gate and for a
  page with no failed `FontFace` entries.
- `reportFontSettle` given `{ settled: false, failedFamilies: [] }` calls `onWarning` once with
  `FONT_SETTLE_WARNING` only; given `{ settled: true, failedFamilies: ["Inter"] }` calls it once
  with `FONT_LOAD_FAILED_WARNING(["Inter"])` only; given both failure conditions calls it twice, in
  that order; given neither, does not call it.
- `gitignoreCoversFile` recognizes an exact literal line and a line carrying exactly one `*`
  (leading, trailing, or mid-string) as covering a filename, ignores comments and blank lines, and
  does not recognize a pattern with two or more wildcards (the documented approximation).
- `needsGitignoreAdvisory` returns true for a git repo with no `.gitignore` file at all, and false
  when every written filename is covered.
- `findGitRoot` returns the nearest ancestor containing `.git` and `undefined` outside any repo.
