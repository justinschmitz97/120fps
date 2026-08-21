---
kind: milestone
status: draft
---

# M76-M83 map: field-test remediation

## STATUS: all eight implemented, 2026-08-20

Branch `feat/m76-m83-field-test-remediation`, uncommitted. Unit suite **198 files / 3466 passed / 1 skipped**, `tsc --noEmit` clean. Baseline before this work was 181 files / 3132 tests, so **+334 tests across 16 changed source files** (+2584/-271 lines). The single reported "error" is the documented `provider-wrapper.test.ts` esbuild temp-dir flake (`specs/overview/00-tdd.md`), which predates this work.

Specs remain `status: draft` — they were implemented under an explicit instruction to execute, not because they were approved. Review and promote them, or amend against what shipped.

### Still open after all eight

1. **ant-design-F3 is NOT closed.** The noise filter no longer deletes inherited props, but `@types/react` 19 carries ~170 event-handler members, so `onClick` lands past the 32-prop cap anyway. Needs a finer rank (prefer handlers the component's own code references) — see the M81 implementation findings.
2. **element-plus-F2 is detected, not root-caused.** `detectRenderHealthInconsistency` reports when a run's combo phase and scale-probe phase disagree about whether anything rendered. Why they disagree needs a live reproduction against the real repository.
3. **element-plus-F1's stack overflow never reproduced** under TS 5.9.3. Guards are defensive; the real trigger is unknown.
4. **No e2e coverage was authored or run.** The e2e files named in M79's frontmatter do not exist, and the Vue `"propsExcluded"` disclosure has no end-to-end proof that `report.combos[].disclosureReason` is actually set, because no `test/unit/*` file calls `analyze()` by repo convention. Everything is unit-tested plus source-wiring assertions. **Run `pnpm test:e2e` and add those cases before shipping.**
5. **No re-verification against the real corpus.** All twenty repositories sit at `E:\repositories\` source-only. Re-run taxonomy first — it is the cleanest control and still has no verified healthy run.


Coordination document for the eight milestones remediating the 2026-08-20 field test (`FIELD-TEST.md`, 101 findings across 20 repositories, 14 root-cause groups). Delete this file once all eight specs are approved; it exists to keep their boundaries from overlapping.

Evidence: `C:\Projekte\120fps-fieldtest\` — `EVIDENCE.md` (every finding with a repro), `findings/<repo>.md`, `profiles/<repo>.md`, `STATE.md`.

## Ordering

M76 and M77 are the wall: 8 of the ~12 measurable repositories never rendered a component, and until they do, M80-M83 cannot be validated against real code. Expect the finding count to rise once the wall is down — element-plus produced three measurement-integrity defects purely because its runs got far enough to expose them.

| # | Milestone | Group(s) | Unblocks |
|---|---|---|---|
| M76 | Layered alias resolution across the workspace | G1 | mantine, chakra-ui, cal.com |
| M77 | Type-space is not runtime-space | G3 | shadcn-ui, material-ui, chakra-ui, twenty |
| M78 | Environment preflight tells the truth | G8, half of G7 | excalidraw, solid-ui, pnp-app, preact-app |
| M79 | Diagnostics survive the failure path | G2, G11 | dub, twenty, ant-design, taxonomy |
| M80 | The measured tree is the whole component | G4 | radix-primitives, base-ui |
| M81 | Prop schemas are complete and safe to render | G9, G5 | heroui, ant-design, commerce, base-ui |
| M82 | Stylesheet selection is validated and disclosed | G6 | ant-design, cal.com, heroui |
| M83 | Modes and flags never lie about what ran | rest of G7, G10, G12-G14 | element-plus |

## Boundaries

These specs touch overlapping files. Ownership is by *behavior*, not by file, and each spec must state in `Does NOT include` which neighbouring milestone owns the adjacent behavior.

- **M76 owns** where alias sources come from and in what order. It does not change what an individual alias entry is allowed to point at — that is M77.
- **M77 owns** whether a resolved target is a runtime module at all: types-only `paths` targets, type-only imports, and the entry-extension gate. It does not change config discovery order — that is M76.
- **M78 owns** preflight checks that run *before* the harness builds: install presence, react-dom resolution, and gate parity across `--explain-props` / `--no-preflight`. It does not own what happens to warnings once a build has already failed — that is M79.
- **M79 owns** the failure path itself: warnings surviving a crash, uncaught build failures, exit codes, and hints reading the captured error. It does not add new preflight checks — that is M78.
- **M80 owns** disclosure of what was rendered. It does not change prop synthesis — that is M81.
- **M81 owns** the prop schema: which props survive the cap, in what order, and whether a synthesized value is safe to render. It does not change composition — that is M80.
- **M82 owns** stylesheet selection and its disclosure.
- **M83 owns** parity between what a flag promises and what ran, plus report self-consistency.

## A correction that changes M76's contract

The mantine failure is **not** "the upward tsconfig search stopped too early". M69 already bounds `findCompilerConfig` at the workspace root, and it correctly stops at `packages/@mantine/core/tsconfig.json` because that file exists. TypeScript behaves identically: a package config that does not `extends` the root does not inherit root `paths`. Mantine's own build resolves `@mantine/*` through its bundler, not through the package tsconfig.

So "climb past the nearest config" would be wrong — it would apply aliases TypeScript itself would not apply, and would break the M69 contract at `test/unit/tsconfig-aliases.test.ts`.

The correct contract is a **layered, disclosed fallback**: when a bare specifier that names a workspace sibling fails to resolve through the member's own config, consult the workspace-root config as an explicit fallback layer, apply it, and say so in `HarnessResult.warnings`. The alias that rescues the run must be attributable, because a user reading the report needs to know an alias came from a config their component's own package does not reference.

The same layering applies to `vite.config`: `readViteConfigData` is called with the member root only (`src/harness.ts:1538`) while `workspaceRoot` is computed one line above at `:1531` and used elsewhere in the same function. Chakra's root `vite.config.ts` carries the alias that makes `@chakra-ui/react` resolvable from source, and it is never read.

## Cross-cutting rules for all eight specs

- Anchor every claim to `file:line` read from current source. Do not copy line numbers from `FIELD-TEST.md` without re-reading — the report was written against the 0.5.0 build and lines may have moved.
- Every spec lists the field-test finding IDs it closes, so the report and the specs stay traceable to each other.
- Every acceptance criterion must be checkable against a fixture, not against a cloned repository. The repositories are at `E:\repositories\` source-only and are a manual re-verification corpus, not CI.
- Where a finding was recorded as `inferred` rather than `verified` in `EVIDENCE.md`, the spec must either verify the mechanism in source or state the behavior as observed and scope the fix to the observable.
- Two findings are **product decisions, not bugs**, and belong in ADRs rather than these milestones. Neither may be silently resolved by a milestone:
  - Vue runtime-form props (`props: {}`, Options API) are excluded by `specs/decisions/0002-typescript-only-prop-inference.md:26`. The tool behaved as specified in primevue; the defects are that the exclusion is silent and that measurement proceeds anyway. M80/M81 may fix the disclosure. Widening the scope needs a new ADR.
  - The `.js`/`.ts` entry gate at `src/cli.ts:1153` contradicts ADR 0002:20, which states "Untyped JS components: default props only" and at :26 compares runtime-form Vue to "an untyped JS React component" — both presuppose `.js` is measured. Per `specs/README.md` a spec-code mismatch is a bug, so M77 fixes the gate; but confirm the intended scope in the ADR rather than assuming.

## Corrections established during spec authoring

These supersede the corresponding claims in `FIELD-TEST.md`, which was written from black-box observation. Where they disagree, this section wins.

- **cal.com-F1's mechanism is VERIFIED, not inferred** (established by M76). `src/harness.ts:2061-2066` collapses every bare specifier to its package name before adding it to `optimizeDeps.include`, so `@calcom/ui/classNames` becomes a bare `@calcom/ui` lookup. All three failing packages genuinely lack a resolvable root: an `exports` map with no `"."` key, no `main` at all, and a `main` pointing at an unbuilt `dist/`. Vite resolves every `optimizeDeps.include` entry before pre-bundling, so the harness's own manufactured entry is what crashes.
- **ant-design-F2's "zero disclosure" is a symptom of G2, not an independent CSS defect** (established by M82). `CSS_FALLBACK_WARNING` already exists and already fires on every fallback pick (`src/harness.ts:393`). The reason no disclosure reached the user is that the harness crashed (ant-design-F1) before the report and warnings stage was ever reached. The wrong stylesheet *selection* is genuinely M82's; the missing *disclosure* on that run is M79's. Neither spec may claim to fix the other's half.
- **Widening the entry gate alone would introduce a NEW crash** (established by M77, and the single most important correction here). Vite's default `esbuild.include` is `/\.(m?ts|[jt]sx)$/`, which excludes plain `.js`; the harness's `createServer` call declares no `esbuild` key and carries no `@vitejs/plugin-react` in its plugins array. So material-ui's JSX-containing `.js` components would pass a widened `ACCEPTED_COMPONENT_EXTENSIONS` and then fail the Vite transform — trading a clear rejection for an obscure crash. M77 therefore specifies a scoped `esbuild.loader: 'jsx'` companion as a **required** part of behavior 3, not an optional extra. Any implementation that widens the gate without it is incomplete and must fail review.
- **The types-only `paths` fix needs no `@types/` substring check** (established by M77). `resolveTarget` (`src/harness.ts:1873-1933`) already returns `undefined` for a directory holding only `.d.ts` files, because none of them are in `SOURCE_EXTENSIONS`/`EXTENSIONS` and there is no `main`/`module`/`exports`. The general "has no loadable entry" rule subsumes the special case, which is both simpler and less likely to miss a variant. Prefer it over the path-substring heuristic suggested in the original brief.
- **The type-only-import half of G3 is VERIFIED, not inferred** (established by M77), by tracing bare-specifier collection through `scanExternalDeps` into Vite's eager boot-time `optimizeDeps` resolution.
- **`detect-component-export` has a test-locked silent fallback.** `test/unit/detect-component-export.test.ts:122-139` locks a filename-guess fallback for files with zero exports. M77's new "this file contains no component" error must therefore live in the `src/cli.ts` gate, not inside `detectComponentExport`, or that test breaks.
- **twenty-F3's wrong replacement message has its own root cause** (established by M79). The finding has two independent halves, and both need fixing. First, correct warnings are dropped on the crash path (G2, as reported). Second, the message that replaces them is a false positive in its own right: `src/preflight.ts:87-91`'s `css-preprocessor` recognizer performs **no availability check at all** and is absent from `SUPPORTED_TRANSFORM_PLUGINS` (`src/harness.ts:1158-1169`), so `PROJECT_TRANSFORM_WARNING` fires unconditionally for any `.scss`/`.sass`/`.less`/`.styl` import whether or not the preprocessor is installed. That is why twenty was told to install `sass` on a machine already running `sass-embedded`. Fixing the crash-path drop alone would leave the false positive intact.
- **chakra-ui-F1 and base-ui-F2 root causes confirmed in source** (M79). `hintsForReport` (`src/hints.ts:142-196`) reads only `report.combos`, and curve mode leaves `combos: []`, so a render error can never reach hint selection in that mode. Separately, `extraHintLines` maps `providerCandidates` blindly and never reads the captured page-error text, which is why every Base UI crash was blamed on a missing provider.
- **taxonomy-F1's env behavior confirmed and undocumented** (M79). `readEnvDefines` (`src/harness.ts:962-990`) reads only `.env` and `.env.local` and defines `process.env` as `{}`. The invoking shell's environment is genuinely never read, and neither `--help` nor `README.md` mentions `.env` at all (both grepped, zero hits). The documentation gap is part of M79's scope.
- **No process-level handlers exist** (M79, grep-verified): zero `unhandledRejection` or `uncaughtException` handlers anywhere in `src/`, and `main()` is invoked with no `.catch`. The `--help` exit-code table at `src/cli.ts:744-747` documents `2 = setup error`, which the observed exit 1 contradicts.
- **The react-dom misdiagnosis is LOCKED IN BY AN EXISTING TEST** (established by M78). `test/unit/react-version-boot-gate.test.ts:51-53` currently asserts the buggy fallback message for a project with zero `node_modules` — that is, it encodes the excalidraw-shaped bug as expected behavior. M78 cannot pass without editing that assertion, and the edit must appear under `Changed contracts`. An implementer who sees this test fail and "fixes" the code to satisfy it has restored the defect. Flag this in the implementation brief.
- **`--explain-props` contradicts its own stated intent** (M78). `explainProps` (`src/analyze.ts:1644-1706`) never calls `runPreflight` or `assertReactDomClient`; it runs only `resolveProjectPaths` and `extractPropsDetailed`. The comment adjacent to its call site at `src/cli.ts:952-953` states the opposite intent. The gate-parity fix is restoring documented behavior, not adding new behavior.
- **The Preact risk is real specifically for Vite-config projects** (M78, sharper than the original brief). `readViteConfigData`'s `resolve.alias` output is already merged into the harness's own Vite alias list, so a Vite **literal-path** alias to Preact is genuinely mounted. A webpack or Next.js **bare-specifier** alias is dropped by the `fs.existsSync` requirement instead — verified against the real `next.config.js` in the preact-app corpus. So preact-app-F3's silent-mismeasurement risk applies to the Vite-config shape, and the webpack shape fails differently. The two need separate fixtures.
- **excalidraw-F3's compounding note has a mechanism** (M78): `transformHits` populate before the preflight hard-check throws, and the outer catch at `src/analyze.ts:2407-2415` unconditionally appends `transformFailureNote`. That is why a CSS-preprocessor complaint stacks on top of an unrelated primary failure.
- **M71 already computes the discovery layer** (`CssDiscovery.source`: `entry` / `candidate` / `fallback` / `none`) but never surfaces it to `CssReport` or the JSON. M82 is therefore mostly plumbing an existing value outward, not inventing a new one.
- **CORRECTION (M82 implementation): the fingerprint hazard below was NOT real.** `buildEnvFingerprint` itself already guards at `src/budget.ts:477` with `...(input.css && input.css.length > 0 ? { css: input.css } : {})`, so passing `css: []` was always safe and no baseline could have been invalidated. The coordinator's warning was over-cautious. The guard-site edits in `analyze.ts` were made anyway as defence in depth (they decouple `analyze.ts` from that implementation detail) and a pinning test now asserts `buildEnvFingerprint(base)` and `buildEnvFingerprint({...base, css: []})` are identical. Keep the generalized rule below — it is sound practice — but do not repeat the claim that this specific case was broken.
- **Fingerprint hazard, caught during M82 authoring.** `buildEnvFingerprint` is called at `src/analyze.ts:846`, `:1559` and `:1887` as `ctx.cssReport ? { css: ctx.cssReport.files } : {}`. M82 requires `cssReport` to always exist so the negative case can be disclosed — which would silently change fingerprint identity for every project that has no CSS, invalidating their baselines. Those three guards must become a `.files.length > 0` check in the same change. **Any milestone that makes a previously-optional report field always-present must check the fingerprint call sites for the same hazard.**

## The compound-component defect has TWO mechanisms, not one (established by M80)

`FIELD-TEST.md` describes both radix and base-ui as "sibling parts declared in the same file". **That is only true of radix.** Verified by reading both:

- **radix** (`E:\repositories\radix-primitives\packages\react\{tabs,select,accordion}\src\*.tsx`, all three read directly): each file exports BOTH a prefixed family (`TabsList`, `TabsTrigger`, …) AND bare Radix aliases (`Root`, `List`, `Trigger`, …) from the same `export {}` block. `findRoot` (`src/composition.ts:70-88`) requires every other export to share the root's prefix, and `Root` does not share the `Tabs` prefix, so root detection fails outright. Bare aliases pass `isComponentName`'s PascalCase filter (`src/prop-gen.ts:1690-1694`) and do enter the export list, so they actively defeat the test. **This is an M17 bug.**
- **base-ui** (`E:\repositories\base-ui\packages\react\src\tabs\root\TabsRoot.tsx`): only ONE component export exists in the measured file. Sibling parts live in adjacent directories, aggregated by `tabs/index.ts` via `export * as Tabs from './index.parts'`. **M17 was never designed to see across files**, so this is a gap rather than a bug. M80 uses the file's type-only relative imports (`TabsTab`, `TabsPanel`, lines 12-13) as the covering signal for this shape.

Consequence for implementers: a disclosure signal that only inspects same-file exports covers radix and misses base-ui entirely. M80 also names, and explicitly defers, the underlying `findRoot` prefix bug and a fixed-length-slice bug in `classifySuffix` (`src/composition.ts:61-68`) — fixing those would actually close radix's gap rather than disclose it, which is out of scope.

## `--explain-props` diverges from the run for TWO separate reasons

Both verified; M81 and M83 each own one, and neither fix covers the other.

- Value resolution never reads the degenerate flag: `grep degenerate src/prop-gen-values.ts` returns zero hits, so the run injects `{}` for props the dry run correctly flagged (base-ui-F3). **M81 owns this.**
- Warnings never reach the measurement path: `extractSchemas` (`src/analyze.ts:2056-2065`) calls `extractProps` **without** `onWarning`, so `extractPropsDetailed`'s warnings are dropped on the real run even though `--explain-props` prints them. **M83 owns this** as part of mode/flag parity.

Also confirmed for verdict design: `report.pass = combos.every(c => c.verdict !== "fail")` (`src/analyze.ts:537`), so a WARN combo keeps `report.pass: true` — WARN is the correct "still green, actively flagged" bucket, and `JSON.stringify(report, …)` (`:864`) serializes the report object directly, so any new field is JSON-visible with no extra wiring.

## element-plus-F3 is a placeholder-synthesis defect, not harness noise (established by M83)

The field test hypothesised that avatar.vue's WARN verdicts came from the harness polling its own internal URL. **That hypothesis is wrong.** The 404s are the tool's own `"test"` string placeholder, synthesized into an image `src` prop and then relative-resolved by the browser against the harness's serving root — verified against `src/prop-gen-values.ts:126-147` and `avatar.vue:33-36`.

This puts the finding in the same family as commerce-F1 (`"test"` into `currencyCode`) and base-ui-F2 (`"120fps-placeholder"` into a `render` validator): **a placeholder value that is syntactically a string but semantically invalid for the prop's role.** M81 owns the synthesis fix; M83 keeps only the attribution rule that a request the harness itself caused must not be charged to the component's verdict. Neither spec may claim the finding alone.

## Two findings resolved outright by source reading (M83)

- **chakra-ui-F7 is NOT a defect.** `detectComponentExport`'s pick of `DialogRootProvider` over `DialogRoot` is correct by JavaScript export semantics. Close it as working-as-intended rather than fixing it.
- **primevue-Minor1 IS a defect, now confirmed.** The `.fixture.tsx` extension the tool suggests for `.vue` candidates is never accepted by the loader. The field test left this untested; it is real.

## element-plus-F4 is an ordering bug (M83)

Sharper than "the leak heuristic ignores the noise verdict": the isolation verdict is computed at `src/analyze.ts:809` and `report.noise` is not populated until `:826` — seventeen lines later in the same function. The noise classification does not yet exist when the leak verdict is decided, so no amount of checking would help until the order changes.

## Why harness directories survive a crash (M83)

`bootServer`'s catch (`src/harness.ts:1719-1724`) performs no `rmSync`, and `cleanup` (`:1734-1737`) is reachable only on the success path. `sweepStaleHarnessDirs` (`:1795-1813`) is age-gated at one hour, so it never covers a directory the current run just created and abandoned.

## `ctx.disclosureReason` was a stale snapshot (found during the Vue producer work)

M80's plumbing was dead in **two** ways, not one. Beyond having no producer, `ModeContext`'s `disclosureReason` was a **value-spread computed at `ctx` construction**, which happens strictly before `getSchemas()`/`extractSchemas()` runs in the combo and matrix pipelines. Any value set inside `extractSchemas` — exactly what M80's spec describes the producer doing — could never reach the final `Report`. `"uncomposed"` was unaffected because it is assigned earlier, before `ctx` is built; only `"propsExcluded"` was affected.

Fixed by converting that one field to a getter (`get disclosureReason() { return disclosureReason; }`). **Anyone adding a future `disclosureReason` producer that runs after `ctx` construction must keep the getter** — reverting it to a value spread silently disables the disclosure while leaving every test that checks `buildReport` in isolation still green.

## Correction to M80 scope 2's spec text

The spec names `src/prop-gen.ts:415` (`if (!root) return []`) as the silent-empty-return point for Vue. It is not. `createVueScripts`'s `resolve()` returns `""` (defined, not `undefined`) for the virtual `.vue.ts` entry of any SFC lacking `<script setup>`, so `root` is never `undefined` in practice. The real convergence point for all three cases — no `<script setup>`, no `<script>` at all, and `<script setup>` with untyped runtime `defineProps({...})` — is `if (!call?.typeNode) return []` several lines later. The producer hooks there, gated on `parseSfcScript(...) === undefined` so the untyped-`<script setup>` case is correctly excluded (that shape is out of scope and must keep returning `[]` silently).

## OPEN WORK carried forward (must be scheduled, not forgotten)

1. ~~**M80 scope 2 is unimplemented**~~ — **DONE.** The producer exists: `detectOptionsApiProps` (`src/vue-sfc.ts:101-171`) disclosing `props`/`extends`/`mixins` without following any chain, `VUE_OPTIONS_API_PROPS_WARNING` (`src/prop-gen.ts:426-448`), and the `extractSchemas` `onWarning` wiring (`src/analyze.ts:2159-2178`) that was previously absent. Remaining gap: no end-to-end `analyze()` test proves `report.combos[].disclosureReason === "propsExcluded"` for a real Vue project, because no `test/unit/*` file calls `analyze()` by repo convention. **Add a `test/e2e/vue-support.test.ts` case whenever e2e is next run.**

1b. (superseded) original text: **M80 scope 2 is unimplemented: nothing ever produces `"propsExcluded"`.** The disclosure is plumbed end to end — `ComboReport.disclosureReason`, the verdict downgrade, the `[props excluded]` console mark, `ModeContext`/`BuildReportInput` threading, and tests — but no code path emits it, because the producer needs `src/vue-sfc.ts` (`detectOptionsApiProps`) and `src/prop-gen.ts` (`extractVueProps` sink call, `VUE_OPTIONS_API_PROPS_WARNING`, and the `extractSchemas` `onWarning` wiring). Both were outside Lane C's granted files, and the lane correctly stopped rather than reaching across. **This is a coordinator boundary error, not a worker failure.** Schedule a follow-up lane owning `src/vue-sfc.ts` + `src/prop-gen.ts` (both now free: M81's lane has finished). Until then, primevue's hollow-pass finding is NOT closed and the last acceptance bullet of M80 is unmet.
   - Note the same follow-up should carry the `extractSchemas` `onWarning` fix from the "two separate reasons" section above, since it lives in the same call path.
2. **ant-design-F3 remains open** (event-handler ranking ceiling — see the M81 implementation findings).
3. **`server.close()` hang after an explicit `transformRequest()`** — unowned; M79 or M83 should adopt it.
4. **element-plus-F1 and excalidraw-F4** both need re-testing against the real repositories once M76/M77/M78 land, since neither reproduced under fixtures.

## Correction to M80's own spec text

The spec's comment block implies `TabsTab` surfaces alongside `TabsPanel` for the base-ui shape. Verified against `SUFFIX_MAP`: there is no `Tab$` pattern, so `classifyByStem("TabsTab", "TabsRoot")` yields suffix `"Tab"` → `"unknown"`. Only `TabsPanel` surfaces, so `declaredCompositionSiblings` returns one entry rather than two. The acceptance criterion (non-empty) still holds and the disclosure still fires, but the warning will not name `TabsTab`. Fix the spec prose, not the code.

## Findings from M76/M77 IMPLEMENTATION

- **The `esbuild: { loader: 'jsx' }` prescription is INFEASIBLE as literally written** — including as this map stated it earlier. Vite's `vite:esbuild` plugin applies ONE `loader` value to every file its `include`/`exclude` filter matches. Setting `loader: "jsx"` routes `.ts`/`.tsx` through the JSX loader too, and `esbuild.transformSync("interface X{}", { loader: "jsx" })` throws (verified against esbuild 0.25.12). That reproduces the exact obscure crash the companion fix exists to prevent, merely relocated.
  - **Correct implementation, now shipped:** a standalone Vite plugin `jsxInJsPlugin()` with `enforce: "pre"` that transforms only `.js` outside `node_modules` via `transformWithEsbuild(..., { loader: "jsx" })`, leaving `vite:esbuild` to own `.ts`/`.tsx`/`.jsx`/`.mts` unchanged. Verified end to end against a real `buildAndServe()` server: transform completes in ~20ms and returns `React.createElement` output importing the pre-bundled `react`.
  - Anyone revisiting M77 must not "simplify" this back into a top-level `esbuild` option.
- **The `withProductionResolution` hazard does NOT apply to M77's new checks.** `resolveTarget`/`resolveDirectoryEntry` and `installedPackageDir`/`isInstalledOnResolutionChain` are pure `fs.existsSync`/`statSync` probes with no `require.resolve` or `createRequire`, so the vitest `NODE_PATH` hoisting problem cannot affect them. The warning in the original brief was over-cautious for this milestone.
- **Ambiguity in M76's own spec text**, resolved conservatively: it says "the same manifest-then-index logic already applied to local aliased targets" (which describes `resolveTarget`) while citing `resolveDirectoryEntry, :1873-1893` (manifest-only, no index fallback). The implementation followed the literal citation for M76's workspace-sibling check, and `resolveTarget` for M77's type-only-package check, as those specs each explicitly name. If the intent was otherwise, fix the spec text rather than the code.
- **Open, unowned: `server.close()` hangs after an explicit `transformRequest()`.** Reproduced consistently under vitest (60s timeout) when a test calls `harness.server.transformRequest()` outside the normal browser-navigation path, even though the transform itself completes in ~20ms both standalone and in vitest. Traced to dev-server teardown, not to any M77 code. The corresponding regression test was removed rather than left flaky. No spec owns dev-server lifecycle — **M79 or M83 should pick this up**, since both touch harness lifecycle.

## Findings from M81 IMPLEMENTATION (these supersede the spec-authoring conclusions above)

- **CONFLICT-1 is FALSIFIED, not merely resolved.** All three forwardRef fixtures — including Fixture B, excalidraw's exact shape (destructured arrow parameter, no annotation) — extract `required`/`optional` flags correctly against TypeScript 5.9.3 with **zero source changes**. The test file passed on its first run before `prop-gen.ts` was touched. `checker.getTypeAtLocation` does resolve `forwardRef`'s contextual typing in this ad hoc extraction call.
  - **Most likely real cause of excalidraw-F4: that repository had no `node_modules` at all.** Without `@types/react` installed, `forwardRef`'s contextual typing has nothing to resolve against, so the props type degrades — while the non-forwardRef siblings that extracted correctly carried inline annotations needing no ambient types. That reclassifies excalidraw-F4 from a prop-extraction defect to another symptom of the uninstalled-project case, which is **M78's** territory. Re-test it after M78 lands rather than treating it as open M81 work.
- **The 32-prop cap does not save `onClick` on a real `@types/react` surface.** Verified empirically: `@types/react` 19's `DOMAttributes` carries roughly 170 `on*`/`on*Capture` members, so under M81's Tier-2 "any event handler" rule a component extending the full `HTMLAttributes & ButtonHTMLAttributes` surface places `onClick` at stable-order index ~145 — well past 32, so it still does not survive. M81's noise-filter fix (props are no longer *deleted* pre-cap) is real and tested, but the ranking tier is too coarse to close ant-design-F3 for the actual real-world shape. **ant-design-F3 is NOT closed.** Follow-up needs a finer rank that prefers handlers the component's own code references, or a per-component allowlist. Do not mark that finding done.
- **element-plus-F1's stack overflow could not be reproduced.** Neither a `TableProps<Node<T>>` nesting nor a self-widening `Wrap<T> = {value:T; next?:Wrap<Wrap<T>>}` produces a V8 `RangeError` under TypeScript 5.9.3 — TS's own instantiation-depth guards resolve both gracefully. The defensive try/catch guards are implemented and the "never crashes" contract is pinned by tests, but no evidence gathered here proves the catch branches ever fire. The real trigger in element-plus remains unknown; re-test against the real repo after M76/M77 land.
- **The spec's suggested `isReactNodeMember` heuristic was unsafe and was replaced.** "Provably assignable from `string`" misclassifies, because `string` is assignable to itself and to `Iterable<string>` (strings are iterable), which wrongly typed plain string props and the Iterable fixture as `reactnode`. The implementation uses a whole-type exact-name check (`checker.typeToString(type) === "ReactNode"`), verified by compiler-API probe: TypeScript preserves the alias name only at the un-decomposed top level, and `ReactNode`'s decomposed members never individually print `ReactNode`. Anyone revisiting this must not reinstate the assignability test.
- **`VariantProps<typeof x>` over this repo's `cva-lib.ts` does NOT produce zero-declaration members** (probe-verified: declarations trace back to the local `variants` object literal). Genuine zero-declaration members require a non-homomorphic mapped type (`{[P in K]: V}` over a literal `K`). Any future fixture meant to reproduce heroui's shape must use that construction.

## CONFLICT-1 — RESOLVED by M81

Both findings were correct; they tested different declaration shapes. Established by reading both components' actual source:

- `radix-primitives/packages/react/select/src/select.tsx:312-314` declares `function SelectTrigger(props: ScopedProps<SelectTriggerProps>, forwardedRef)` — an **explicit parameter type annotation**. Extraction works.
- `excalidraw/packages/excalidraw/components/FilledButton.tsx:39-55` declares `(destructured, ref) => …` with **no annotation**, relying on `forwardRef`'s contextual typing. Extraction reports 8 of 11 optional fields as required.

The discriminator is annotation presence, **not** arrow-versus-function-expression syntax — both syntactic forms hit identical code at `src/prop-gen.ts:620-628,930-946`. Never write "forwardRef extraction is broken"; the accurate statement is that extraction degrades when the props type is only available through contextual typing. Whether `checker.getTypeAtLocation` resolves contextual typing reliably in an ad hoc (non-`getDiagnostics()`) call is a TypeScript compiler-API property that fixtures must settle, not source reading.

## A second correction to ant-design-F3, verified by coordinator

The report attributes ant-design's missing `onClick` and ~40 DOM attributes to the 32-prop cap. **That is wrong, and the real cause is a different mechanism.** There are two distinct filters in `src/prop-gen.ts`, not one:

- `isNoiseProp` (`:991`) tested against `REACT_TYPE_PACKAGE` (`:970`, matching `node_modules/@types/react`) **fully removes** matching props at `:1003`, before any ordering or capping happens.
- `MAX_PROPS = 32` (`:976`) with the `declaredHere` ordering then applies at `:1011-1016` to whatever survived.

Props inherited from `React.HTMLAttributes` live in `@types/react`, so they are deleted by the noise filter and never reach the cap at all. M81's ranking work fixes heroui and chakra; it does **not** fix ant-design. That needs the noise filter to stop removing props the component demonstrably uses — `onClick` on a Button is not noise. Implementers must treat these as two separate fixes with two separate tests.

Confirmed alongside it: `grep degenerate src/prop-gen-values.ts` returns zero hits, so value resolution genuinely never consults the degenerate flag the dry run sets — base-ui-F3's root cause, verified.
