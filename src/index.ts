export { extractProps, extractExports, extractAllProps, detectScalingProps, projectSourceFiles, resetExtractionCache, extractionCacheStats, type PropSchema, type ScalingPropMatch } from "./props/index.js";
export {
  inferComposition,
  type ExportInfo,
  type CompositionTree,
  type CompositionNode,
  type CompositionTemplate,
} from "./props/index.js";
export {
  generateCombinations,
  generateDeltaPairs,
  generateScalingCombos,
  type PropCombination,
  type DeltaPair,
} from "./props/index.js";
export {
  buildAndServe,
  compositionToJsx,
  detectNextJs,
  buildShimAliases,
  detectWrapper,
  detectGlobalCss,
  discoverGlobalCss,
  findProjectEntry,
  entryStylesheetImports,
  largestStylesheet,
  validateCssFiles,
  detectTailwindVite,
  loadTailwindVitePlugin,
  resolveStyleTooling,
  detectUnsupportedStyleEngines,
  findPostcssConfigAbove,
  readViteConfigData,
  readEnvDefines,
  parseEnvFile,
  CSS_DROPPED_WARNING,
  CSS_FALLBACK_WARNING,
  CSS_IMPORT_SKIPPED_WARNING,
  CSS_PREPROCESSOR_MISSING_WARNING,
  UNSUPPORTED_STYLE_ENGINES,
  UNSUPPORTED_STYLE_ENGINE_WARNING,
  VITE_CONFIG_IGNORED_WARNING,
  ENV_DEFINE_PREFIXES,
  STYLESHEET_EXTENSIONS,
  type CssDiscovery,
  type StyleTooling,
  type ViteConfigData,
  detectReactCompiler,
  resolveReactCompiler,
  resolveReactCompilerState,
  loadReactCompilerPlugin,
  reactCompilerResolutionWarning,
  REACT_COMPILER_PACKAGE,
  REACT_COMPILER_DISABLED_WARNING,
  cssImportSpecifier,
  cssImportBlock,
  generateEntry,
  generateComposedEntry,
  scanExternalDeps,
  GLOBAL_CSS_CANDIDATES,
  SHIM_MODULES,
  unshimmedNextModules,
  UNSUPPORTED_NEXT_MODULE_WARNING,
  WRAPPER_CANDIDATES,
  type HarnessResult,
  type BuildHarnessOptions,
  type ComponentIdentity,
  type EntryOptions,
  reactJsxRuntimeDeps,
  type ShimEntry,
  type ReactCompilerResolution,
  type ReactCompilerState,
} from "./harness/index.js";
export {
  measureMount,
  measureRerender,
  measureWrapperOverhead,
  applyWrapperViewport,
  settleStyles,
  needsStyleSettle,
  FONT_SETTLE_TIMEOUT_MS,
  FONT_SETTLE_WARNING,
  collectTrace,
  computeMedian,
  computeP95,
  parseTraceDuration,
  tryCollectGarbage,
  detectAnimations,
  classifyMeasuredState,
  installMeasuredStateProbe,
  readNetworkProbe,
  probeLateMutation,
  beginMutationWatch,
  endMutationWatch,
  MEASURED_STATE_HOLD_MS,
  type MeasuredState,
  enterHarness,
  runHarnessSession,
  mountAndWait,
  mountAndTrace,
  rerenderAndTrace,
  HARNESS_NAV_WAIT,
  MEASUREMENT_BROWSER_ARGS,
  FRAME_PUMP_WARNING,
  createFramePump,
  rafFence,
  openMeasurementSession,
  createBrowserPool,
  type BrowserPool,
  type FramePump,
  type MeasurementPacing,
  type MeasurementSession,
  type TraceEvent,
  type MeasureOptions,
  type MeasureRerenderOptions,
  type MountResult,
  type RerenderResult,
  type TimingResult,
  type HarnessSessionOptions,
} from "./browser/index.js";
export {
  discoverInteractions,
  type InteractionDescriptor,
  type InteractionType,
  type DiscoverOptions,
} from "./browser/index.js";
export {
  explore,
  fnv1aHash,
  createRng,
  type StateNode,
  type StateEdge,
  type StateGraph,
  type PathStep,
  type ExploreOptions,
  type ExploreResult,
} from "./analysis/index.js";
export {
  parseMetrics,
  computeINP,
  computeScalingCurve,
  linearRegression,
  createCalibrationTrace,
  attributeCost,
  type CdpMetrics,
  type LongTask,
  type FrameTiming,
  type ScalingCurve,
  type ParseMetricsOptions,
  type CostAttribution,
  type CostBucket,
} from "./report/index.js";
export {
  computeCV,
  buildTimingWithCV,
  computeVerdict,
  classifyTier,
  deriveReportMode,
  formatTable,
  attachWrapperReport,
  type ReportMode,
  DEFAULT_THRESHOLDS,
  TIER_BUDGETS,
  CHURN_DEGRADATION_LIMIT,
  LEAK_BYTES_PER_CYCLE,
  type ComponentTier,
  type TierBudget,
  type TimingWithCV,
  type ComboReport,
  type InteractionReport,
  type Report,
  type PropDelta,
  type Thresholds,
  type MachineInfo,
  type CalibrationResult,
  type BaselineComparison,
  type Regression,
  type Improvement,
  type NormalizedDelta,
  type EnvFingerprint,
  type EnvMatch,
  type WrapperReport,
  type CssReport,
  type ReactCompilerReport,
} from "./report/index.js";
export { analyze, buildReport, isFixturePath, detectFixture, hasScaleExport, resolveWrapPath, resolveCssFiles, type AnalyzeOptions, type BuildReportInput } from "./pipeline/index.js";
// M65
export {
  explainProps,
  formatExplainProps,
  resolveProgressReporter,
  renderFailed,
  TARGET_WITH_FIXTURE_ERROR,
  type PropsExplanation,
  type ExplainedProp,
} from "./pipeline/index.js";
export {
  extractPropsDetailed,
  normalizeComponentName,
  type ExtractPropsOptions,
  type PropsExtraction,
  type PropWarningRecord,
} from "./props/index.js";
export {
  detectProviderImport,
  detectLocalProviderModule,
  providerCandidateLabels,
  PROVIDER_LIBRARIES,
  type ProviderHit,
} from "./project/index.js";
export { targetNotFoundMessage } from "./harness/index.js";
export { collectStaticPreBuildWarnings, assertRendererSupported, VUE_PROJECT_REACT_FILE_ERROR, resolveJsxImportSource, type StaticPreBuild } from "./harness/index.js";
export { PROVIDER_HINT_LINE } from "./report/index.js";
export { detectScaleExport, loadTsconfigAliases, findProjectRoot, sweepStaleHarnessDirs, detectComponentExport, createServerPool, SWEEP_DEP_WARNING, ALIAS_SHAPE_WARNING, BROKEN_ALIAS_WARNING, fsAllowDirs, type ServerPool } from "./harness/index.js";
export {
  createHarnessDir,
  HARNESS_DIR_UNWRITABLE,
  assertReactDomClient,
  REACT_DOM_CLIENT_MISSING,
  isOutsideRoot,
  componentImportPath,
  resolveWrapper,
} from "./harness/index.js";
export {
  findCompilerConfig,
  findWorkspaceRoot,
  resolveProjectModel,
  declaredPackages,
  isPackageAvailable,
  isPackageDeclared,
  detectPnP,
  readProjectManifest,
  WORKSPACE_LOCKFILES,
  type ProjectModel,
} from "./project/index.js";
export { scanExports } from "./props/index.js";
export {
  attachPageErrorCapture,
  enrichTimeoutError,
  enrichPhaseError,
  gotoWithErrorContext,
  mergeDrains,
  hasPageErrors,
  renderDrain,
  HARNESS_STALL_HINT,
  type PageErrorCapture,
  type PageErrorDrain,
  type MeasurementPhase,
  type PhaseContext,
} from "./browser/index.js";
export {
  resolveStressPattern,
  executeStressPattern,
  findAriaGroupSiblings,
  type StressStep,
  type StressPattern,
} from "./analysis/index.js";
// M106 C1/C2
export { type StressPatternRun } from "./analysis/index.js";
export { EXPLORE_STALLED_WARNING } from "./analysis/index.js";
export {
  detectFramework,
  diffSnapshots,
  detectMemoBailouts,
  detectContextFanOut,
  computeRenderAttribution,
  computePortalOrphans,
  hasReactWarning,
  injectProfilerHook,
  collectProfilerData,
  resetProfilerData,
  countBodyOrphans,
  generateProbeEntry,
  generateProbeHtml,
  runReactAnalysis,
  PROFILER_HOOK_SCRIPT,
  type ReactOptimizations,
  type ProfilerSnapshot,
  type ProfilerDiff,
  type FiberInfo,
  type RenderAttribution,
  type CallbackIdentityDelta,
  type ProbeEntryOptions,
  type ReactAnalysisOptions,
} from "./analysis/index.js";
export { parseArgs, resolveReactCompilerFlag, type CliArgs } from "./cli/index.js";
export {
  parseIsolationPhases,
  computeChurnDegradation,
  buildMemoryReport,
  buildStrictModeReport,
  buildRerenderIsolation,
  selectIsolationCombos,
  runIsolationPhases,
  computeIsolationVerdict,
  isolationBaselineMetrics,
  measureChurn,
  measureMemory,
  measureStrictMode,
  CHURN_CYCLES,
  DEFAULT_MEMORY_CYCLES,
  ISOLATION_WARMUP_RUNS,
  MEMORY_WARMUP_CYCLES,
  DEGENERATE_COMBO_WARNING,
  MEMORY_SKIPPED_WARNING,
  type IsolationPhase,
  type RerenderIsolation,
  type MemoryReport,
  type StrictModeReport,
  type IsolationReport,
  type IsolationComboSelection,
  type IsolationRunOptions,
  type IsolationRunResult,
  type MemoryMeasurement,
  type PhaseOptions,
} from "./analysis/index.js";
export {
  loadBudgetConfig,
  loadBaseline,
  saveBaseline,
  resolveComponentBudget,
  resolveTolerances,
  compareBaseline,
  buildEnvFingerprint,
  classifyEnv,
  computeSourceFingerprint,
  describeEnvDiff,
  envAdvisory,
  UNKNOWN_ENV_WARNING,
  NORMALIZED_FLOOR_MS,
  type BudgetConfig,
  type ComponentBudget,
  type Baseline,
  type BaselineEntry,
  type BaselineEnvPolicy,
  type BaselineMetrics,
  type EnvFingerprintInput,
  type ResolvedTolerance,
} from "./report/index.js";

// M42/M48
export {
  runPreflight,
  recognizeTransform,
  detectAsyncComponent,
  preflightFailureMessage,
  transformFailureNote,
  NODE_BUILTIN_WARNING,
  PROJECT_TRANSFORM_WARNING,
  PREFLIGHT_BYPASSED_WARNING,
  TRANSFORM_RECOGNIZERS,
  type PreflightHit,
  type PreflightResult,
  type TransformRecognizer,
} from "./project/index.js";

// M44
export {
  describePresetSibling,
  detectPropPresets,
  loadPropPresets,
  applyPropPresets,
  isPresetRef,
  UNKNOWN_PRESET_PROPS_WARNING,
  PRESET_REF_KEY,
  PRESET_SHAPE_WARNING,
  type PropPresets,
  type PresetRef,
  type PresetSibling,
} from "./props/index.js";

// M45
export {
  computeEnvKey,
  baselineKey,
  parseBaselineKey,
  selectBaselineEntry,
  BASELINE_VERSION,
  BASELINE_SLOT_TTL_DAYS,
  LEGACY_ENV_KEY,
  NO_ENV_BASELINE_WARNING,
  PRUNED_SLOTS_NOTICE,
  type BaselineSelection,
} from "./report/index.js";

// M46
export {
  classifyNoise,
  computeCvPercent,
  buildNoiseReport,
  probeMachineNoise,
  NOISE_CV_PERCENT,
  HOSTILE_CV_PERCENT,
  NOISE_PROBE_SAMPLES,
  NOISY_RUN_WARNING,
  HOSTILE_RUN_WARNING,
  NOISY_BASELINE_NOTE,
  HOSTILE_BASELINE_NOTE,
  formatNoiseWarning,
  type NoiseLevel,
  type NoiseReport,
  type NoiseSignals,
} from "./browser/index.js";

// M47
export {
  probeVolatileRegions,
  VOLATILITY_PROBE_GAP_MS,
  VOLATILE_DOM_NOTICE,
} from "./analysis/index.js";

// M49
export {
  compareAgainstRef,
  formatCompare,
  distinguishable,
  deltaPercent,
  validateCompareOptions,
  DEPENDENCY_DRIFT_ERROR,
  type CompareReport,
  type CompareCombo,
  type CompareOptions,
} from "./analysis/index.js";

// M50
export { formatMarkdown, formatJUnit } from "./report/index.js";

// M51
export {
  HINTS,
  hintsForReport,
  formatHints,
  MEASUREMENT_BASIS_LINE,
  type Hint,
  type HintId,
} from "./report/index.js";
// M105 I12
export { hintsForMountAbort } from "./report/index.js";

// M52
export {
  installObservers,
  beginObservedWindow,
  readObservedWindow,
  observedInteractionMs,
  EVENT_TIMING_THRESHOLD_MS,
  type ObservedWindow,
  type ObservedEvent,
  type ObservedLongFrame,
} from "./browser/index.js";

// M53
export { warmupsForPosition } from "./browser/index.js";
export { runWithSplitErrorWindows, type TransitionPageErrors } from "./browser/index.js";
export { countComponentNodes, totalComponentNodes, collectUnresolvedSpriteRefs, COMPONENT_NODE_COUNT_SOURCE, UNRESOLVED_SPRITE_REFS_SOURCE, COMPONENT_NODE_COUNT_EXPRESSION, UNRESOLVED_SPRITE_REFS_EXPRESSION, MAX_UNRESOLVED_SPRITE_REFS, type ComponentNodeCount } from "./browser/index.js";
export { matrixValues, matrixDeclaredValues, matrixAxesFor, matrixHeldAbsentProps, MAX_MATRIX_AXIS_VALUES, type MatrixAxisValues } from "./props/index.js";
export { TRACE_FLUSH_TIMEOUT_MS, TRACING_STALL_RETRY_WARNING, TARGET_CLOSED_RETRY_WARNING, contextRetryWarningFor, retryBudgetExhaustedNoteFor, TRACING_BUDGET_EXHAUSTED_NOTE, TARGET_CLOSED_BUDGET_EXHAUSTED_NOTE } from "./browser/index.js";
export { selectMeasuredExport } from "./props/index.js";
export { UNTYPED_JS_COMPONENT_WARNING, isUntypedJsComponentWarning } from "./props/index.js";
export { SYNTHESIZED_REQUIRED_OBJECT_WARNING, isSynthesizedRequiredObjectWarning } from "./props/index.js";
export { VUE_SETUP_RUNTIME_PROPS_WARNING, isVueSetupRuntimePropsWarning, VUE_UNRESOLVED_PROPS_TYPE_WARNING, isVueUnresolvedPropsTypeWarning } from "./props/index.js";
export { churnParitySeries, buildChurnTiming } from "./analysis/index.js";
export { EFFECTIVE_SAMPLES_WARNING } from "./pipeline/index.js";

// M57
export {
  isVueFile,
  loadVueCompiler,
  parseSfcScript,
  resetVueCompilerCache,
  virtualScriptPath,
  VUE_COMPILER_MISSING,
  VUE_SFC_SPECIFIERS,
  type SfcScript,
  type VueSfcCompiler,
} from "./project/index.js";
export {
  rendererFor,
  vueComponentName,
  generateVueEntry,
  vueRenderTreeHelper,
  sfcProducesComponent,
  SFC_NO_COMPONENT,
  type Renderer,
} from "./harness/index.js";
export { strictModeUnsupported, VUE_STRICTMODE_ERROR } from "./analysis/index.js";

// M100
export {
  alternativeExportNote,
  NO_PROPS_MEASURED_WARNING,
  ALTERNATIVE_EXPORT_WITHOUT_DEGENERATE_PROPS_NOTE,
  predictMode,
  DRY_RUN_RUNTIME_ONLY_NOTE,
  type PredictedMode,
} from "./pipeline/index.js";

// M106 C4
export { UNRESOLVED_SPRITE_REFS_WARNING } from "./pipeline/index.js";
