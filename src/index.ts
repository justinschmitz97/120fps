export { extractProps, type PropSchema } from "./prop-gen.js";
export {
  generateCombinations,
  type PropCombination,
} from "./prop-gen-values.js";
export { buildAndServe, type HarnessResult } from "./harness.js";
export {
  measureMount,
  collectTrace,
  computeMedian,
  computeP95,
  parseTraceDuration,
  tryCollectGarbage,
  type TraceEvent,
  type MeasureOptions,
  type MountResult,
  type TimingResult,
} from "./measure.js";
export {
  discoverInteractions,
  type InteractionDescriptor,
  type InteractionType,
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
  type CdpMetrics,
  type LongTask,
  type FrameTiming,
  type ScalingCurve,
  type ParseMetricsOptions,
} from "./metrics.js";
export {
  computeCV,
  buildTimingWithCV,
  computeVerdict,
  formatTable,
  DEFAULT_THRESHOLDS,
  type TimingWithCV,
  type ComboReport,
  type InteractionReport,
  type Report,
  type Thresholds,
  type MachineInfo,
  type CalibrationResult,
} from "./report.js";
export { analyze, buildReport, type AnalyzeOptions, type BuildReportInput } from "./analyze.js";
export { parseArgs, type CliArgs } from "./cli.js";
