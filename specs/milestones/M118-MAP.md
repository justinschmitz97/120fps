---
kind: milestone
status: approved
---

# M118 map: module layout by pipeline stage

Executes ADR 0005. Spec: `m118-module-layout.md`. Branch `feat/m118-module-layout` from d63537e.
Every worker reads this file, the ADR and the spec before acting. Line numbers below are from
d63537e and shift after wave 1: re-grep before editing.

## Goal

`src/` is nine stage directories with one-responsibility files of at most 800 lines, value imports
point downward and go through stage indexes, one helper per fact, comments without history, a
curated `src/index.ts`, and two tests that keep it so. Behaviour is unchanged: same passing tests,
same output.

## Target tree and wave 1 mapping

Wave 1 moves files with `git mv`, keeping basenames unless the row says otherwise. Content changes
in wave 1 are limited to import paths, the four location-dependent path resolutions, and
`package.json` `bin`.

| Today | Wave 1 path | Later |
|---|---|---|
| `cli.ts` | `cli/main.ts` | wave 2 split |
| `analyze.ts` | `pipeline/analyze.ts` | wave 2 split |
| `metrics.ts` | `analysis/metrics.ts` | |
| `explorer.ts` | `analysis/explorer.ts` | |
| `stress-patterns.ts` | `analysis/stress-patterns.ts` | |
| `isolation.ts` | `analysis/isolation.ts` | |
| `compare.ts` | `analysis/compare.ts` | |
| `react-profiler.ts` | `analysis/react-profiler.ts` | wave 3 moves `detectFramework` and its warnings to `project/framework.ts` |
| `measure.ts` | `browser/measure.ts` | wave 2 split |
| `discovery.ts` | `browser/discovery.ts` | |
| `page-errors.ts` | `browser/page-errors.ts` | |
| `observers.ts` | `browser/observers.ts` | |
| `noise.ts` | `browser/noise.ts` | |
| `harness.ts` | `harness/build.ts` | wave 2 split |
| `shims/*` | `harness/shims/*` | |
| `prop-gen.ts` | `props/extract.ts` | wave 2 split |
| `prop-gen-values.ts` | `props/values.ts` | |
| `prop-presets.ts` | `props/presets.ts` | |
| `composition.ts` | `props/composition.ts` | |
| `project-model.ts` | `project/model.ts` | |
| `preflight.ts` | `project/preflight.ts` | |
| `vue-sfc.ts` | `project/vue-sfc.ts` | |
| `report.ts` | `report/report.ts` | wave 2 split |
| `hints.ts` | `report/hints.ts` | |
| `ci-report.ts` | `report/ci.ts` | |
| `budget.ts` | `report/budget.ts` | |
| `index.ts` | `index.ts` | wave 3 curates |
| (new) | `shared/` | wave 3 fills |

Stage indexes: each directory gets `index.ts` that re-exports every export of its files
(`export * from "./file.js"`; named lists where `export *` would collide). `src/index.ts` keeps its
current names but sources them from stage indexes.

Import rules after wave 1:

- A file imports a sibling directly (`./file.js`) and another directory through its index
  (`../harness/index.js`). Type-only imports may name the file directly.
- Tests import `../../src/<stage>/index.js` for values. A test may import a file directly only for
  a name the stage index does not export (there should be none).
- Location-dependent code to fix in the move commit: `harness.ts:117` and `:4001` (shim dir,
  stays `shims` beside the file once the file is `harness/build.ts`), `harness.ts:3826`
  (`installRoot`: `..` becomes `../..`), `cli.ts:1465` (`../package.json` becomes
  `../../package.json`), `package.json` `bin` to `./dist/cli/main.js`, and every test that reads a
  `dist/shims` or `dist/cli.js` path.

## Allowed value-import edges

Rows import from columns (amended after wave 1, see ADR 0005 amendment: `report` sits between
`analysis` and `browser`). Type-only imports are exempt except into `cli` and `pipeline`.

| from \ to | shared | project | props | harness | browser | report | analysis | pipeline |
|---|---|---|---|---|---|---|---|---|
| cli | yes | yes | yes | yes | yes | yes | yes | yes |
| pipeline | yes | yes | yes | yes | yes | yes | yes | |
| analysis | yes | yes | yes | yes | yes | yes | | |
| report | yes | yes | yes | | yes | | | |
| browser | yes | yes | yes | yes | | | | |
| harness | yes | yes | yes | | | | | |
| props | yes | yes | | | | | | |
| project | yes | | | | | | | |
| shared | | | | | | | | |

Observed after wave 1 (663d6db): 123 cross-directory value imports, all through stage indexes.
Remaining violations, each in the boundary test's allowlist with its owner:

| Edge | Cause | Fix | Wave, owner |
|---|---|---|---|
| `harness/build.ts → analysis` | `detectFramework` | new `project/framework.ts` takes `detectFramework` and its warnings out of `analysis/react-profiler.ts` | 2a harness worker |
| `project/preflight.ts → harness` | `detectProjectTransforms`, `SUPPORTED_TRANSFORM_PLUGINS` | `project/transforms.ts` | 2a harness worker |
| `project/preflight.ts → props` | `projectCompilerOptions` | `project/compiler-options.ts` takes `projectCompilerOptions`, `createCompilerOptions`, `warnTsconfigOnce` out of `props/program.ts` | 3 |
| `project/preflight.ts → browser` | `setImportCycleReported` (run-level dedup flag in `page-errors.ts`) | move the flag and its reader to `shared/run-state.ts` or `project/` | 3 |
| `report/report.ts → analysis`, `report/hints.ts → analysis` | `isSuperlinearGrowth` value; the rest are types | `isSuperlinearGrowth` moves to `report/stats.ts`; `analysis/metrics.ts` imports it from `../report/index.js`; type imports become `import type` | 2a report worker |
| `report/ci.ts → analysis` | isolation report types | `import type` | 2a report worker |

Type cycles to break by moving types: `props/composition.ts ↔ props/extract.ts` (`props/schema.ts`,
2a props worker).

Wave 2a report lane found two more value edges from `report` into `analysis` that a type import
cannot fix: `report/stats.ts` calls `computeScalingCurve` and `attributeCost` from
`analysis/metrics.ts`, and `report/ci.ts` reads `CHURN_DEGRADATION_LIMIT` and
`LEAK_BYTES_PER_CYCLE` from `analysis/isolation.ts`. Decision: `analysis/metrics.ts` is trace math
that only `pipeline` and `report` consume, so wave 3 moves it to `report/metrics.ts` (`git mv`,
imports repointed); the two isolation thresholds are report policy like `TIER_BUDGETS`, so wave 3
moves them to `report/types.ts` and `analysis/isolation.ts` imports them from `../report/index.js`.
The two allowlist entries stay until then.

Worktree artifact, verified 2026-09-04: `test/unit/prop-cap-ranking.test.ts › variant and size
survive the 32-prop cap` fails only inside a worktree with the `node_modules` junction (expected 2
to be 32; passes in the main checkout at the same commit). A wave 2 full-suite run in a worktree
therefore shows two failures: that one and the baseline `vue-setup-inject-evidence` one.

## Wave 2 splits

Every split: new sibling files created with the moved declarations verbatim (comments included;
wave 3 cleans comments), the residual file keeps the orchestrator, the stage `index.ts` re-exports
the new files, imports between the new siblings are direct. Constants move with the function that
emits them. No file above 800 lines. Each split is one commit per directory.

Wave 2 runs in git worktrees, one branch per worker (`m118-<stage>` from
`feat/m118-module-layout`), with a `node_modules` junction to `C:\Projekte\120fps\node_modules`.
A worker edits only its directories, the tests that exercise them, and its own entries in the two
ratchet/boundary allowlists. The coordinator merges the branches.

Additions from wave 1 evidence:

- Harness worker also owns `project/`: it splits `project/preflight.ts` (1,196 lines) into the
  import-graph walk and the environment gates/remedies, creates `project/framework.ts` from
  `analysis/react-profiler.ts` (`detectFramework`, `FRAMEWORK_*`, `PREACT_*`, `SOLID_*` warnings
  and their helpers; `analysis/react-profiler.ts` imports them from `../project/index.js`), and
  creates `project/transforms.ts` so `preflight.ts` imports `./transforms.js`.
- Report worker moves `isSuperlinearGrowth` into `report/stats.ts` (`analysis/metrics.ts` and
  `report/hints.ts` import it from there), converts type-only imports from `analysis` in
  `report/ci.ts` and `report/report.ts` to `import type`, and removes the matching allowlist
  entries.
- Props worker leaves `projectCompilerOptions`, `createCompilerOptions` and `warnTsconfigOnce` in
  `props/program.ts`; wave 3 moves them to `project/compiler-options.ts`.
- Files over 800 lines with no split table (`analysis/explorer.ts` 909, `browser/discovery.ts` 823,
  `props/values.ts` 822, `report/budget.ts` 808): wave 3's comment cleanup is expected to bring them
  under the cap; any that stays above gets a split in wave 3.

### harness/ (from `build.ts`, 7,215 lines, 25 clusters)

| New file | Takes |
|---|---|
| `shims.ts` | `SHIM_MODULES`, `buildShimAliases`, `detectNextJs`, `unshimmedNextModules`, `diagnoseMissingShimExport` |
| `dirs.ts` | harness dir create/mark/sweep/teardown: `createHarnessDir`, `sweepActiveHarnessDirs`, `sweepStaleHarnessDirs`, `sweepStaleTmpDirs`, `isProcessAlive`, `removeHarnessDirWithRetries`, `HARNESS_DIR_*` |
| `server.ts` | `ServerPool`, `createServerPool`, `harnessEsbuildOptions`, `harnessServerCompileOptions`, `fsAllowDirs`, `unionCachedDeps`, `readDepCacheMetadata` |
| `renderer.ts` | `assertReactDomClient`, `assertRendererSupported`, `rendererFor`, `detectReactMajor`, `detectBundlerReactDomAlias`, `componentImportPath`, `isOutsideRoot`, `resolveJsxImportSource`, `jsxInJsPlugin` |
| `entry.ts` (split into `entry-react.ts`, `entry-vue.ts` if over 800) | `generateEntry`, `generateReactEntry`, `generateVueEntry`, `generateComposedEntry`, `renderTreeHelper`, `vueRenderTreeHelper`, `setupBlock`, `setupApiBlock`, `wrapImportLine`, `compositionToJsx`, `componentModuleImport` |
| `exports.ts` | `detectComponentExport`, `detectScaleExport`, `detectWrapper`, `resolveWrapper`, `sfcProducesComponent`, `SFC_NO_COMPONENT` |
| `css.ts` | `discoverGlobalCss`, `rankedStylesheets`, `resolveStylesheetImportTarget`, `validateCssFiles`, `entryStylesheetImports`, `CssDiscovery`, `stylesheetRuleCount`, `CSS_*` |
| `style-tooling.ts` | `resolveStyleTooling`, `detectTailwindVite`, `findPostcssConfig*`, `Tailwind3Pipeline`, `writeAnchoredTailwind3Config`, `RUNTIME_STYLE_BINDINGS`, `readPostcssPluginDeclarations` |
| `vite-config.ts` | `readViteConfigData`, `parseViteConfigFile`, `fold*`, `isFoldableCallArgument`, `VITE_CONFIG_*`, `aliasedPackageMissingEntry` |
| `env.ts` | `parseEnvFile`, `readEnvDefines`, `hasAnyEnvFile`, `NO_ENV_FILE_REMEDY_NOTE` |
| `deps-scan.ts` | `scanExternalDeps`, `walkExternalDeps`, `externalDepsWalks`, `readSpecifiers`, `declaredRuntimeEntries`, `resolveWorkspaceSourceEntry`, `isWorkspaceSibling`, `BROKEN_ALIAS_WARNING`, `TYPE_ONLY_PACKAGE_WARNING`, `UNRESOLVED_PREBUNDLE_ENTRY_WARNING` |
| `bundler-failure.ts` | `presentBundlerFailure`, `diagnoseUnbuiltWorkspacePackage`, `stylesheetReadFailureTarget`, `diagnoseNuxtBuildModule`, `stripBundlerStackFrames`, `installRoot`, `diagnoseGitignoredGeneratedFile`, `detectPackageManager`, `findLikelyGenerateCommand` |
| `prebuild.ts` | `collectStaticPreBuildWarnings`, `StaticPreBuild`, `disclosedGoverningConfigs` |
| `build.ts` (residual) | `buildAndServe`, `BuildHarnessOptions`, `HarnessResult` |
| `../project/tsconfig-aliases.ts` | `loadTsconfigAliases`, `parseTsconfigPathsConfig`, `buildPathAliasEntry`, `ALIAS_SHAPE_WARNING`, `ROOT_ABSOLUTE_ALIAS_WARNING` |
| `../project/react-compiler.ts` | `resolveReactCompilerState`, `loadReactCompilerPlugin`, `reactJsxRuntimeDeps`, `ReactCompilerTarget`, `reactCompilerRuntime*`, `reactCompilerBabelOptions` |
| `../project/transforms.ts` | `detectProjectTransforms`, `loadProjectTransformPlugins`, `SUPPORTED_TRANSFORM_PLUGINS`, `stripServerHooks` |
| `../project/resolve.ts` | `resolveLocalImport`, `resolveTarget`, `conditionalEntry`, `resolveSubpathImport`, `resolveServerConditions`, `pickConditionalTarget`, `pickSubpathImportTarget`, `resolveTypeScriptCounterpart`, `TS_COUNTERPARTS`, `SUBPATH_IMPORT_CONDITIONS`, `EXPORT_ENTRY_CONDITIONS`, `exportsRootTargets`, `exportConditionTargets`, `resolvePackageDir` (wave 3 replaces with `installedPackageDir`) |

The harness worker owns `harness/` and `project/` in wave 2. Anything moved under `project/` must
not import from `harness/`; pass shim aliases and tsconfig aliases in as parameters where the code
reads them today.

### pipeline/ (from `analyze.ts`, 4,980 lines)

| New file | Takes |
|---|---|
| `modes/context.ts` | `ModeContext`, `PredictedMode`, `predictMode` |
| `modes/combo.ts` | `runComboMode` and its helpers |
| `modes/curve.ts` | `runCurveMode`, `applyAutoScalingCurves`, `CURVE_*` |
| `modes/matrix.ts` | `runMatrixMode`, `measureStandardPropDeltas`, `propDeltasFromMeasured`, `MATRIX_*` |
| `modes/isolation.ts` | `runIsolationMode` |
| `build-report.ts` | `buildReport`, `BuildReportInput`, `detectHarnessFault`, `applyBaselineWorkflow`, `buildBaselineEntry`, `buildReactCompilerReport`, `buildCssReport` |
| `verdict-reuse.ts` | `tryReuseStoredVerdict`, `collectMachineInfo`, `optionsAllowVerdictReuse`, `projectConfigFingerprintFiles`, `legacyBaselineWarning` |
| `explain-props.ts` | `explainProps`, `formatExplainProps`, `explainValue`, `PropsExplanation`, `ExplainedProp` |
| `fixtures.ts` | `detectFixture`, `isFixturePath`, `hasScaleExport`, `resolveJsxChildCandidates`, `trialMountComposition`, `initFixtureOutcome`, `FixtureProvenance` |
| `resolve.ts` | `resolveWrapPath`, `resolveProjectPaths`, `resolveFramework`, `resolveCssFiles`, `probeStylesheetMatchStats` |
| `estimate.ts` | `estimateRunCost`, `estimateMeasuredUnits`, `estimateExplainedRunCost`, `RunCostEstimate`, `DEFAULT_PHASE_ESTIMATE` |
| `remedies.ts` | `alternativeExportNote`, `renderFailed`, `explainsZeroPropCount`, `presetAnswersRemedy`, `remediesAfterPreset`, `remedyNamesLoadedPreset`, `presetShapeDisclosure` |
| `analyze.ts` (residual) | `analyze`, `AnalyzeOptions`, `resolveProgressReporter`, `writeReportJson`, `formatAccumulatedWarnings` |

### props/ (from `extract.ts`, 3,311 lines)

| New file | Takes |
|---|---|
| `program.ts` | `ExtractionCache`, `createCachedProgram`, `resetExtractionCache`, `extractionCacheStats`, `stableStringify`, `projectCompilerOptions`, `createCompilerOptions`, `warnTsconfigOnce` |
| `schema.ts` | `PropSchema`, `PropProvenance`, `ScalingPropMatch`, `PropWarningRecord`, `WarningRecorder`, `ExportInfo` (moved here from `composition.ts`, which imports it back) |
| `vue.ts` | `findDefineProps`, `applyWithDefaults`, `createVueScripts`, `extractVueProps`, `VUE_*` warnings and their `is*Warning` predicates |
| `candidates.ts` | `collectComponentCandidates`, `selectMeasuredExport`, `selectTargetCandidate`, `resolveEntryDeclaration`, `followReExportedComponent`, `bindProps`, `applyDeclaredDefaults`, `findComponentPropsType`, `looksLikePropsType`, `componentStem` |
| `classify.ts` | `typeToSchema`, `classifyType`, `classifyTypeByShape`, `objectSchema`, `tupleSchema`, `warnCollapsedUnion`, `warnDegenerateProps`, `warnRecursive*` |
| `synthesize.ts` | `SynthContext`, `synthesizeValue`, `synthesizeElement`, `cloneSynthesized`, `collectionValue` |
| `exports.ts` | `scanExports`, `extractExports`, `extractAllProps`, `projectSourceFiles` |
| `extract.ts` (residual) | `extractProps`, `extractPropsDetailed`, `detectScalingProps`, `PropsExtraction`, `warnOnce`, `emit` |

### browser/ (from `measure.ts`, 2,099 lines)

| New file | Takes |
|---|---|
| `dom.ts` | `detectAnimations`, `countComponentNodes`, `collectUnresolvedSpriteRefs`, measured-state, network and mutation probes |
| `settle.ts` | `settleStyles`, `reportFontSettle` |
| `session.ts` | `enterHarness`, `refreshCdpSession`, `CdpHolder`, `openMeasurementSession`, `runHarnessSession`, `MeasurementSession`, `HARNESS_NAV_WAIT` |
| `retry.ts` | `classifyStall`, `withFrameStarvationRetry`, `withWarmupRetry`, `isContextLostError`, `RetryBudget`, `withContextRetry`, `CONTEXT_RETRY_WARNING`, `RETRY_BUDGET_EXHAUSTED_NOTE`, `TRACING_*`, `TARGET_CLOSED_*` |
| `pacing.ts` | `FramePump`, `createFramePump`, `MeasurementPacing`, `BrowserPool`, `createBrowserPool`, `suspendThrottle`, `MEASUREMENT_BROWSER_ARGS`, `FRAME_PUMP_WARNING` |
| `trace.ts` | `TraceEvent`, `parseTraceDuration`, `collectTrace`, `TRACE_FLUSH_TIMEOUT_MS` |
| `measure.ts` (residual) | `measureMount`, `measureRerender`, `measureWrapperOverhead`, `applyWrapperViewport`, `serializeProps`, `DegradedPassBound`, `createDegradedPassBound`, `warmupsForPosition`, `runWithSplitErrorWindows` |

### report/ (from `report.ts`, 2,203 lines)

| New file | Takes |
|---|---|
| `types.ts` | every `interface`/`type` of the Report shape, `DEFAULT_THRESHOLDS`, `TIER_BUDGETS` |
| `stats.ts` | `computeCV`, `buildTimingWithCV`, `perStepCost`, `classifyTier`, `computeVerdict`, `buildCurveReport`, `computeCurveVerdict`, `evaluateCurve`, `buildMatrixReport`, `deriveReportMode`, `describeMode`, `detectRenderHealthInconsistency` |
| `terminal.ts` | `formatTable`, `format*Output`, `append*`, `padRow`, `formatHeap`, `formatStylesheetsLine`, `presentWarnings`, `dedupeWarnings`, `formatNoiseLine`, `shortenNoiseWarning`, `attachWrapperReport` |
| `phases.ts` | `PhaseClock`, `PhaseTimings`, `createPhaseClock`, `PHASE_NAMES`, `PhaseName`, `BoundaryPhase`, `classifyPhaseLabel`, `describePhaseBreakdown`, `formatPhaseBreakdown`, `formatElapsedClock`, `formatPhaseDuration` |
| `report.ts` | deleted when empty; `index.ts` re-exports the four files |

### cli/ (from `main.ts`, 1,980 lines)

| New file | Takes |
|---|---|
| `args.ts` | `CliArgs`, `KNOWN_FLAGS`, `parseArgs`, `splitTargetSpec`, `resolveCurveOption`, `resolveReactCompilerFlag` |
| `lifecycle.ts` | `armExitWatchdog`, `abortRun`, `createRunWatchdog`, `registerTerminationHandlers`, `terminationExitCode`, `closePoolsBounded`, `sweepHarnessDirsAfterClose`, `harnessLeftoverDirs`, `watchdogAbortOutput` |
| `errors.ts` | `formatCliError`, `resolveFatalProcessError`, `pushCurrentRunWarning`, `wrapperNotFoundMessage`, `stylesheetNotFoundMessage`, `nodeVersionError` |
| `help.ts` | `helpText`, `printHelp` |
| `paths.ts` | `expandComponentPaths`, `globToRegExp`, `globRoot`, `hasComponentShape`, `isComponentFile`, `nodePathReader`, `resolveReportPaths`, `defaultJsonPathFor`, `formatJsonSplitNotice`, `componentStem` |
| `gitignore.ts` | `findGitRoot`, `needsGitignoreAdvisory`, `formatGitignoreTip`, `gitignoreTipPatterns`, `suggestedPatternFor` |
| `main.ts` (residual) | `main`, `runOne`, `writeCiFile`, `formatTotalLine`, `resolvedRootsLine`, `resolvedRootsOutput` |

## Wave 2a outcome (merged at 8e34075)

- `harness/`: `build.ts` 7,215 → 511; 16 files, largest `vite-config.ts` 713. Beyond the table:
  `css.ts` split into `css.ts` + `stylesheets.ts`; `deps-scan.ts` split into `deps-scan.ts` +
  `workspace-entries.ts`; `entry.ts` stayed one file (565). `detectReactMajor` lives in
  `project/react-compiler.ts` (its only caller), `disclosedGoverningConfigs` in
  `project/tsconfig-aliases.ts` (its only writer), `escapeRegex` in `project/tsconfig-aliases.ts`
  (imported by two harness files; wave 3 moves it to `shared/`). `harness/index.ts` carries a
  24-name compatibility re-export block from `../project/index.js` so `src/index.ts` and tests
  that read those names from `harness/index.js` still compile; wave 3 deletes it and repoints.
- `project/`: `preflight.ts` 1,193 → 666 + `preflight-gates.ts` 536; `framework.ts` 79 (from
  `analysis/react-profiler.ts`, which re-exports the four framework names for its tests; wave 3
  repoints those tests and deletes the re-export); `tsconfig-aliases.ts`, `resolve.ts`,
  `react-compiler.ts`, `transforms.ts`.
- `props/`: `extract.ts` 3,311 → 371; `program.ts` 429, `schema.ts` 64, `vue.ts` 355,
  `candidates.ts` 751, `classify.ts` 739, `synthesize.ts` 432, `exports.ts` 418. The prop-ranking
  cluster (`propRank`, `MAX_PROPS`, `isNoiseName`, `KNOWN_VARIANT_AXIS_NAMES`, …) sits in
  `program.ts` for size reasons only; wave 3 moves it to `props/rank.ts`. New export
  `resetWarnOnceCache` in `extract.ts` (called by `resetExtractionCache`).
- `report/`: `report.ts` deleted; `types.ts` 539, `stats.ts` 508, `terminal.ts` 477,
  `terminal-modes.ts` 556, `phases.ts` 169. Nine formerly private `append*`/`format*` helpers are
  exported for `terminal-modes.ts`. `budget.ts` and `types.ts` both declare `BaselineComparison`,
  `Regression`, `Improvement` (different shapes); wave 3 renames the `budget.ts` trio.
- Boundary allowlist after 2a: `project/preflight.ts → browser`, `project/preflight.ts → props`,
  `report/stats.ts → analysis`, `report/ci.ts → analysis`. Line-cap allowlist: `analysis/explorer.ts`
  909, `analysis/react-profiler.ts` 902, `browser/discovery.ts` 823, `browser/measure.ts`,
  `cli/main.ts`, `pipeline/analyze.ts` (2b), `props/values.ts` 822, `report/budget.ts` 808.

## Wave 2b outcome (merged at 9d7910e)

- `cli/`: `main.ts` 1,979 → 507; `args.ts` 637 (also `resolveMatrixOption`, `resolveIsolationOption`),
  `lifecycle.ts` 290, `errors.ts` 147, `help.ts` 100, `paths.ts` 234, `gitignore.ts` 101. Sibling
  cycle `main.ts ↔ lifecycle.ts` (`watchdogAbortOutput` reads `resolvedRootsOutput`,
  `formatTotalLine`), function-body only.
- `browser/`: `measure.ts` 2,099 → 790; `dom.ts` 306, `settle.ts` 87, `session.ts` 278, `retry.ts`
  288, `pacing.ts` 124, `trace.ts` 289. `trace.ts` also holds the `TimingResult`/`MountResult`/
  `RerenderResult`/`MeasureOptions` types and `buildTimingResult`; wave 3 may move those to
  `browser/results.ts` once `serializeProps` leaves `measure.ts`. `isolation-orchestrate.test.ts`
  now mocks `browser/measure.js` and `browser/session.js`.
- `pipeline/`: `analyze.ts` 4,980 → 787; `build-report.ts` 759, `explain-props.ts` 794, `modes/`
  (`context` 161, `combo` 403, `curve` 295, `matrix` 420, `isolation` 181), `remedies.ts` 300,
  `resolve.ts` 225, `verdict-reuse.ts` 214, `fixtures.ts` 184, `estimate.ts` 148, and
  `phases.ts` 717 (accepted: the nine phase functions `analyze()` delegates to, each with an explicit
  parameter object). The boundary test's `directoryOf` now returns the stage (first path segment),
  so `pipeline/modes/` is intra-stage.
- Ratchet test defect to fix in wave 3 task 7: the comment scanner mis-tracks quote state across a
  regex literal containing `"` (`COLLAPSED_UNION_WARNING`), so per-file comment-token counts can
  shift by a few when a file is split; the allowlist values are the scanner's own observed counts.
- Line-cap allowlist after wave 2: `analysis/explorer.ts` 909, `analysis/react-profiler.ts` 902,
  `browser/discovery.ts` 823, `props/values.ts` 822, `report/budget.ts` 808. Boundary allowlist:
  `project/preflight.ts → browser`, `→ props`, `report/stats.ts → analysis`, `report/ci.ts →
  analysis`. Duplicate names: `componentStem` (cli/paths, props/candidates), `serializeProps`
  (analysis/explorer, analysis/react-profiler, browser/measure).

Verified in the main checkout at 9d7910e (2026-09-04): `tsc --noEmit` exit 0; build exit 0 with
`dist/{analysis,browser,cli,harness,pipeline,project,props,report}` and 20 files in
`dist/harness/shims`; unit `Test Files 1 failed | 328 passed (329)`, `Tests 1 failed | 4803 passed
| 1 skipped (4805)`, the failure being the baseline `vue-setup-inject-evidence` case; e2e
`cli`, `shim-detect`, `baseline-env`, `cli-path-expansion`: 27 passed; boundary and ratchet tests
8 passed. Behaviour snapshot for later diffs, `node dist/cli/main.js fixtures/button.tsx
--explain-props` (exit 0): `Component: Button`, `binding: fixtures/button.tsx:11`, `Props (5)`
label/variant/disabled/onClick/children with values `"test"`, `"primary", "secondary", "ghost"`,
`true, false`, `(no values)`, `(no values)`; `Composition: would measure Button alone`; `Curve mode:
would not activate: no array or numeric scaling prop`; `Matrix mode: would auto-activate`;
`Estimated real run: ~1m 12s (6 combos x 10 samples; …)`; one stylesheet warning naming
`fixtures/css-font/app/globals.css` as the largest-stylesheet fallback; the dry-run closing
paragraph.

## Wave 3: shared helpers, cycles, comments, surface

Ordered task list (sequential in the main checkout, one commit each, tsc + the stage's tests per
commit, full unit suite after tasks 6 and 11):

1. `git mv src/analysis/metrics.ts src/report/metrics.ts`; repoint imports (pipeline, report,
   tests); remove the `report/stats.ts → analysis` allowlist entry.
2. `CHURN_DEGRADATION_LIMIT`, `LEAK_BYTES_PER_CYCLE` move to `report/types.ts`;
   `analysis/isolation.ts` imports them from `../report/index.js`; remove the `report/ci.ts →
   analysis` entry.
3. `project/compiler-options.ts` takes `projectCompilerOptions`, `createCompilerOptions`,
   `warnTsconfigOnce` (and `warnedTsconfigPaths`) out of `props/program.ts`; `preflight.ts` imports
   `./compiler-options.js`; remove the `preflight → props` entry.
4. `setImportCycleReported` and its flag leave `browser/page-errors.ts` for `shared/run-state.ts`
   (or `project/` if it is only read there); remove the `preflight → browser` entry. Allowlist empty.
5. `shared/fs.ts`, `shared/git.ts`, `shared/stats.ts`, `shared/clone.ts`, `shared/regex.ts`
   (`escapeRegex`), `props/serialize.ts` per the table below; callers repointed; copies deleted;
   duplicate-name allowlist empty.
6. `props/rank.ts`; delete the `harness/index.ts` compatibility block and the
   `analysis/react-profiler.ts` framework re-exports, repointing tests to `project/index.js`; rename
   the `budget.ts` `BaselineComparison`/`Regression`/`Improvement` trio to `Budget*` names.
7. Boundary test also scans dynamic `import("…")` specifiers against the edge table.
8. Comment cleanup per directory (one commit per directory): comment-token allowlist to zero.
9. Files still over 800 lines after 8 get a split (expected: `analysis/explorer.ts`,
   `analysis/react-profiler.ts` if still above); line-cap allowlist empty.
10. `src/index.ts` curated to the surface table; tests importing removed names repointed to stage
    indexes.
11. Module table in `00-tdd.md`; `02-milestones.md` entry; spec Verification filled; e2e subset.

Shared helpers (one commit per row, every former copy deleted, callers repointed):

| `src/shared/` | Replaces |
|---|---|
| `fs.ts`: `toPosix(p)` (`path.resolve` + forward slashes), `pathKey(p)` (`toPosix` lower-cased on win32, from `project/model.ts` `normalisePath`), `isFile`, `isDirectory`, `readJsonFile` | every inline `.replace(/\\/g, "/")` on a resolved path; `harness` `isFile`/`isDirectory`; ad hoc `JSON.parse(readFileSync(...))` readers (`readProjectManifest` in `project/model.ts` stays and uses `readJsonFile`) |
| `git.ts`: `findGitRoot(startDir)` | `cli` `findGitRoot`, `harness` `findGitRootUpward` |
| `stats.ts`: `median(values)`, `sampleCV(values)`, `populationCV(values)` | `measure` `computeMedian`, `report` `computeMedianLocal`, `report` `computeCV` (sample), `noise` `computeCvPercent` (population; keep as its own name, ADR 0005 item 4) |
| `clone.ts`: `cloneDeep(value)` handling Array, Date, RegExp, plain object | `props/values.ts` `cloneTemplate`, `props/synthesize.ts` `cloneSynthesized` (the RegExp branch is the union of both; a test covers each branch) |
| `props/serialize.ts`: `serializeProps` | the three copies in `analysis/explorer.ts`, `browser/measure.ts`, `analysis/react-profiler.ts` (diff the three first; if bodies differ, report before merging) |
| `props/candidates.ts` `componentStem` | `cli/paths.ts` `componentStem` (diff first) |
| `project/model.ts` `installedPackageDir` | `project/resolve.ts` `resolvePackageDir` |

Cycles: `project/framework.ts` takes `detectFramework` and its warnings from
`analysis/react-profiler.ts`; `props/schema.ts` holds the shared types; `report/hints.ts` imports
only types from other stages or the values move into `report/`.

Comments: per directory, delete milestone tokens and history clauses; keep the invariant the
comment states; delete a comment that only says what the code says. Governed by
`C:\Users\justi\.claude\skills\engineer\references\principles-comments.md`.

Curated surface for `src/index.ts`:

| Export | From |
|---|---|
| `analyze`, `AnalyzeOptions`, `buildReport`, `BuildReportInput` | `pipeline` |
| every type in `report/types.ts`, `DEFAULT_THRESHOLDS`, `TIER_BUDGETS` | `report` |
| `formatMarkdown`, `formatJUnit` | `report` |
| `loadBudgetConfig`, `validateBudgetConfig`, `BudgetConfig`, `BaselineMetrics`, `BaselineEntry` | `report` |
| `hintsForReport`, `formatHints`, `HINTS`, `HintId` | `report` |
| `parseArgs`, `CliArgs` | `cli` |
| `PropSchema`, `PropCombination` | `props` |

A test that imports a name from `../../src/index.js` that is not in this table is repointed to the
stage index.

## Wave 3 progress (2026-09-04)

- Tasks 1-4 and 7 done (a87a8b8 `report/metrics.ts`, d09dfb0 isolation thresholds in
  `report/types.ts`, 12fac9e `project/compiler-options.ts`, 5bcd98d `shared/run-state.ts`, a6f9028
  dynamic-import scan and comment-scanner fix). Boundary allowlist empty. All 28 relative
  `import("…")` in `src/` are inline type queries; the four runtime dynamic imports use computed
  or bare specifiers.
- Task 5: `shared/stats.ts` (`computeMedian`, `computeP95`, `computeCV`, `computeCvPercent`),
  `shared/regex.ts` (`escapeRegex`), `shared/git.ts` (`findGitRoot`, replacing the cli copy and
  `findGitRootUpward`), `shared/fs.ts` (`toPosix`, `pathKey`, `isFile`, `isDirectory`; inline
  backslash normalisations in `src/` 77 → 0), `props/serialize.ts` (one `serializeProps`).
  `componentStem`, `resolvePackageDir`/`installedPackageDir`, the clone pair and `readJsonFile`
  were settled by a follow-up worker (see below).
- Task 6: `props/rank.ts` (271cabd); compatibility re-exports deleted (a7a97bf); budget types
  renamed `BudgetComparison`/`BudgetRegression`/`BudgetImprovement` and `report/index.ts` uses
  `export *` for `budget.js` (a9c8e8c).
- The opus dedupe worker hung after its seventh commit with step 10 uncommitted; the coordinator
  verified the uncommitted step (tsc, 27 touched test files green) and committed it.
- Line-cap allowlist: `analysis/explorer.ts` 899, `analysis/react-profiler.ts` 890,
  `browser/discovery.ts` 823, `props/values.ts` 822, `report/budget.ts` 809.
- Task 5 follow-up (e63d0ea, 6ffa17f, fc2addb): one `installedPackageDir` (`resolvePackageDir`
  deleted; the only divergence was `isFile` versus `existsSync` on `package.json`, unreachable in
  a real install); one `cloneDeep` in `shared/clone.ts` (union of both clone helpers; a synthesized
  `RegExp` inside a generated `Map` is now cloned per entry where `cloneSynthesized` shared one
  reference, no test or output depends on that identity); `readJsonFile` in `shared/fs.ts` for the
  three readers whose try/catch wrapped only the read and parse (four readers with wider try blocks
  stay inline). `componentStem` differs between cli and props (a bare dotfile name such as `.tsx`:
  cli strips it to empty, props keeps it), so the cli copy is renamed `reportStem` (b777684) and
  both stay.
- Task 8 (comments, 5c7ed2f, df855d2, c014eae, 1f6aff8, 6d995e6, 594e683, 6c38bd1, 51e7b8b,
  fb06669): every `COMMENT_TOKENS` entry removed; `grep` for the history regex over `src/` finds
  one hit, a user-facing remedy string in `project/preflight-gates.ts`, which the scanner ignores.
  Lanes rewrote mixed comments to their invariant, deleted history-only banners, corrected stale
  flat-file path references inside rewritten comments, and stripped audit ids, review-round and
  corpus citations the regex does not catch. Unflagged comments were not audited; a stale path in
  an unflagged comment (e.g. `report/ci.ts` citing `src/isolation.ts`) may remain.
- Task 10 (36f9780): `src/index.ts` 472 names → 20 (12 runtime: `analyze`, `buildReport`,
  `DEFAULT_THRESHOLDS`, `TIER_BUDGETS`, `formatMarkdown`, `formatJUnit`, `loadBudgetConfig`,
  `validateBudgetConfig` (newly exported from `report/budget.ts`), `hintsForReport`,
  `formatHints`, `HINTS`, `parseArgs`); `export type * from "./report/types.js"` carries the
  Report types. Nothing in `test/`, `src/`, `fixtures/` or `README.md` imports the root barrel.
- Found, not fixed: `PropProvenance` is declared twice with the same literal union
  (`props/schema.ts` and `report/types.ts`); `report` may import `props`, so one declaration
  can go. Left for a follow-up.
- Remaining: task 9 (splits for `analysis/explorer.ts` 891, `analysis/react-profiler.ts` 877,
  `browser/discovery.ts` 823, `props/values.ts` 808, `report/budget.ts` 811), 11 (docs, e2e,
  spec approval), then an adversarial review of d63537e..HEAD by a non-implementer.

## Wave 4: review findings (opus reviewer, not an implementer, at e094cf8)

Verified clean: `analyze()` versus its nine phases (statement multiset diff, `await` order,
try/catch boundaries, thunk reads at the original points, `rebuildHarness` at the original two
positions, `classifyHarnessFault` byte-identical expressions); every shared helper against both old
bodies; the seven file-level sibling cycles (no top-level initialiser reads a partner binding);
the direct-run gate for `npx`, `node dist/cli/main.js` and another cwd; every changed test (357 of
391 are import-path-only; no assertion removed; `killed-run-cleanup` got stronger); move fidelity
of all 17 split commits (only `export` prefixes and import reshuffles unbalanced); no exported
name lost (916 → 1055 names); constants unchanged.

Findings and disposition:

| # | Finding | Disposition |
|---|---|---|
| 1 | `report/types.ts` comment claims `report` may not import `props`; it may, and `PropProvenance` is declared twice | fixed in wave 4: one declaration in `props/schema.ts`, `report/types.ts` re-exports it |
| 2 | `shared/run-state.ts` comment says `--no-preflight` leaves the flag unset; the walk runs regardless | comment corrected in wave 4 |
| 3 | after `runPreflightPhase` throws a hard rejection, `providerCandidates`, `transitiveProviderCandidates`, `activeTransforms` keep their initial values; unobservable because the catch rethrows before `attachHarnessContext` | comment at `analyze.ts:373` corrected in wave 4; behaviour identical on every observable path |
| 4, 5 | two tests now read the whole `pipeline/` tree, so their `toContain` assertions are wider; two `slice` ranges are unbounded | deferred: tighten to the file that holds the asserted line |
| 6 | `cloneDeep` aliases a `Map`/`Set`/class instance where `cloneTemplate` produced `{}`; unreachable because synthesis never emits those | disclosed here |
| 7 | three `budget.ts` types and cli's `componentStem` were renamed | authorised exceptions, recorded in the spec's MUST NOT |
| 9 | six comments cite files that no longer exist | fixed in wave 4 |
| 10 | ratchet blind spots: directory-level cycle check only, `function` declarations only (an `export const f = () =>` duplicate escapes), side-effect imports unparsed | deferred |
| 11 | 325 runtime values and 106 types leave the package root; none documented | CHANGELOG states it |

Correction to the shared-helpers table: `toPosix` only swaps separators; `resolvePosix` is the
one that resolves first (used at one site, `harness/server.ts`).

## Ratchet and boundary tests (written in wave 1, allowlists emptied by wave 3)

`test/unit/module-boundaries.test.ts`: reads every `.ts` under `src/` (not `shims/`), extracts
`import ... from "<rel>"` and `export ... from "<rel>"`, classifies type-only (`import type`,
`export type`), resolves the target directory, and asserts: (1) a value import into another
directory targets that directory's `index.js`; (2) the edge is in the table above; (3) no value
cycle among directories. Failures print `file:line from → to`.

`test/unit/module-ratchets.test.ts`: (1) lines per file ≤ 800 with an allowlist map `{file: cap}`;
(2) zero matches per file of `/\bM\d{2,3}\b|used to|no longer|previously/` in comment text with an
allowlist map `{file: count}`; (3) no top-level `function <name>` defined in two files, allowlist of
names. Each allowlist entry is removed as soon as it is met; a stricter observed value than the
allowlist fails the test so the allowlist cannot lag behind.

## Waves, ownership, models

| Wave | Task | Owner | Verifies |
|---|---|---|---|
| 0 | ADR, spec, map, EOL normalisation, baseline | coordinator, sonnet baseline | baseline recorded below |
| 1 | moves, stage indexes, import rewrites, path fixes, both tests with allowlists | one opus worker | tsc, full unit suite, build, `--help` |
| 2a | split `harness/` (+ `project/` extractions), `props/`, `report/` | opus, sonnet, sonnet in worktrees | tsc + own directory's tests per worker; full unit suite by a verifier after merge |
| 2b | split `pipeline/`, `browser/`, `cli/` | opus, sonnet, sonnet in worktrees | same |
| 3 | shared helpers, cycles, comments per directory, curated surface, allowlists to empty | sonnet per directory, sequential in the main tree | tsc + full unit suite per commit |
| 4 | module table in `00-tdd.md`, `02-milestones.md` entry, spec approval, e2e subset, adversarial review | coordinator, opus reviewer ≠ implementer | spec Verification section |

## Rules for every worker

- Read `C:\Users\justi\.claude\skills\engineer\SKILL.md` and
  `C:\Users\justi\.claude\skills\engineer\references\principles-refactoring.md` first.
- Node is not on the Bash PATH: `export PATH=/c/Users/justi/AppData/Local/nvm/v22.22.2:$PATH`.
- `vitest run <files> --maxWorkers=2`; never the e2e suite unless the brief names files; one vitest
  process at a time.
- No `git stash`, no `git checkout --` on files you did not change, no rebase. Commit on the branch
  named in the brief with the message prefix `M118:`.
- A move is `git mv`. Never delete and recreate a file that exists.
- Preserve line endings: all `src/` and `test/` files are LF after wave 0. After any scripted edit,
  `git diff --numstat` must show only the lines you meant to change.
- Never `Write` an existing source file; `Edit` it. New files may be written whole.
- Behaviour is frozen: no identifier renames, no signature changes, no message text changes, no
  reordering of side effects. When a split forces a choice that would change behaviour, stop and
  report.
- Report with the template in the brief: changed, verified (commands and verbatim results), facts
  (`file:line`), assumptions, open.

## Baseline (wave 0, d63537e, recorded 2026-09-04)

- `tsc --noEmit`: exit 0, no diagnostics.
- `tsc` build: exit 0; `dist/` holds one `.js`+`.d.ts` pair per source file plus `dist/shims/`
  (ten Next shims); `node dist/cli.js --help` exit 0.
- `vitest run test/unit --maxWorkers=2`: Test Files 1 failed | 326 passed (327); Tests 1 failed |
  4795 passed | 1 skipped (4797); 277 s.
  Pre-existing failure, deterministic in isolation: `test/unit/vue-setup-inject-evidence.test.ts`
  › "a project the Vue compiler does not resolve from › records why each specifier failed":
  `AssertionError: expected { __esModule: true, …(25) } to be undefined` at line 51
  (`loadVueCompiler(dir)` resolves through vitest's hoisted `NODE_PATH`; see `00-tdd.md` Tests).
- `vitest run test/e2e/cli.test.ts test/e2e/shim-detect.test.ts --maxWorkers=1`: 2 files, 15
  tests passed, 77 s.
- Wave 0 commits: c2455b8 (ADR, spec, map), c8db8be (`.gitattributes`, 42 files renormalised to
  LF; every `src/` and `test/` file is now `i/lf w/lf`).

## Verification (approved 2026-09-04 at 9ee7058)

Recorded in `m118-module-layout.md` "Verification": tsc clean; unit `1 failed | 4803 passed | 1
skipped (4805)` with the baseline failure only; e2e `cli`, `shim-detect`, `baseline-env` 24
passed; build layout mirrors `src/`; `--help` and `--explain-props` unchanged; 35 renames in the
move commit; 12 runtime exports; all four allowlists empty; 116 files, largest 783 lines.

Process notes for the next map: worktrees with a `node_modules` junction work for parallel lanes,
with the `prop-cap-ranking` artifact as the one known false failure; the only merge conflicts were
allowlist entries in `module-ratchets.test.ts`, resolved by deleting both sides; two opus workers
hung silently after finishing their edits (no process, no file change for over an hour) and were
stopped, their uncommitted work verified and committed by the coordinator; the unit suite needs
`dist/` built first.
