import type { InteractionType, MeasuredState, NoiseReport } from "../browser/index.js";
import type { ScalingCurve, CostAttribution } from "./metrics.js";
import type { ReactOptimizations } from "../analysis/index.js";
import type { HintId } from "./hints.js";
import type { PhaseTimings } from "./phases.js";
import type { PropProvenance } from "../props/index.js";

export type { PropProvenance };

export type { MeasuredState };

export interface Thresholds {
  mountMs: number;
  interactionMs: number;
  // One 60fps frame under 4x throttle. Used by --flat-thresholds.
  interactionStepMs: number;
  relativeMount: number;
  rerenderMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  mountMs: 50,
  interactionMs: 400,
  interactionStepMs: 67,
  relativeMount: 2.0,
  rerenderMs: 16,
};

export type ComponentTier = "T1" | "T2" | "T3" | "T4";

export interface TierBudget {
  mountMs: number;
  rerenderMs: number;
  interactionMs: number;
  // One 120fps frame is 8.33ms; under 4x CPU throttle it is the 33ms T1 allows per event.
  interactionStepMs: number;
}

export const TIER_BUDGETS: Record<ComponentTier, TierBudget> = {
  T1: { mountMs: 14, rerenderMs: 10, interactionMs: 250, interactionStepMs: 33 },
  T2: { mountMs: 44, rerenderMs: 30, interactionMs: 300, interactionStepMs: 50 },
  T3: { mountMs: 60, rerenderMs: 36, interactionMs: 350, interactionStepMs: 67 },
  T4: { mountMs: 80, rerenderMs: 48, interactionMs: 400, interactionStepMs: 100 },
};

export const CHURN_DEGRADATION_LIMIT = 2.0;

// 3x over the ~2.4 KB/cycle floor that survives warmup, 24x under the smallest leak seen.
export const LEAK_BYTES_PER_CYCLE = 8192;

export interface MachineInfo {
  cpu: string;
  cores: number;
  ramMb: number;
  os: string;
  nodeVersion: string;
  chromiumVersion: string;
}

export interface CalibrationResult {
  totalDuration: number;
  scriptDuration: number;
}

export type EnvMatch = "identical" | "normalizable" | "incompatible" | "unknown";

// `shape` versions the fingerprint independently of the baseline file's own version.
export interface EnvFingerprint {
  shape: 1;
  // Absent or 1 means a document-wide DOM count; a mismatch makes a baseline incomparable.
  metrics?: number;
  cpu: string;
  cores: number;
  os: string;
  nodeVersion: string;
  chromiumVersion: string;
  cpuThrottle: number;
  samples: number;
  calibrationTotalDuration: number;
  calibrationScriptDuration: number;
  mode: "combo" | "curve" | "matrix" | "isolation";
  css?: string[];
  wrapper?: string;
  reactCompiler?: boolean;
  // Omitted for React; a different renderer is a different measurement, never a regression.
  framework?: "vue" | "vanilla";
}

export interface TimingWithCV {
  samples: number[];
  median: number;
  p95: number;
  cv: number;
  unstable: boolean;
}

export interface InteractionReport {
  selector: string;
  type: InteractionType;
  label: string;
  timing: TimingWithCV;
  relativeTiming: number;
  portal?: boolean;
  stressPattern?: string;
  // `timing.median` covers every step; the budget is per step.
  steps?: number;
  // Set when the explore clock cut the pattern short: a 3-of-20 cycle is another interaction.
  stepsPlanned?: number;
}

export interface ComboReport {
  comboIndex: number;
  props: Record<string, unknown>;
  mount: TimingWithCV;
  unmount: TimingWithCV;
  rerender: TimingWithCV;
  rerenderChange?: TimingWithCV;
  domNodeCount: number;
  heapDelta: number;
  interactions: InteractionReport[];
  scalingCurve: ScalingCurve | null;
  rerenderScalingCurve?: ScalingCurve | null;
  relativeMount: number;
  verdict: "pass" | "warn" | "fail";
  // `phaseTimings.explore` stays the phase interval and is never a sum of these.
  exploreWallClockMs?: number;
  tier?: ComponentTier;
  hasAnimation?: boolean;
  // The settled component, or a transient scene (skeleton, fallback, pre-response render).
  measuredState?: MeasuredState;
  costAttribution?: CostAttribution;
  reactOptimizations?: ReactOptimizations;
  // This combo's own windows only; the sub-probe's go to `transitionPageErrors`.
  pageErrors?: string[];
  // Names a window, never a cause: excluded from this combo's renderHealth and verdict.
  transitionPageErrors?: { toComboIndex: number; errors: string[] };
  // "error" = nothing rendered and the page threw; "empty" = nothing rendered, nothing threw.
  renderHealth?: "error" | "empty";
  // The combo rendered part of the component; "propsExcluded" is ADR 0002's TypeScript scope.
  disclosureReason?: "uncomposed" | "propsExcluded";
  // Interaction to Next Paint in ms: the worst input-to-paint gap across the interactions.
  inp?: number;
  // Sibling-copies probe: N extra trees mounted side by side, never a prop variation.
  scaleProbe?: number;
  // `props: {}` alone is ambiguous: a component with no props at all measures the same.
  measuredWithoutProps?: boolean;
  // `<use href="#id">` targets nothing defined: the render measured a graphic that drew nothing.
  unresolvedSpriteRefs?: string[];
  // The crash came from a synthesized value: the verdict is demoted, `report.pass` ignores it.
  harnessFault?: {
    propName: string;
    value: unknown;
    provenance: PropProvenance;
    evidence: string;
  };
}

export interface PropDelta {
  propName: string;
  baseValue: unknown;
  flipValue: unknown;
  mountDelta: number;
  rerenderDelta: number;
}

export interface ScalingPoint {
  n: number;
  mount: TimingWithCV;
  rerender: TimingWithCV;
  unmount: TimingWithCV;
  domNodeCount: number;
  heapDelta: number;
  interactions: InteractionReport[];
  costAttribution?: CostAttribution;
  // "error" = nothing rendered and the page threw; "empty" = a legal short-circuit.
  renderHealth?: "error" | "empty";
  // Deduped with a (×N) repeat suffix, exactly like a combo's.
  pageErrors?: string[];
  // This point's React profiler snapshot, when the pass ran.
  reactOptimizations?: ReactOptimizations;
}

export interface ScalingCurveReport {
  propName: string;
  propKind: "array" | "number";
  reason: string;
  points: ScalingPoint[];
  mountCurve: ScalingCurve;
  rerenderCurve: ScalingCurve;
  unmountCurve: ScalingCurve;
  interactionCurves: Record<string, ScalingCurve>;
  domGrowth: ScalingCurve;
  heapGrowth: ScalingCurve;
  // Set when the DOM node count never moved: the growth class then describes nothing.
  domFlat?: boolean;
  // Present exactly when the curve verdict is `fail`.
  violation?: CurveViolation;
  // Structural counterpart to CURVE_RENDER_ERROR_WARNING, so no consumer matches its prose.
  renderErrorPoints?: CurveRenderErrorPoint[];
  // N values left out of every fit: a fit over a zero-DOM point describes no render.
  fitExcludedPoints?: number[];
}

export interface CurveRenderErrorPoint {
  // The scale-point N value (not a combo index: curve mode has no combos).
  n: number;
  pageErrors: string[];
}

export interface CurveViolation {
  kind: "growth" | "budget";
  metric: "mount" | "rerender";
  // kind: "growth"
  growthClass?: ScalingCurve["growthClass"];
  // kind: "budget"
  budgetMs?: number;
  // First measured N at or above the budget.
  crossingN?: number;
  // Largest measured N still under it; absent when the smallest N already exceeded.
  lastPassingN?: number;
  medianMs?: number;
}

export interface MatrixAxis {
  propName: string;
  values: unknown[];
  // What the component declares; `values.length` is what the truncated axis offered.
  declaredValueCount?: number;
}

export interface MatrixCell {
  comboIndex: number;
  props: Record<string, unknown>;
  mount: TimingWithCV;
  rerender: TimingWithCV;
  unmount: TimingWithCV;
  domNodeCount: number;
  tier: ComponentTier;
  verdict: "pass" | "warn" | "fail";
  // Null when this cell was not explored; only the hottest cells are.
  worstInteractionMs: number | null;
  // Copied from the combo this cell projects, so a matrix run does not drop the mark.
  disclosureReason?: "uncomposed" | "propsExcluded";
}

export interface CompoundEffect {
  props: Record<string, unknown>;
  expectedMount: number;
  actualMount: number;
  compoundDelta: number;
  significance: "high" | "medium" | "low";
}

// `measuredValues < declaredValues` means the header's `a × b` overstates the run.
export interface MatrixAxisCoverage {
  propName: string;
  declaredValues: number;
  measuredValues: number;
  heldValue?: unknown;
}

export interface MatrixReport {
  axes: MatrixAxis[];
  axisCoverage: MatrixAxisCoverage[];
  // Non-axis props no cell carries; a silently dropped prop is a different measurement.
  heldAbsentProps?: string[];
  cells: MatrixCell[];
  hotCells: MatrixCell[];
  coldCells: MatrixCell[];
  // A cell can fail on an interaction while mounting cheaply, so hotCells can miss it.
  failingCells: MatrixCell[];
  compoundEffects: CompoundEffect[];
}

export interface NormalizedDelta {
  baseline: number;
  current: number;
  deltaPercent: number;
}

export interface Regression {
  metric: string;
  baseline: number;
  current: number;
  deltaPercent: number;
  tolerance: number;
  normalized?: NormalizedDelta;
}

export interface Improvement {
  metric: string;
  baseline: number;
  current: number;
  deltaPercent: number;
  normalized?: NormalizedDelta;
}

export interface BaselineComparison {
  hasBaseline: boolean;
  regressions: Regression[];
  improvements: Improvement[];
  missingInteractions?: string[];
  envMatch?: EnvMatch;
  envMismatches?: string[];
  // Baseline and current run measured different scenes; comparison skipped.
  measuredStateMismatch?: { baseline: MeasuredState; current: MeasuredState };
  // The entry came from another environment's slot. Informational only.
  crossEnvironment?: boolean;
  // The machine was too busy to compare against.
  skippedNoisy?: boolean;
}

export interface WrapperReport {
  path: string;
  autoDetected: boolean;
  overheadMs: number;
  domNodes: number;
  // The wrapper exported a callable `setup` that ran before first render.
  hasSetup?: boolean;
}

export interface CssReport {
  // ProjectRoot-relative posix paths, in injection order.
  files: string[];
  autoDetected: boolean;
  // Which discovery layer decided, so even "none" is disclosed rather than implied.
  layer:
    | "explicit"
    | "entry-chain"
    | "known-name"
    // The package's own package.json named the stylesheet; no filename convention applied.
    | "package-declared"
    | "largest-fallback"
    | "runtime"
    | "disabled"
    | "none"
    // Discovered but unreadable: dropped, and the run measured unstyled instead of aborting.
    | "unreadable";
  // One entry per file in `files`, same order; an `unreadable` layer names the dropped file.
  details?: Array<{
    file: string;
    bytes: number;
    rules: number;
    unreadable?: string;
    // Rules of this sheet that matched at least one element under `#root`.
    matchedRules?: number;
  }>;
  // Declared by package.json but not on disk, so `layer: "none"` can say "declared, not built".
  declaredMissing?: string[];
  // The same declarations with the field that named each one and the build command.
  declaredMissingFields?: Array<{ field: string; path: string; buildCommand?: string }>;
  // present only when layer === "runtime"
  runtimeEngines?: string[];
  // Absent reads as recognised; `false` is an import from an unlisted package, weaker evidence.
  runtimeEnginesRecognised?: boolean;
  // present only when layer === "largest-fallback"
  onlyCandidate?: boolean;
  noEntryInPackage?: boolean;
  // Present only when layer === "none": what the search did and why each candidate was rejected.
  searchNotes?: string[];
}

// `detected` is the package check, `active` is what ran; a flag can make them diverge.
export interface ReactCompilerReport {
  active: boolean;
  detected: boolean;
  version?: string;
  target?: "17" | "18" | "19";
  // The runtime that major needs, when its absence is what stopped the transform.
  skipped?: { target: string; missingModule: string };
}

// Same vocabulary as `EnvFingerprint.mode`, so a report and its baseline slot agree.
export type ReportMode = "combo" | "curve" | "matrix" | "isolation";

export interface Report {
  version: 1;
  timestamp: string;
  // Optional: a report without it resolves through `deriveReportMode`.
  mode?: ReportMode;
  machine: MachineInfo;
  componentPath: string;
  componentName: string;
  calibration: CalibrationResult;
  combos: ComboReport[];
  thresholds: Thresholds;
  pass: boolean;
  fixturePath?: string;
  fixtureAutoDetected?: boolean;
  propDeltas?: PropDelta[];
  autoScalingProp?: string;
  autoScalingReason?: string;
  tieredBudgets?: boolean;
  autoComposition?: boolean;
  compositionTree?: import("../props/index.js").CompositionTree;
  nextJsShims?: string[];
  scalingCurveReport?: ScalingCurveReport;
  matrixReport?: MatrixReport;
  baseline?: BaselineComparison;
  isolation?: import("../analysis/index.js").IsolationReport;
  wrapper?: WrapperReport;
  // The preset module that supplied prop values, and which props it fed.
  propPresets?: { path: string; props: string[] };
  // How trustworthy the machine was while this ran.
  noise?: NoiseReport;
  // Recognizer codes of the project's own Vite transforms that compiled this run.
  projectTransforms?: string[];
  // Ids, never prose, so a hint can be reworded without a schema change.
  hints?: HintId[];
  // Attached only when a combo failed to render, never a finding on a healthy run.
  providerCandidates?: string[];
  // Candidates reached only through an intermediate file, so hints.ts can word it honestly.
  transitiveProviderCandidates?: string[];
  css?: CssReport;
  reactCompiler?: ReactCompilerReport;
  warnings?: string[];
  // Verdict reused from a baseline entry: source unchanged, environment identical.
  cached?: boolean;
  // Absent on a cached verdict: nothing was measured.
  phaseTimings?: PhaseTimings;
}
