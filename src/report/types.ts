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
  // Cost allowed for one interaction event. A frame at 120fps is 8.33ms, and
  // measurements run under 4x CPU throttle, so one such frame is 33ms here.
  interactionStepMs: number;
}

export const TIER_BUDGETS: Record<ComponentTier, TierBudget> = {
  T1: { mountMs: 14, rerenderMs: 10, interactionMs: 250, interactionStepMs: 33 },
  T2: { mountMs: 44, rerenderMs: 30, interactionMs: 300, interactionStepMs: 50 },
  T3: { mountMs: 60, rerenderMs: 36, interactionMs: 350, interactionStepMs: 67 },
  T4: { mountMs: 80, rerenderMs: 48, interactionMs: 400, interactionStepMs: 100 },
};

export const CHURN_DEGRADATION_LIMIT = 2.0;

// Above the ~2.4 KB/cycle floor that survives warmup, with 3x headroom under it
// and 24x under the smallest leak observed. A 1 KB/cycle threshold sits inside
// the floor and calls every component a leak.
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

// Persisted per baseline entry. `shape` versions the fingerprint independently
// of the baseline file's own version, so new fields never invalidate a file.
export interface EnvFingerprint {
  shape: 1;
  // Measurement revision: absent or 1 means the DOM count was not yet
  // component-scoped. A mismatch makes a baseline incomparable, not merely different.
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
  // Omitted for React, which every baseline without this field implicitly
  // was, so those entries keep comparing. A different framework is a different
  // renderer and a different measurement, never a regression.
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
  // Steps in the stress pattern behind `timing`. `timing.median` is the cost
  // of all of them; the budget is per step.
  // The steps that ran, so the per-step cost printed beside it
  // divides by what was actually measured.
  steps?: number;
  // Set when the explore wall clock cut the pattern short: how many steps the
  // pattern would have run. The row says so, because a 3-of-20 cycle is not
  // the interaction the pattern's name describes.
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
  // The wall clock the state graph already measured for this combo's
  // exploration. Absent when this combo was never explored. The run-level
  // `phaseTimings.explore` stays the phase interval and is never a sum of
  // these.
  exploreWallClockMs?: number;
  tier?: ComponentTier;
  hasAnimation?: boolean;
  // Whether these numbers describe the settled component or a transient
  // scene (skeleton, fallback, pre-response render).
  measuredState?: MeasuredState;
  costAttribution?: CostAttribution;
  reactOptimizations?: ReactOptimizations;
  // Uncaught exceptions and console.error output captured while this
  // combo was measured, deduped with a (×N) repeat suffix. Absent when the
  // page stayed quiet. Scoped to this combo's own windows (mount, stable
  // rerender); what the prop-delta sub-probe's rerender into the next combo's
  // props raised lives in `transitionPageErrors` instead.
  pageErrors?: string[];
  // Errors raised while the rerender
  // pass drove this combo's props into `combos[toComboIndex]`'s props to price
  // the prop delta. Reported on this row because this row's measurement is
  // what observed them, excluded from this combo's `renderHealth`,
  // `harnessFault` and verdict because this combo's own props are not what
  // was rendering. The window also spans the re-mount that precedes each
  // delta rerender, so this names a window, never a cause.
  transitionPageErrors?: { toComboIndex: number; errors: string[] };
  // "error" = nothing rendered and the page threw, which can never be a
  // pass. "empty" = nothing rendered and nothing threw, which is legal.
  // Absent whenever the combo rendered at least one node.
  renderHealth?: "error" | "empty";
  // The combo rendered something, but not the whole component: either a
  // compound Root's declared sibling parts never composed in ("uncomposed"),
  // or a Vue SFC's props were excluded by ADR 0002's TypeScript-only scope
  // ("propsExcluded"). Absent whenever renderHealth already fully discloses
  // the combo, and absent whenever no known-excluded shape was hit.
  disclosureReason?: "uncomposed" | "propsExcluded";
  // Interaction to Next Paint, in ms: the worst input-to-paint gap across
  // this combo's explored interactions. Absent when exploration produced no
  // interaction traces for the combo.
  inp?: number;
  // Set when this combo is the auto-scale sibling-copies probe (N whole
  // extra trees mounted side by side), never a real prop variation. `props`
  // never carries the `__120fps_scaleN` marker that produced it: this field
  // is where that identity now lives.
  scaleProbe?: number;
  // The run applied none of the component's own props,
  // because a fixture or an auto-composed scene supplied the render instead.
  // `props: {}` on its own is ambiguous — a component with no props at all
  // measures the same way — so the fact is stated rather than left to be
  // inferred from an empty object.
  measuredWithoutProps?: boolean;
  // `<use href="#id">` targets this combo's render
  // referenced and the document never defined. A same-document fragment
  // reference issues no request, so the network capture is blind to it,
  // and `<svg>` + `<use>` count as two real nodes — the render measured a
  // graphic that drew nothing.
  unresolvedSpriteRefs?: string[];
  // Set when this combo's fatal render crash is attributable to a value
  // the harness synthesized (a risky `provenance`), not to the component.
  // The underlying facts (`renderHealth: "error"`, `pageErrors`) stay on the
  // combo unchanged; only the verdict is demoted (never left at "fail"), and
  // `report.pass` ignores a combo that carries this field.
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
  // The same two-way split combo mode
  // draws — "error" = nothing rendered and the page threw, "empty" = nothing
  // rendered and nothing threw (a legal short-circuit, e.g. a component's own
  // `if (options.length <= 1) return null`). Absent whenever the point
  // rendered at least one node.
  renderHealth?: "error" | "empty";
  // What the page raised while this point was measured, deduped exactly like
  // a combo's. Absent when the page stayed quiet.
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
  // Set when the DOM node count never changed across scale points: the growth
  // class then describes nothing that was measured.
  domFlat?: boolean;
  // Present exactly when the curve verdict is `fail`: what was violated and
  // where, so the reader does not diff each N row against the budget by hand.
  violation?: CurveViolation;
  // A structural counterpart to
  // CURVE_RENDER_ERROR_WARNING's formatted string in report.warnings, so a
  // consumer (hintsForReport, formatCurveOutput) can detect a broken scale
  // point without matching a "scale point N=" prose convention. Populated in
  // runCurveMode at the same point the warning is pushed, so the two never
  // drift. Absent when every scale point rendered.
  renderErrorPoints?: CurveRenderErrorPoint[];
  // The N values left out of every curve fit because they
  // rendered nothing. A fit over a zero-DOM point describes a render that did
  // not happen. Absent when every measured point rendered, and absent when
  // excluding them would leave fewer than two points to fit at all.
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
  // Largest measured N still under it. Absent when the smallest N already
  // exceeded: the crossing then lies at or below the sweep's floor.
  lastPassingN?: number;
  medianMs?: number;
}

export interface MatrixAxis {
  propName: string;
  values: unknown[];
  // An over-wide union (>8 values) becomes an axis over a
  // truncated value set, so `values.length` is what the matrix offered and
  // this is what the component declares. Absent when nothing was truncated.
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
  // Slowest interaction measured on this cell, or null when interactions were
  // not explored for it (only the hottest cells are explored).
  worstInteractionMs: number | null;
  // Copied from the combo this cell projects — combo mode already
  // carries this mark and JSON field for the identical underlying combo, and
  // a matrix run over the same component must not silently drop it.
  disclosureReason?: "uncomposed" | "propsExcluded";
}

export interface CompoundEffect {
  props: Record<string, unknown>;
  expectedMount: number;
  actualMount: number;
  compoundDelta: number;
  significance: "high" | "medium" | "low";
}

// What each declared axis was actually measured at, once the
// cell cap has taken its slice. `measuredValues < declaredValues` means the
// header's `a × b` overstates the run; `measuredValues === 1` means the axis
// was held, and `heldValue` is what it was held at.
export interface MatrixAxisCoverage {
  propName: string;
  declaredValues: number;
  measuredValues: number;
  heldValue?: unknown;
}

export interface MatrixReport {
  axes: MatrixAxis[];
  axisCoverage: MatrixAxisCoverage[];
  // (Lane B `matrixHeldAbsentProps`): non-axis props that no cell
  // carries at all. A cell that silently lost a prop reads as a cell the
  // component rendered without it, which is a different measurement.
  heldAbsentProps?: string[];
  cells: MatrixCell[];
  hotCells: MatrixCell[];
  coldCells: MatrixCell[];
  // Every failing cell, regardless of mount cost. A cell can fail on an
  // interaction while mounting cheaply, so it need not appear in hotCells.
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

// files are projectRoot-relative posix paths, in injection order.
export interface CssReport {
  files: string[];
  autoDetected: boolean;
  // Which discovery layer decided, so the outcome (including "none") is
  // always disclosed, never just implied by an omitted key.
  layer:
    | "explicit"
    | "entry-chain"
    | "known-name"
    // The measured package's own package.json named the
    // stylesheet (`style`, `exports["./styles"]`, `exports[*].style`), and a
    // 0-rule passthrough among them had its `@import` targets resolved one
    // hop. "matched a conventional filename" is false for that pick — the
    // package declared it, and nothing about the filename was consulted.
    | "package-declared"
    | "largest-fallback"
    | "runtime"
    | "disabled"
    | "none"
    // A stylesheet was discovered and looked resolvable, but
    // something it references internally could not be read (Vite's real
    // PostCSS pipeline is the only thing that ever sees that nested chain);
    // it was dropped and the run measured unstyled instead of aborting.
    // `files` is empty, same as "disabled" -- the dropped file names live in
    // the warning that reported the drop, not here.
    | "unreadable";
  // One entry per file in `files`, same order. Computed regardless of layer,
  // so a near-empty stylesheet is distinguishable from a real one even when
  // named explicitly via --css.
  // Populated whenever `layer` is set, including the `unreadable` layer
  // — an entry there names the file that was dropped and why, so the JSON
  // says which stylesheet the run measured without instead of carrying an
  // empty list that reads like "there were none".
  // `matchedRules` is how many of this sheet's own rules matched at
  // least one element under `#root` in the measured render. Absent when the
  // probe did not run (no healthy mount to measure against).
  details?: Array<{
    file: string;
    bytes: number;
    rules: number;
    unreadable?: string;
    matchedRules?: number;
  }>;
  // The stylesheets the measured package's own
  // package.json declares (`style`, `exports[...].style`) whose target is not
  // on disk yet, as projectRoot-relative posix paths. Present whenever the
  // manifest declared one, so `layer: "none"` can say "declared, not built"
  // instead of asserting nothing was declared.
  declaredMissing?: string[];
  // The same declarations with the manifest field that named
  // each one and the package's own build command, when lane A's producer
  // supplied them. The `none` branch names the field, the path and the
  // command; without them it names the paths alone.
  declaredMissingFields?: Array<{ field: string; path: string; buildCommand?: string }>;
  // present only when layer === "runtime"
  runtimeEngines?: string[];
  // Whether the engines above are ones the
  // recogniser names. `false` is a read of a `makeStyles`/`styled` import from
  // a package the list does not carry, which is weaker evidence than a
  // declared dependency and says so in its own wording. Absent reads as
  // recognised, matching every producer that only ever resolved from the
  // closed list.
  runtimeEnginesRecognised?: boolean;
  // present only when layer === "largest-fallback"
  onlyCandidate?: boolean;
  noEntryInPackage?: boolean;
}

// `detected` is the package check, `active` is what actually ran; they diverge
// when a flag overrides detection or when the package cannot be resolved.
export interface ReactCompilerReport {
  active: boolean;
  detected: boolean;
  version?: string;
  // The React major the transform compiled for, and the runtime that
  // major needs when its absence is what kept the transform from running.
  target?: "17" | "18" | "19";
  skipped?: { target: string; missingModule: string };
}

// Which measurement this report describes. Same vocabulary as
// `EnvFingerprint.mode`, so a report and the baseline slot it compares against
// name their mode the same way.
export type ReportMode = "combo" | "curve" | "matrix" | "isolation";

export interface Report {
  version: 1;
  timestamp: string;
  // Optional: every report written before this field existed, and every
  // baseline entry, resolves through `deriveReportMode` instead.
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
  // Recognizer codes of the project's own Vite transforms that compiled
  // this run.
  projectTransforms?: string[];
  // Finding classes this run triggered. Ids, never prose: hints can be
  // reworded without a schema change.
  hints?: HintId[];
  // Provider-dependent imports the preflight walk found, attached only
  // when a combo actually failed to render: evidence for the render-error
  // hint, never a finding on a healthy run.
  providerCandidates?: string[];
  // The subset of providerCandidates reached only transitively
  // (an intermediate file the component imports is what actually reaches
  // the candidate, not the component itself) -- additive and backward
  // compatible, so providerCandidates keeps naming every real candidate
  // unfiltered exactly as before, while hints.ts uses this to pick honest
  // wording ("component's import graph reaches X" instead of "component
  // imports X") for exactly the entries listed here.
  transitiveProviderCandidates?: string[];
  css?: CssReport;
  reactCompiler?: ReactCompilerReport;
  warnings?: string[];
  // Verdict reused from a fingerprinted baseline entry: source
  // unchanged, environment identical, nothing was measured.
  cached?: boolean;
  // Where this run's minutes went. Absent on a cached verdict and on
  // any report written before this field existed.
  phaseTimings?: PhaseTimings;
}
