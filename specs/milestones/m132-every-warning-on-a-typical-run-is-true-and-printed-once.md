---
kind: milestone
status: draft
tests:
  - test/unit/report-informational-warnings.test.ts
  - test/unit/zero-prop-count-names-its-cause.test.ts
  - test/unit/vue-support.test.ts
  - test/unit/vite-plugin-note-names-what-it-dropped.test.ts
  - test/unit/warnings-print-once-per-run.test.ts
  - test/unit/a-component-that-declares-no-props-says-so.test.ts
  - test/unit/the-vite-note-names-only-what-was-dropped.test.ts
  - test/unit/no-node-warning-reaches-the-users-terminal.test.ts
  - test/unit/the-dry-run-honours-no-css.test.ts
  - test/unit/third-party-build-output-is-captured.test.ts
  - test/unit/a-warning-carries-one-prefix.test.ts
  - test/unit/a-provider-hint-names-what-the-file-imported.test.ts
---

# M132: every warning on a typical run is true, printed once, and names what to do

Lane D (`src/pipeline/remedies.ts`, `src/pipeline/explain-props.ts`, `src/harness/vite-config.ts`,
`src/harness/postcss-config.ts`, `src/harness/style-tooling.ts`, `src/cli/main.ts`, the
`PROVIDER_LIBRARIES` tables in `src/project/preflight.ts`, the vite-config note push in
`src/harness/prebuild.ts`, and the zero-props warning call in `src/pipeline/modes/combo.ts`).

## Purpose

Twenty-seven of the fifty run-7 repositories reached a report and passed, and every one of them
printed warnings. Five of the warnings a passing run prints are wrong, repeated, or not the tool's
to print: a component that declares no props is told its extraction may have failed; a Vite config
whose aliases were honoured is told they were ignored, and a plugin list the tool could name is
described as anonymous; the same project-level note prints three times in one dry run; Node's own
`MODULE_TYPELESS_PACKAGE_JSON` warning about the *project's* config file appears in the user's
terminal; `--no-css` is silently ignored by the dry run; and the provider hint names a hook the file
never imported. After this milestone every warning a passing run prints is a statement the run can
support, it appears once, and it names the thing the reader would change.

Evidence: `C:/Projekte/120fps-fieldtest/smoke/run7-FINDINGS.md` cluster 4 (F14-F18) and the logs of
soybean-admin, lobe-chat, nextjs-boilerplate, dify, vue-pure-admin, vue3-element-admin, midday and
plane in `smoke/run7-smoke1/`.

## Root causes (verified)

The verifier for every item below: run-7 investigation (2026-09-06), refuted by default; logs under
`C:/Projekte/120fps-fieldtest/smoke/run7-smoke1/logs/<repo>/`.

1. **The zero-prop warning hedges against itself** — `ZERO_PROPS_WARNING`
   (`src/pipeline/remedies.ts:58-59`) ends "…if the component has typed props, extraction may have
   failed"; it is pushed from `src/pipeline/explain-props.ts:244-250` and
   `src/pipeline/modes/combo.ts:243-248`. `explainsZeroPropCount` (`src/pipeline/remedies.ts:173-180`)
   has no explainer for the case "the component declares none". The verifier: 5 of 5 components
   checked positively declare no props — soybean-admin's `soybean-avatar.vue`, lobe-chat's
   `Divider` (`memo(() => …)`), nextjs-boilerplate's `LocaleSwitcher` (`() =>`), and two more. The
   correct wording already exists one file away, in `VUE_RUNTIME_DEFINE_PROPS_WARNING`
   (`src/props/vue.ts:162-166`), which says extraction did not fail.
2. **The vite-config note over-claims, under-names and repeats** —
   `VITE_CONFIG_IGNORED_WARNING` (`src/harness/vite-config.ts:87-101`) is pushed at
   `src/harness/prebuild.ts:63-71`. (a) `resolve.alias` is marked ignored wholesale when a single
   entry fails to resolve statically (`src/harness/vite-config.ts:432`, `:447`, `:451`) although the
   rest are honoured. (b) A computed `plugins: setupVitePlugins(...)` produces the nameless pre-M117
   wording, although the callee is right there in the AST. (c) The project-level note is pushed once
   per candidate, so a three-candidate dry run prints it three times. The verifier: soybean-admin,
   dify, lobe-chat, vue-pure-admin and vue3-element-admin all show the nameless wording; vue-pure-admin
   shows the note three times in one dry run. This changes the text M117 C3 quotes
   (`m117-output-that-respects-the-reader.md:80-86`), which is why C3 below supersedes it.
3. **Node's warning about the project's config reaches the user's terminal** — `requireConfig`
   (`src/harness/postcss-config.ts:115-121`, with the `await import()` at `:139`) and
   `src/harness/style-tooling.ts:96` and `:311` load the project's `postcss.config.js` /
   `tailwind.config.ts`. When that file has no `"type"` in its `package.json`, Node emits
   `MODULE_TYPELESS_PACKAGE_JSON` on the process. The verifier: no filter exists anywhere —
   `grep -n "emitWarning\|NODE_NO_WARNINGS" src` returns nothing — and the warning appears in midday's
   and plane's logs. `src/cli/main.ts:130` is where `parseArgs` runs, so a listener installed above it
   covers every load.
4. **`--no-css` is a no-op in the dry run** — `src/pipeline/explain-props.ts:148` calls
   `resolveCssFiles({}, projectRoot, warnings, {…})` with an empty options object, so neither `noCss`
   nor `cssFiles` reaches the resolver. The verifier: the flag changes the real run and not the dry
   run, which is exactly what the M100/M110 parity rule forbids.
5. **The provider hint names a hook the file never imported** — `PROVIDER_LIBRARIES`
   (`src/project/preflight.ts:54-66`) maps a package to one representative hook, and the hint prints
   that hook regardless of what the file imported. The verifier: a file that imports only `Link` from
   `react-router` is told about `react-router (useNavigate)`.
6. **A third party's stderr is passed through, then said again properly** — during `harness: building`
   the Tailwind PostCSS plugin writes an `enhanced-resolve` stack to stderr and 120fps prints it
   verbatim. The verifier: rallly's log carries 18 such lines during the build, and about 100 lines
   later the same fact is reported by 120fps's own stylesheet-probe warning
   (`src/harness/stylesheet-probe.ts:11`) — `smoke/run7-new1/rallly.json`, flags `slow-real`,
   `slow-explore` and `stack-trace`. M94's rule is that a third-party failure is re-presented as a
   120fps message, never as a raw stack.
7. **One warning carries two prefixes** — anything-llm's line
   `no representative value could be synthesized for onToggle` prints with a doubled `⚠ Warning:`
   prefix. The verifier: `smoke/run7-new1/anything-llm.json` (class `verdict-fail`, exit 1, real 45 s)
   and its log. Cosmetic, and in the same producer/printer seam C4 fixes.

## MUST

- **C1** A component whose source declares no props produces a warning that says so and states that
  extraction did not fail, mirroring `VUE_RUNTIME_DEFINE_PROPS_WARNING`'s wording. The hedge "if the
  component has typed props, extraction may have failed" is printed only when the run has a reason to
  suspect extraction failed — an unresolved annotation module (M130 C4), an unparsed source, or a
  binding the extractor could not follow — and that reason is named in the same line.
- **C2** `explainsZeroPropCount` recognises the "declares none" explanation, so a zero-prop count that
  has been explained does not also draw the generic remedy.
- **C3** The vite-config note names only what the run actually dropped, and this supersedes the text
  M117 C3 quotes at `m117-output-that-respects-the-reader.md:80-86`:
  - `resolve.alias` is named only when *no* alias entry was honoured. When some were honoured and
    some were not, the note names the specific entries that were dropped, not the key.
  - A computed `plugins:` expression is named by its callee, in the same shape M117 C3 fixed for a
    call expression: `vite.config.ts declares plugins the harness cannot honor: setupVitePlugins —
    the project's Vite config is never executed.`
  - Everything else M117 C3 and C4 fix stands: an object literal by its `name`, anything else as
    `unnamed plugin #<n>`, no plugin named whose transform this run applied, the note omitted when
    the list empties, and `--explain-props` deciding from the same detection as the real run.
- **C4** The project-level vite-config note is produced once per run, not once per candidate, in the
  dry run and in the real run. This is M117 C1's dedup rule applied at the producer. "Once per run"
  is once per *measured component*: `collectStaticPreBuildWarnings` keeps a per-project ledger that
  `src/cli/main.ts` clears beside `resetCurrentRunWarnings()` in the per-component `finally`, so a
  glob sweep states the project's config for every component it measures. `--explain-props` walks
  all its candidates inside one such window, so a three-candidate dry run still states it once.
- **C5** No Node runtime warning emitted because of a file inside the *project* reaches the user's
  terminal. A `process.on("warning", …)` listener installed before `parseArgs`
  (`src/cli/main.ts:130`) swallows exactly `MODULE_TYPELESS_PACKAGE_JSON` for a filename outside
  120fps's own installation tree, and re-emits everything else unchanged.
- **C6** `--no-css` and `--css <file>` decide the dry run exactly as they decide the real run:
  `src/pipeline/explain-props.ts:148` forwards `{ noCss, cssFiles }`. With `--no-css`, the dry run
  reports no stylesheet and prints no stylesheet warning (M100/M110 parity).
- **C8** Output a third party writes through `console.error` during a run is captured, not streamed.
  It is printed only when no 120fps warning reports the same fact — compared after normalising case,
  whitespace, path separators and drive letters, because a 120fps warning re-words the fact — and
  when it is printed it is introduced by a 120fps sentence naming the tool that produced it (M94).
  The sentence claims no phase: the capture spans the run, not the build alone. `DEBUG` still shows
  everything. `console.error` is the interception point rather than `process.stderr.write`, which
  120fps's own diagnostics use: wrapping the stream itself would buffer the tool's own output and
  breach the MUST NOT below. A tool that writes to the stream directly (linkwarden's daisyUI banner)
  still streams raw; see Deferred.
- **C9** A warning carries exactly one prefix. A text that already begins with the warning prefix is
  not prefixed again, in the terminal, the JSON `warnings` array and the markdown report.
- **C7** The provider hint names what the file imported. When the run observed the representative
  hook in the file, the hook is named; otherwise the hint names the package alone — "imports
  react-router" — and nothing else.

## MUST NOT

- Suppress a 120fps warning to make output quieter. C5 filters exactly one Node warning code, for
  files outside 120fps's tree; a Node warning about 120fps's own code still prints.
- Set `NODE_NO_WARNINGS`, pass `--no-warnings` to the process, or remove the process's other warning
  listeners. C5 is scoped by code and by path.
- Drop a warning the dry run printed but the real run does not, or the reverse (M100, M110).
- Print the vite-config note for a config whose every declared plugin is a transform the run applied
  (M117 C4), or for a run that declares no plugins at all.
- Claim extraction succeeded when it did not. C1 narrows the hedge; it does not remove it.
- Change the noise sentinel's wording, the `(×N)` suffix shape, or the markdown fold M117 C1 and C2
  fixed.
- Swallow a third party's build output that no 120fps warning covers. C8 defers it and re-presents
  it; it never discards the only account of a failure.
- Strip a prefix from a text that a consumer parses. C9 prevents the second prefix; it does not
  rewrite the warning body.

## Verification

- **C1, C2** — `test/unit/a-component-that-declares-no-props-says-so.test.ts`,
  `test/unit/zero-prop-count-names-its-cause.test.ts`,
  `test/unit/report-informational-warnings.test.ts` (rewrites `:61-63`) and
  `test/unit/vue-support.test.ts` (`:361-374`): a `() => <div/>` arrow component, a
  `memo(() => …)` component and a Vue SFC with no `defineProps` each produce the "declares none"
  wording and no hedge; a component whose annotation references an unresolved module produces the
  hedge *and* names the module; `explainsZeroPropCount` returns true for the new text.
- **C3, C4** — `test/unit/the-vite-note-names-only-what-was-dropped.test.ts`,
  `test/unit/vite-plugin-note-names-what-it-dropped.test.ts` and
  `test/unit/warnings-print-once-per-run.test.ts`: a config with three aliases of which one fails
  statically names that one entry and not `resolve.alias`; a config where every alias fails names
  `resolve.alias`; `plugins: setupVitePlugins(...)` yields `setupVitePlugins`; an object literal
  yields its `name`; a spread yields `unnamed plugin #1`; a three-candidate dry run emits the
  project-level note exactly once.
- **C5** — `test/unit/no-node-warning-reaches-the-users-terminal.test.ts`: a synthetic
  `MODULE_TYPELESS_PACKAGE_JSON` warning whose `filename` is under a temporary project directory is
  swallowed; the same code with a filename inside 120fps's install root is re-emitted; an
  `ExperimentalWarning` from anywhere is re-emitted; the listener is installed once per process.
- **C6** — `test/unit/the-dry-run-honours-no-css.test.ts` and
  `test/unit/explain-props-parity.test.ts`: `--explain-props --no-css` reports no stylesheet and no
  stylesheet warning; `--explain-props --css <file>` reports that file; both match the real run's
  decision for the same fixture.
- **C8** — `test/unit/third-party-build-output-is-captured.test.ts`: stderr written during the build
  is not printed when a 120fps warning reports the same file; it is printed, once and introduced, when
  no warning covers it; `DEBUG` prints it in both cases.
- **C9** — `test/unit/a-warning-carries-one-prefix.test.ts`: a text already carrying the prefix is
  printed with one; a text without it gains one; the JSON array carries the unprefixed text in both
  cases.
- **C7** — `test/unit/a-provider-hint-names-what-the-file-imported.test.ts`: a file importing only
  `Link` from `react-router` produces "imports react-router" with no hook named; a file importing
  `useNavigate` names the hook; a specifier read without its file's text keeps the table's hook.
- Types: `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` clean.
- Suite: the tests above plus `test/unit/hints.test.ts`,
  `test/unit/postcss-config-plugins-load-from-the-defining-package.test.ts`,
  `test/unit/css-preprocessor-declared-vs-installed.test.ts`,
  `test/unit/dry-run-prints-project-transform-warnings.test.ts`, then the full unit suite once before
  the lane's final commit.

Recorded run of this milestone's verification (2026-09-07, worktree
`C:/Projekte/120fps-run7-lane-d`, node 22.22.2):

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
-> exit 0, no output

npx vitest run test/unit/a-component-that-declares-no-props-says-so.test.ts   test/unit/the-vite-note-names-only-what-was-dropped.test.ts   test/unit/no-node-warning-reaches-the-users-terminal.test.ts   test/unit/the-dry-run-honours-no-css.test.ts   test/unit/third-party-build-output-is-captured.test.ts   test/unit/a-warning-carries-one-prefix.test.ts   test/unit/a-provider-hint-names-what-the-file-imported.test.ts --maxWorkers=2
-> Test Files  7 passed (7);  Tests  44 passed (44)

npx vitest run test/unit --maxWorkers=2 (M133's five red test files excluded)
-> Test Files  2 failed | 371 passed (373)
   Tests  2 failed | 5216 passed | 1 skipped (5219)
   Duration 427.89s
   the two failures are the recorded pre-existing set: prop-cap-ranking.test.ts and
   vue-setup-inject-evidence.test.ts

npx vitest run test/unit/the-vite-note-names-only-what-was-dropped.test.ts   test/unit/vite-plugin-note-names-what-it-dropped.test.ts   test/unit/static-prebuild-warnings.test.ts test/unit/static-prebuild-warning-parity.test.ts   test/unit/explain-props-parity.test.ts   test/unit/dry-run-prints-project-transform-warnings.test.ts   test/unit/warnings-print-once-per-run.test.ts --maxWorkers=2
-> Test Files  7 passed (7);  Tests  55 passed (55)
   (re-run after the `plugins: await getPluginsList(...)` unwrap landed)
```

Recorded run of the review fixes (2026-09-07, merged with `feat/run7-remediation` at `55f5102`):

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json   -> exit 0, no output

npx vitest run <the 16 files this lane's two milestones touch> --maxWorkers=2
-> Test Files  16 passed (16);  Tests  169 passed (169)

npx vitest run test/unit --maxWorkers=2
-> Test Files  2 failed | 389 passed (391)
   Tests  2 failed | 5455 passed | 1 skipped (5458)
   Duration 460.04s
   the two failures are the recorded pre-existing set: prop-cap-ranking.test.ts and
   vue-setup-inject-evidence.test.ts
```

Corpus repros, through a `dist` built in `C:/Projekte/120fps-run7-lane-d`:

```
node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/soybean-admin \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-d/soybean-admin \
  --label m132-soybean --cli C:/Projekte/120fps-run7-lane-d/dist/cli/main.js \
  -- src/components/custom/soybean-avatar.vue --samples 3 --max-combos 2 \
     --explore-budget 30 --no-deltas
# expected: zero-prop line says the component declares none; the note names setupVitePlugins

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/vue-pure-admin \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-d/vue-pure-admin \
  --label m132-vue-pure-admin-dry --cli C:/Projekte/120fps-run7-lane-d/dist/cli/main.js \
  -- src/views/components/slider/components/Input.vue --explain-props
# expected: the project-level vite-config note appears once (baseline 3x)

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run5/midday/apps/dashboard \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-d/midday \
  --label m132-midday --cli C:/Projekte/120fps-run7-lane-d/dist/cli/main.js \
  -- src/components/tables/invoices/skeleton.tsx --samples 3 --max-combos 2 \
     --explore-budget 30 --no-deltas
# expected: no MODULE_TYPELESS_PACKAGE_JSON in the log; 120fps's own warnings unchanged

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories-run6/plane/apps/web \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-d/plane \
  --label m132-plane --cli C:/Projekte/120fps-run7-lane-d/dist/cli/main.js \
  -- core/components/rich-filters/filter-item/loader.tsx --samples 3 --max-combos 2 \
     --explore-budget 30 --no-deltas
# expected: same

node C:/Projekte/120fps-fieldtest/tools/run120.mjs \
  --cwd E:/repositories/taxonomy \
  --out C:/Projekte/120fps-fieldtest/logs/run7-lane-d/taxonomy \
  --label m132-no-css-dry --cli C:/Projekte/120fps-run7-lane-d/dist/cli/main.js \
  -- components/ui/label.tsx --explain-props --no-css
# expected: no stylesheet reported, matching the real run under --no-css
```

Recorded corpus results (2026-09-07, `dist` built at this commit; logs under
`C:/Projekte/120fps-fieldtest/logs/run7-lane-d/<repo>/`):

| Repo | Before | After |
|---|---|---|
| soybean-admin | `No props extracted: … if the component has typed props, extraction may have failed`; `vite.config.ts declares resolve.alias and plugins, which the harness read but cannot honor` | `⚠ No props extracted: the component declares no props, so it is measured with empty props: extraction did not fail and the component is not broken.`; `⚠ vite.config.ts declares resolve.alias and plugins the harness cannot honor: setupVitePlugins — the project's Vite config is never executed`; `Result: PASS` |
| vue-pure-admin (3-candidate `--explain-props`) | the project-level note 3× per dry run, nameless | the note once, `… cannot honor: getPluginsList — …` (`grep -c 'cannot honor'` = 1 over 3 candidates) |
| midday | `(node:…) [MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of file:///E:/repositories-run5/midday/packages/ui/tailwind.config.ts …` | `grep -c MODULE_TYPELESS` = 0; the run's own warnings unchanged |
| plane | same Node warning (`grep -c` = 1) | `grep -c MODULE_TYPELESS` = 0; reaches a report in 25.6 s |
| taxonomy (`--explain-props --no-css`) | `Stylesheets: styles/globals.css (found in the project entry's own imports)` | `Stylesheets: none (--no-css)` |
| rallly | 7 `enhanced-resolve` stack lines during `harness: building`, then the same fact as a 120fps warning | 0 stack lines; the covering warning (`… did not compile ([postcss] tailwindcss: … Can't resolve '@tailwindcss/typography' …)`) is the only account printed |
| anything-llm | `⚠ Warning: no representative value could be synthesized for onToggle …` | `⚠ no representative value could be synthesized for onToggle …` (`grep -c '⚠ Warning:'` = 0) |

## Deferred

- **A positive "declares no props" claim.** C1 infers it from the absence of a suspicion mark, so an
  extractor failure that emits no warning at all would still read as "declares none". A positive
  signal needs a field on `PropsBinding` (`src/props/candidates.ts`), which is another lane's file.
- **Third-party output written straight to the stream.** C8 intercepts `console.error`; a tool that
  calls `process.stdout.write` or `process.stderr.write` (linkwarden's daisyUI banner) still streams
  raw. Wrapping the streams would capture 120fps's own writes, which the MUST NOT above forbids;
  separating the two needs a tagged writer, not a wrapper.
- **A structured diagnostic record** in place of string constants and `isXWarning` predicates. ADR
  0005 item 6 names it as a later decision; this milestone keeps warning text beside its emitter.
- **The `(×N)` dedup rule itself.** M117 C1 owns it; C4 only moves one producer so it emits once.
- **Filtering more Node warning codes.** C5 is scoped to the one code the corpus produced; widening
  the filter needs a repository that produces another.
- **A per-alias report of what the harness did honour.** C3 names what was dropped; a positive
  listing is output the corpus never asked for.
