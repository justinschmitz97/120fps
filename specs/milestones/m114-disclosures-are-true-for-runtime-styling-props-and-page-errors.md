---
kind: milestone
status: approved
tests:
  - test/unit/vue-setup-inject-evidence.test.ts
  - test/unit/runtime-style-engine-disclosure.test.ts
  - test/unit/vite-root-entry-discovery.test.ts
  - test/unit/console-format-substitution.test.ts
  - test/unit/default-export-behind-a-wrapper.test.ts
  - test/unit/controlled-pair-matrix-axes.test.ts
  - test/unit/re-exported-props-resolution.test.ts
  - test/unit/zero-props-names-the-barrel.test.ts
  - test/unit/mount-abort-hints-name-read-evidence.test.ts
  - test/unit/runtime-style-engine-line.test.ts
---

# M114: Disclosures are true for runtime styling, props and page errors

Lanes A (`src/harness.ts`, `src/page-errors.ts`), B (`src/prop-gen.ts`, `src/prop-gen-values.ts`,
`src/vue-sfc.ts`), C (`src/analyze.ts`, `src/hints.ts`, `src/report.ts`). The map's ownership table
gives `src/page-errors.ts` to lane A, which owns it here, so G2 (M108) and G8 never edit it twice.

## Purpose

Nine run-5 findings in which the run measured something defensible and then said something untrue
about it: a Griffel-styled component reported "no stylesheet found", a matrix crossed a controlled
prop with its `default` twin, a barrel reported zero props, a wrapped default export made the header
name and the props table disagree, two hints named a cause the run never read, React's `%s` reached
the user raw, vuetify was told it has no entry while its vite config declares one.

Closes: fluentui-F3, fluentui-F1, gutenberg-F2, react-spectrum-F3, ark-F2, logto-F1, vitesse-F1,
supabase-F2, vuetify-F1.

Evidence, all under `C:\Projekte\120fps-fieldtest\`: `EVIDENCE.md` rows 64, 68-71, 77, 82-84;
`verify/{fluentui,gutenberg,react-spectrum,ark,logto,vitesse,supabase,vuetify}.md`;
`remediation/cluster-briefs.md` section G8; the `logs/` files those rows name.

## Root causes (verified)

Every line below was re-checked in `C:\Projekte\120fps-m107\src`. Two differ from the brief:
`findComponentPropsType` sits at `prop-gen.ts:1568`, its `return {}` at `:1581` (brief: 1567, 1580).

1. **fluentui-F3** (`harness.ts:1358-1365`) `RUNTIME_STYLE_ENGINES` is a closed six-entry allowlist
   without Griffel, so `discoverGlobalCss` skipped the runtime branch at `:1348-1349` and returned
   `source: "none"` (`:1351`), although `@griffel/react` is a direct dependency of that package.
2. **fluentui-F1** (`prop-gen-values.ts:377`, `:412-421`) `matrixValues` returns `[false, true]` for
   every boolean schema and `matrixAxesFor` has no mutual-exclusion rule, so all four Dialog cells
   set `open` and `defaultOpen` together, which Fluent's `useControllableState` rejects.
3. **gutenberg-F2** (`prop-gen.ts:864`, `:1568`, `:1581`) `collectComponentCandidates` walks the
   entry file's own children only, so a barrel that imports a binding and re-exports it yields no
   target and `findComponentPropsType` returns `{}`. The declaring file printed 32 props.
4. **react-spectrum-F3** (`analyze.ts:3755`, `:3764-3770`) `explainsZeroPropCount` registers no
   re-export cause, so a shim printed `ZERO_PROPS_WARNING`, whose "extraction may have failed"
   clause was false for a cause the filesystem decides.
5. **ark-F2** (`hints.ts:232`) `VUE_PROXY_FRAME_SIGNATURE` is `/\bat Proxy\.\$?\w/`; the optional `$`
   matches `at Proxy._sfc_render`, so `hintsForMountAbort` (`:244-252`) fired `vuePluginGlobals` for
   a plain provide/inject failure. `m105-lane-c-hints.md:72` asks for the `at Proxy.$` form.
6. **logto-F1** (`prop-gen.ts:2808-2812`) `scanExports` records `export default X` only for an
   identifier expression, so `export default forwardRef(Button)` was dropped and `selectMeasuredExport`
   (`:1017-1025`) fell to the first non-`Provider` export, which `detectComponentExport`
   (`harness.ts:4693-4697`) returned as `LinkButton`; `prop-gen.ts:917` had unwrapped `Button` for the table.
7. **vitesse-F1** (`hints.ts:244-256`, `analyze.ts:3740`) no mount-abort signature matches
   `X is not defined` and `hintsForMountAbort` receives the message alone, so the `defineModels`
   `ReferenceError` printed with no link to the ignored-plugins warning that named the cause class.
8. **supabase-F2** (`page-errors.ts:127-130`) the console listener records `msg.text()`, and Playwright
   renders a format string beside its arguments, so React's `%s` templates arrived unsubstituted.
9. **vuetify-F1** (`harness.ts:916`, `:1524-1530`, `:1838`, `:848-863`) `findProjectEntry` probes
   `projectRoot/index.html` and four Next.js stems only, the vite property loop has a `publicDir`
   branch and no `root` branch, and `IGNORED_KEY_ORDER` omits `root`, so vuetify's `vite.config.ts:34`
   root went undisclosed and `CSS_FALLBACK_WARNING` claimed the package has no entry of its own.

## MUST

### Lane A (`src/harness.ts`, `src/page-errors.ts`)

- A1 A component whose measured package declares a runtime styling engine prints
  `Stylesheets: none — styling is generated at runtime by <engines>; no stylesheet was needed`. The
  recognised set covers Griffel (`@griffel/react`, `@griffel/core`), Emotion, `styled-components`,
  `@ant-design/cssinjs`, `antd-style`, `css-render` and `primevue`.
- A2 When no stylesheet was found and no recognised engine resolved, but the measured file imports a
  `makeStyles`, `createUseStyles` or `styled` binding from a package the list does not name, the run
  discloses `styling appears to be generated at runtime by <package> (unrecognised engine)` and names
  `--css`. Without such an import the line stays `none found`.
- A3 For a project whose vite config declares `root` as a string literal or a foldable `resolve(...)`
  call, the resolved entry is `<root>/index.html`, a root-absolute `src="/x.js"` in it resolves
  against that directory, and an unfoldable `root` appears in the ignored-keys line.
- A4 The fallback stylesheet warning claims that the package has no application entry only when no
  entry was found under the project root and none under the config's `root`. Its other clauses (the
  named file, the size-alone ranking, the `--css` remedy) are unchanged.
- A5 A statically foldable `build.rollupOptions.input` HTML path resolves as the entry, and the
  `Stylesheets:` line names the deciding layer, so an entry-chain pick never reads as a fallback
  pick.
- A6 A captured console message substitutes `%s`, `%d`, `%i`, `%f`, `%o`, `%O` and `%c` from the
  console arguments before the text is recorded, turns a literal `%%` into `%`, and keeps surplus
  arguments appended. The JSON `pageErrors` entries carry the substituted text.

### Lane B (`src/prop-gen.ts`, `src/prop-gen-values.ts`, `src/vue-sfc.ts`)

- B1 A default export written as a call wrapper — `forwardRef(X)`, `memo(X)`, `withTheme(X)`, or a
  nested chain of them — reports `X` as the default export, so the reported export name and the
  measured schema share one binding.
- B2 An optional boolean axis crosses absent against present; a required boolean keeps `false` and
  `true`. The matrix disclosure names which member is absent.
- B3 No matrix cell sets a controlled prop and its `default<X>` twin together (`open`/`defaultOpen`,
  `value`/`defaultValue`, `checked`/`defaultChecked`): when both are eligible the axis set keeps the
  controlled one and the disclosure names the dropped twin.
- B4 When the entry file declares no candidate and the measured export is an imported or re-exported
  binding, the module specifier resolves and candidates are collected in the declaring module, whose
  path and line the binding line names.
- B5 When that resolution fails, the run names the barrel and the specifier that did not resolve
  instead of a props table; the record carrying them is I7.
- B6 The run records whether the measured SFC's `<script setup>` block calls `inject(`, so C2's
  hint has read evidence; the field is I8. `<script setup>` is the whole scope: an Options-API or
  plain `<script>` SFC whose `setup()` injects records `usesInject` false and gets no hint, and a
  component the run cannot re-read discloses that read failure instead of recording a silent false.

### Lane C (`src/analyze.ts`, `src/hints.ts`, `src/report.ts`)

- C1 A component reached through a re-export prints `re-export of <module>: measuring <module>` and
  the declaring module's props. When the specifier does not resolve, the run prints `<barrel>
  re-exports <specifier>, which did not resolve: no props were read there` in place of
  `ZERO_PROPS_WARNING`, and `explainsZeroPropCount` accepts that text.
- C2 The Vue plugin hint prints only for a `$`-prefixed proxy frame together with a read of
  undefined. A read of undefined inside an ordinary SFC render frame prints the provide/inject hint
  with the `120fps.setup.vue` provide remedy only when the same run recorded an `inject(` call in the
  measured component's `<script setup>` block (B6); otherwise the abort prints no hint. When that
  re-read throws, the run says so in its warnings rather than presenting the failure as "no
  `inject(` call".
- C3 A mount abort reading `<identifier> is not defined` prints a hint naming the config file and
  stating that its declared `plugins` were read but not executed, together with the identifier, when
  the run recorded `plugins` among the ignored keys; with an empty ignored list the abort prints no
  hint. The plugin names themselves arrive with M117 A3/C4.
- C4 The `Stylesheets:` line renders A2's unrecognised-engine outcome in its own wording, so an
  unlisted engine and a recognised one never read alike.

## MUST NOT

- Assert a runtime styling engine, a Vue plugin, a provide/inject cause or a macro plugin the run
  did not read from the repository; no signature and no read evidence means no hint
  (`m105-lane-c-hints.md:50-56`).
- Assert that a package has no application entry while one exists under a `root` its config declares.
- Synthesize a matrix cell that sets a controlled prop and its `default<X>` counterpart together, or
  print `ZERO_PROPS_WARNING` alongside a named re-export cause.
- Change any measured window, verdict rule or tier budget. fluentui-F1's FAIL was a timing miss.
- Let the `Stylesheets:` line, the re-export disclosure or the unresolved-re-export cause read
  differently in `--explain-props` than in the real run: all three are decidable from the filesystem
  alone, so M100's parity rule (`m100-...md:50-51`, `:58-60`) covers them.

## Interfaces needed

- I5: producer A (`discoverGlobalCss`), consumer C (`formatStylesheetsLine`, `report.ts:696-699`):
  the CSS result already carries `runtimeEngines: string[]` (`harness.ts:1349`, `report.ts:473`);
  M114 adds `runtimeEnginesRecognised: boolean` beside the `declaredMissing` M112 lands on the same
  record. Needed by A1, A2, C4. A2's unrecognised outcome must reach C4 as layer `"runtime"` with
  `runtimeEnginesRecognised` false and a non-empty `runtimeEngines`: C4's branch renders inside
  `case "runtime"` only, so a layer of `"none"` would fall through to "none found" and leave A2
  undisclosed. Until lane A lands, C4 is unit-verified only; the fluentui-F3 repro is rerun then.
- I10: producer A (`ViteConfigData.ignoredKeys`, set at `harness.ts:2011`), consumer C
  (`hintsForMountAbort`, `analyze.ts:3740`), which receives that list and the config path beside the
  message. Needed by C3.
- I7: producer B (`findComponentPropsType`, `prop-gen.ts:1568`), consumer C (`explainsZeroPropCount`,
  `analyze.ts:3764`): `PropsBinding` gains `unresolvedReExport?: { barrel: string; specifier: string }`
  on the extraction record M112 introduces. Needed by B5, C1.
- I8: producer B (`src/vue-sfc.ts`), consumer C (`hintsForMountAbort`): the SFC parse result gains
  `usesInject: boolean`. Needed by B6, C2.
- I9: producer B (`scanExports`, `prop-gen.ts:2787`), consumer A (`detectComponentExport`,
  `harness.ts:4681`, `:4693`): unchanged signature, the returned `ExportInfo[]` carries the unwrapped
  identifier with `isDefault: true`. Needed by B1.

Conflicts in `M107-M117-MAP.md`: C4 — `formatExplainProps` (`analyze.ts:2601-2710`): C1's re-export
line is one insertion beside the `binding:` line, landing after M112's preset step and before M117's
dedup; C5 and C6 — M112 lands its warning records and its declared-but-unbuilt stylesheet branch
first; C8 — M108 lands its page-error replay before A6; C9 — A3's `ignoredKeys` and `root` work
lands before M117's plugin names.

## Verification

1. `vitest run <the eight test files> --maxWorkers=2` passes and the existing lane A/B/C tests stay
   green, the map's baseline failures excepted. 2. `node node_modules/typescript/bin/tsc --noEmit` is
   clean. 3. The corpus repros below run against a scratch dist built from this worktree.

Unit tests use new fixture directories; the map forbids editing existing ones. The quoted
`RUNTIME_STYLE_ENGINES` copy in `m82-stylesheet-selection-disclosure.md:101-108` is refreshed in the
same commit, coordinator-owned.

- A1, A2, C4: `fixtures/griffel-project/` (`package.json` declaring `@griffel/react`, a `makeStyles`
  component, no stylesheet on disk), plus a variant importing `makeStyles` from an unlisted package.
  Assert `layer: "runtime"`, the engine list, both rendered lines.
- A3, A4, A5: `fixtures/vite-root-project/` (`root` a foldable `resolve(...)` call, `dev/index.html`
  loading `/index.js`, one stylesheet under `src/`, plus computed-`root` and
  `build.rollupOptions.input` variants). Assert the entry, the absent no-entry clause, the
  ignored-keys line for the computed variant. A third variant,
  `fixtures/vite-root-mixed-args/`, writes `root: resolve(process.env.APP_ROOT, "dev")` beside a real
  `dev/` directory: assert `root` is undefined and `ignoredKeys` carries `root`, so a call with one
  unreadable argument never folds to a root the config did not declare.
- A6: a fake Playwright page double in test/unit/console-format-substitution.test.ts, emitting
  `console` with `["Warning: %s is invalid", "size"]`, replaced the planned `fixtures/console-format/`
  project: substitution reads only the message text and its arg previews, and a browser run would
  have added a dev server and a real render to assert the same strings. Assert the recorded text,
  every placeholder the substituter names (`%s`, `%d`, `%i`, `%f`, `%o`, `%O`, `%c`), `%%`, surplus
  arguments. What the double cannot show — that `String(JSHandle)` yields the preview — is evidenced
  by the supabase-F2 corpus run below.
- B1: `fixtures/m58/hoc-default.tsx` (already `export default withTheme(Chart)`, read without
  editing). Assert `scanExports` and `detectComponentExport` both return `Chart`.
- B2, B3: `fixtures/controlled-pair/` with `open?: boolean` and `defaultOpen?: boolean`. Assert that
  no cell carries both and that the absent member appears.
- B4, B5, C1: `fixtures/barrel-reexport/` (`component.tsx` declares the props interface, `index.tsx`
  re-exports it, `broken.tsx` re-exports an unresolvable specifier), beside `fixtures/wrap-reexport.tsx`.
  Assert the followed schema, the binding line, the unresolved outcome, `explainsZeroPropCount`.
- B6, C2, C3: `fixtures/vue-inject-context/` (an SFC whose `inject()` context is undefined, an SFC
  calling an unrewritten macro). Assert the hints for a `$` frame, for an `_sfc_render` frame with and
  without `inject(`, and for `X is not defined` with an empty and a non-empty ignored-plugins list.

Corpus repros, copied from the `EVIDENCE.md` rows. Four rows are truncated there at the column width;
the `[tail]` comes from the recorded `cliArgs` in `logs/<repo>/<label>.meta.json`. One unaffected
corpus repo still reaches a report: a bounded shadcn-admin button run.

- fluentui-F3: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/fluentui/packages/react-components/react-button/library --out C:/Projekte/120fps-fieldtest/logs/fluentui --label explain-button --timeout 1500 -- src/components/Button/Button.tsx --e` `[tail: --explain-props]` prints `Stylesheets: none — styling is generated at runtime by @griffel/react; no stylesheet was needed`.
- fluentui-F1: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/fluentui/packages/react-components/react-dialog/library --out C:/Projekte/120fps-fieldtest/logs/fluentui --label run-dialog --timeout 1500 -- src/components/Dialog/Dialog.tsx --sampl` `[tail: --samples 5 --max-combos 4 --explore-budget 60 --no-deltas]`: no combo in `run-dialog.json` carries `open` and `defaultOpen` together and the `useControllableState` console errors are gone. The verdict may stay FAIL on mount timing.
- gutenberg-F2: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/gutenberg/packages/components --out C:/Projekte/120fps-fieldtest/logs/gutenberg --label ep-confirm-dialog --timeout 1500 -- src/confirm-dialog/index.tsx --explain-props` prints `Props (32):` and `  binding:  src/confirm-dialog/component.tsx:201`, matching the `F2-verify` run on the declaring file.
- react-spectrum-F3: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/react-spectrum/packages/react-aria-components --out C:/Projekte/120fps-fieldtest/logs/react-spectrum --label explain-shim-button --timeout 1500 -- ../@react-spectrum/button/src/index` `[tail: .ts --explain-props]` prints the `re-export of` line naming `@adobe/react-spectrum/Button` with a non-zero props count, or the named unresolved-re-export cause. Never `ZERO_PROPS_WARNING`.
- ark-F2: `node run120.mjs --cwd .../ark/packages/vue --label vue-dialog-trigger-real -- src/components/dialog/dialog-trigger.vue --samples 5 --max-combos 4 --explore-budget 60 --no-deltas` (recorded cwd `E:/repositories-run5/ark/packages/vue`) prints no `the component reads a global that a Vue plugin installs` line, and no hint in its place: ark's `create-context.ts` uses `provide`/`inject`, but the measured `dialog-trigger.vue` calls `useDialogContext()`, so B6 reads no `inject(` call in it and C2 forbids a hint. Amended from "the provide/inject hint in its place", which contradicted C2's MUST.
- logto-F1: `node run120.mjs --cwd .../packages/console --label explain-button --timeout 1500 -- src/ds-components/Button/index.tsx --explain-props` (recorded cwd `E:/repositories-run5/logto/packages/console`) prints `Component: Button` and an `exports:` line containing `Button`.
- vitesse-F1: `node run120.mjs --cwd /e/repositories-run5/vitesse --label real-input -- src/components/TheInput.vue --samples 5 --max-combos 4 --explore-budget 60 --no-deltas` prints the `defineModels is not defined` abort followed by a hint naming `vite.config.ts` and stating that its declared `plugins` were read but not executed.
- supabase-F2: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/supabase/apps/studio --out C:/Projekte/120fps-fieldtest/logs/supabase --label real-copybutton --timeout 1500 -- components/ui/CopyButton.tsx --samples 5 --max-combos 4 --explore-budg` `[tail: --explore-budget 60 --no-deltas]`: the captured page errors carry substituted text and no bare `%s`.
- vuetify-F1: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/vuetify/packages/vuetify --out C:/Projekte/120fps-fieldtest/logs/vuetify --label vbtn-auto --timeout 1500 -- src/components/VBtn/VBtn.tsx --framework auto --explain-props` no longer reaches the fallback warning at all: M112's declared-but-unbuilt branch returns first with `Stylesheets: none injected — package.json "exports[./styles]" declares lib/styles/main.css, which is not built yet`, so the `this package has no application entry` clause is unreachable here rather than merely absent, and no largest-fallback pick is disclosed. Amended from the earlier prediction of a rendered fallback warning naming `src/components/VField/VField.sass`. The root and entry reads are evidenced instead by `readViteConfigData` and `findProjectEntry` probes through the scratch dist (Lane A evidence below), which return the `dev` root, `ignoredKeys= resolve.alias, plugins` with no `root`, and `dev/index.js`.

### Lane A evidence

Run 2026-09-03 in `C:/Projekte/120fps-m107` on `feat/m107-run5-remediation`, scratch dist
`C:/Projekte/120fps-fieldtest/scratch/A-M114/dist/cli.js`.

1. Tests. `node node_modules/vitest/vitest.mjs run test/unit/runtime-style-engine-disclosure.test.ts
   test/unit/vite-root-entry-discovery.test.ts test/unit/console-format-substitution.test.ts
   --maxWorkers=2`: `Test Files  3 passed (3)` / `Tests  28 passed (28)`.
   The 43 test files that exercise `discoverGlobalCss`, `findProjectEntry`, `readViteConfigData`,
   `CSS_FALLBACK_WARNING`, `attachPageErrorCapture` or the `Stylesheets:` line:
   `Test Files  43 passed (43)` / `Tests  706 passed (706)`, after four assertions this milestone
   supersedes were rewritten: `runtime-style-engine-detection.test.ts` (the closed engine list, A1,
   and the two `discoverGlobalCss` runtime results that now carry `runtimeEnginesRecognised`, I5)
   and `vite-config-workspace-root.test.ts` (`root: '.'` is read now, A3). Three console-message
   test doubles (`page-errors.test.ts`, `render-health.test.ts`, `render-health-edge-cases.test.ts`)
   gained the `args()` a real `ConsoleMessage` always has, which A6 reads.
   The whole `test/unit` suite, run after them: `Test Files  318 passed (318)` /
   `Tests  4696 passed | 1 skipped (4697)`, so the map's four baseline-failure files are green too
   (lane B closed them under this milestone).
2. `node node_modules/typescript/bin/tsc --noEmit`: clean, no output.
3. Corpus, each through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs ... --cli
   C:/Projekte/120fps-fieldtest/scratch/A-M114/dist/cli.js`.

- fluentui-F3 (A1), label `M114-fluentui-F3-after`, closed.
  Before: `  Stylesheets: none found (checked the project entry, conventional filenames, and the
  largest stylesheet under the project)`.
  After: `  Stylesheets: none — styling is generated at runtime by @griffel/react, @griffel/core; no
  stylesheet was needed`. The package declares both Griffel entry points, so both are named.
- vuetify-F1 (A3, A4), label `M114-vuetify-after`, closed.
  Before: `no entry stylesheet import and no conventional global stylesheet were found, so
  src/components/VField/VField.sass was injected because it is the largest stylesheet found under
  this project; this package has no application entry (index.html or Next.js app/pages stem) of its
  own, so no import chain corroborates the pick -- it is ranked by size alone; pass --css to name
  the right one`.
  After: the run no longer reaches that warning at all — M112's declared-but-unbuilt branch, landed
  before this one, returns first with `Stylesheets: none injected — package.json "exports[./styles]"
  declares lib/styles/main.css, which is not built yet`. The false clause is gone twice over: read
  through the scratch dist, `readViteConfigData` returns
  `root= E:\repositories-run5\vuetify\packages\vuetify\dev` and
  `ignoredKeys= resolve.alias, plugins` (no `root`, because `resolve('dev')` folds, as the row
  predicted), and `findProjectEntry` returns
  `E:\repositories-run5\vuetify\packages\vuetify\dev\index.js` — the module `dev/index.html` loads
  through a root-absolute `/index.js`, so `noEntryInPackage` can never be true here again.
- supabase-F2 (A6), label `M114-supabase-after`, closed.
  Before: `- React does not recognize the \`%s\` prop on a DOM element. ... remove it from the DOM
  element. defaultVariants defaultvariants` and `- Invalid prop \`%s\` supplied to
  \`React.Fragment\`. React.Fragment can only have \`key\` and \`children\` props. data-size (×5)`.
  After: `- React does not recognize the \`defaultVariants\` prop on a DOM element. If you
  intentionally want it to appear in the DOM as a custom attribute, spell it as lowercase
  \`defaultvariants\` instead. ...` and `- Invalid prop \`data-size\` supplied to
  \`React.Fragment\`. React.Fragment can only have \`key\` and \`children\` props. (×5)`.
  `M114-supabase-after.json` contains zero occurrences of `%s`. `Result: PASS`.
- Unaffected repo, label `M114-A-shadcn-admin-after`: `src/components/ui/button.tsx
  --explain-props` still reaches `Component: Button` / `Props (32):`.
- A5 (`build.rollupOptions.input`) has no corpus row of its own: no run-5 repo declares one. It is
  unit-verified on `fixtures/vite-rollup-input/`, where the folded html input decides the
  `entry-chain` layer instead of the size-ranked fallback.
- Lane B's and lane C's repros were not re-run by lane A: nothing in `src/harness.ts` or
  `src/page-errors.ts` decides them.

Open, blocked on I5's lane C half. A2's unrecognised-engine outcome is produced
(`discoverGlobalCss` returns `source: "runtime"`, `runtimeEngines: ["@acme/styling"]`,
`runtimeEnginesRecognised: false` for a measured file importing `makeStyles` from an unlisted
package) and rendered (`formatStylesheetsLine` already carries C4's branch), but the two hops
between them live in `src/analyze.ts`, lane C's file, and were not landed: `resolveCssFiles` neither
forwards a `measuredFile` into `discoverGlobalCss` nor copies `runtimeEnginesRecognised` onto the
`CssReport` it builds (`:4674-4685`, `:2477`). Until lane C adds both, A2 is unit-verified only and
a real run never takes the branch; A1 is unaffected, because an absent
`runtimeEnginesRecognised` reads as recognised by C4's own rule. The quoted
`RUNTIME_STYLE_ENGINES` copy in `m82-stylesheet-selection-disclosure.md:101-108` is coordinator-owned
and still lists the six pre-M114 engines.

### Lane B evidence

Run 2026-09-02 in `C:/Projekte/120fps-m107` on `feat/m107-run5-remediation`, scratch dist
`C:/Projekte/120fps-fieldtest/scratch/B-M114/dist/cli.js`.

1. Tests. `node node_modules/vitest/vitest.mjs run test/unit/default-export-behind-a-wrapper.test.ts
   test/unit/controlled-pair-matrix-axes.test.ts test/unit/re-exported-props-resolution.test.ts
   test/unit/vue-setup-inject-evidence.test.ts --maxWorkers=2`:
   `Test Files  4 passed (4)` / `Tests  16 passed (16)`.
   The 71 test files that import `src/prop-gen.ts`, `src/prop-gen-values.ts` or `src/vue-sfc.ts`:
   `Test Files  71 passed (71)` / `Tests  967 passed (967)`, after three assertions this milestone
   supersedes were rewritten: `matrix-harden.test.ts` H13 and `matrix-cell-selection.test.ts`
   (an optional boolean's axis is now absent/present, B2) and `tsconfig-export-harden.test.ts` H11
   (`export default memo(Widget)` names `Widget`, not the filename fallback `Fancy`, B1).
   The map's baseline failures in `test/unit/vue-dual-block-props.test.ts` and
   `test/unit/prop-default-disclosure.test.ts` are closed: `Tests  27 passed (27)`, after
   `fixtures/vue-dual-block` joined `pnpm-workspace.yaml` with a `package.json` declaring `vue`
   (`pnpm install` adds only that importer to `pnpm-lock.yaml`) and `importVueCompiler` began
   recording why each specifier failed instead of swallowing the throw.
2. `node node_modules/typescript/bin/tsc --noEmit`: clean, no output.
3. Corpus, each through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs ... --cli
   C:/Projekte/120fps-fieldtest/scratch/B-M114/dist/cli.js`.

- logto-F1 (B1), label `M114-logto-after`, closed.
  Before: `Component: LinkButton` / `  exports:  LinkButton`.
  After: `Component: Button` / `  exports:  Button, LinkButton`.
- gutenberg-F2 (B4), label `M114-gutenberg-after`, closed for the props, open for the file name.
  Before: `Props (0):` / `  binding:  no component declaration (props read from the file itself)`.
  After: `Props (32):` / `  binding:  src/confirm-dialog/index.tsx:201`. The line is the declaring
  module's; the *file* still names the barrel, because `bindingFile` is derived in
  `src/analyze.ts:2596-2599` from the measured path. `extractPropsDetailed` now returns
  `targetFile` (`.../confirm-dialog/component.tsx`) for lane C's C1 line to consume.
- react-spectrum-F3 (B4, B5), label `M114-react-spectrum-after`, closed for lane B.
  Before: `Props (0):` and `No props extracted: component measured with empty props only; if the
  component has typed props, extraction may have failed`.
  After: `Props (32):`, no zero-props warning. The specifier resolves, so the unresolved-re-export
  record does not fire here; C1's `re-export of` line is lane C's half.
- fluentui-F1 (B2, B3), label `M114-fluentui-after`, closed.
  Before: `Prop Matrix (modalType × open × defaultOpen × inertTrapFocus × unmountOnClose)`,
  13 lines of `A component must be either controlled or uncontrolled (specify either the state or
  the defaultState, but not both).`, `Result: FAIL`.
  After: `Prop Matrix (modalType × open × inertTrapFocus × unmountOnClose)`,
  `Held absent (no value in any cell): defaultOpen, surfaceMotion, onOpenChange.`,
  zero `but not both` lines, `Result: PASS`. No combo in `M114-fluentui-after.json` carries `open`
  and `defaultOpen` together (`#2 props={"modalType":"modal","open":true}`).
  One rendering gap for lane C: an axis held at its absent member prints
  `Held at one value (not crossed at this cell cap): unmountOnClose=undefined`;
  `appendAxisCoverage` (`src/report.ts:1932`) prints `absent` only when `measuredValues === 0`.
- Unaffected repo, label `M114-shadcn-admin-after`: `src/components/ui/button.tsx --explain-props`
  still reaches `Component: Button` / `Props (32):`.
- Lane A and lane C repros (fluentui-F3, ark-F2, vitesse-F1, supabase-F2, vuetify-F1) were not run
  by lane B: nothing in `src/prop-gen.ts`, `src/prop-gen-values.ts` or `src/vue-sfc.ts` decides them.

### Lane C evidence

Run 2026-09-03 in `C:/Projekte/120fps-m107` on `feat/m107-run5-remediation`, scratch dist
`C:/Projekte/120fps-fieldtest/scratch/C-M114/dist/cli.js`.

1. Tests. `node node_modules/vitest/vitest.mjs run test/unit/zero-props-names-the-barrel.test.ts
   test/unit/mount-abort-hints-name-read-evidence.test.ts
   test/unit/runtime-style-engine-line.test.ts --maxWorkers=2`:
   `Test Files  3 passed (3)` / `Tests  19 passed (19)`.
   The 42 test files that import `src/hints.js` or exercise the zero-props, `--explain-props` and
   `Stylesheets:` surfaces of `src/analyze.ts` and `src/report.ts`:
   `Test Files  42 passed (42)` / `Tests  677 passed (677)`, no assertion rewritten. The whole
   `test/unit` suite, run after them: `Test Files  311 passed (311)` /
   `Tests  4609 passed | 1 skipped (4610)`, so the map's four baseline-failure files are green too
   (lane B closed them under this milestone).
2. `node node_modules/typescript/bin/tsc --noEmit`: clean, no output.
3. Corpus, each through `node C:/Projekte/120fps-fieldtest/tools/run120.mjs ... --cli
   C:/Projekte/120fps-fieldtest/scratch/C-M114/dist/cli.js`.

- gutenberg-F2 (C1), label `M114-gutenberg-after`, closed.
  Before: `  binding:  no component declaration (props read from the file itself)` with `Props (0):`.
  After: `  binding:  src/confirm-dialog/index.tsx:201` /
  `  re-export of src/confirm-dialog/index.tsx: measuring src/confirm-dialog/component.tsx` /
  `Props (32):`. The line lane B left open — the barrel named as the binding file — is now
  disclosed beside it, from `extractPropsDetailed`'s `targetFile` (I7).
- react-spectrum-F3 (C1), label `M114-react-spectrum-after`, closed.
  Before: `Props (0):` and `No props extracted: component measured with empty props only; if the
  component has typed props, extraction may have failed`.
  After: `  binding:  src/index.ts:77` /
  `  re-export of src/index.ts: measuring ../../@adobe/react-spectrum/src/button/Button.tsx` /
  `Props (32):`, and no `No props extracted` line anywhere in the log.
- vitesse-F1 (C3), label `M114-vitesse-after`, closed.
  Before: `Error: mount phase failed on combo 0 of TheInput.vue: page.evaluate: ReferenceError:
  defineModels is not defined` and no `What to do about it:` block.
  After: the same abort, then `What to do about it:` /
  `  a global the config's plugins would have defined is missing` /
  `    vite.config.ts declares plugins, which the harness read but did not execute; nothing defined
  defineModels.` / `    README #project-transforms`.
- ark-F2 (C2), label `M114-ark-after`, closed: the false claim is gone and the corpus row above is
  amended to the outcome C2's MUST requires.
  Before: `What to do about it:` / `  the component reads a global that a Vue plugin installs`.
  After: the abort prints no `What to do about it:` block at all. The plugin claim is gone, which is
  the finding. The provide/inject hint does not take its place here: the measured SFC
  (`src/components/dialog/dialog-trigger.vue:18`) calls `useDialogContext()`, and B6 records
  `usesInject` from the measured component's own setup block, so this run read no `inject(` call.
  C2's own rule ("only when the same run recorded an `inject(` call in the measured component;
  otherwise the abort prints no hint") and the MUST NOT decide this over the row's original
  expectation, which rested on `create-context.ts`, a file no lane reads.
- Unaffected repo, label `M114-C-shadcn-admin-after`: `src/components/ui/button.tsx
  --explain-props` still reaches `Component: Button` / `Props (32):`.
- Lane A's repros (fluentui-F3, vuetify-F1, supabase-F2) were not run by lane C: A1/A2 fill the
  `runtimeEnginesRecognised` field C4 renders, and nothing in `src/analyze.ts`, `src/hints.ts` or
  `src/report.ts` decides the entry chain or the console capture.

## Deferred

- A transitive stylesheet walk through the entry's JS imports. M71 scopes discovery to the entry's
  own side-effect imports, and vuetify's `src/styles/main.sass` is three hops away.
- `css.preprocessorOptions.additionalData` as a stylesheet source: M106 A3 already folds and replays
  it. No closed finding needs a layer from it.
- fluentui-F1's FAIL verdict and the tier budget: a sub-2 ms mount-budget miss, M117 owns the noise.
- `UNSUPPORTED_STYLE_ENGINES` (`harness.ts:1417`), which no run-5 finding named; the
  `#PopoverContent` export-suffix retest, which `src/cli.ts:343` already supports; Vue Options-API
  global detection beyond the `$` frame rule; macro support of any kind.

## Approval

Approved 2026-09-03. Commits: `b5d7070` + `b28c9cd` (lane B), `bdac910` + `88a1d61` (lane C),
`096786b` + `755d26d` (lane A), all on `feat/m107-run5-remediation`.

All fourteen MUST items (A1-A6, B1-B6, C1-C4) carry an assertion in the ten test files the
frontmatter names; re-run together at approval:
`Test Files  10 passed (10)` / `Tests  76 passed (76)`.

- Lane A (A1-A6): `Test Files  3 passed (3)` / `Tests  28 passed (28)`, the 43 files touching
  `discoverGlobalCss`/`findProjectEntry`/`CSS_FALLBACK_WARNING`/the `Stylesheets:` line
  `706 passed (706)`, `tsc --noEmit` clean. Corpus: fluentui-F3 closed (the Griffel runtime line),
  supabase-F2 closed (substituted text, zero `%s` in the JSON, `Result: PASS`), vuetify-F1 closed by
  M112's declared-but-unbuilt branch with the root and entry reads probed through the scratch dist,
  shadcn-admin unaffected. A5 has no corpus row and the spec states why (no run-5 repo declares
  `build.rollupOptions.input`); it is unit-verified on `fixtures/vite-rollup-input/`.
- Lane B (B1-B6): `Test Files  4 passed (4)` / `Tests  16 passed (16)`, the 71 files importing
  `prop-gen.ts`/`prop-gen-values.ts`/`vue-sfc.ts` `967 passed (967)`, `tsc --noEmit` clean. Corpus:
  logto-F1, gutenberg-F2, react-spectrum-F3, fluentui-F1 (`Result: PASS`, no cell carrying `open`
  with `defaultOpen`) all closed, shadcn-admin unaffected.
- Lane C (C1-C4): `Test Files  3 passed (3)` / `Tests  19 passed (19)`, the 42 files importing
  `src/hints.js` or exercising the zero-props, `--explain-props` and `Stylesheets:` surfaces
  `677 passed (677)`, the whole `test/unit` suite `4609 passed | 1 skipped`, `tsc --noEmit` clean.
  Corpus: gutenberg-F2, react-spectrum-F3, vitesse-F1, ark-F2 all closed, shadcn-admin unaffected.

Correction to the lane A evidence, verified at approval: its "Open, blocked on I5's lane C half"
paragraph is superseded. `755d26d` landed both hops — `resolveCssFiles` forwards `measuredFile`
into `discoverGlobalCss` (`src/analyze.ts:4788-4791`, callers `:2582`, `:3700`) and copies
`runtimeEnginesRecognised` onto the `CssReport` (`:4818-4820`, `:2499`) — so A2 reaches a real run,
and the `RUNTIME_STYLE_ENGINES` copy in `m82-stylesheet-selection-disclosure.md:103-111` now lists
the M114 set.

### Deferred / open

- A transitive stylesheet walk through the entry's JS imports (M71 scopes discovery to the entry's
  own side-effect imports; vuetify's `src/styles/main.sass` is three hops away).
- `css.preprocessorOptions.additionalData` as a stylesheet source: M106 A3 already folds and
  replays it.
- fluentui-F1's FAIL verdict and the tier budget: a sub-2 ms mount-budget miss, M117 owns the noise.
- `UNSUPPORTED_STYLE_ENGINES` (`harness.ts:1417`); the `#PopoverContent` export-suffix retest; Vue
  Options-API global detection beyond the `$` frame rule; macro support of any kind.
- Lane B's rendering gap for lane C, still open: an axis held at its absent member prints
  `Held at one value (not crossed at this cell cap): unmountOnClose=undefined`, because
  `appendAxisCoverage` (`src/report.ts:2056`) prints `absent` only when `measuredValues === 0`.
  B2's `Held absent (no value in any cell):` disclosure is unaffected.
- Plugin names in C3's hint arrive with M117 A3/C4.
