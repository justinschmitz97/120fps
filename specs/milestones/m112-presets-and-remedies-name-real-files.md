---
kind: milestone
status: approved
tests:
  # Lane B
  - test/unit/preset-sibling-shape-is-disclosed.test.ts
  # Lane C
  - test/unit/remedy-follows-the-applied-preset.test.ts
  - test/unit/init-fixture-scaffolds-or-explains.test.ts
  - test/unit/stylesheet-disclosure-completeness.test.ts
  # Lane A
  - test/unit/declared-stylesheet-absent-is-named.test.ts
  - test/unit/package-declared-stylesheets.test.ts
---

# M112: presets and remedies name real files

Lanes B (`src/prop-presets.ts`, `src/prop-gen.ts`), C (`src/analyze.ts`, `src/composition.ts`, `src/report.ts`),
A (`src/harness.ts`), per `specs/milestones/M107-M117-MAP.md`. Closes: radix-themes-F1, radix-themes-F2,
radix-themes-F3, epic-stack-F3, logto-F4.

## Purpose

A user who follows a printed remedy changes something the run then uses. Five run-5 findings show the opposite:
the tool names a file to create that already exists as real source, ignores a preset file it found because the
file's shape is wrong and says nothing, repeats the "add a preset" clause in the run that loaded and applied
that preset, claims no stylesheet was declared while the package's `package.json` declares one, and accepts
`--init-fixture` on the path whose warning recommends it while writing nothing.

Evidence: `C:\Projekte\120fps-fieldtest\EVIDENCE.md` rows radix-themes-F1/F2/F3 (lines 73-75), epic-stack-F3
(line 79), logto-F4 (line 81); `verify\radix-themes.md:15-106`, `verify\epic-stack.md:61-96`,
`verify\logto.md:103-116`; `remediation\cluster-briefs.md` G6 (lines 137-162); logs
`logs/radix-themes/explain-button.log:1`, `logs/radix-themes/real-button.log:17,113`,
`logs/radix-themes/dialog-init-fixture.log:57`, `logs/epic-stack/ep1-button.log`,
`logs/logto/explain-button-preset.log:6`.

## Root causes (verified)

Lines re-checked against this worktree's `src`; where the cluster brief differs, the real line wins.

1. **radix-themes-F1** — `warnPropCap` (`src/prop-gen.ts:1338-1344`) and `warnCollapsedUnion`
   (`src/prop-gen.ts:1350-1362`) render the remedy through `presetFileName` (`src/prop-gen.ts:1332-1336`)
   unconditionally. The same file already owns the branching pattern: `presetRemedyClause`
   (`src/prop-gen.ts:524-528`), used by `warnDegenerateProps` (`src/prop-gen.ts:1369-1383`). radix ships
   `src/components/button.props.tsx` (89 B) and `badge.props.tsx` (845 B) as real component source at exactly
   the stems the remedy names.
2. **epic-stack-F3, and the second order of radix-themes-F1** — `detectPropPresets`
   (`src/prop-presets.ts:28-33`) finds a `<stem>.props.tsx`, `loadPropPresets` (`src/prop-presets.ts:114`) calls
   `findDefaultExport` (`src/prop-presets.ts:85`), and the result is `undefined` at `src/prop-presets.ts:128`
   for anything other than a default-exported object literal (radix's `export { baseButtonPropDefs as
   buttonPropDefs } from ...`, epic-stack's `export const variant = "default"`). Both call sites,
   `src/analyze.ts:2421-2422` and `src/analyze.ts:3069-3070`, drop that outcome with no warning.
3. **logto-F4** — `explainProps` pushes the extraction warnings at `src/analyze.ts:2418`, three lines before it
   detects and applies the preset (`src/analyze.ts:2421-2427`), so the capped-extraction remedy is stale by
   construction; the same run prints `presets:  <path>` from `src/analyze.ts:2614`.
4. **radix-themes-F2** — `packageStylesheetCandidates` (`src/harness.ts:1133-1164`) collects `manifest.style` at
   `src/harness.ts:1140` and returns only the `isFile` survivors at `src/harness.ts:1159-1162`, so a
   declared-and-absent target leaves no trace. `discoverGlobalCss` (`src/harness.ts:1241`) walks past the
   package-declared layer (`src/harness.ts:1289-1300`) to the size-ranked survivor and emits
   `CSS_FALLBACK_WARNING` (`src/harness.ts:848-863`) from `src/harness.ts:1340-1345`, whose fixed prefix asserts
   nothing was declared. The file models the missing half elsewhere: `StylesheetImportTarget`
   (`src/harness.ts:735`) carries `{ declared }` at `:756`, `:987` and `:1223`, and
   `CSS_BROKEN_IMPORT_SKIPPED_WARNING` (`src/harness.ts:1173`) names an absent target plus the build that
   produces it.
5. **radix-themes-F3** — `UNCOMPOSED_SIBLINGS_WARNING` (`src/composition.ts:428-431`) has two emission sites.
   The never-composed site (`src/analyze.ts:3016-3025`, guarded by `!compositionTree`) never reads
   `options.initFixture`. The rollback site (`src/analyze.ts:3537`) sits after the only caller of
   `writeFixtureScaffold` (`src/analyze.ts:3519-3522`, the call at `:3521`), whose third parameter is a
   `CompositionTree` (`src/analyze.ts:2716-2719`) — the value that is `undefined` on the first path, so the flag
   cannot act there even in principle.

## MUST

### Lane B (`src/prop-presets.ts`, `src/prop-gen.ts`)

- B1 A preset is looked up as `<stem>.120fps.props.tsx`, `<stem>.120fps.props.ts`, `<stem>.props.tsx`,
  `<stem>.props.ts`, in that order, and is recognised by shape: a default-exported object literal. The first
  candidate carrying that shape wins; an earlier candidate without it does not stop the search.
- B2 A candidate file that exists under one of those names without that shape is reported by its path as
  "exists, not a preset: no default-exported object literal (expected `export default { prop: [values] }`)", and
  every remedy that would have named it names `<stem>.120fps.props.tsx` instead.
- B3 A cap or collapsed-union warning that a later preset would change is re-renderable after the preset loads:
  its subject and its text are recoverable per component stem, not only as a printed line. With no preset
  candidate on disk the sentence is unchanged, character for character; its channel is the run's warning
  list on any run that passes a warning sink, no longer stderr.

### Lane C (`src/analyze.ts`, `src/composition.ts`, `src/report.ts`)

- C1 The preset is detected and applied before any extraction warning is printed. After a preset is applied, the
  cap and collapsed-union warnings are re-rendered against the applied schema: a warning whose subject the
  preset removed does not print, and a warning that survives names the preset that is already loaded instead of
  asking for a file. The dry run (`--explain-props`) and the real run print the same text (M100 parity).
- C2 The B2 disclosure reaches the terminal, the report JSON `warnings` array and the markdown report, in the
  dry run and the real run. The disclosure is pushed once per path by its producer; no dedup pass is added here
  (M117 C1 owns `(×N)`).
- C3 `--init-fixture` on the never-composed path (`!compositionTree` with declared siblings) writes
  `<stem>.fixture.tsx` holding the bound root plus one `TODO` placeholder per declared sibling, and prints
  `wrote fixture scaffold <path>; edit it to render the real composition, then re-run`; when the target exists
  it prints `--init-fixture skipped: <path> already exists`. The flag never finishes without an outcome line on
  a path whose warning recommends it.
- C4 The report's `css` object carries Lane A's declared-but-absent targets as `css.declaredMissing: string[]`
  (project-root-relative posix paths), and `formatStylesheetsLine`'s `none` branch names the declaring field,
  the missing path and the build command instead of "none found".

### Lane A (`src/harness.ts`)

- A1 A package stylesheet declared in the measured package's `package.json` (`style`, `exports["./styles"]`,
  `exports["./style.css"]`, `exports[*].style`) whose target does not exist is reported as declared-but-unbuilt,
  naming the declaring field, the missing path and the package's own build command (`packageManagerRunCommand`,
  `src/harness.ts:3083`; M95 rule), on any run where no stylesheet was injected; a run that injected
  an entry-chain or conventional-name stylesheet keeps its current text.
- A2 With such a target present, the size-ranked fallback is not used for that package: the run reports
  `css.layer: "none"` with a non-empty `css.declaredMissing`, and `CSS_FALLBACK_WARNING`'s "no entry stylesheet
  import and no conventional global stylesheet were found" sentence does not print for that run.

## MUST NOT

- Name a `<stem>.props.tsx` as a file to create while a file of that name exists on disk.
- Print the "add a preset" clause in a run that loaded and applied a preset.
- Drop a detected preset candidate silently because its shape is wrong.
- Assert that a package declared no stylesheet while its manifest declared one.
- Accept `--init-fixture` and write nothing without printing why.
- Lift the prop cap because a preset exists: M86's rule stands (a preset-named prop is promoted into Tier 0 of
  the ranking, `presetPropNames`, `src/prop-gen.ts:1795-1800`), and `test/unit/prop-cap-preset-exempt.test.ts`
  stays green.
- Change a verdict, an exit code or a measured number on any run that has no declared-but-absent stylesheet and
  no preset-shaped sibling — the control (shadcn-admin) is byte-identical, except that the prop-cap sentence
  moves from stderr into the run's warning block (same words, two-space indent, stdout), which is the channel
  move B3 and C1 require. On radix-themes the fallback sheet is
  deliberately no longer injected; that scene change is the fix, and no verdict or exit code changes with it.

## Interfaces needed

- I7, producer lane B, consumer lane C. `extractPropsDetailed`'s result exposes `warningRecords: Array<{ kind:
  "prop-cap" | "collapsed-union" | "degenerate"; stem: string; text: string }>` beside the existing `warnings:
  string[]`. Needed by C1. M114 adds `unresolvedReExport` to the same record surface afterwards.
- I6, producer lane B, consumer lane C. `src/prop-presets.ts` exports `describePresetSibling(componentPath): {
  path: string; shape: "preset" | "no-default-export" } | undefined`, the shape-aware form of
  `detectPropPresets`. Needed by B1, B2, C1, C2.
- I5, producer lane A, consumer lane C. `packageStylesheetCandidates` returns `Array<{ file: string } | {
  declared: string }>` (the `StylesheetImportTarget` shape at `src/harness.ts:735`), the `discoverGlobalCss`
  result gains `declaredMissing: Array<{ field: string; path: string; buildCommand?: string }>`, `CssReport`
  (`src/report.ts:429-477`) gains `declaredMissing?: string[]` beside `declaredMissingFields?: Array<{ field:
  string; path: string; buildCommand?: string }>`, and `formatStylesheetsLine` (`src/report.ts:681-699`)
  renders the declared-but-unbuilt outcome in its own wording. Needed by A1, A2, C4. M114 adds `runtimeEngines` and `runtimeEnginesRecognised` to the same
  record afterwards.

Conflicts in `M107-M117-MAP.md`: C5 — M112's warning records land before M114's re-export outcome; C6 — M112's
declared-but-absent branch is a new early return ahead of the fallback, never a rewrite of
`CSS_FALLBACK_WARNING`'s sentence, and M114 rewrites the `noEntryInPackage` clause afterwards; C4 — M115 and
M110 land in `explainProps` before M112's preset step, which is one insertion after `src/analyze.ts:2418`.

## Verification

Unit tests, `vitest run <file> --maxWorkers=2`. New fixture directories (the map forbids editing an existing
fixture): `fixtures/preset-collision/` with (a) `re-export.tsx` plus `re-export.props.tsx` re-exporting a named
binding (the radix shape), (b) `named-only.tsx` plus `named-only.props.tsx` holding `export const variant =
"default"` (the epic-stack shape), (c) `wide.tsx` with more than 32 props plus a valid `wide.120fps.props.tsx`;
`fixtures/declared-absent-style/` with a `package.json` declaring `"style": "./styles.css"` and a build script,
no `styles.css`, one real `src/tokens.css`; `fixtures/uncomposed-bare-alias/` with a bare root export plus
prefixed sibling exports that defeat `findRoot` (radix's dual shape).

- B1/B2 — `test/unit/preset-sibling-shape-is-disclosed.test.ts`: `describePresetSibling` returns
  `no-default-export` for (a) and (b) and `preset` for (c); with (c) present the cap remedy names
  `wide.120fps.props.tsx`; `fixtures/m86/preset-restore.props.tsx` and `fixtures/m44-preset-literal.props.ts`
  still load as presets.
- B3/C1/C2 — `test/unit/remedy-follows-the-applied-preset.test.ts`: `explainProps` over (c) prints no "Add
  …props.tsx" clause; over (a) prints the disclosure once and names `re-export.120fps.props.tsx`; the real-run
  path (`src/analyze.ts:3069`) prints the same strings.
- C3 — `test/unit/init-fixture-scaffolds-or-explains.test.ts`: `fixtures/uncomposed-bare-alias/` with
  `initFixture: true` writes the scaffold and returns the wrote-line; a second call returns the skipped-line;
  without the flag nothing is written.
- A1/A2 — `test/unit/declared-stylesheet-absent-is-named.test.ts`:
  `packageStylesheetCandidates(fixtures/declared-absent-style)` returns `{ declared: ".../styles.css" }`;
  `discoverGlobalCss` names the `package.json` `style` field, the missing path and the build command, emits no
  `CSS_FALLBACK_WARNING`, and does not inject `src/tokens.css`.
  `test/unit/package-declared-stylesheets.test.ts:182-186` is rewritten to expect `{ file }` records and
  `:189-198` ("ignores declarations that name no file on disk") becomes "names a declaration whose file is not
  on disk as `{ declared }`"; the non-stylesheet target (`./src/styles.js`) is still ignored. Every other
  assertion in that file stays byte-identical.

Corpus, commands verbatim from `EVIDENCE.md` (the wrapper is `node
C:/Projekte/120fps-fieldtest/tools/run120.mjs`; `.../` elides `/e/repositories-run5/radix-themes` and
`/e/repositories-run5/logto`), run against a scratch dist built from this worktree:

- radix-themes-F1: `node run120.mjs --cwd .../packages/radix-ui-themes --label explain-button --
  src/components/button.tsx --explain-props` — the cap warning names `button.120fps.props.tsx`, and one line
  names `src/components/button.props.tsx` as "exists, not a preset".
- radix-themes-F2: `node run120.mjs --cwd .../packages/radix-ui-themes --label real-button --
  src/components/button.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas` — the `Stylesheets:`
  line names `package.json` `style: ./styles.css` as declared-but-unbuilt with the package's build command;
  `src/styles/tokens/color.css` is not injected and `css.layer` is no longer `largest-fallback`.
- radix-themes-F3: `node run120.mjs --cwd .../packages/radix-ui-themes --label dialog-init-fixture --
  src/components/dialog.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas --init-fixture` — `wrote
  fixture scaffold …/src/components/dialog.fixture.tsx`, and the file is on disk after the run.
- epic-stack-F3: `created app/components/ui/button.props.tsx with 'export const variant = "default"', then
  run120.mjs --cwd /e/repositories-run5/epic-stack -- app/components/ui/button.tsx --explain-props` — the run
  names that file as "exists, not a preset" and points at `button.120fps.props.tsx`; with `export default {
  variant: "outline" }` it prints `presets:`.
- logto-F4: `created src/ds-components/Button/index.props.tsx with title/type values, then node run120.mjs --cwd
  .../packages/console --label explain-button-preset --timeout 1500 -- src/ds-components/Button/index.tsx
  --explain-props` — `presets: src/ds-components/Button/index.props.tsx` prints and the capped-extraction remedy
  no longer asks for that file.

Lanes A, B and C run their existing `test/unit/` suites; nothing green at 7177203 outside the four files under
"Baseline failures" in `M107-M117-MAP.md` fails.

Control: shadcn-admin button (a run-5 repo that reached a report) prints an unchanged `Stylesheets:` line and
verdict. `tsc --noEmit` clean. Decisive lines pasted here at approval.

### Lane B evidence

Tests: `node node_modules/vitest/vitest.mjs run test/unit/preset-sibling-shape-is-disclosed.test.ts
--maxWorkers=2` -> `Test Files  1 passed (1)`, `Tests  15 passed (15)`. The lane's existing suites
(40 `test/unit/*.test.ts` files that import `prop-gen`/`prop-presets`, two batches of 20,
`--maxWorkers=2`): `Tests  2 failed | 170 passed (172)` and `Tests  18 failed | 380 passed (398)`;
the 20 failures are the two baseline files (`prop-default-disclosure.test.ts`,
`vue-dual-block-props.test.ts`) named under "Baseline failures" in `M107-M117-MAP.md`.

`node node_modules/typescript/bin/tsc --noEmit`: clean.

Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/B-M112/dist/cli.js` built from this
worktree (`build-scratch.sh B-M112`, tree at `ddc79f5` plus the three lanes' uncommitted work):

- radix-themes-F1 (`--cwd .../packages/radix-ui-themes -- src/components/button.tsx
  --explain-props`, label `M112-radix-themes-after`). Before (`logs/radix-themes/explain-button.log`):
  `Add button.props.tsx to choose the props that matter.` and 8x
  `Add button.props.tsx to choose a different branch.`, next to a real
  `src/components/button.props.tsx`. After:
  `Warning: 247 props were extracted from E:\repositories-run5\radix-themes\packages\radix-ui-themes\src\components\button.tsx; measuring the first 32. Add button.120fps.props.tsx to choose the props that matter.`
  and 8x `Add button.120fps.props.tsx to choose a different branch.` Closed for the lane B half (no
  remedy names an existing file); the "exists, not a preset" disclosure line is C2, not landed yet.
- epic-stack-F3 (`app/components/ui/button.props.tsx` recreated with
  `export const variant = "default";`, then `--cwd /e/repositories-run5/epic-stack --
  app/components/ui/button.tsx --explain-props`, label `M112-epic-stack-after`; the file was removed
  again afterwards). Before (`logs/epic-stack/ep1-button.log`):
  `Add button.props.tsx to choose the props that matter.` After:
  `Warning: 240 props were extracted from E:\repositories-run5\epic-stack\app\components\ui\button.tsx; measuring the first 32. Add button.120fps.props.tsx to choose the props that matter.`
  Closed for the lane B half; the disclosure line is C2.
- logto-F4 (`src/ds-components/Button/index.props.tsx` recreated with a default-exported
  `title`/`type` object, then `--cwd .../packages/console -- src/ds-components/Button/index.tsx
  --explain-props`, label `M112-logto-after`; the file was removed again afterwards). Before
  (`logs/logto/explain-button-preset.log`): `Add index.props.tsx to choose the props that matter.`
  beside `presets:  src/ds-components/Button/index.props.tsx`. After:
  `Warning: 319 props were extracted from E:\repositories-run5\logto\packages\console\src\ds-components\Button\index.tsx; measuring the first 32. Add index.props.tsx to choose the props that matter.`
  with `title  unknown  optional  "Sign in", "Sign out"` measured from the preset. Not closed: the
  remedy is re-rendered after the preset is applied by C1, which consumes lane B's
  `PropsExtraction.warningRecords` (I7). The remedy correctly names the preset that is on disk.
- Control shadcn-admin (`-- src/components/ui/button.tsx --explain-props`, label
  `M112-shadcn-admin-after`): reaches the same report, and with no preset-named sibling on disk the
  text is unchanged character for character:
  `Warning: 240 props were extracted from E:\repositories-run5\shadcn-admin\src\components\ui\button.tsx; measuring the first 32. Add button.props.tsx to choose the props that matter.`

#### Lane B follow-up: the cap warning goes through the record sink

`warnPropCap` (`src/prop-gen.ts:1393`) wrote its text with `warnOnce` straight to `process.stderr`
and took no sink parameter, unlike `warnCollapsedUnion` and `warnDegenerateProps`, so `analyze.ts`
could neither withhold nor re-render the cap remedy after a preset loaded (B3 / C1, logto-F4). It
now takes the same `sink` parameter in the same position and emits through `emit`, so the text
reaches `PropsExtraction.warnings` whenever a caller passes `onWarning` and still prints once to
stderr, character for character, when no sink is passed.

Tests: `node node_modules/vitest/vitest.mjs run test/unit/preset-sibling-shape-is-disclosed.test.ts
--maxWorkers=2` -> `Test Files  1 passed (1)`, `Tests  18 passed (18)`. The lane's existing suites
(71 `test/unit/*.test.ts` files that import `prop-gen`/`prop-presets`, two batches):
`Test Files  36 passed (36)`, `Tests  488 passed (488)` and `Test Files  35 passed (35)`,
`Tests  490 passed (490)`. Whole `test/unit` suite: `Test Files  313 passed (313)`,
`Tests  4640 passed | 1 skipped (4641)`.

`node node_modules/typescript/bin/tsc --noEmit`: clean.

Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/B-M112/dist/cli.js` built from this
worktree at `27c0015` plus this change:

- logto-F4 (`--cwd .../packages/console -- src/ds-components/Button/index.tsx --explain-props`,
  label `M112-logto-after`; the preset file was recreated with a default-exported `title`/`type`
  object and removed again afterwards). Before (`logs/logto/explain-button-preset.log`):
  `Add index.props.tsx to choose the props that matter.` beside
  `presets:  src/ds-components/Button/index.props.tsx`. After:
  `  Warning: 319 props were extracted from E:\repositories-run5\logto\packages\console\src\ds-components\Button\index.tsx; measuring the first 32. The applied preset src/ds-components/Button/index.props.tsx is already loaded; extend it to choose the props that matter.`
  beside `  presets:  src/ds-components/Button/index.props.tsx`. Closed.
- radix-themes-F1 (`--cwd .../packages/radix-ui-themes -- src/components/button.tsx
  --explain-props`, label `M112-radix-themes-after`). After:
  `  Warning: 247 props were extracted from E:\repositories-run5\radix-themes\packages\radix-ui-themes\src\components\button.tsx; measuring the first 32. Add button.120fps.props.tsx to choose the props that matter.`
  and, once, `  src/components/button.props.tsx exists, not a preset: no default-exported object literal (expected ...)`. Closed.
- epic-stack-F3 (`app/components/ui/button.props.tsx` recreated with
  `export const variant = "default";`, removed again afterwards; `--cwd /e/repositories-run5/epic-stack
  -- app/components/ui/button.tsx --explain-props`, label `M112-epic-stack-after`). After:
  `  Warning: 240 props were extracted from E:\repositories-run5\epic-stack\app\components\ui\button.tsx; measuring the first 32. Add button.120fps.props.tsx to choose the props that matter.`
  and `  app/components/ui/button.props.tsx exists, not a preset: no default-exported object literal (expected ...)`. Closed.
- Control shadcn-admin (`-- src/components/ui/button.tsx --explain-props`, label
  `M112-shadcn-admin-after`): reaches the same report; the cap sentence is unchanged word for word; it now
  prints in the run's warning block (two-space indent, stdout) instead of on stderr — the channel move B3 and
  C1 parity require:
  `  Warning: 240 props were extracted from E:\repositories-run5\shadcn-admin\src\components\ui\button.tsx; measuring the first 32. Add button.props.tsx to choose the props that matter.`

##### The real measurement path moves onto the warning channel too

The four runs above are `--explain-props`. The real path passes an `onWarning` to
`extractPropsDetailed` (`src/analyze.ts:3727`), so on every real run over a component with more than
32 props the cap sentence now travels sink -> `runWarnings` -> `report.warnings`
(`src/analyze.ts:3850`) into the terminal warning block, the report JSON `warnings` array and the
markdown report, no longer to stderr. Verdicts, exit codes and numbers are unchanged. Two real runs
against the scratch dist confirm it, both `exit=0`:

- Control shadcn-admin (`--cwd /e/repositories-run5/shadcn-admin -- src/components/ui/button.tsx
  --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`, label `M112-B-shadcn-admin-real`,
  `exit=0`, digest `pass=true noise=hostile`, `warnings=6`). Warning block:
  `⚠ Warning: 240 props were extracted from E:\repositories-run5\shadcn-admin\src\components\ui\button.tsx; measuring the first 32. Add button.props.tsx to choose the props that matter.`
  and the same sentence, with no trailing newline, in the report JSON `warnings` array:
  `"Warning: 240 props were extracted from E:\repositories-run5\shadcn-admin\src\components\ui\button.tsx; measuring the first 32. Add button.props.tsx to choose the props that matter."`
- radix-themes-F2 (`--cwd .../packages/radix-ui-themes -- src/components/button.tsx --samples 5
  --max-combos 4 --explore-budget 60 --no-deltas`, label `M112-B-radix-themes-real`, `exit=0`,
  digest `css layer=none files=0`, `warnings=14`). The Stylesheets line is lane A's landed text,
  unchanged by this lane:
  `Stylesheets: none injected - package.json "style" declares styles.css, which is not built yet; run `pnpm run build` in that package, then re-run`
  and the cap sentence prints in the same warning block:
  `⚠ Warning: 247 props were extracted from E:\repositories-run5\radix-themes\packages\radix-ui-themes\src\components\button.tsx; measuring the first 32. Add button.120fps.props.tsx to choose the props that matter.`

Tests after the trim and the two real runs: `node node_modules/vitest/vitest.mjs run
test/unit/preset-sibling-shape-is-disclosed.test.ts --maxWorkers=2` -> `Test Files  1 passed (1)`,
`Tests  18 passed (18)`; whole `test/unit` suite (`--maxWorkers=2`): `Test Files  315 passed (315)`,
`Tests  4667 passed | 1 skipped (4668)`. `node node_modules/typescript/bin/tsc --noEmit`: clean.

The sink hands `options.onWarning` the trimmed line (`src/prop-gen.ts:290`), so the entry
`src/report.ts:1365` renders carries no trailing newline and prints no stray blank line; the JSON
string above is the evidence, and `test/unit/preset-sibling-shape-is-disclosed.test.ts` asserts it
at the sink.

### Lane C evidence

Tests: `node node_modules/vitest/vitest.mjs run test/unit/remedy-follows-the-applied-preset.test.ts
test/unit/init-fixture-scaffolds-or-explains.test.ts
test/unit/stylesheet-disclosure-completeness.test.ts --maxWorkers=2` -> `Test Files  3 passed (3)`,
`Tests  26 passed (26)`. Full `test/unit` suite (`--maxWorkers=2`), after this lane's commit:
`Test Files  308 passed (308)`, `Tests  4578 passed | 1 skipped (4579)` — the four "Baseline
failures" files included, all four now green (lanes A and B fixed them under M108 and M114).

`node node_modules/typescript/bin/tsc --noEmit`: clean.

Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/C-M112/dist/cli.js`
(`build-scratch.sh C-M112`, tree at `4be73af` plus the lanes' uncommitted work):

- radix-themes-F1 / C2 (`--cwd .../packages/radix-ui-themes -- src/components/button.tsx
  --explain-props`, label `M112-radix-themes-after`). Before
  (`logs/radix-themes/explain-button.log:1`): `Add button.props.tsx to choose the props that
  matter.` next to a real `src/components/button.props.tsx`, dropped in silence. After:
  "  src/components/button.props.tsx exists, not a preset: no default-exported object literal
  (expected `export default { prop: [values] }`)", beside `Add button.120fps.props.tsx to choose the
  props that matter.` Closed.
- epic-stack-F3 / C2 (`app/components/ui/button.props.tsx` recreated with
  `export const variant = "default";`, then `--cwd /e/repositories-run5/epic-stack --
  app/components/ui/button.tsx --explain-props`, label `M112-epic-stack-after`; the file was removed
  again afterwards). Before (`logs/epic-stack/ep1-button.log`): `Add button.props.tsx to choose the
  props that matter.`, and no word about the sibling. After:
  "  app/components/ui/button.props.tsx exists, not a preset: no default-exported object literal
  (expected `export default { prop: [values] }`)", beside `Add button.120fps.props.tsx to choose the
  props that matter.` Closed.
- radix-themes-F3 / C3 (`--cwd .../packages/radix-ui-themes -- src/components/dialog.tsx --samples 5
  --max-combos 4 --explore-budget 60 --no-deltas --init-fixture`, label
  `M112-radix-dialog-init-fixture-after`). Before (`logs/radix-themes/dialog-init-fixture.log:57`):
  the uncomposed disclosure printed and the flag wrote nothing at all. After:
  `wrote fixture scaffold E:\repositories-run5\radix-themes\packages\radix-ui-themes\src\components\dialog.fixture.tsx; edit it to render the real composition, then re-run`
  on its own line and again inside the run's warning block, beside
  `W Root declares sibling parts (Trigger, Content, Title, Description, Close) recognized by
  auto-composition, but none were composed in`; the file was on disk after the run (956 bytes,
  removed again to leave the corpus clean). `exit=0`, verdict unchanged. Closed.
- logto-F4 / C1 (`src/ds-components/Button/index.props.tsx` recreated with a default-exported
  `title`/`type` object, then `--cwd .../packages/console -- src/ds-components/Button/index.tsx
  --explain-props`, label `M112-logto-after`; the file was removed again afterwards). Before
  (`logs/logto/explain-button-preset.log:6`): `Add index.props.tsx to choose the props that matter.`
  beside `presets:  src/ds-components/Button/index.props.tsx`. After, unchanged:
  `Warning: 319 props were extracted from ...\index.tsx; measuring the first 32. Add index.props.tsx to choose the props that matter.`
  with `  presets:  src/ds-components/Button/index.props.tsx` and
  `  title              unknown    optional             "Sign in", "Sign out"` measured from the
  preset. Not closed; see "Open against I7" below.
- Control shadcn-admin (`-- src/components/ui/button.tsx --explain-props`, label
  `M112-shadcn-admin-after`): `exit=0`, same report, and with no preset-named sibling on disk the
  text is unchanged character for character:
  `Warning: 240 props were extracted from E:\repositories-run5\shadcn-admin\src\components\ui\button.tsx; measuring the first 32. Add button.props.tsx to choose the props that matter.`

Open against I7 (producer lane B, `src/prop-gen.ts`). `warnPropCap` records the cap warning and then
writes it through `warnOnce`, straight to `process.stderr`; it takes no `sink` parameter, unlike
`warnCollapsedUnion` and `warnDegenerateProps`. A consumer in `src/analyze.ts` therefore cannot
withhold the stale capped-extraction remedy on a run that loaded a preset: by the time
`extractPropsDetailed` returns, the line is already on the terminal. Re-rendering it into the run's
`warnings` channel would print two contradictory remedies for one subject, which is the defect M112
exists to remove, so lane C does neither. Closing logto-F4 needs one lane B change: route
`warnPropCap` through `emit(key, text, sink)` as its two neighbours already do. The collapsed-union
half of C1 is implemented and needs nothing (`remediesAfterPreset`, `src/analyze.ts`), because those
warnings do reach the sink.

Open against I5 (producer lane A, `src/harness.ts`). The `discoverGlobalCss` result carries no
`declaredMissing` yet, so `buildCssReport` reads the member structurally and the field is absent on
every run today; radix-themes-F2's `Stylesheets:` line is still `src/styles/tokens/color.css
(largest-stylesheet fallback, low confidence - verify with --css)`. C4's consumer half is in place
and unit-tested: `CssReport.declaredMissing`, the `none` branch of `formatStylesheetsLine`, and the
projectRoot-relative posix normalisation in `buildCssReport`. The `Stylesheets:` line names the missing paths;
A1's own warning carries the field and the command.

#### Lane C follow-up: the declared-missing line and the cap remedy after a preset

Both halves the lane left open are closed by their producers landing, and both seams now carry a
test of their own. I5: lane A's `M112 (lane A): review fix-ups` (`a56003f`) forwards
`declaredMissing` through `resolveCssFiles`, so `buildCssReport` reads a real record and the
`Stylesheets:` line names the declaration instead of "none found". I7: lane B's `M112 (lane B): cap
warning goes through the record sink` (`c8f39a9`) routes `warnPropCap` through the sink, so the cap
remedy reaches `PropsExtraction.warnings` and `remediesAfterPreset` re-renders it after the preset
is applied.

Tests added here: `test/unit/stylesheet-disclosure-completeness.test.ts` gains "a
declared-but-unbuilt stylesheet from discovery to the printed line" (three cases, the fixture
`fixtures/declared-absent-style/` through `resolveCssFiles` then `buildCssReport` then
`formatStylesheetsLine`, no cast literal anywhere on the path);
`test/unit/remedy-follows-the-applied-preset.test.ts` gains "the capped-extraction remedy in a run
that applied a preset" (three cases over `fixtures/preset-collision/wide.tsx` and the new control
`fixtures/preset-collision/wide-uncovered.tsx`, a capped component with no preset-named sibling).
Both seams fail when removed: with the `declaredMissing` forward deleted from `resolveCssFiles` and
the `remedyNamesLoadedPreset` map deleted from `remediesAfterPreset`,
`Tests  4 failed | 30 passed (34)`, the first being `AssertionError: expected 'Warning: 43 props
were extracted from...' to contain 'The applied preset fixtures/preset-co...'`.

Tests: `node node_modules/vitest/vitest.mjs run test/unit/remedy-follows-the-applied-preset.test.ts
test/unit/stylesheet-disclosure-completeness.test.ts
test/unit/init-fixture-scaffolds-or-explains.test.ts --maxWorkers=2` -> `Test Files  3 passed (3)`,
`Tests  43 passed (43)`. Whole `test/unit`
(`--maxWorkers=2`): `Test Files  4 failed | 314 passed (318)`, `Tests  18 failed | 4678 passed |
1 skipped (4697)`. The four are lanes A and B's in-flight work in the same worktree
(`console-format-substitution.test.ts`, `runtime-style-engine-detection.test.ts`,
`vite-config-workspace-root.test.ts`, `vite-root-entry-discovery.test.ts`, all against uncommitted
`src/harness.ts` and `src/page-errors.ts`); this lane changed no source file, so none of them can
follow from it. The four "Baseline failures" files are green.

`node node_modules/typescript/bin/tsc --noEmit`: clean.

Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/C-M112/dist/cli.js` (`build-scratch.sh
C-M112`, tree at `bdd8261` plus the lanes' uncommitted work):

- radix-themes-F2 / C4 (`--cwd .../packages/radix-ui-themes -- src/components/button.tsx --samples 5
  --max-combos 4 --explore-budget 60 --no-deltas`, label `M112-radix-themes-after`). Before
  (`logs/radix-themes/real-button.log:17`):
  `Stylesheets: src/styles/tokens/color.css (largest-stylesheet fallback, low confidence — verify with --css)`
  After (`logs/radix-themes/M112-radix-themes-after.log`):
  `Stylesheets: none injected — package.json "style" declares styles.css, which is not built yet; run `pnpm run build` in that package, then re-run`
  Digest `css layer=none files=0`, `exit=0`, `Result: PASS`, verdicts unchanged. Closed.
- logto-F4 / C1 (`src/ds-components/Button/index.props.tsx` recreated with a default-exported
  `title`/`type` object, then `--cwd .../packages/console -- src/ds-components/Button/index.tsx
  --explain-props`, label `M112-logto-after`; the file was removed again afterwards). Before
  (`logs/logto/explain-button-preset.log:6`): `Add index.props.tsx to choose the props that matter.`
  beside `presets:  src/ds-components/Button/index.props.tsx`. After
  (`logs/logto/M112-logto-after.log:67`):
  `  Warning: 319 props were extracted from E:\repositories-run5\logto\packages\console\src\ds-components\Button\index.tsx; measuring the first 32. The applied preset src/ds-components/Button/index.props.tsx is already loaded; extend it to choose the props that matter.`
  beside `  presets:  src/ds-components/Button/index.props.tsx` (`:6`). `exit=0`. Closed.
- Control shadcn-admin (`-- src/components/ui/button.tsx --explain-props`, label
  `M112-C-shadcn-admin-after`): `exit=0`, same report, and both lines are unchanged character for
  character: `Stylesheets: src/styles/index.css (found in the project entry's own imports)` and
  `Warning: 240 props were extracted from E:\repositories-run5\shadcn-admin\src\components\ui\button.tsx; measuring the first 32. Add button.props.tsx to choose the props that matter.`

### Lane A evidence

Tests: `node node_modules/vitest/vitest.mjs run test/unit/declared-stylesheet-absent-is-named.test.ts
test/unit/package-declared-stylesheets.test.ts --maxWorkers=2` -> `Test Files  2 passed (2)`,
`Tests  37 passed (37)`. Full `test/unit` suite (`--maxWorkers=2`) after this lane's change:
`Test Files  312 passed (312)`, `Tests  4630 passed | 1 skipped (4631)` — the four "Baseline
failures" files included, all four green.

`node node_modules/typescript/bin/tsc --noEmit`: clean.

Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/A-M112/dist/cli.js` (`build-scratch.sh
A-M112`, tree at `88a1d61` plus this lane's uncommitted work):

- radix-themes-F2 / A1, A2 (`--cwd .../packages/radix-ui-themes -- src/components/button.tsx
  --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`, label `M112-radix-themes-after`).
  Before (`logs/radix-themes/real-button.log:17,113`):
  `Stylesheets: src/styles/tokens/color.css (largest-stylesheet fallback, low confidence — verify with --css)`
  and
  `⚠ no entry stylesheet import and no conventional global stylesheet were found, so src/styles/tokens/color.css was injected because it is the largest stylesheet found under this project; ...`
  After (`logs/radix-themes/M112-radix-themes-after.log:114`, digest `css layer=none files=0`):
  `⚠ this package's package.json "style" declares styles.css, which is not on disk yet — most likely because a build this harness never runs produces it. No stylesheet was injected and the component is measured unstyled; run `pnpm run build` in this package, then re-run, or pass --css to name a stylesheet that exists.`
  The fallback sheet is gone (`css layer=none`, `files=0`, no `CSS_FALLBACK_WARNING`), `exit=0` and the
  verdicts are unchanged. Closed for A1 and for A2's fallback half.
  Not closed at that commit: line 17 read
  `Stylesheets: none found (checked the project entry, conventional filenames, and the largest stylesheet under the project)`
  — closed by the review fix-ups below.
- Control shadcn-admin (`-- src/components/ui/button.tsx --explain-props`, label
  `M112-A-shadcn-admin-after`): `exit=0`, same report, and the stylesheet line is unchanged:
  `Stylesheets: src/styles/index.css (found in the project entry's own imports)`.

#### Lane A review fix-ups

Reviewer findings: A2's report half was unmet end to end (`discoverGlobalCss` returned
`declaredMissing` and `resolveCssFiles` dropped it); no test crossed
`resolveCssFiles`/`discoverGlobalCss` for that record; the new early return sat ahead of the runtime
CSS-in-JS layer, so a declared-missing sheet hid a runtime engine; I5's landed shape (the rich
record plus `CssReport.declaredMissingFields`) deviated from the map text; A1's wording was
unconditional while the code fires only where no stylesheet was injected.

Changed: `src/harness.ts` asks `detectRuntimeStyleEngines` at the declared-but-unbuilt return and
carries `runtimeEngines` on it, and `CSS_DECLARED_UNBUILT_WARNING` names those engines in place of
the measured-unstyled clause when they are present; `src/analyze.ts` forwards `declaredMissing`
through `resolveCssFiles` (I5's two-line plumbing); the map's I5 entry, I5 above and A1's wording
describe the landed shape.

Tests: `node node_modules/vitest/vitest.mjs run test/unit/declared-stylesheet-absent-is-named.test.ts
test/unit/package-declared-stylesheets.test.ts --maxWorkers=2` -> `Test Files  2 passed (2)`,
`Tests  40 passed (40)`. With the `src/analyze.ts` forward removed, the new seam test fails with
`AssertionError: expected undefined to deeply equal [ { field: 'style', …(2) } ]`. The 40
`test/unit/*.test.ts` files naming `harness` (the 15 CSS-related ones first):
`Test Files  40 passed (40)`, `Tests  758 passed (758)`; `bundler-error-presentation.test.ts`, a
"Baseline failures" file, is among them and green.

`node node_modules/typescript/bin/tsc --noEmit`: clean.

Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/A-M112/dist/cli.js` (`build-scratch.sh
A-M112`, tree at `9fa3b7e` plus the lanes' uncommitted work):

- radix-themes-F2 / A2's report half (`--cwd .../packages/radix-ui-themes --
  src/components/button.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`, label
  `M112-radix-themes-after`). Before (`logs/radix-themes/real-button.log:17`):
  `Stylesheets: src/styles/tokens/color.css (largest-stylesheet fallback, low confidence — verify with --css)`
  After (`logs/radix-themes/M112-radix-themes-after.log:17`):
  `Stylesheets: none injected — package.json "style" declares styles.css, which is not built yet; run `pnpm run build` in that package, then re-run`
  Digest `css layer=none files=0`, `exit=0`, `Result: PASS`, verdicts unchanged. Closed.
- Control shadcn-admin (`-- src/components/ui/button.tsx --explain-props`, label
  `M112-A-shadcn-admin-fixup-after`): `exit=0`, same report, stylesheet line unchanged:
  `Stylesheets: src/styles/index.css (found in the project entry's own imports)`.

## Deferred

- Lifting the prop cap for a preset: `verify/epic-stack.md:88-92` shows the cap is correct as it stands (M86
  promotes preset-named props into Tier 0; `variant` and `size` were inside the 32).
- vuetify-F1's false "this package has no application entry" clause inside the same `CSS_FALLBACK_WARNING`
  sentence: M114 (G8) owns that rewrite.
- Dry-run and real-run parity for transforms and composition inside `explainProps`: M110 (G4).
- Migrating `<stem>.props.tsx` presets to the new name: both names keep working, nothing renames.
- radix-themes-F4 and logto-F2: overturned as by-design in verification.
- The overview line `specs/overview/00-tdd.md:529` scopes `--init-fixture` to the rollback path, while
  `m80-composition-disclosure.md:325-334` points the never-composed radix shape at the flag. C3 resolves that
  conflict in favour of M80; the overview sentence is the coordinator's edit. The same coordinator edit covers
  the preset name: `specs/overview/00-tdd.md:38`, `:675`, `:893` and `specs/overview/01-glossary.md:76` say
  `<stem>.props.tsx|ts`, and gain `<stem>.120fps.props.tsx|ts` as the preferred name with the older one still
  loading.

## Approval

Approved 2026-09-03. Commits: `cf0ec3e`, `9918ee2`, `3b492ef` (lane C first wave), `9fa3b7e`,
`a56003f` (lane A + review fix-ups), `c8f39a9`, `bdd8261` (lane B cap sink + fix-ups), `0174e7e`,
`536102b` (lane C follow-up + fix-ups).

Re-run at approval: `node node_modules/vitest/vitest.mjs run
test/unit/preset-sibling-shape-is-disclosed.test.ts test/unit/remedy-follows-the-applied-preset.test.ts
test/unit/init-fixture-scaffolds-or-explains.test.ts test/unit/stylesheet-disclosure-completeness.test.ts
test/unit/declared-stylesheet-absent-is-named.test.ts test/unit/package-declared-stylesheets.test.ts
--maxWorkers=2` -> `Test Files  6 passed (6)`, `Tests  103 passed (103)`.
`test/unit/prop-cap-preset-exempt.test.ts` (the MUST NOT's named guard): `Tests  3 passed (3)`.

- Lane B (`src/prop-presets.ts`, `src/prop-gen.ts`) — B1, B2, B3.
  `preset-sibling-shape-is-disclosed.test.ts` 18 passed; `tsc --noEmit` clean. Corpus: radix-themes-F1
  and epic-stack-F3 name `<stem>.120fps.props.tsx`, logto-F4 names the loaded preset, control
  shadcn-admin's sentence is unchanged word for word on the warning channel.
- Lane C (`src/analyze.ts`, `src/composition.ts`, `src/report.ts`) — C1, C2, C3, C4.
  `remedy-follows-the-applied-preset.test.ts` + `init-fixture-scaffolds-or-explains.test.ts` +
  `stylesheet-disclosure-completeness.test.ts` 43 passed; `tsc --noEmit` clean. Corpus:
  radix-themes-F1/F2 disclosure and `Stylesheets:` line closed, radix-themes-F3 wrote the dialog
  scaffold (`exit=0`, verdict unchanged), logto-F4 closed, control unchanged.
- Lane A (`src/harness.ts`) — A1, A2. `declared-stylesheet-absent-is-named.test.ts` +
  `package-declared-stylesheets.test.ts` 40 passed; `tsc --noEmit` clean. Corpus: radix-themes-F2
  reports `css layer=none files=0`, no `CSS_FALLBACK_WARNING`, build command named; control's
  stylesheet line unchanged.

### Deferred / open

- Lifting the prop cap for a preset: M86's Tier 0 promotion stands, nothing changes.
- vuetify-F1's false "this package has no application entry" clause: M114 (G8) owns it. The vuetify
  row's expected line is now the M112 declared-but-unbuilt outcome observed in
  `C:/Projekte/120fps-fieldtest/retest/hoppscotch-vitesse-vuetify.md`.
- Dry-run and real-run parity for transforms and composition inside `explainProps`: M110 (G4).
- Migrating `<stem>.props.tsx` presets to the new name: both names keep working, nothing renames.
- radix-themes-F4 and logto-F2: overturned as by-design in verification.
- The `--init-fixture` scope conflict (`specs/overview/00-tdd.md:529`) and the preset-name updates in
  `00-tdd.md:38,:675,:893` and `01-glossary.md:76`: coordinator edits, outside this spec's commit.
- B1's "an earlier shapeless candidate does not stop the search" branch is implemented
  (`src/prop-presets.ts:58-70`) and covered indirectly (the legacy `<stem>.props.tsx` fallback), with
  no fixture pairing a shapeless `.120fps.props.tsx` against a valid `.props.tsx`.
