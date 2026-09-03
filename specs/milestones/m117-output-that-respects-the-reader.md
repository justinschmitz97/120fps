---
kind: milestone
status: draft
tests:
  # Lane C
  - test/unit/warnings-print-once-per-run.test.ts
  - test/unit/vite-plugin-note-names-what-it-dropped.test.ts
  - test/unit/noise-warning-is-one-terminal-line.test.ts
  # Lane A
  - test/unit/gitignore-tip-follows-the-written-path.test.ts
  # Lane A landed vite-plugin-note-names-what-it-dropped.test.ts with A3's half; lane C extends it.
---

# M117: Output that respects the reader

Lanes C (`src/analyze.ts`, `src/report.ts`, `src/ci-report.ts`) and A (`src/cli.ts`, `src/harness.ts`); new work from
the run-5 DX audit, closing no EVIDENCE.md finding id.

## Purpose

A reader of one run's output sees each fact once, stated at the length it is worth. Today a run that rebuilds its
harness prints the same static warning twice; the vite-config note names a config key, not the plugins it dropped; the
noise line spends four sentences on a machine fact and names no flag; the `.gitignore` tip fires for reports written
outside the repository; the markdown report drops the warnings the README promises.

Sources, all run 5 (2026-09-02):

- `C:\Projekte\120fps-fieldtest\remediation\dx-audit.md:17` (item 6, the repeated boilerplate warning) and `:19` (item
  7, the hostile noise line).
- `C:\Projekte\120fps-fieldtest\logs\shadcn-admin\dialog-real2.log:52` and `:55` — the identical vite-config warning
  twice, bracketing the composition-rollback warning; `:57` the four-sentence hostile line; `:67` the `.gitignore` tip
  for a report at `C:\Projekte\120fps-fieldtest\logs\shadcn-admin\dialog-real2.json`, outside the repository.
- `C:\Projekte\120fps-fieldtest\logs\ark\react-accordion-nomatrix.log:101` (the note names the key `plugins`, never
  `dts` or `react`) and `:120` (the same misplaced tip).
- Two adjacent but distinct vite-config notes (the ignored-keys line and the `css.preprocessorOptions.scss.api` line) in
  12 further logs: 7 under `logs\directus\` (`explain-vbutton:43-44`, `explain-vdialog`, `explain-vselect`,
  `explain-vtable`, `real-vbutton:7-8`, `real-vdialog`, `real-vselect`) and 5 under `logs\regression-twenty\`
  (`twenty1-explain:37-38`, `twenty1-run:104-105`, `twenty3-matrix1`, `twenty3-matrix2`, `twenty3-matrix4`). Their texts
  differ, so C1 leaves both; C3 rewrites only the first.
- `C:\Projekte\120fps-fieldtest\findings\ark.md:105`, `findings\shadcn-admin.md:64` (the note on every invocation
  against the repository).

## Root causes (verified)

Every line number below was checked against `C:\Projekte\120fps-m107\src` (`feat/m107-run5-remediation`).

1. `src/analyze.ts:3401`, `:3505`, `:3544` — three sites run `if (harness.warnings)
   runWarnings.push(...harness.warnings)`. A run that rebuilds its harness (stylesheet dropped at `:3505`, composition
   rolled back at `:3544`) appends the whole static-prebuild warning list a second time, so `report.warnings` holds one
   identical string twice. `dialog-real2.log:52`/`:55` is that duplicate, sitting directly after the rollback warning.
2. `src/report.ts:1123-1127` — `appendWarnings` iterates `report.warnings` verbatim: no equality check, no repeat count.
   The `(×N)` suffix this milestone reuses already exists for page errors at `src/page-errors.ts:69`.
3. `src/harness.ts:1960-1964` — the vite-config reader adds the literal string `"plugins"` to `ignored` when the array
   literal is non-empty and never inspects its elements, so `VITE_CONFIG_IGNORED_WARNING` (`src/harness.ts:1575-1583`)
   names a config key. `src/harness.ts:3242-3245` emits it whenever that key is present, including when every element is
   a plugin whose transform the run applies anyway (`SUPPORTED_TRANSFORM_PLUGINS`, `src/harness.ts:2384-2395`).
4. `src/report.ts:1133-1138` (`enrichNoiseWarning`) calls `formatNoiseWarning` (`src/noise.ts:116-130`), which lists
   both signals at their raw values whether or not either crossed its threshold (`NOISE_CV_PERCENT` 15,
   `HOSTILE_CV_PERCENT` 30, `NOISY_UNSTABLE_FRACTION` 0.25, `HOSTILE_UNSTABLE_FRACTION` 0.5, `src/noise.ts:24-30`),
   names no flag, and runs four sentences long. The JSON gets the opposite: `src/analyze.ts:3246`/`:3248` push the bare
   constant, so the long form exists only in the terminal, where a reader is scanning.
5. `src/cli.ts:1474-1481` — the tip's gate maps each written report path through `path.basename`, so a report written
   outside the repository still counts as written into it; `needsGitignoreAdvisory` (`src/cli.ts:1211-1215`) then asks
   only whether that bare filename is covered by the repository's `.gitignore`. `.120fps-harness-*` is advertised in
   `GITIGNORE_SUGGESTED_PATTERNS` (`src/cli.ts:1156-1164`) and never checked against disk.
6. `src/ci-report.ts:210-297` — `formatMarkdown` builds the verdict line, the component table, two folds and the machine
   footer, never reading `report.warnings`, though `README.md:118` states that warnings reach the markdown output.

## MUST

### Lane C (`src/analyze.ts`, `src/report.ts`, `src/ci-report.ts`)

- C1 A warning whose text is identical to one already recorded for the same component report is recorded once;
  `--explain-props` deduplicates its own list by the same rule. The terminal prints it once; when the run produced it
  more than once, the line ends with the count in the page-error shape, ` (×3)`. The JSON `warnings` array holds one
  entry per distinct text, in first-occurrence order (the noise entry in the full form C6 defines).
- C2 The markdown report (`--report-md`) carries the run's warnings: one `<details>` fold per component that has
  warnings, listing that component's deduped texts with the same `(×N)` suffixes; a run whose components have no
  warnings adds no fold.
- C3 The vite-config note names what the harness dropped: `vite.config.ts declares plugins the harness cannot honor:
  tanstackRouter, react, tailwindcss — the project's Vite config is never executed.` Each declared plugin is named as
  the config writes it (a call expression by its callee, an object literal by its `name` property, anything else as
  `unnamed plugin #<n>`). The note prints once per run, including a run that rebuilt its harness. A config with other
  ignored keys keeps them: the note reads `vite.config.js declares resolve.alias, css.preprocessorOptions and plugins
  the harness cannot honor: sass, vue — the project's Vite config is never executed`, and the `css.preprocessorOptions`
  preprocessor-globals clause (`src/harness.ts:1579-1582`) is printed unchanged.
- C4 The note names no plugin whose transform this run applied: a declared name that is a transform's recognizer code or
  the plugin factory the harness recognizes for it (`vue` for `@vitejs/plugin-vue`, `svgr` for `vite-plugin-svgr`,
  `vanillaExtractPlugin` for `vanilla-extract`) is left out, and the note is omitted when the list empties.
  `--explain-props` decides from the same detection as the real run, so both print the note or both omit it.
- C5 The terminal prints one line for a `noisy` or `hostile` machine, naming only the signals that crossed their
  threshold and the one flag that helps: `machine: hostile (probe CV 53%, 100% of metrics unstable); raise --samples to
  measure through it.` A signal at or below its threshold is not listed.
- C6 The JSON keeps the long form: `noise.level`, all four entries of `noise.signals`, and a `warnings` entry carrying
  the full text — the machine sentence, the provisional-numbers sentence, and the baseline sentence when a baseline
  comparison was applicable to the run. The noise warning is the one text that differs by channel: the JSON entry
  carries the full sentences, the terminal and the markdown fold carry C5's one line.
- C7 The noise line changes no verdict wording: for the same numbers, `Result:`, every combo verdict and every budget
  line read exactly as they do on a quiet run.

### Lane A (`src/cli.ts`, `src/harness.ts`)

- A1 The `.gitignore` tip prints only when at least one path this run wrote or left behind is inside the git root of the
  directory the user ran from and is not covered by that repository's `.gitignore`: a `120fps-report*.json` at its
  resolved absolute path, `120fps-baseline.json` when `--save-baseline` was passed, or a `.120fps-harness-*` entry still
  present at that root. A report written to a path outside the repository prints no tip.
- A2 The tip names only the patterns for the paths that triggered it, and prints once per process, after the last one.
- A3 The names the note prints follow the config's own order: `/e/repositories-run5/ark/packages/react/vite.config.mts`
  (`dts()` then `react()`) yields `dts, react`; an inline object plugin yields its `name` (`hostile-transform`);
  anything else yields `unnamed plugin #<n>`; a config whose `plugins` array is empty or absent produces no note.

## MUST NOT

- Drop a warning the dry run printed: a text printed once by `--explain-props` is printed once by the real run, and the
  M100/M110 parity rule holds unchanged.
- Collapse two warnings whose texts differ by one character; C1's key is the exact string.
- Suppress a warning across invocations, sessions or working directories: "once" is once per run. No
  `--no-warn-vite-plugins`-style acknowledgment flag.
- Change `report.noise`, its thresholds, or any verdict because of C5; write to any file from the tip.

## Interfaces needed

- I10, producer lane A, consumer lane C. `ViteConfigData` carries the declared plugin names A3 records
  (`src/harness.ts:1532-1536`) beside the `ignoredKeys` M114 sets; C3 and C4 read them together with the transforms
  detected for that run (the codes `Report.projectTransforms` also carries, `src/report.ts:525`,
  `src/analyze.ts:3256-3257`), so the dry run reaches the same answer without a Report. The note's text stays in lane
  A's constants, as M108 requires.
- I10 blocking hand-off, landed with A3: A3's wording breaks `VITE_CONFIG_IGNORED_SHAPE` (`src/analyze.ts:4477`), whose
  regex still requires the pre-A3 `, which the harness read but cannot honor: ` clause. Until C3 reads
  `ViteConfigData.pluginNames`, `viteConfigIgnoredKeys` returns undefined for every real run whose vite.config declares
  a non-empty `plugins` array literal, so M114 C3's `vitePluginsNotExecuted` mount-abort hint does not fire on a real
  run. No test is red: `test/unit/mount-abort-hints-name-read-evidence.test.ts:104` builds the warning with the legacy
  two-argument form, a shape no run now produces. The code fix is lane C's. Interim shape if C3 keeps scraping
  warnings: `/^(\S+) declares (.+?) the harness cannot honor: /`; when C3 lands, that test's call becomes
  `VITE_CONFIG_IGNORED_WARNING("vite.config.ts", ["plugins", "resolve.alias"], ["react"])` so it asserts against the
  wording a run prints.
- Nothing else. C5 consumes `NoiseReport.signals` (`src/report.ts:522`) and the four thresholds exported from
  `src/noise.ts:24-30`; nothing in `src/noise.ts` (lane B) changes. A1 reads the repository inside `src/cli.ts`.

Conflicts in `M107-M117-MAP.md`: C9 — M114 lands its `ignoredKeys` and `root` work before A3's plugin names; C11 — C1's
collector lands after every warning producer (M107-M113); C4 — the parity check follows M115, M110 and M112 in
`explainProps`; C12 — the `.gitignore` tip lands last in `src/cli.ts`. M117's lane-A change stays inside
`readViteConfigData`'s plugin handling and `VITE_CONFIG_IGNORED_WARNING`.

## Verification

### Unit

- C1, C2 — `test/unit/warnings-print-once-per-run.test.ts`. Report literals in the shape
  `test/unit/report-informational-warnings.test.ts` uses; no fixture directory. A `warnings` array holding one string
  three times plus two distinct strings: `formatTable` prints three lines, the repeated one ending `(×3)`;
  `formatMarkdown` lists the same three texts in its fold; the collector, given the same string twice, keeps one entry.
- C3, C4, A3 — `test/unit/vite-plugin-note-names-what-it-dropped.test.ts` over the existing
  `fixtures/vite-config-project/`, whose `vite.config.ts` declares one inline object plugin named `hostile-transform`:
  the reported plugin names are `["hostile-transform"]` and the note names it. Add
  `fixtures/vite-config-supported-plugins/` — a package declaring `@vitejs/plugin-vue` and a `vite.config.ts` whose
  `plugins` is `[vue()]` — and assert no note.
- C5, C6, C7 — `test/unit/noise-warning-is-one-terminal-line.test.ts`. Report literals with `noise.signals` at (probeCv
  53, unstableFraction 1), (probeCv 15.4, unstableFraction 0) and (probeCv 5, unstableFraction 0, contextRetries 1): the
  terminal warning is one line, lists only the crossed signals, contains `--samples`; the JSON `warnings` entry still
  carries the full sentences and `noise.signals` all four numbers; the `Result:` line is byte-identical to the same
  report with `noise.level: "quiet"`.
- A1, A2 — `test/unit/gitignore-tip-follows-the-written-path.test.ts`, extending the temp-directory pattern of
  `test/unit/gitignore-advisory.test.ts`: a git root with a report path resolved outside it (no tip), inside it and
  uncovered (tip naming `120fps-report*.json` only), inside it and covered (no tip), and a `.120fps-harness-abc`
  directory present at the root (tip naming `.120fps-harness-*` only).

### Corpus

Run against a scratch dist built from this worktree, per the map's rule, one run at a time.

1. The duplicate (root cause 1); command from `C:\Projekte\120fps-fieldtest\logs\shadcn-admin\dialog-real2.meta.json`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/shadcn-admin --out C:/Projekte/120fps-fieldtest/logs/shadcn-admin --label dialog-real2 --timeout 1500 -- src/components/ui/dialog.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas
```

Before: `grep -c "cannot honor" dialog-real2.log` = 2 (lines 52, 55). After: 1, reading `⚠ vite.config.ts declares
plugins the harness cannot honor: tanstackRouter, react, tailwindcss — the project's Vite config is never executed`
(`/e/repositories-run5/shadcn-admin/vite.config.ts:11-18`). The neighbouring composition-rollback and
uncomposed-siblings warnings stay; `Result: FAIL` at line 28 keeps its wording.

2. The tip (root cause 5); EVIDENCE.md row shadcn-admin-F2 verbatim, its `.../logs` expanded to the absolute path the
   row abbreviates:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/shadcn-admin --out C:/Projekte/120fps-fieldtest/logs/shadcn-admin --label toolbar-remedy --timeout 1500 -- src/components/data-table/toolbar.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas
```

Before: `Tip: 120fps writes report/baseline files into this repo...` at line 57. After: no `Tip:` line, because
`run120.mjs` appends `--json C:/Projekte/120fps-fieldtest/logs/shadcn-admin/toolbar-remedy.json`, outside
`/e/repositories-run5/shadcn-admin`. Every line above the tip is unchanged.

3. The plugin note (root causes 3, 4); EVIDENCE.md row ark-F1 verbatim, its `.../ark` expanded:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/ark/packages/react --out C:/Projekte/120fps-fieldtest/logs/ark --label react-accordion-nomatrix --timeout 1500 -- src/components/accordion/accordion-root.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas
```

`--out C:/Projekte/120fps-fieldtest/logs/ark` and `--timeout 1500` are the wrapper options
`logs/ark/react-accordion-nomatrix.meta.json` records for this label; the CLI args are ark-F1's verbatim. Then the same
component under `--explain-props`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/ark/packages/react --out C:/Projekte/120fps-fieldtest/logs/ark --label react-accordion-explain --timeout 1500 -- src/components/accordion/accordion-root.tsx --explain-props
```

In each of the two invocations the note appears exactly once and names `dts, react`
(`/e/repositories-run5/ark/packages/react/vite.config.mts:16-35`), replacing line 101's `declares plugins`.

4. Unaffected repository; the cwd and args `logs/midday/real-button-v2.meta.json` records (exit 0 in run 5):

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/midday/packages/ui --out C:/Projekte/120fps-fieldtest/logs/midday --label m117-button --timeout 1500 -- src/components/button.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas
```

After: `Result: PASS`, as at `real-button-v2.log:98`.

### Lane A evidence

Lane A only (A1, A2, A3 and I10's producer); C1-C7 are lane C's and land after this.

- Tests: `node node_modules/vitest/vitest.mjs run test/unit/gitignore-tip-follows-the-written-path.test.ts
  test/unit/vite-plugin-note-names-what-it-dropped.test.ts --maxWorkers=2` -> `Test Files  2 passed (2)`,
  `Tests  20 passed (20)`. The 20 files that read the changed regions
  (`grep -ln "VITE_CONFIG\|readViteConfigData\|ignoredKeys\|GITIGNORE\|gitignore\|collectStaticPreBuildWarnings\|viteConfig" test/unit/*.test.ts`):
  `Test Files  20 passed (20)`, `Tests  200 passed (200)` -- `test/unit/bundler-error-presentation.test.ts` included,
  green since M108's fix-up.
- `node node_modules/typescript/bin/tsc --noEmit`: clean, no output.
- A1's positive half (a report written inside the repository prints the tip) is covered by unit assertions on
  `gitignoreTipPatterns` and `formatGitignoreTip`
  (`test/unit/gitignore-tip-follows-the-written-path.test.ts`, `test/unit/gitignore-advisory.test.ts`), not
  end-to-end: the corpus wrapper writes every report outside the repository under test, so corpus run 2 below shows
  only the no-tip case.
- Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/A-M117/dist/cli.js`, one run at a time, `--timeout 1500`.

1. shadcn-admin `src/components/ui/dialog.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`
   (label `M117-shadcn-admin-after`). Before (`logs/shadcn-admin/dialog-real2.log:52`, `:55`):
   `grep -c "cannot honor"` = 2, each reading
   `vite.config.ts declares plugins, which the harness read but cannot honor: the project's Vite config is never executed`.
   After: `grep -c "cannot honor"` = 1, line 36 reading
   `vite.config.ts declares plugins the harness cannot honor: tanstackRouter, react, tailwindcss — the project's Vite config is never executed`.
   `Result: FAIL` keeps its wording (line 34). A3 closed. C1 not decided by this
   run: it rolled back no composition, so the harness rebuilt once and the duplicate site never fired; the dedup
   collector is lane C's.
2. shadcn-admin `src/components/data-table/toolbar.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`
   (label `M117-shadcn-admin-tip-after`). Before (`logs/shadcn-admin/toolbar-remedy.log:57`):
   `Tip: 120fps writes report/baseline files into this repo. Consider adding to .gitignore: 120fps-report*.json, 120fps-baseline.json, .120fps-harness-*`.
   After: `grep -c "^Tip:"` = 0 -- the wrapper writes the report to
   `C:/Projekte/120fps-fieldtest/logs/shadcn-admin/M117-shadcn-admin-tip-after.json`, outside the repository.
   `Result: FAIL [render error]` at line 30 unchanged. A1, A2 closed.
3. ark `src/components/accordion/accordion-root.tsx` (labels `M117-ark-after`, `M117-ark-explain-after`). Before
   (`logs/ark/react-accordion-nomatrix.log:101`):
   `vite.config.mts declares plugins, which the harness read but cannot honor: the project's Vite config is never executed`.
   After, real run line 118 and `--explain-props` line 49, once each:
   `vite.config.mts declares plugins the harness cannot honor: dts, react — the project's Vite config is never executed`
   (`vite.config.mts:16-35`, `dts()` then `react()`). `Result: PASS` at line 114. A3 closed for both channels.
4. midday `packages/ui/src/components/button.tsx` (label `M117-midday-after`): `Result: PASS` at line 98, as at
   `logs/midday/real-button-v2.log:98`. shadcn-admin `src/components/ui/button.tsx --explain-props` (label
   `M117-shadcn-button-explain-after`) still reaches `Dry run: nothing was measured, no report was written.`

### Lane C evidence

Lane C only (C1-C7, consuming I10's `ViteConfigData.pluginNames`), on top of lane A's commits.

- Tests: `node node_modules/vitest/vitest.mjs run test/unit/warnings-print-once-per-run.test.ts
  test/unit/noise-warning-is-one-terminal-line.test.ts
  test/unit/vite-plugin-note-names-what-it-dropped.test.ts --maxWorkers=2` -> `Test Files  3 passed (3)`,
  `Tests  37 passed (37)`. Whole suite (`test/unit`, `--maxWorkers=2`): `Test Files  321 passed (321)`,
  `Tests  4735 passed | 1 skipped (4736)` -- the four MAP baseline failures included, green since lanes A
  and B fixed them. Two assertions moved with C5/C6:
  `test/unit/verdict-report-clarity.test.ts` ("keeps the baseline clause in the JSON text and out of the
  terminal") and `test/unit/verdict-report-clarity-harden.test.ts` H12 now assert the baseline sentence on
  `report.warnings[0]` (the JSON's full text) and its absence from `formatTable`.
- `node node_modules/typescript/bin/tsc --noEmit`: clean, no output.
- Corpus, scratch dist `C:/Projekte/120fps-fieldtest/scratch/C-M117/dist/cli.js`, one run at a time,
  `--timeout 1500`. Labels carry a `-c-` infix so lane A's logs stay readable.

1. shadcn-admin `src/components/ui/dialog.tsx --samples 5 --max-combos 4 --explore-budget 60 --no-deltas`
   (label `M117-c-shadcn-admin-after`). Before (`logs/shadcn-admin/dialog-real2.log:52`, `:55`):
   `grep -c "cannot honor"` = 2, both reading
   `⚠ vite.config.ts declares plugins, which the harness read but cannot honor: the project's Vite config is never executed`.
   After: `grep -c "cannot honor"` = 1, line 36 reading
   `⚠ vite.config.ts declares plugins the harness cannot honor: tanstackRouter, react, tailwindcss — the project's Vite config is never executed`.
   `Result: FAIL` (line 34) keeps its wording. The noise line, before at `dialog-real2.log:57` in four
   sentences, is line 38:
   `⚠ machine: hostile (probe CV 60%); raise --samples to measure through it.` -- 33% of metrics unstable is
   below the hostile threshold, so it is not named. The JSON keeps the long form:
   `machine: hostile (probe CV 60%, 33% of metrics unstable). The machine was too busy to measure against. Budget verdicts still print, but treat every number as provisional.`
   C1, C3, C5, C6, C7 closed.
2. shadcn-admin `src/components/data-table/toolbar.tsx --samples 5 --max-combos 4 --explore-budget 60
   --no-deltas` (label `M117-c-toolbar-after`). Before (`logs/shadcn-admin/toolbar-remedy.log:57`): the tip
   named all three patterns. After, line 57:
   `Tip: 120fps writes report/baseline files into this repo. Consider adding to .gitignore: .120fps-harness-*`
   -- the report path is outside the repository, and the one pattern left is a stale
   `/e/repositories-run5/shadcn-admin/.120fps-harness-CBXUBP/` from run 5, which A1 counts and A2 names
   alone. `Result: FAIL [render error]` (line 30) unchanged; the six `(×N)` page-error replay lines
   (`:41-46`) are byte-identical to the before log, so C1's suffix did not disturb them. A1, A2 hold under
   lane C's collector.
3. ark `src/components/accordion/accordion-root.tsx` (labels `M117-c-ark-after`,
   `M117-c-ark-explain-after`). Before (`logs/ark/react-accordion-nomatrix.log:101`):
   `vite.config.mts declares plugins, which the harness read but cannot honor: ...`. After,
   `grep -c "cannot honor"` = 1 in each channel: real run line 118 and `--explain-props` line 49, both
   reading
   `vite.config.mts declares plugins the harness cannot honor: dts, react — the project's Vite config is never executed`.
   `Result: PASS` at line 114. C3, C4 parity closed; neither `dts` nor `react` is a transform the harness
   applies, so both stay named.
4. midday `packages/ui/src/components/button.tsx` (label `M117-c-midday-after`): `Result: PASS`, exit 0,
   as at `logs/midday/real-button-v2.log:98`. shadcn-admin `src/components/ui/button.tsx --explain-props`
   (label `M117-c-shadcn-button-explain-after`) still reaches
   `Dry run: nothing was measured, no report was written.` with the note printed once (line 50).

C2 is decided by unit assertions only: no corpus command in this milestone passes `--report-md`.
C4's positive half (a note that empties and disappears) is covered by
`fixtures/vite-config-supported-plugins/`, whose only plugin is `vue()` and whose package.json declares
`@vitejs/plugin-vue`; no corpus repository in run 5 declares a plugins array made up entirely of
transforms the harness applies.

## Deferred

- A `--no-warn-vite-plugins` flag or a per-cwd acknowledgment file, `dx-audit.md:17`'s alternative. Suppression across
  invocations hides a true statement about what the run measured, and M100/M110 parity requires the dry run and the real
  run to print the same set.
- Downgrading noise-tagged FAILs to WARN before a verdict prints, `dx-audit.md:19`'s own improvement candidate. That
  changes a verdict, which C7 forbids; the three overturned run-5 findings (fluentui-F1, supabase-F1, twenty-R1) record
  correct tool behaviour on a contended machine.
- Warnings in the JUnit output, which `README.md:118` also claims and `formatJUnit` (`src/ci-report.ts:358-382`) does
  not carry: a JUnit `failure` body describes a failing testcase, and a passing component has no element to attach a
  warning to. That README line is the coordinator's.
- Wall-clock and phase-breakdown lines, which M115 owns.
