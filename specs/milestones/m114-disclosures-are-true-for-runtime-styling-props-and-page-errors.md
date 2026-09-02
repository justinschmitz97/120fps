---
kind: milestone
status: draft
tests:
  - test/unit/runtime-style-engine-disclosure.test.ts
  - test/unit/vite-root-entry-discovery.test.ts
  - test/unit/console-format-substitution.test.ts
  - test/unit/default-export-behind-a-wrapper.test.ts
  - test/unit/controlled-pair-matrix-axes.test.ts
  - test/unit/re-exported-props-resolution.test.ts
  - test/unit/zero-props-names-the-barrel.test.ts
  - test/unit/mount-abort-hints-name-read-evidence.test.ts
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
- B6 The run records whether the measured SFC's setup block calls `inject(`, so C2's hint has read
  evidence; the field is I8.

### Lane C (`src/analyze.ts`, `src/hints.ts`, `src/report.ts`)

- C1 A component reached through a re-export prints `re-export of <module>: measuring <module>` and
  the declaring module's props. When the specifier does not resolve, the run prints `<barrel>
  re-exports <specifier>, which did not resolve: no props were read there` in place of
  `ZERO_PROPS_WARNING`, and `explainsZeroPropCount` accepts that text.
- C2 The Vue plugin hint prints only for a `$`-prefixed proxy frame together with a read of
  undefined. A read of undefined inside an ordinary SFC render frame prints the provide/inject hint
  with the `120fps.setup.vue` provide remedy only when the same run recorded an `inject(` call in the
  measured component (B6); otherwise the abort prints no hint.
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
  record. Needed by A1, A2, C4.
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
  ignored-keys line for the computed variant.
- A6: `fixtures/console-format/`, calling `console.error("Warning: %s is invalid", "size")`. Assert
  the recorded text, `%%`, surplus arguments.
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
- ark-F2: `node run120.mjs --cwd .../ark/packages/vue --label vue-dialog-trigger-real -- src/components/dialog/dialog-trigger.vue --samples 5 --max-combos 4 --explore-budget 60 --no-deltas` (recorded cwd `E:/repositories-run5/ark/packages/vue`) prints no `the component reads a global that a Vue plugin installs` line, and the provide/inject hint in its place, because ark's `create-context.ts` uses `provide`/`inject`.
- logto-F1: `node run120.mjs --cwd .../packages/console --label explain-button --timeout 1500 -- src/ds-components/Button/index.tsx --explain-props` (recorded cwd `E:/repositories-run5/logto/packages/console`) prints `Component: Button` and an `exports:` line containing `Button`.
- vitesse-F1: `node run120.mjs --cwd /e/repositories-run5/vitesse --label real-input -- src/components/TheInput.vue --samples 5 --max-combos 4 --explore-budget 60 --no-deltas` prints the `defineModels is not defined` abort followed by a hint naming `vite.config.ts` and stating that its declared `plugins` were read but not executed.
- supabase-F2: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/supabase/apps/studio --out C:/Projekte/120fps-fieldtest/logs/supabase --label real-copybutton --timeout 1500 -- components/ui/CopyButton.tsx --samples 5 --max-combos 4 --explore-budg` `[tail: --explore-budget 60 --no-deltas]`: the captured page errors carry substituted text and no bare `%s`.
- vuetify-F1: `node C:/Projekte/120fps-fieldtest/tools/run120.mjs --cwd /e/repositories-run5/vuetify/packages/vuetify --out C:/Projekte/120fps-fieldtest/logs/vuetify --label vbtn-auto --timeout 1500 -- src/components/VBtn/VBtn.tsx --framework auto --explain-props` prints the fallback warning without the `this package has no application entry` clause (the entry resolves to `dev/index.html` under the config's `root`), keeps `src/components/VField/VField.sass` as the disclosed largest-fallback pick, and its vite-config line still reads `resolve.alias, plugins` with no `root`, because `resolve('dev')` folds.

## Deferred

- A transitive stylesheet walk through the entry's JS imports. M71 scopes discovery to the entry's
  own side-effect imports, and vuetify's `src/styles/main.sass` is three hops away.
- `css.preprocessorOptions.additionalData` as a stylesheet source: M106 A3 already folds and replays
  it. No closed finding needs a layer from it.
- fluentui-F1's FAIL verdict and the tier budget: a sub-2 ms mount-budget miss, M117 owns the noise.
- `UNSUPPORTED_STYLE_ENGINES` (`harness.ts:1417`), which no run-5 finding named; the
  `#PopoverContent` export-suffix retest, which `src/cli.ts:343` already supports; Vue Options-API
  global detection beyond the `$` frame rule; macro support of any kind.
