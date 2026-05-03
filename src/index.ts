export { extractProps, extractExports, extractAllProps, detectScalingProps, type PropSchema, type ScalingPropMatch } from "./prop-gen.js";
export {
  inferComposition,
  type ExportInfo,
  type CompositionTree,
  type CompositionNode,
  type CompositionTemplate,
} from "./composition.js";
export {
  generateCombinations,
  generateDeltaPairs,
  generateScalingCombos,
  type PropCombination,
  type DeltaPair,
} from "./prop-gen-values.js";
export { buildAndServe, compositionToJsx, type HarnessResult, type BuildHarnessOptions } from "./harness.js";
export {
  measureMount,
  measureRerender,
  collectTrace,
  computeMedian,
  computeP95,
  parseTraceDuration,
  tryCollectGarbage,
  detectAnimations,
  type TraceEvent,
  type MeasureOptions,
  type MeasureRerenderOptions,
  type MountResult,
  type RerenderResult,
  type TimingResult,
} from "./measure.js";
export {
  discoverInteractions,
  type InteractionDescriptor,
  type InteractionType,
  type DiscoverOptions,
} from "./discovery.js";
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
} from "./explorer.js";
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
} from "./metrics.js";
export {
  computeCV,
  buildTimingWithCV,
  computeVerdict,
  classifyTier,
  formatTable,
  DEFAULT_THRESHOLDS,
  TIER_BUDGETS,
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
} from "./report.js";
export { analyze, buildReport, isFixturePath, detectFixture, hasScaleExport, type AnalyzeOptions, type BuildReportInput } from "./analyze.js";
export { detectScaleExport } from "./harness.js";
export {
  resolveStressPattern,
  executeStressPattern,
  findAriaGroupSiblings,
  type StressStep,
  type StressPattern,
} from "./stress-patterns.js";
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
} from "./react-profiler.js";
export { parseArgs, type CliArgs } from "./cli.js";
