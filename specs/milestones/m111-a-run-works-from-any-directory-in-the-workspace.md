---
kind: milestone
status: draft
tests:
  - test/unit/tailwind-config-resolves-from-the-member-root.test.ts
  - test/unit/run-prints-the-roots-it-resolved.test.ts
  - test/unit/remedy-commands-name-the-directory-to-run-in.test.ts
---

# M111: A run works from any directory in the workspace

Lane A (`src/harness.ts`, `src/cli.ts`, `src/project-model.ts`). Wave 1, after M109 and before M113
in lane A's sequence (`specs/milestones/M107-M117-MAP.md`, "Ordering").

## Purpose

A developer measures a component in a workspace member from wherever the shell happens to be: the
repository root, the member directory, a sibling app. Today the shell directory decides whether the
CSS builds at all. midday's `packages/ui/src/components/button.tsx` reached calibration from
`packages/ui` and crashed with exit 2 from the repository root, because Tailwind 3 read its own
config from `process.cwd()`. After this milestone the two runs produce the same stylesheet decision,
the same warnings and the same verdict, both name the member root and the workspace root they
resolved, and any remedy they print is a command the user can paste in the directory they are in.

Closes: midday-F1 (blocker, crash).

Evidence: `C:\Projekte\120fps-fieldtest\EVIDENCE.md:61` (row), `verify\midday.md:14-52` (root cause,
falsifying evidence, fix direction), `verify\midday.md:6-13` (the swallowed-flag note that governs
how the recorded command replays), `remediation\cluster-briefs.md:116-135` (G5),
`logs\midday\explain-button.log:7-30` (the crash), `logs\midday\compiler-check.log:6,10,13` (the same
component building fine from a directory that has a Tailwind config).

## Root causes (verified)

1. Tailwind 3 resolves its config from the process directory. midday's `packages/ui/postcss.config.js`
   declares `tailwindcss`; Vite loads that PostCSS config from the Vite root
   (`src/harness.ts:3528-3529` passes `root: projectRoot`), and the plugin then calls
   `resolveDefaultConfigPath`
   (`/e/repositories-run5/midday/node_modules/tailwindcss/lib/util/resolveConfigPath.js:63-71`,
   tailwindcss 3.4.19), which resolves against `process.cwd()`. From the monorepo root, which carries
   no `tailwind.config.*`, the plugin fell back to the default config: empty `content`, no `border`
   theme extension. `@apply border-border` in `packages/ui/src/globals.css:1` threw inside PostCSS,
   Vite answered 500, the harness never became ready, exit 2 (`verify/midday.md:28-40`).
2. The harness computes a Tailwind decision for version 4 alone. `detectTailwindVite`
   (`src/harness.ts:1389`) probes `@tailwindcss/vite`, and `resolveStyleTooling` (`:1496`) records
   `tailwind` from that probe. No Tailwind 3 config path is computed anywhere, so the server options
   at `src/harness.ts:3547-3558` carry `css.postcss` and `css.preprocessorOptions` only. (The map
   cites this gate as `:1358-1400`; `:1358` is `RUNTIME_STYLE_ENGINES`, and the gate M111 changes is
   `:1389`, `:1473` and `:1496`.)
3. `findPostcssConfigAbove` (`src/harness.ts:1473`) returns `undefined` as soon as the member has its
   own PostCSS config. midday's member has one, so the harness passed nothing and the plugin's own
   directory search decided (`verify/midday.md:36-40`).
4. No line states which roots a run resolved. `resolveProjectModel` (`src/project-model.ts:62`) and
   `resolveProjectPaths` (`src/analyze.ts:3993`) compute member root and workspace root;
   `formatExplainProps` (`src/analyze.ts:2601-2614`) prints the component file, the binding and the
   exports; the CLI writes that block at `src/cli.ts:1320` and the report table at `:1442` with
   nothing added. A user comparing two directories had no printed evidence that both runs resolved
   the same project, which is why the run-5 runner attributed the crash to project resolution
   (`verify/midday.md:20-27` refutes that attribution).
5. The unbuilt-sibling remedy prints another package's raw script body. `src/harness.ts:4249` reads
   the value of `scripts.build`, and `UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING` (`:4030-4040`)
   renders "Run `<body>` in that package first", naming neither the directory nor the package
   manager. `packageManagerRunCommand` (`:3083`) already renders `pnpm run build` and carries no
   directory.

## MUST

### Lane A (`src/harness.ts`, `src/cli.ts`, `src/project-model.ts`)

- **A1** A member whose PostCSS pipeline declares Tailwind 3 builds its CSS with the
  `tailwind.config.{js,cjs,mjs,ts}` nearest the member (member root first, then each ancestor up to
  and including the workspace root), whatever directory the CLI was started from. The midday button
  measured from the repository root prints no `content option ... is missing or empty` line and no
  `@apply border-border` PostCSS failure.
- **A2** Two runs of one component that differ only in the shell directory print the same
  `Stylesheets:` line, the same warnings in the same order, the same prop schema, the same governing
  tsconfig path (I1, M109) and the same verdict, and write JSON reports that differ only in
  `timestamp`, `machine`, measured durations, and `componentPath` (the CLI argument as given); after
  `componentPath` is resolved to an absolute path the two reports are equal. The permitted differences in the warning
  text are the start-directory prefix A5 adds to a remedy command (`cd <dir> && `) and the start
  directory A3 names.
- **A3** When a member's PostCSS pipeline declares Tailwind 3 and no config governs it, the CSS
  failure names the config filenames searched for, the directories searched (member root through
  workspace root) and the directory a run would have to start from. That message never names a build
  script.
- **A4** Every run prints one line naming the resolved member root and the workspace root: in the dry
  run as the first line of each component's block (after the `=== <path> ===` header a
  multi-component run prints), in a real run once per component ahead of that component's table. The
  paths are absolute and identical from every shell directory. A single-package project prints one
  root. The line is suppressed under `--ci` in both the dry run and the real run, where the table is
  suppressed too.
- **A5** A remedy that asks the user to run a package script prints the package manager invocation of
  the script name (`pnpm run build`, `yarn build`, `npm run version`), prefixed with `cd <dir> && `
  when that package's directory differs from the directory the CLI was started from. `<dir>` is that
  package's directory relative to the start directory, posix-separated. When no relative path exists
  (a different drive), `<dir>` is the absolute path. A raw script body is never printed. This covers
  all three remedies that name a package script: the unbuilt-sibling warning, the Nuxt generate
  remedy and the gitignored-generated-file remedy.

## MUST NOT

- Let the shell directory change the Vite root, the alias set, the stylesheet pick, the resolved
  tsconfig or the baseline key.
- Ship a Tailwind of the harness's own. The member's installed Tailwind stays the only one loaded,
  as `loadTailwindVitePlugin` (`src/harness.ts:1395-1399`) already requires.
- Replace a member's own `postcss.config.*` plugin list. A pipeline whose Tailwind entry receives an
  explicit config keeps every other plugin the member declared (`autoprefixer` in midday's case).
- Print the roots line more than once per component, or on any phase line.
- Change what `--explain-props` costs. The dry run stays browser-free (`verify/midday.md:55-62`) and
  finishes in 7-8 s from both directories (`verify/midday.md:22-24`).

## Interfaces needed

None. The roots line is written by `src/cli.ts`, the Tailwind config search lives in
`src/harness.ts`, and the root pair comes from `src/project-model.ts`: three lane-A files. A2 reads
I1's answer (`resolveGoverningTsconfig`, M109) and adds nothing to it.

Conflicts in `M107-M117-MAP.md`, which are sequencing and not interfaces because lane A is
sequential:

- C2: M109 edits the same `createServer({...})` option object (`src/harness.ts:3528-3558`) to add
  `esbuild.jsx`. M109 lands first; M111 adds its CSS option to whatever that object then reads.
- C3: M107 rewrites the rescue loop that builds the unbuilt-sibling remedy
  (`src/harness.ts:4227-4252`). M107 lands first; M111 rewrites the command text at the line M107
  leaves it on.
- C6 and C12: the stylesheet disclosure record (I5) belongs to M112 and M114; A1 touches the PostCSS
  and Tailwind options only. A4's roots line lands before M115's breakdown in the CLI's
  per-component block.
- C11: A3's message is ordinary warning text on the existing channel (`src/analyze.ts:3401`, `:3505`,
  `:3544`). M111 is a producer; M117 dedups last. No new channel.
- M108 owns the Nuxt build-module remedy (`src/harness.ts:3007-3022`), one of
  `findLikelyGenerateCommand`'s two call sites. M108 lands first; M111 A5 only wraps the command text
  that site then prints.

Carrying the two roots into `Report` and `--report-md` would need `src/report.ts` (lane C). Deferred.

## Verification

Fixture: new directory `fixtures/tailwind3-monorepo/` with a root `package.json`, a
`pnpm-workspace.yaml` and no Tailwind config; `packages/ui/package.json` declaring
`tailwindcss@^3.4.19`; `packages/ui/tailwind.config.js` with a non-empty `content` and
`theme.extend.colors.border`; `packages/ui/postcss.config.js` declaring `tailwindcss` and
`autoprefixer`; `packages/ui/src/globals.css` using `@apply border-border`;
`packages/ui/src/Button.tsx`. A new directory, because the map's fixture rule forbids editing the
shared `fixtures/workspace-monorepo/` the G5 brief proposed extending.

Unit tests:

- **A1, A2** `test/unit/tailwind-config-resolves-from-the-member-root.test.ts`: resolve the member's
  style tooling with the start directory passed as an argument, the fixture root, then `packages/ui`,
  and assert the same `packages/ui/tailwind.config.js`; assert the ancestor case (config at the
  fixture root only) picks the ancestor; assert a member with `@tailwindcss/vite` keeps today's
  version-4 answer and receives no version-3 config path. No test changes `process.cwd()`, so the
  resolver takes the start directory as a parameter rather than reading it.
- **A3** same file: a member declaring `tailwindcss` in PostCSS with no config at any level yields a
  message naming the four filenames, the member root, the workspace root and the start directory.
- **A4** `test/unit/run-prints-the-roots-it-resolved.test.ts`: format the line for a member inside
  `fixtures/tailwind3-monorepo`, for a single-package fixture (one root, one path), and assert one
  occurrence per component across a two-component sweep.
- **A5** `test/unit/remedy-commands-name-the-directory-to-run-in.test.ts`: the unbuilt-sibling warning
  for a sibling at `packages/ui`, start directory the repository root, reads
  "Run `cd packages/ui && pnpm run build` ..."; started inside `packages/ui` it reads
  "Run `pnpm run build` ..."; a manifest without a `build` script prints no command; a yarn workspace
  prints `yarn build`.

Corpus, through the scratch dist the map's verification rule describes. Command copied verbatim from
`EVIDENCE.md:61`:

    node run120.mjs --cwd /e/repositories-run5/midday --label explain-button --explain-props -- packages/ui/src/components/button.tsx

`tools/run120.mjs:15-17` parses everything before `--` as wrapper option pairs, so `--explain-props`
never reached the CLI (`logs/midday/explain-button.meta.json` holds
`"cliArgs": ["packages/ui/src/components/button.tsx"]`, `verify/midday.md:6-13`). A verbatim replay
is therefore a measuring run, which is what produced the crash. Expected after the fix: exit 0, a
written report, zero occurrences of `content option` and of `border-border` in the log, and a roots
line naming `E:\repositories-run5\midday\packages\ui` as the member root and
`E:\repositories-run5\midday` as the workspace root (the platform absolute form `path.resolve`
returns; the same two paths appear in the member-root run).

The member-root half of the pair, the same row with the wrapper's directory moved to the member
(run 5 measured this component from `packages/ui` as `logs/midday/real-button-v2`, exit 0, with
`--samples 5 --max-combos 4 --explore-budget 60 --no-deltas`; the parity run drops those flags so the
pair differs only in the shell directory):

    node run120.mjs --cwd /e/repositories-run5/midday/packages/ui --label real-button-v2 -- src/components/button.tsx

Expected after the fix: the same `Stylesheets:` line (`src/globals.css`, largest-stylesheet
fallback), the same warning list and the same verdict as the repository-root run, and the same two
absolute roots.

Control required by the map: one unaffected run-5 repository that already reached a report
(shadcn-admin's button) still reaches one against the same scratch dist, with its output unchanged
apart from the new roots line.

Also required before the commit: the lane's existing tests stay green (baseline failures excepted)
and `tsc --noEmit` is clean.

### Lane A evidence

Run 2026-09-03 in `C:\Projekte\120fps-m107`, scratch dist
`C:/Projekte/120fps-fieldtest/scratch/A-M111/dist/cli.js`.

Tests, the three files above (`node node_modules/vitest/vitest.mjs run <files> --maxWorkers=2`):

    Test Files  3 passed (3)
         Tests  15 passed (15)

The lane's existing tests, the 25 files under `test/unit/` that exercise `resolveStyleTooling`,
`packageManagerRunCommand`, `findLikelyGenerateCommand`, `postcssConfigDir`, `resolveProjectModel`,
`UNBUILT_WORKSPACE*` or `buildAndServe`:

    Test Files  25 passed (25)
         Tests  457 passed (457)

`node node_modules/typescript/bin/tsc --noEmit`: clean, no output.

Corpus. midday from the repository root, the `EVIDENCE.md:61` command with `--out`, `--timeout` and
`--cli` added, label `M111-midday-after`:

- before (`logs/midday/explain-button.log:12`, exit 2 after 36 s):

      [postcss] E:/repositories-run5/midday/packages/ui/src/globals.css:1:1: The `border-border` class does not exist. If `border-border` is a custom class, make sure it is defined within a `@layer` directive.

- after (`logs/midday/M111-midday-after.log`, exit 0 after 160 s):

      Roots: member E:\repositories-run5\midday\packages\ui, workspace E:\repositories-run5\midday
      Stylesheets: src/globals.css (largest-stylesheet fallback, low confidence - verify with --css)
      Result: PASS

  `grep -c` in that log: `content option` 0, `border-border` 0. The roots line occurs once. Closed: yes.

midday from the member root (`--cwd /e/repositories-run5/midday/packages/ui --
src/components/button.tsx`, label `M111-midday-memberroot-after`, exit 0 after 263 s): the same
`Stylesheets: src/globals.css (largest-stylesheet fallback, low confidence - verify with --css)`,
the same `Result: PASS`, the same
`Roots: member E:\repositories-run5\midday\packages\ui, workspace E:\repositories-run5\midday`,
and `JSON.stringify(report.warnings)` equal between the two reports. Closed: yes.

Control, shadcn-admin (`--cwd /e/repositories-run5/shadcn-admin -- src/components/ui/button.tsx
--explain-props`, label `M111-shadcn-admin-after`, exit 0 after 2 s): the dry run still reaches its
summary, with the new first line `Root: E:\repositories-run5\shadcn-admin` (one root, a
single-package project). Closed: yes.

Open against A2, then closed in code, corpus re-run pending. The two midday reports differed in
one directory-dependent field, `css.details[0].matchedRules` (11 from the repository root, 22 from
the member root, reproducibly); `hints` and the CV-derived unstable flags also differ, but a second
repository-root run reproduces those differences from the same directory, so they are measurement
noise. Cause, verified: Tailwind 3 resolves a relative `content` glob against `process.cwd()`, and
midday declares `content: ["./src/**/*.{ts,tsx}"]` (`packages/ui/tailwind.config.ts:5`), so from the
repository root that scan matches no source and only the base rules are generated. The first attempt
(load the config with `tailwindcss/loadConfig` and pass the rewritten object as `config`) was
reverted: an object config makes Tailwind re-resolve and re-hash the config on every PostCSS build,
and both corpus runs hit the 20-minute watchdog. `writeAnchoredTailwind3Config`
(`src/harness.ts`) keeps the cache instead: it writes the member's config back out into the harness
directory with every relative glob resolved against the member root, and passes that *file's path*
as `config`, so Tailwind's config-path-keyed context cache still hits. Re-run the midday pair and
assert `matchedRules` is equal before calling A2 closed.

## Deferred

- Member root and workspace root in the JSON report and in `--report-md`. `src/report.ts` belongs to
  lane C, and no finding needs the fields; the terminal line closes midday-F1's diagnosis gap.
- Running the server's lifetime under `process.chdir(projectRoot)`, the second fix direction in
  `verify/midday.md:50-52`. A process-wide directory change races a multi-component sweep and every
  concurrent path resolution; an explicit config path reaches the same observable behaviour with no
  global state.
- Tailwind 4 (`@tailwindcss/vite`) config resolution, which already reads from the Vite root and
  produced no run-5 finding.
- A general guard for any PostCSS or Vite plugin that reads `process.cwd()` on its own. Run 5 names
  one such plugin (Tailwind 3); a generic guard would need a plugin inventory this evidence does not
  support.
- Byte-equal reports as the assertion the G5 brief proposed. A report carries a timestamp, machine
  data and measured durations, so A2 compares the decision fields instead.
