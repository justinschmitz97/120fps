import path from "node:path";
import { isVueFile } from "./vue-sfc.js";
import type { InteractionType } from "./discovery.js";
import {
  computeScalingCurve,
  attributeCost,
  isSuperlinearGrowth,
  type ScalingCurve,
  type CostAttribution,
} from "./metrics.js";
import type { ReactOptimizations } from "./react-profiler.js";
import { computeMedian, computeP95, type MeasuredState } from "./measure.js";
import {
  formatNoiseWarning,
  HOSTILE_RUN_WARNING,
  NOISY_RUN_WARNING,
  type NoiseReport,
} from "./noise.js";
import { hintsForReport, formatHints, MEASUREMENT_BASIS_LINE, type HintId } from "./hints.js";
// M104: the same value identity the matrix generator itself uses, so "how many
// distinct values did this axis take" is counted the way the cells were built.
import { comboKey } from "./prop-gen-values.js";
import { hasPageErrors, renderDrain } from "./page-errors.js";

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

// Budgets rise monotonically T1 → T4, so "at least T3" is a floor expressed as
// a position in this order.
const TIER_ORDER: ComponentTier[] = ["T1", "T2", "T3", "T4"];

export function classifyTier(info: {
  domNodeCount: number;
  hasPortal: boolean;
  hasScaling?: boolean;
  hasAnimation: boolean;
}): ComponentTier {
  const bySize: ComponentTier =
    info.domNodeCount <= 10 ? "T1" : info.domNodeCount <= 40 ? "T2" : "T4";
  // A portal or an animation buys the component T3's headroom; it never takes
  // headroom away. A 2000-node animated table is still a 2000-node table.
  if (!info.hasPortal && !info.hasAnimation) return bySize;
  return TIER_ORDER.indexOf(bySize) >= TIER_ORDER.indexOf("T3") ? bySize : "T3";
}

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
  // Measurement revision: absent or 1 predates M31's component-scoped DOM
  // count. A mismatch makes a baseline incomparable, not merely different.
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
  // M57. Omitted for React, which every pre-M57 baseline implicitly was, so
  // those entries keep comparing. A different framework is a different renderer
  // and a different measurement, never a regression.
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
  steps?: number;
}

// M84/M85 cross-lane interface: how a synthesized prop value was chosen
// (`src/prop-gen.ts`, Lane B, `PropSchema.provenance`). Declared here, on
// Lane C's side, because M85 is the first consumer and the field may not
// exist on `PropSchema` yet; both sides read/write the identical union so a
// later real `provenance?: PropProvenance` on `PropSchema` is a structural
// no-op merge, not a breaking change.
export type PropProvenance = "declared" | "preset" | "heuristic" | "placeholder" | "contract";

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
  tier?: ComponentTier;
  hasAnimation?: boolean;
  // M40: whether these numbers describe the settled component or a transient
  // scene (skeleton, fallback, pre-response render).
  measuredState?: MeasuredState;
  costAttribution?: CostAttribution;
  reactOptimizations?: ReactOptimizations;
  // M59: uncaught exceptions and console.error output captured while this
  // combo was measured, deduped with a (×N) repeat suffix. Absent when the
  // page stayed quiet.
  // M99: this list is now this combo's own windows only (mount, stable
  // rerender); what the prop-delta sub-probe's rerender into the next combo's
  // props raised lives in `transitionPageErrors` instead.
  pageErrors?: string[];
  // M99 (radix-primitives-F1, base-ui-F1): errors raised while the rerender
  // pass drove this combo's props into `combos[toComboIndex]`'s props to price
  // the prop delta. Reported on this row because this row's measurement is
  // what observed them, excluded from this combo's `renderHealth`,
  // `harnessFault` and verdict because this combo's own props are not what
  // was rendering. The window also spans the re-mount that precedes each
  // delta rerender, so this names a window, never a cause.
  transitionPageErrors?: { toComboIndex: number; errors: string[] };
  // M59: "error" = nothing rendered and the page threw, which can never be a
  // pass. "empty" = nothing rendered and nothing threw, which is legal.
  // Absent whenever the combo rendered at least one node.
  renderHealth?: "error" | "empty";
  // M80: the combo rendered something, but not the whole component: either a
  // compound Root's declared sibling parts never composed in ("uncomposed"),
  // or a Vue SFC's props were excluded by ADR 0002's TypeScript-only scope
  // ("propsExcluded"). Absent whenever renderHealth already fully discloses
  // the combo, and absent whenever no known-excluded shape was hit.
  disclosureReason?: "uncomposed" | "propsExcluded";
  // Interaction to Next Paint, in ms: the worst input-to-paint gap across
  // this combo's explored interactions. Absent when exploration produced no
  // interaction traces for the combo.
  inp?: number;
  // M61: set when this combo is the auto-scale sibling-copies probe (N whole
  // extra trees mounted side by side), never a real prop variation. `props`
  // never carries the `__120fps_scaleN` marker that produced it: this field
  // is where that identity now lives.
  scaleProbe?: number;
  // M100 (calcom-F4): the run applied none of the component's own props,
  // because a fixture or an auto-composed scene supplied the render instead.
  // `props: {}` on its own is ambiguous — a component with no props at all
  // measures the same way — so the fact is stated rather than left to be
  // inferred from an empty object.
  measuredWithoutProps?: boolean;
  // M106 C4 (calcom-F5): `<use href="#id">` targets this combo's render
  // referenced and the document never defined. A same-document fragment
  // reference issues no request, so the M70 network capture is blind to it,
  // and `<svg>` + `<use>` count as two real nodes — the render measured a
  // graphic that drew nothing.
  unresolvedSpriteRefs?: string[];
  // M85: set when this combo's fatal render crash is attributable to a value
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
  // M104 (commerce-F2) / M106 C3 (dub-F6): the same two-way split combo mode
  // draws — "error" = nothing rendered and the page threw, "empty" = nothing
  // rendered and nothing threw (a legal short-circuit, e.g. a component's own
  // `if (options.length <= 1) return null`). Absent whenever the point
  // rendered at least one node.
  renderHealth?: "error" | "empty";
  // What the page raised while this point was measured, deduped exactly like
  // a combo's. Absent when the page stayed quiet.
  pageErrors?: string[];
  // M104: this point's React profiler snapshot, when the pass ran.
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
  // M79 gap (chakra-ui-F1): a structural counterpart to
  // CURVE_RENDER_ERROR_WARNING's formatted string in report.warnings, so a
  // consumer (hintsForReport, formatCurveOutput) can detect a broken scale
  // point without matching a "scale point N=" prose convention. Populated in
  // runCurveMode at the same point the warning is pushed, so the two never
  // drift. Absent when every scale point rendered.
  renderErrorPoints?: CurveRenderErrorPoint[];
  // M104 (commerce-F2): the N values left out of every curve fit because they
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
  // not explored for it (M21 explores only the hottest cells).
  worstInteractionMs: number | null;
  // M91: copied from the combo this cell projects — combo mode already
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

// M104 (twenty-F3): what each declared axis was actually measured at, once the
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
  // M40: baseline and current run measured different scenes; comparison skipped.
  measuredStateMismatch?: { baseline: MeasuredState; current: MeasuredState };
  // M45: the entry came from another environment's slot. Informational only.
  crossEnvironment?: boolean;
  // M46: the machine was too busy to compare against.
  skippedNoisy?: boolean;
}

export interface WrapperReport {
  path: string;
  autoDetected: boolean;
  overheadMs: number;
  domNodes: number;
  // M41: the wrapper exported a callable `setup` that ran before first render.
  hasSetup?: boolean;
}

// files are projectRoot-relative posix paths, in injection order.
export interface CssReport {
  files: string[];
  autoDetected: boolean;
  // M82: which discovery layer decided, so the outcome (including "none") is
  // always disclosed, never just implied by an omitted key.
  layer:
    | "explicit"
    | "entry-chain"
    | "known-name"
    // M102 (heroui-F1): the measured package's own package.json named the
    // stylesheet (`style`, `exports["./styles"]`, `exports[*].style`), and a
    // 0-rule passthrough among them had its `@import` targets resolved one
    // hop. "matched a conventional filename" is false for that pick — the
    // package declared it, and nothing about the filename was consulted.
    | "package-declared"
    | "largest-fallback"
    | "runtime"
    | "disabled"
    | "none"
    // M89 defect 3: a stylesheet was discovered and looked resolvable, but
    // something it references internally could not be read (Vite's real
    // PostCSS pipeline is the only thing that ever sees that nested chain);
    // it was dropped and the run measured unstyled instead of aborting.
    // `files` is empty, same as "disabled" -- the dropped file names live in
    // the warning that reported the drop, not here.
    | "unreadable";
  // One entry per file in `files`, same order. Computed regardless of layer,
  // so a near-empty stylesheet is distinguishable from a real one even when
  // named explicitly via --css.
  // M102: populated whenever `layer` is set, including the `unreadable` layer
  // — an entry there names the file that was dropped and why, so the JSON
  // says which stylesheet the run measured without instead of carrying an
  // empty list that reads like "there were none".
  // M102 / I7: `matchedRules` is how many of this sheet's own rules matched at
  // least one element under `#root` in the measured render. Absent when the
  // probe did not run (no healthy mount to measure against).
  details?: Array<{
    file: string;
    bytes: number;
    rules: number;
    unreadable?: string;
    matchedRules?: number;
  }>;
  // present only when layer === "runtime"
  runtimeEngines?: string[];
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
  compositionTree?: import("./composition.js").CompositionTree;
  nextJsShims?: string[];
  scalingCurveReport?: ScalingCurveReport;
  matrixReport?: MatrixReport;
  baseline?: BaselineComparison;
  isolation?: import("./isolation.js").IsolationReport;
  wrapper?: WrapperReport;
  // M44: the preset module that supplied prop values, and which props it fed.
  propPresets?: { path: string; props: string[] };
  // M46: how trustworthy the machine was while this ran.
  noise?: NoiseReport;
  // M48: recognizer codes of the project's own Vite transforms that compiled
  // this run.
  projectTransforms?: string[];
  // M51: finding classes this run triggered. Ids, never prose: hints can be
  // reworded without a schema change.
  hints?: HintId[];
  // M65: provider-dependent imports the preflight walk found, attached only
  // when a combo actually failed to render: evidence for the render-error
  // hint, never a finding on a healthy run.
  providerCandidates?: string[];
  // M92 gap 3: the subset of providerCandidates reached only transitively
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
  // M39: verdict reused from a fingerprinted baseline entry: source
  // unchanged, environment identical, nothing was measured.
  cached?: boolean;
}

// Exactly the conditions the React Optimizations section prints a line for.
function hasReactFinding(opts: ReactOptimizations | undefined): boolean {
  if (!opts) return false;
  if (opts.durationsUnavailable) return true;
  if (opts.memoBailout && (opts.memoBailoutComponents?.length ?? 0) > 0) return true;
  if (opts.contextFanOut && (opts.contextFanOutComponents?.length ?? 0) > 0) return true;
  if ((opts.callbackIdentityDeltas?.length ?? 0) > 0) return true;
  if ((opts.portalOrphans ?? 0) > 0) return true;
  return (opts.renderAttribution?.length ?? 0) > 0;
}

const WRAPPER_OVERHEAD_WARN_MS = 1;

export function attachWrapperReport(report: Report, wrapper: WrapperReport): void {
  report.wrapper = wrapper;

  const notes: string[] = [];
  if (wrapper.overheadMs >= WRAPPER_OVERHEAD_WARN_MS) {
    notes.push(
      `Wrapper ${wrapper.path} adds ${wrapper.overheadMs.toFixed(2)}ms to every mount measurement.`,
    );
  }
  if (wrapper.domNodes > 0) {
    notes.push(
      `Wrapper ${wrapper.path} renders ${wrapper.domNodes} DOM node(s) counted in tier classification.`,
    );
  }
  if (notes.length > 0) {
    report.warnings = [...(report.warnings ?? []), ...notes];
  }
}

export function computeCV(samples: number[]): number {
  if (samples.length <= 1) return 0;
  const n = samples.length;
  let sum = 0;
  for (const s of samples) sum += s;
  const mean = sum / n;
  const absMean = Math.abs(mean);
  if (absMean === 0) return 0;
  let variance = 0;
  for (const s of samples) variance += (s - mean) ** 2;
  // Sample variance: N measurements are a sample of the component's cost
  // distribution, not the population. The n divisor understates dispersion at
  // the sample counts this tool runs (n=3..10).
  variance /= n - 1;
  const stddev = Math.sqrt(variance);
  return (stddev / absMean) * 100;
}

// M35: driven pacing shrinks medians to their busy cost, so relative CV on a
// sub-millisecond metric explodes while absolute noise stays trivial: and an
// unstable flag would silently skip its baseline comparison (M22). Unstable
// requires both: high relative CV and noise above the 0.5ms absolute floor
// (the same floor M29 uses for normalized comparison).
export const UNSTABLE_NOISE_FLOOR_MS = 0.5;

export function buildTimingWithCV(samples: number[]): TimingWithCV {
  const median = computeMedian(samples);
  const p95 = computeP95(samples);
  const cv = computeCV(samples);
  const n = samples.length;
  const mean = n > 0 ? samples.reduce((a, b) => a + b, 0) / n : 0;
  const stddevMs = (cv / 100) * Math.abs(mean);
  return {
    samples,
    median,
    p95,
    cv,
    unstable: cv > 15 && stddevMs > UNSTABLE_NOISE_FLOOR_MS,
  };
}

// Only for translating an explicitly supplied aggregate --threshold-interaction
// into the per-event budget the verdict uses, so an existing CI flag keeps its
// meaning. Tier budgets are derived from frames, not from this.
export const REFERENCE_EVENTS = 11;

export function perStepCost(interaction: InteractionReport): number {
  const events = interaction.steps && interaction.steps > 0 ? interaction.steps : 1;
  return interaction.timing.median / events;
}

export function computeVerdict(
  combo: ComboReport,
  thresholds: Thresholds,
  options?: { tierBudget?: TierBudget; explicitInteraction?: boolean },
): "pass" | "warn" | "fail" {
  // M59: nothing rendered and the page threw. The timings are real, but they
  // describe React mounting and unmounting a broken tree, so no budget
  // comparison on them means anything.
  if (combo.renderHealth === "error") return "fail";
  const mountMs = options?.tierBudget?.mountMs ?? thresholds.mountMs;
  const rerenderMs = options?.tierBudget?.rerenderMs ?? thresholds.rerenderMs;
  const interactionMs = options?.tierBudget?.interactionMs ?? thresholds.interactionMs;
  if (combo.mount.median > mountMs) return "fail";
  if (!options?.tierBudget && combo.relativeMount > thresholds.relativeMount) return "fail";
  if (combo.rerender.median > rerenderMs) return "fail";
  if (combo.rerenderChange && combo.rerenderChange.median > rerenderMs * 1.5) {
    if (options?.tierBudget) return "warn";
    return "fail";
  }
  // `Thresholds` is public and predates `interactionStepMs`, so a caller
  // constructing it by hand must not silently disable the interaction check.
  const perStepMs = options?.explicitInteraction
    ? interactionMs / REFERENCE_EVENTS
    : options?.tierBudget?.interactionStepMs
      ?? thresholds.interactionStepMs
      ?? DEFAULT_THRESHOLDS.interactionStepMs;
  for (const interaction of combo.interactions) {
    if (perStepCost(interaction) > perStepMs) return "fail";
  }
  if (combo.mount.unstable || combo.unmount.unstable) return "warn";
  if (combo.rerender.unstable) return "warn";
  if (combo.rerenderChange?.unstable) return "warn";
  for (const interaction of combo.interactions) {
    if (interaction.timing.unstable) return "warn";
  }
  if (options?.tierBudget && combo.relativeMount > thresholds.relativeMount) return "warn";
  return "pass";
}

// M82: the outcome is always disclosed, including "none" — wording keyed on
// which discovery layer decided. `layer` may be absent on a pre-M82 report or
// baseline (the type is required going forward, but reading an old `css`
// object at runtime is not type-checked), so the default branch falls back to
// the old rendering rather than mislabeling a legacy auto-detected pick as
// "none found".
// M90: exported so analyze.ts can format the decision once, right when
// `cssReport` is built, and reuse the identical text as a warning that
// survives a later crash — the same line the final report block would have
// printed, computed early instead of only at assembly time.
export function formatStylesheetsLine(css: CssReport): string {
  switch (css.layer) {
    case "explicit":
      return `Stylesheets: ${css.files.join(", ")} (explicit --css)`;
    case "entry-chain":
      return `Stylesheets: ${css.files.join(", ")} (found in the project entry's own imports)`;
    case "known-name":
      return `Stylesheets: ${css.files.join(", ")} (matched a conventional filename)`;
    case "package-declared":
      return `Stylesheets: ${css.files.join(", ")} (declared by the measured package's own package.json)`;
    case "largest-fallback":
      return (
        `Stylesheets: ${css.files.join(", ")} (largest-stylesheet fallback, low confidence — ` +
        "verify with --css)"
      );
    case "runtime":
      return (
        `Stylesheets: none — styling is generated at runtime by ${(css.runtimeEngines ?? []).join(", ")}; ` +
        "no stylesheet was needed"
      );
    case "disabled":
      return "Stylesheets: none (--no-css)";
    case "unreadable":
      return "Stylesheets: dropped after a read failure -- measured unstyled (see warnings)";
    case "none":
      return (
        "Stylesheets: none found (checked the project entry, conventional filenames, and the " +
        "largest stylesheet under the project)"
      );
    default:
      if (css.files.length > 0) {
        const auto = css.autoDetected ? " (auto-detected)" : "";
        return `Stylesheets: ${css.files.join(", ")}${auto}`;
      }
      return (
        "Stylesheets: none found (checked the project entry, conventional filenames, and the " +
        "largest stylesheet under the project)"
      );
  }
}

export function formatTable(report: Report): string {
  const lines: string[] = [];

  lines.push(`120fps: ${report.componentName}`);
  lines.push(`Machine: ${report.machine.cpu} (${report.machine.cores} cores), ${Math.round(report.machine.ramMb / 1024)}GB RAM, ${report.machine.os}`);
  lines.push(`Node ${report.machine.nodeVersion}, Chromium ${report.machine.chromiumVersion}`);
  lines.push(describeMode(report));
  // M51: first-run users read 14ms and think their button takes 14ms.
  lines.push(MEASUREMENT_BASIS_LINE);
  if (report.cached) {
    lines.push(
      "Result reused from baseline: source unchanged, environment identical (--no-cache measures)",
    );
  }
  if (report.nextJsShims && report.nextJsShims.length > 0) {
    lines.push(`Next.js shims: ${report.nextJsShims.join(", ")}`);
  }
  if (report.wrapper) {
    const auto = report.wrapper.autoDetected ? " (auto-detected)" : "";
    lines.push(
      `Wrapper: ${report.wrapper.path}${auto}, +${report.wrapper.overheadMs.toFixed(2)}ms mount overhead`,
    );
  }
  if (report.css) {
    lines.push(formatStylesheetsLine(report.css));
  }
  if (report.reactCompiler?.active) {
    const version = report.reactCompiler.version
      ? ` (v${report.reactCompiler.version})`
      : "";
    lines.push(`React Compiler: active${version}`);
  }
  lines.push("");

  if (report.isolation) {
    return formatIsolationOutput(lines, report);
  }

  if (report.scalingCurveReport) {
    return formatCurveOutput(lines, report);
  }

  if (report.matrixReport) {
    return formatMatrixOutput(lines, report);
  }

  const header = padRow(["#", "Mount", "Rerender", "Unmount", "DOM", "Interactions", "Scaling", "Verdict"]);
  lines.push(header);
  lines.push("-".repeat(header.length));

  let hasUnstable = false;

  for (const combo of report.combos) {
    // M61: a scale-probe combo's curve describes N sibling copies of the
    // whole component, not a real prop: it must never read as "auto:
    // <prop>", which is the real detected-prop mechanism's label.
    let scaling = "-";
    if (combo.scalingCurve) {
      scaling = combo.scaleProbe !== undefined
        ? `${combo.scalingCurve.growthClass} (synthetic copies)`
        : combo.scalingCurve.growthClass +
          (report.autoScalingProp ? ` (auto: ${report.autoScalingProp})` : "");
    }
    const indexLabel = combo.scaleProbe !== undefined
      ? `×${combo.scaleProbe} copies`
      : String(combo.comboIndex);
    const tierSuffix = combo.tier ? ` (${combo.tier})` : "";
    const animSuffix = combo.hasAnimation && combo.tier ? " [anim]" : "";
    const verdictStr =
      combo.verdict.toUpperCase() + tierSuffix + animSuffix + renderHealthMarks(combo);
    lines.push(
      padRow([
        indexLabel,
        `${combo.mount.median.toFixed(2)}ms`,
        `${combo.rerender.median.toFixed(2)}ms`,
        `${combo.unmount.median.toFixed(2)}ms`,
        String(combo.domNodeCount),
        String(combo.interactions.length),
        scaling,
        verdictStr,
      ]),
    );

    if (combo.mount.unstable || combo.unmount.unstable) hasUnstable = true;
    if (combo.rerender.unstable) hasUnstable = true;
    if (combo.rerenderChange?.unstable) hasUnstable = true;
    for (const i of combo.interactions) {
      if (i.timing.unstable) hasUnstable = true;
    }

    const sorted = [...combo.interactions].sort(
      (a, b) => b.timing.median - a.timing.median,
    );
    const top3 = sorted.slice(0, 3);
    for (const interaction of top3) {
      const portalSuffix = interaction.portal ? " [portal]" : "";
      const patternSuffix = interaction.stressPattern && interaction.stressPattern !== "single-shot"
        ? ` (${interaction.stressPattern})`
        : "";
      const stepSuffix = interaction.steps && interaction.steps > 1
        ? ` = ${perStepCost(interaction).toFixed(2)}ms x ${interaction.steps} steps`
        : "";
      lines.push(
        `    ${interaction.label} (${interaction.type}): ${interaction.timing.median.toFixed(2)}ms${stepSuffix} [${interaction.relativeTiming.toFixed(2)}x cal]${portalSuffix}${patternSuffix}`,
      );
    }
  }

  appendPageErrors(lines, report);

  const hasAttribution = report.combos.some((c) => c.costAttribution && c.costAttribution.buckets.length > 0);
  if (hasAttribution) {
    lines.push("");
    lines.push("Cost breakdown (mount)");
    for (const combo of report.combos) {
      if (!combo.costAttribution || combo.costAttribution.buckets.length === 0) continue;
      if (report.combos.length > 1) {
        lines.push(`  Combo #${combo.comboIndex}:`);
      }
      const top3 = combo.costAttribution.buckets.slice(0, 3);
      for (const bucket of top3) {
        const durStr = bucket.durationMs.toFixed(1).padStart(6) + "ms";
        const pctStr = Math.round(bucket.percentage).toString().padStart(3) + "%";
        lines.push(`  ${bucket.source.padEnd(40)} ${durStr}  ${pctStr}`);
      }
    }
  }

  appendReactSection(
    lines,
    report.combos.map((c) => ({ label: `Combo #${c.comboIndex}`, opts: c.reactOptimizations })),
  );

  if (report.propDeltas && report.propDeltas.length > 0) {
    lines.push("");
    lines.push("Prop Deltas (top 5):");
    const sorted = [...report.propDeltas].sort(
      (a, b) => Math.abs(b.mountDelta) - Math.abs(a.mountDelta),
    );
    const top5 = sorted.slice(0, 5);
    for (const d of top5) {
      const baseStr = String(d.baseValue);
      const flipStr = String(d.flipValue);
      const mountSign = d.mountDelta >= 0 ? "+" : "";
      const rerenderSign = d.rerenderDelta >= 0 ? "+" : "";
      lines.push(
        `  ${d.propName}: ${baseStr} → ${flipStr}     mount ${mountSign}${d.mountDelta.toFixed(2)}ms  rerender ${rerenderSign}${d.rerenderDelta.toFixed(2)}ms`,
      );
    }
  }

  lines.push("");
  lines.push(
    report.pass ? "Result: PASS" : "Result: FAIL",
  );
  // M104 (dub-F5): prop combos only, the same filter `describeMode` applies —
  // a footer counting the sibling-copies scale probes contradicted the
  // "measured N of M prop combos" warning printed two lines below it.
  appendWarnRollup(
    lines,
    report,
    report.combos.filter((c) => c.scaleProbe === undefined).map((c) => c.verdict),
    "combos",
  );

  if (hasUnstable) {
    lines.push("⚠ Unstable results (CV>15%): consider increasing sample count");
  }

  appendWarnings(lines, report);

  appendEmptyRenderNote(lines, report);

  const totalInteractions = report.combos.reduce((sum, c) => sum + c.interactions.length, 0);
  // A composed fixture cannot fix a component that throws, so the suggestion is
  // withheld exactly when the silence already has a stated cause.
  const hasRenderError = report.combos.some((c) => c.renderHealth === "error");
  if (totalInteractions === 0 && !report.fixturePath && !hasRenderError) {
    const stem = path.basename(report.componentPath, path.extname(report.componentPath));
    const dir = path.dirname(report.componentPath);
    // M83 #8 (primevue-Minor1): detectFixture only ever accepts
    // `${stem}.fixture.vue` for a Vue target (never `.fixture.tsx`) — the
    // suggestion must name a file the loader will actually find.
    const suggestedExt = isVueFile(report.componentPath) ? "vue" : "tsx";
    const hint = path.join(dir, `${stem}.fixture.${suggestedExt}`);
    lines.push(`0 interactions found. Consider creating ${hint} with composed children.`);
  }

  if (report.baseline?.hasBaseline) {
    formatBaselineSection(lines, report.baseline);
  }

  appendHints(lines, report);

  return lines.join("\n");
}

// M64: an entry whose analysis found nothing contributes a header and a blank
// label line and no information. Only entries with a finding are shown, and a
// run where none has one prints no section at all.
// M104 (commerce-F1): extracted from formatTable so curve and matrix modes
// print the identical section for the identical data. The label is what the
// mode calls one measurement ("Combo #2", "N=50"); everything else is
// unchanged.
function appendReactSection(
  lines: string[],
  entries: Array<{ label: string; opts?: ReactOptimizations }>,
  // A curve always has several points, so a finding on one of them has to name
  // which N it came from even when it is the only finding — otherwise it reads
  // as describing the whole sweep. Combo mode keeps M64's rule (a single combo
  // needs no label) so its output is unchanged.
  options?: { labelEveryEntry?: boolean },
): void {
  const found = entries.filter((e) => hasReactFinding(e.opts));
  if (found.length === 0) return;
  lines.push("");
  lines.push("React Optimizations");
  for (const entry of found) {
    const opts = entry.opts!;
    if (found.length > 1 || options?.labelEveryEntry) {
      lines.push(`  ${entry.label}:`);
    }
    if (opts.durationsUnavailable) {
      lines.push("  Note: profiler durations unavailable: memo/context findings may be unreliable");
    }
    if (opts.memoBailout && opts.memoBailoutComponents?.length) {
      const label = opts.compilerActive
        ? "Memo bailout (informational, React Compiler active)"
        : "Memo bailout";
      lines.push(`  ${label}: ${opts.memoBailoutComponents.join(", ")}`);
    }
    if (opts.contextFanOut && opts.contextFanOutComponents?.length) {
      lines.push(`  Context fan-out: ${opts.contextFanOutComponents.join(", ")}`);
    }
    if (opts.callbackIdentityDeltas && opts.callbackIdentityDeltas.length > 0) {
      const parts = opts.callbackIdentityDeltas.map(
        (d) => `${d.propName} +${d.deltaMs.toFixed(1)}ms`,
      );
      lines.push(`  Callback identity: ${parts.join(", ")}`);
    }
    if (opts.portalOrphans && opts.portalOrphans > 0) {
      lines.push(`  Portal orphans: ${opts.portalOrphans}`);
    }
    if (opts.renderAttribution && opts.renderAttribution.length > 0) {
      lines.push("  Render attribution:");
      const top3 = opts.renderAttribution.slice(0, 3);
      for (const ra of top3) {
        lines.push(`    ${ra.component}: ${ra.selfDurationMs.toFixed(1)}ms self (${ra.renderCount} renders)`);
      }
    }
  }
}

// M59: what the row says about the page's health, appended to the verdict cell
// so the reader never has to correlate a 0 in the DOM column with a section
// further down.
function renderHealthMarks(combo: ComboReport): string {
  const marks: string[] = [];
  if (combo.renderHealth === "error") marks.push("render error");
  else if (combo.renderHealth === "empty") marks.push("no DOM");
  else if (combo.disclosureReason === "uncomposed") marks.push("uncomposed");
  else if (combo.disclosureReason === "propsExcluded") marks.push("props excluded");
  // M100 (calcom-F4): independent of the health marks above — a row can render
  // perfectly well and still have measured none of the component's own props.
  if (combo.measuredWithoutProps) marks.push("no props applied");
  // M106 C4: the numbers on this row are real and describe a graphic that
  // drew nothing, which no other column can show.
  if ((combo.unresolvedSpriteRefs?.length ?? 0) > 0) marks.push("unresolved sprite");
  // M85: named separately from "render error" — the render did fail, and
  // that mark stays, but this one is what tells the reader the failure is
  // not being counted against the component.
  if (combo.harnessFault) marks.push(`harness fault: ${combo.harnessFault.propName}`);
  const count = combo.pageErrors?.length ?? 0;
  if (count > 0 && combo.renderHealth !== "error") {
    marks.push(`${count} page error${count === 1 ? "" : "s"}`);
  }
  // M99: independent of the combo's own tag above — a row can carry both, and
  // the arrow is what tells the reader the second set was not this combo's
  // own render.
  const transition = combo.transitionPageErrors;
  if (transition && transition.errors.length > 0) {
    const n = transition.errors.length;
    marks.push(`→ #${transition.toComboIndex}: ${n} page error${n === 1 ? "" : "s"}`);
  }
  return marks.map((mark) => ` [${mark}]`).join("");
}

// M59: the messages themselves, once per combo that produced any. A gated
// combo also states why its timings were not allowed to pass.
function appendPageErrors(lines: string[], report: Report): void {
  const affected = report.combos.filter(
    (c) => (c.pageErrors?.length ?? 0) > 0 || (c.transitionPageErrors?.errors.length ?? 0) > 0,
  );
  if (affected.length === 0) return;
  lines.push("");
  lines.push("Page errors");
  for (const combo of affected) {
    lines.push(`  Combo #${combo.comboIndex}:`);
    for (const message of combo.pageErrors ?? []) lines.push(`    - ${message}`);
    appendTransitionPageErrors(lines, combo);
    if (combo.harnessFault) {
      // M85: the "counted as a failure" line below is specifically false for
      // this combo — the value that caused the crash was the harness's own,
      // not the component's, so the opposite statement belongs here instead.
      lines.push(
        `    combo ${combo.comboIndex} rendered 0 DOM nodes while the page threw, but the cause ` +
        `was the harness's own synthesized value for "${combo.harnessFault.propName}" ` +
        `(${JSON.stringify(combo.harnessFault.value)}, provenance: ${combo.harnessFault.provenance}): ` +
        "excluded from the verdict, not counted as a component failure.",
      );
    } else if (combo.renderHealth === "error") {
      lines.push(
        `    combo ${combo.comboIndex} rendered 0 DOM nodes while the page threw: ` +
        "counted as a failure, not a pass.",
      );
    }
  }
}

// M99: the prop-delta sub-probe rerenders combo N's mounted tree into combo
// N+1's props inside combo N's measurement. What it raised is real and stays
// in the report, but it is not combo N's own render, and the window also
// spans the re-mount preceding each delta rerender — so this states what was
// observed and where, and stops short of naming a cause.
function appendTransitionPageErrors(lines: string[], combo: ComboReport): void {
  const transition = combo.transitionPageErrors;
  if (!transition || transition.errors.length === 0) return;
  lines.push(
    `    raised while transitioning to combo #${transition.toComboIndex}'s props ` +
    `(excluded from combo ${combo.comboIndex}'s verdict):`,
  );
  for (const message of transition.errors) lines.push(`      - ${message}`);
}

// M83 #1 (element-plus-F2): a combo marked "renderHealth: empty" and a
// sibling in the same `combos` array (a discrete prop combo or an M61
// scale-probe row) that measured a nonzero DOM count are not two different
// facts to reconcile — they come from the exact same `countComponentNodes`
// computation, so a disagreement between them is a same-run inconsistency,
// not proof the component renders nothing. Detection only: this never
// decides *why* they disagree.
export function detectRenderHealthInconsistency(combos: ComboReport[]): string | undefined {
  const emptyIndices = combos
    .filter((c) => c.renderHealth === "empty")
    .map((c) => c.comboIndex);
  if (emptyIndices.length === 0) return undefined;
  const nonEmptyIndices = combos
    .filter((c) => c.domNodeCount > 0)
    .map((c) => c.comboIndex);
  if (nonEmptyIndices.length === 0) return undefined;
  return RENDER_HEALTH_INCONSISTENT_WARNING(emptyIndices, nonEmptyIndices);
}

export const RENDER_HEALTH_INCONSISTENT_WARNING = (
  emptyIndices: number[],
  nonEmptyIndices: number[],
): string =>
  `combo(s) #${emptyIndices.join(", #")} rendered 0 DOM nodes while combo(s) #${nonEmptyIndices.join(", #")} ` +
  "rendered a nonzero count in the same run: this disagreement was not resolved, so it is reported " +
  "rather than asserted as 'the component renders nothing'.";

// M59: rendering null is legal, and saying so is cheaper than leaving the
// reader to infer it from a 0 in the DOM column.
function appendEmptyRenderNote(lines: string[], report: Report): void {
  const empty = report.combos.filter((c) => c.renderHealth === "empty");
  if (empty.length === 0) return;
  // M83 #1: a sibling combo in the same run that measured a nonzero count
  // contradicts the categorical claim below, so the disagreement is stated
  // instead of asserted away.
  const inconsistency = detectRenderHealthInconsistency(report.combos);
  if (inconsistency) {
    lines.push(inconsistency);
    return;
  }
  const list = empty.map((c) => `#${c.comboIndex}`).join(", ");
  lines.push(
    `Combo ${list} rendered no DOM nodes and the page stayed quiet: ` +
    "the component renders nothing for these props.",
  );
}

// Every output mode ends with the run's warnings; a mode that swallowed them
// would hide the reason its own numbers are what they are.
function appendWarnings(lines: string[], report: Report): void {
  for (const warning of report.warnings ?? []) {
    lines.push(`⚠ ${enrichNoiseWarning(warning, report)}`);
  }
}

// The noise warning reaches `report.warnings` as a fixed sentence, because the
// signals behind it live on `report.noise` and the baseline clause depends on
// whether a comparison happened at all. Both are known here, so the terminal
// prints the specific version of the sentence the JSON's numbers describe.
function enrichNoiseWarning(warning: string, report: Report): string {
  if (warning !== NOISY_RUN_WARNING && warning !== HOSTILE_RUN_WARNING) return warning;
  if (!report.noise) return warning;
  // `analyze.ts` sets `report.baseline` only when --check found an entry to
  // compare against, which is exactly when a comparison was skippable.
  return formatNoiseWarning(report.noise, report.baseline !== undefined) || warning;
}

// M64: WARN rows under "Result: PASS" read as a contradiction without the
// rollup rule stated. Only a fail flips `report.pass`, and that is worth one
// line whenever the table shows warnings and the result does not.
function appendWarnRollup(
  lines: string[],
  report: Report,
  verdicts: ("pass" | "warn" | "fail")[],
  noun: string,
): void {
  if (!report.pass) return;
  const warned = verdicts.filter((v) => v === "warn").length;
  if (warned === 0) return;
  lines.push(
    `${warned} of ${verdicts.length} ${noun} warned; warnings do not fail the run.`,
  );
}

// M51: every mode ends with what to do about what it found. Once per run, after
// the findings, never as a substitute for them.
function appendHints(lines: string[], report: Report): void {
  const hints = formatHints(report.hints ?? hintsForReport(report), report);
  if (hints) lines.push(hints);
}

function formatIsolationOutput(lines: string[], report: Report): string {
  const iso = report.isolation!;

  if (iso.mount) {
    lines.push("Mount (isolated)");
    lines.push(`  Median: ${iso.mount.median.toFixed(2)}ms  P95: ${iso.mount.p95.toFixed(1)}ms  CV: ${iso.mount.cv.toFixed(1)}%`);
    lines.push("");
  }

  if (iso.rerender) {
    lines.push("Rerender (isolated)");
    lines.push(`  Stable:      ${iso.rerender.stable.median.toFixed(2)}ms (React bailout path)`);
    lines.push(`  Prop-change: ${iso.rerender.propChange.median.toFixed(2)}ms`);
    lines.push(`  Churn (10x): ${iso.rerender.churn.median.toFixed(2)}ms (degradation: ${iso.rerender.churnDegradation.toFixed(2)}×)`);
    lines.push("");
  }

  if (iso.unmount) {
    lines.push("Unmount (isolated)");
    lines.push(`  Median: ${iso.unmount.median.toFixed(2)}ms  P95: ${iso.unmount.p95.toFixed(1)}ms  CV: ${iso.unmount.cv.toFixed(1)}%`);
    lines.push("");
  }

  if (iso.memory) {
    const m = iso.memory;
    const beforeKB = (m.heapBefore / 1024).toFixed(0);
    const afterKB = (m.heapAfter / 1024).toFixed(0);
    const growthKB = (m.heapGrowth / 1024).toFixed(1);
    const perCycleKB = (m.heapGrowthPerCycle / 1024).toFixed(1);
    lines.push(`Memory (${m.cycles} cycles)`);
    lines.push(`  Heap: ${beforeKB}KB → ${afterKB}KB (+${growthKB}KB, +${perCycleKB}KB/cycle)`);
    lines.push(`  Leak suspected: ${m.leakSuspected ? "YES" : "NO"}`);
    lines.push("");
  }

  if (iso.strictMode) {
    const sm = iso.strictMode;
    lines.push("StrictMode");
    lines.push(`  Normal mount:  ${sm.normalMount.median.toFixed(2)}ms`);
    lines.push(`  Strict mount:  ${sm.strictMount.median.toFixed(2)}ms (overhead: +${sm.overhead.toFixed(1)}%)`);
    lines.push(`  Double-invoke clean: ${sm.doubleInvokeClean ? "YES" : "NO"}`);
    lines.push("");
  }

  lines.push(report.pass ? "Result: PASS" : "Result: FAIL");
  appendWarnings(lines, report);
  appendHints(lines, report);

  if (report.baseline?.hasBaseline) {
    formatBaselineSection(lines, report.baseline);
  }

  return lines.join("\n");
}

const ENV_MATCH_LINES: Record<EnvMatch, string> = {
  identical: "Environment: identical: comparing raw timings",
  normalizable: "Environment: normalizable: comparing calibration-normalized values",
  incompatible: "Environment: incompatible: comparison skipped",
  unknown: "Environment: unknown: comparing raw timings",
};

function formatEnvMismatches(lines: string[], mismatches: string[] | undefined): void {
  for (const mismatch of mismatches ?? []) {
    lines.push(`    - ${mismatch}`);
  }
}

function formatBaselineSection(lines: string[], comparison: BaselineComparison): void {
  lines.push("");
  lines.push("Baseline comparison:");

  if (comparison.envMatch === "incompatible") {
    lines.push(`  ${ENV_MATCH_LINES.incompatible}`);
    formatEnvMismatches(lines, comparison.envMismatches);
    return;
  }

  const allMetrics = new Map<string, { baseline?: number; current?: number; delta?: number; status: string }>();

  for (const r of comparison.regressions) {
    allMetrics.set(r.metric, {
      baseline: r.baseline,
      current: r.current,
      delta: r.deltaPercent,
      status: `REGRESSED (tolerance: ${r.tolerance}%)`,
    });
  }
  for (const imp of comparison.improvements) {
    allMetrics.set(imp.metric, {
      baseline: imp.baseline,
      current: imp.current,
      delta: imp.deltaPercent,
      status: "OK (improved)",
    });
  }

  if (allMetrics.size === 0) {
    lines.push("  All metrics within tolerance: OK");
  } else {
    const header = padRow(["Metric", "Baseline", "Current", "Delta", "Status"], [14, 12, 12, 10, 30]);
    lines.push(header);
    lines.push("-".repeat(header.length));

    for (const [metric, info] of allMetrics) {
      const deltaStr = info.delta !== undefined ? `${info.delta >= 0 ? "+" : ""}${info.delta.toFixed(1)}%` : "-";
      lines.push(padRow(
        [metric, `${info.baseline?.toFixed(2)}ms`, `${info.current?.toFixed(2)}ms`, deltaStr, info.status],
        [14, 12, 12, 10, 30],
      ));
    }

    const regCount = comparison.regressions.length;
    if (regCount > 0) {
      lines.push(`  ${regCount} regression(s) detected`);
    }
  }

  const normalized = [...comparison.regressions, ...comparison.improvements].filter(
    (m) => m.normalized !== undefined,
  );
  if (normalized.length > 0) {
    lines.push("  Normalized (÷ calibration total):");
    for (const m of normalized) {
      const n = m.normalized!;
      const sign = n.deltaPercent >= 0 ? "+" : "";
      lines.push(
        `    ${m.metric}: ${n.baseline.toFixed(4)} → ${n.current.toFixed(4)}  ${sign}${n.deltaPercent.toFixed(1)}%`,
      );
    }
  }

  if (comparison.envMatch) {
    lines.push(`  ${ENV_MATCH_LINES[comparison.envMatch]}`);
    formatEnvMismatches(lines, comparison.envMismatches);
  }

  if (comparison.missingInteractions && comparison.missingInteractions.length > 0) {
    lines.push(
      `  ⚠ Baseline interaction(s) not measured in this run: ${comparison.missingInteractions.join(", ")}`,
    );
  }
}

function formatCurveOutput(lines: string[], report: Report): string {
  const cr = report.scalingCurveReport!;
  lines.push(`Scaling: ${cr.propName} (${cr.propKind}, ${cr.reason})`);
  lines.push("");

  const header = padCurveRow(["N", "Mount", "Rerender", "Unmount", "DOM", "Heap", "Growth"]);
  lines.push(header);
  lines.push("-".repeat(header.length));

  // M79 gap: a scale point the page threw on stops printing a bare Growth
  // cell — mirrors renderHealthMarks's bracket convention exactly, so the
  // table never reads as a healthy curve that merely fit a class the reader
  // cannot cross-check.
  const brokenNs = new Set((cr.renderErrorPoints ?? []).map((p) => p.n));
  for (let i = 0; i < cr.points.length; i++) {
    const p = cr.points[i];
    const isLast = i === cr.points.length - 1;
    let growth = isLast ? cr.mountCurve.growthClass : "";
    if (brokenNs.has(p.n)) growth += " [render error]";
    // M104 (commerce-F2): a DOM of 0 in a column of growing counts is the only
    // signal this row measured a render that did not happen. Said in words, on
    // the row itself, so the reader is not left cross-checking the source.
    else if (p.renderHealth === "empty") growth += ` [renders nothing at N=${p.n}]`;
    lines.push(
      padCurveRow([
        String(p.n),
        `${p.mount.median.toFixed(2)}ms`,
        `${p.rerender.median.toFixed(2)}ms`,
        `${p.unmount.median.toFixed(2)}ms`,
        String(p.domNodeCount),
        `+${formatHeap(p.heapDelta)}`,
        growth,
      ]),
    );
  }

  lines.push("");
  // Every curve `hintsForReport` reads for superlinearity, so a hint can never
  // cite a class this screen does not show.
  lines.push(`Growth: mount ${cr.mountCurve.growthClass}, rerender ${cr.rerenderCurve.growthClass}`);
  // M104: a growth class is only as good as the points behind it, so which
  // points it is not fitted over belongs next to it, never further down.
  if (cr.fitExcludedPoints && cr.fitExcludedPoints.length > 0) {
    lines.push(
      `  fitted over the points that rendered; N=${cr.fitExcludedPoints.join(", ")} rendered ` +
      "0 DOM nodes and is excluded.",
    );
  }

  lines.push("");
  const resultMark = brokenNs.size > 0 ? " [render error]" : "";
  lines.push((report.pass ? "Result: PASS" : "Result: FAIL") + resultMark);
  if (!report.pass && cr.violation) {
    lines.push(`  ${formatCurveViolation(cr.violation)}`);
  }

  const hasUnstable = cr.points.some(
    (p) => p.mount.unstable || p.rerender.unstable || p.unmount.unstable,
  );
  if (hasUnstable) {
    lines.push("⚠ Unstable results (CV>15%): consider increasing sample count");
  }

  // M104 (commerce-F1): a component whose only interesting prop is an array
  // auto-activates curve mode, and the fan-out its combo-mode siblings
  // disclose in full was absent here with no note that a pass had been skipped.
  appendReactSection(
    lines,
    cr.points.map((p) => ({ label: `N=${p.n}`, opts: p.reactOptimizations })),
    { labelEveryEntry: true },
  );

  appendWarnings(lines, report);

  appendHints(lines, report);

  return lines.join("\n");
}

const COL_WIDTHS = [4, 12, 12, 12, 8, 14, 14, 10];

function padRow(cells: string[], widths?: number[]): string {
  const w = widths ?? COL_WIDTHS;
  return cells.map((c, i) => c.padEnd(w[i] ?? 10)).join(" ");
}

const CURVE_COL_WIDTHS = [6, 10, 10, 10, 6, 10, 10];

function padCurveRow(cells: string[]): string {
  return cells.map((c, i) => c.padEnd(CURVE_COL_WIDTHS[i] ?? 10)).join(" ");
}

function formatHeap(bytes: number): string {
  if (Math.abs(bytes) >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (Math.abs(bytes) >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

export interface BuildCurveReportInput {
  propName: string;
  propKind: "array" | "number";
  reason: string;
  scalePoints: number[];
  mounts: import("./measure.js").MountResult[];
  rerenders: import("./measure.js").RerenderResult[];
  explores: import("./explorer.js").ExploreResult[];
  heapDeltas: number[];
  calibration: CalibrationResult;
  thresholds: Thresholds;
  skipAttribution?: boolean;
}

export function buildCurveReport(input: BuildCurveReportInput): ScalingCurveReport {
  const points: ScalingPoint[] = [];

  for (let i = 0; i < input.scalePoints.length; i++) {
    const n = input.scalePoints[i];
    const mount = input.mounts[i];
    const rerender = input.rerenders[i];
    const exploreResult = input.explores[i];

    const interactions: InteractionReport[] = [];
    if (exploreResult?.graph.edges) {
      for (const edge of exploreResult.graph.edges) {
        interactions.push({
          selector: edge.interaction.selector,
          type: edge.interaction.type,
          label: edge.interaction.label,
          timing: buildTimingWithCV(edge.samples),
          relativeTiming: input.calibration.totalDuration > 0
            ? computeMedianLocal(edge.samples) / input.calibration.totalDuration
            : 0,
          ...(edge.interaction.portal ? { portal: true } : {}),
          ...(edge.stressPattern ? { stressPattern: edge.stressPattern } : {}),
        });
      }
    }

    const point: ScalingPoint = {
      n,
      mount: buildTimingWithCV(mount?.mount.samples ?? [0]),
      rerender: buildTimingWithCV(rerender?.stable.samples ?? [0]),
      unmount: buildTimingWithCV(mount?.unmount.samples ?? [0]),
      domNodeCount: mount?.domNodeCount ?? 0,
      heapDelta: input.heapDeltas[i] ?? 0,
      interactions,
    };

    if (!input.skipAttribution && mount?.mountTraces && mount.mountTraces.length > 0) {
      point.costAttribution = attributeCost(mount.mountTraces);
    }

    // M104 (commerce-F2) / M106 C3 (dub-F6): the same split combo mode draws.
    // A point that rendered nothing measured a render that did not happen —
    // its timings are real and its growth contribution is not.
    if (point.domNodeCount === 0) {
      point.renderHealth = mount?.pageErrors?.fatal ? "error" : "empty";
    }
    if (mount?.pageErrors && hasPageErrors(mount.pageErrors)) {
      point.pageErrors = renderDrain(mount.pageErrors);
    }

    points.push(point);
  }

  // Fitting a growth class over a point that rendered nothing puts a
  // non-render in the same series as the renders. Excluded only while at
  // least two rendering points remain: below that there is no curve to fit
  // either way, and `domFlat` / `renderErrorPoints` already describe that run.
  const rendering = points.filter((p) => p.domNodeCount > 0);
  const fitPoints = rendering.length >= 2 ? rendering : points;
  const fitExcludedPoints = points.filter((p) => !fitPoints.includes(p)).map((p) => p.n);

  const mountCurve = computeScalingCurve(fitPoints.map((p) => ({ n: p.n, metric: p.mount.median })));
  const rerenderCurve = computeScalingCurve(fitPoints.map((p) => ({ n: p.n, metric: p.rerender.median })));
  const unmountCurve = computeScalingCurve(fitPoints.map((p) => ({ n: p.n, metric: p.unmount.median })));
  const domGrowth = computeScalingCurve(fitPoints.map((p) => ({ n: p.n, metric: p.domNodeCount })));
  const heapGrowth = computeScalingCurve(fitPoints.map((p) => ({ n: p.n, metric: p.heapDelta })));

  const interactionCurves: Record<string, ScalingCurve> = {};
  const interactionsByLabel = new Map<string, { n: number; metric: number }[]>();
  for (const point of points) {
    for (const interaction of point.interactions) {
      const existing = interactionsByLabel.get(interaction.label) ?? [];
      existing.push({ n: point.n, metric: interaction.timing.median });
      interactionsByLabel.set(interaction.label, existing);
    }
  }
  for (const [label, curvePoints] of interactionsByLabel) {
    if (curvePoints.length >= 2) {
      interactionCurves[label] = computeScalingCurve(curvePoints);
    }
  }

  const { violation } = evaluateCurve(points, mountCurve, input.thresholds);

  return {
    propName: input.propName,
    propKind: input.propKind,
    reason: input.reason,
    points,
    mountCurve,
    rerenderCurve,
    unmountCurve,
    interactionCurves,
    domGrowth,
    heapGrowth,
    ...(fitExcludedPoints.length > 0 ? { fitExcludedPoints } : {}),
    ...(violation ? { violation } : {}),
  };
}

function computeMedianLocal(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeCurveVerdict(
  points: ScalingPoint[],
  mountCurve: ScalingCurve,
  thresholds: Thresholds,
): "pass" | "warn" | "fail" {
  return evaluateCurve(points, mountCurve, thresholds).verdict;
}

// The walk that decides the verdict already knows which budget broke and at
// which N; returning it costs one object and saves the reader a manual diff.
export function evaluateCurve(
  points: ScalingPoint[],
  mountCurve: ScalingCurve,
  thresholds: Thresholds,
): { verdict: "pass" | "warn" | "fail"; violation?: CurveViolation } {
  if (isSuperlinearGrowth(mountCurve)) {
    return {
      verdict: "fail",
      violation: { kind: "growth", metric: "mount", growthClass: mountCurve.growthClass },
    };
  }

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    // Every earlier point cleared both budgets, so points[i-1] is the largest
    // measured N still under whichever budget breaks here.
    const lastPassingN = i > 0 ? { lastPassingN: points[i - 1].n } : {};
    if (point.mount.median > thresholds.mountMs) {
      return {
        verdict: "fail",
        violation: {
          kind: "budget",
          metric: "mount",
          budgetMs: thresholds.mountMs,
          crossingN: point.n,
          ...lastPassingN,
          medianMs: point.mount.median,
        },
      };
    }
    if (point.rerender.median > thresholds.rerenderMs) {
      return {
        verdict: "fail",
        violation: {
          kind: "budget",
          metric: "rerender",
          budgetMs: thresholds.rerenderMs,
          crossingN: point.n,
          ...lastPassingN,
          medianMs: point.rerender.median,
        },
      };
    }
  }

  const lastPoint = points[points.length - 1];
  if (lastPoint) {
    if (lastPoint.mount.median > thresholds.mountMs * 0.75) return { verdict: "warn" };
    if (lastPoint.rerender.median > thresholds.rerenderMs * 0.75) return { verdict: "warn" };
  }

  return { verdict: "pass" };
}

// An explicit --curve that falls back to another mode answers a different
// question than the one asked, and the mode line alone reads like success.
export const CURVE_NOT_ACTIVATED_WARNING = (reason: string): string =>
  `--curve did not activate: ${reason}. The numbers below answer a different question ` +
  `than "does it scale with its data?".`;

const VIOLATION_METRIC_LABEL: Record<CurveViolation["metric"], string> = {
  mount: "Mount",
  rerender: "Rerender",
};

export function formatCurveViolation(violation: CurveViolation): string {
  const metric = VIOLATION_METRIC_LABEL[violation.metric];
  if (violation.kind === "growth") {
    return `${metric} cost grows ${violation.growthClass} with N: superlinear growth fails on its own, whatever the per-N budgets say.`;
  }
  const budget = `${(violation.budgetMs ?? 0).toFixed(2)}ms budget`;
  const median = `${(violation.medianMs ?? 0).toFixed(2)}ms`;
  const where =
    violation.lastPassingN !== undefined
      ? `between N=${violation.lastPassingN} and N=${violation.crossingN}`
      : `at N=${violation.crossingN}, the smallest measured N`;
  return `${metric} crosses its ${budget} ${where} (N=${violation.crossingN}: ${median}).`;
}

export interface BuildMatrixReportInput {
  axes: MatrixAxis[];
  // The matrix cells ARE the combos (M21). Projecting them keeps cell verdicts
  // and the run-level pass/fail derived from one computation instead of two
  // that drift: the combo verdict already accounts for interactions.
  combos: ComboReport[];
  propDeltas?: PropDelta[];
}

export function buildMatrixReport(input: BuildMatrixReportInput): MatrixReport {
  const cells: MatrixCell[] = input.combos.map((combo) => ({
    comboIndex: combo.comboIndex,
    props: combo.props,
    mount: combo.mount,
    rerender: combo.rerender,
    unmount: combo.unmount,
    domNodeCount: combo.domNodeCount,
    tier: combo.tier ?? "T1",
    verdict: combo.verdict,
    worstInteractionMs:
      combo.interactions.length > 0
        ? Math.max(...combo.interactions.map((i) => i.timing.median))
        : null,
    ...(combo.disclosureReason !== undefined ? { disclosureReason: combo.disclosureReason } : {}),
  }));

  const sorted = [...cells].sort((a, b) => b.mount.median - a.mount.median);
  const hotCells = sorted.slice(0, 5);
  const coldCells = [...cells].sort((a, b) => a.mount.median - b.mount.median).slice(0, 3);
  const failingCells = cells.filter((c) => c.verdict === "fail");

  let compoundEffects: CompoundEffect[] = [];
  if (input.propDeltas && input.propDeltas.length > 0 && input.axes.length >= 2) {
    const anchorProps: Record<string, unknown> = {};
    for (const axis of input.axes) {
      anchorProps[axis.propName] = axis.values[0];
    }
    const anchorCell = cells.find((c) => {
      for (const axis of input.axes) {
        if (c.props[axis.propName] !== anchorProps[axis.propName]) return false;
      }
      return true;
    });
    const anchorMount = anchorCell?.mount.median ?? 0;

    for (const cell of hotCells) {
      let diffCount = 0;
      let expectedMount = anchorMount;
      for (const axis of input.axes) {
        if (cell.props[axis.propName] !== anchorProps[axis.propName]) {
          diffCount++;
          const delta = input.propDeltas.find(
            (d) => d.propName === axis.propName && d.flipValue === cell.props[axis.propName],
          );
          if (delta) expectedMount += delta.mountDelta;
        }
      }
      if (diffCount < 2) continue;
      if (expectedMount <= 0) continue;

      const compoundDelta = cell.mount.median - expectedMount;
      const ratio = cell.mount.median / expectedMount;
      const significance: CompoundEffect["significance"] =
        ratio >= 1.5 ? "high" : ratio >= 1.2 ? "medium" : "low";

      compoundEffects.push({
        props: cell.props,
        expectedMount,
        actualMount: cell.mount.median,
        compoundDelta,
        significance,
      });
    }
  }

  // M104 (twenty-F3): derived from the cells that were measured, never from
  // the axis declaration, so the cap's effect on the run is visible.
  const axisCoverage: MatrixAxisCoverage[] = input.axes.map((axis) => {
    const seen = new Map<string, unknown>();
    for (const c of cells) seen.set(comboKey(c.props[axis.propName]), c.props[axis.propName]);
    const coverage: MatrixAxisCoverage = {
      propName: axis.propName,
      declaredValues: axis.values.length,
      measuredValues: seen.size,
    };
    if (seen.size === 1) coverage.heldValue = [...seen.values()][0];
    return coverage;
  });

  return { axes: input.axes, axisCoverage, cells, hotCells, coldCells, failingCells, compoundEffects };
}

// M91 (primevue-F2): the same mark combo mode's renderHealthMarks prints for
// disclosureReason, scoped to the one field a MatrixCell actually carries —
// a cell has no renderHealth/pageErrors/harnessFault of its own to mark.
function matrixCellDisclosureMark(cell: MatrixCell): string {
  if (cell.disclosureReason === "uncomposed") return " [uncomposed]";
  if (cell.disclosureReason === "propsExcluded") return " [props excluded]";
  return "";
}

// M104 (twenty-F3): `Prop Matrix (isOpen × size)` claims both props were
// crossed. Under a cell cap that keeps the anchor plus one single-axis
// deviation, one of them was not. Printed only when the claim needs the
// correction, so a full matrix's output is byte-identical to before.
function appendAxisCoverage(lines: string[], mr: MatrixReport): void {
  const coverage = mr.axisCoverage ?? [];
  const held = coverage.filter((a) => a.measuredValues <= 1);
  if (held.length === 0) return;
  const heldLabel = held
    .map((a) => `${a.propName}=${a.measuredValues === 0 ? "absent" : formatCellValue(a.heldValue)}`)
    .join(", ");
  const crossed = coverage.filter((a) => a.measuredValues > 1).map((a) => a.propName);
  lines.push(
    crossed.length > 0
      ? `Axes crossed: ${crossed.join(", ")}. Held at one value (not crossed at this cell cap): ${heldLabel}.`
      : `No axis was crossed at this cell cap: ${heldLabel}.`,
  );
}

function formatCellValue(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function formatMatrixOutput(lines: string[], report: Report): string {
  const mr = report.matrixReport!;
  const axisNames = mr.axes.map((a) => a.propName);

  // A cell can pass on mount yet fail on an interaction, so showing only the
  // hottest cells can print an all-PASS table above a FAIL result.
  const shown = [...mr.hotCells];
  const extraFailures = mr.failingCells.filter(
    (f) => !shown.some((c) => c.comboIndex === f.comboIndex),
  );
  shown.push(...extraFailures);

  lines.push(`Prop Matrix (${axisNames.join(" × ")})`);
  const shownLabel = extraFailures.length > 0
    ? `${mr.hotCells.length} hottest + ${extraFailures.length} failing shown`
    : `${mr.hotCells.length} hottest shown`;
  lines.push(`${mr.cells.length} cells measured, ${shownLabel}:`);
  appendAxisCoverage(lines, mr);
  lines.push("");

  const cols = [...axisNames, "Mount", "Rerender", "Interact", "DOM", "Verdict"];
  const widths = cols.map((c) => Math.max(c.length + 2, 10));

  lines.push(cols.map((c, i) => c.padEnd(widths[i])).join(""));
  lines.push(cols.map((_, i) => "-".repeat(widths[i] - 2).padEnd(widths[i])).join(""));

  for (const cell of shown) {
    const vals = [
      ...axisNames.map((name) => String(cell.props[name] ?? "")),
      `${cell.mount.median.toFixed(2)}ms`,
      `${cell.rerender.median.toFixed(2)}ms`,
      cell.worstInteractionMs === null ? "-" : `${cell.worstInteractionMs.toFixed(2)}ms`,
      String(cell.domNodeCount),
      `${cell.verdict.toUpperCase()} (${cell.tier})${matrixCellDisclosureMark(cell)}`,
    ];
    lines.push(vals.map((v, i) => v.padEnd(widths[i])).join(""));
  }

  if (mr.compoundEffects.length > 0) {
    lines.push("");
    lines.push("Compound effects:");
    for (const effect of mr.compoundEffects) {
      const propParts = Object.entries(effect.props)
        .filter(([name]) => axisNames.includes(name))
        .map(([name, val]) => `${name}=${String(val)}`);
      // A cell can cost *less* than its parts predict; "above" was printed for
      // both signs, which contradicted the number next to it.
      const deltaStr = effect.compoundDelta >= 0
        ? `+${effect.compoundDelta.toFixed(1)}ms`
        : `${effect.compoundDelta.toFixed(1)}ms`;
      const direction = effect.compoundDelta >= 0 ? "above" : "below";
      lines.push(`  ${propParts.join(" + ")}: ${deltaStr} ${direction} additive expectation (${effect.significance})`);
    }
  }

  lines.push("");
  const pass = report.pass ? "PASS" : "FAIL";
  lines.push(`Result: ${pass}`);
  appendWarnRollup(lines, report, mr.cells.map((c) => c.verdict), "cells");
  // M91 (primevue-F2): a cell's own `disclosureReason` (copied from the combo
  // it projects, see buildMatrixReport) is what the row mark reads; page
  // errors themselves still live only on the combo, so this block is unchanged.
  appendPageErrors(lines, report);
  appendEmptyRenderNote(lines, report);
  // M104 (commerce-F1): matrix cells are combos (M21), so the section reads
  // from the same field combo mode reads.
  appendReactSection(
    lines,
    report.combos.map((c) => ({ label: `Combo #${c.comboIndex}`, opts: c.reactOptimizations })),
  );
  appendWarnings(lines, report);
  appendHints(lines, report);

  return lines.join("\n");
}

// The one place a report's mode is decided. `report.mode` wins when present;
// otherwise the populated fields answer it, which keeps reports written before
// the field readable.
export function deriveReportMode(report: Report): ReportMode {
  if (report.mode) return report.mode;
  if (report.isolation) return "isolation";
  if (report.scalingCurveReport) return "curve";
  if (report.matrixReport) return "matrix";
  return "combo";
}

// M32 D3: curve mode auto-activates, empties `combos`, and prints a different
// table. Without this line the reader cannot tell which measurement they got.
export function describeMode(report: Report): string {
  switch (deriveReportMode(report)) {
    case "isolation":
      return "Mode: isolation";
    case "curve": {
      const c = report.scalingCurveReport;
      return c ? `Mode: curve over "${c.propName}" (${c.reason})` : "Mode: curve";
    }
    case "matrix":
      return "Mode: prop matrix";
  }

  // M61: the sibling-copies scale probe is not a prop combo: counting it in
  // "measured" without a matching "generated" is exactly the contradiction
  // dogfooding found ("12 measured of 8 generated").
  const propCombos = report.combos.filter((c) => c.scaleProbe === undefined);
  const scaleProbes = report.combos.length - propCombos.length;
  const measured = propCombos.length;
  const probeSuffix = scaleProbes > 0
    ? `, +${scaleProbes} scale probe${scaleProbes === 1 ? "" : "s"}`
    : "";

  if (measured === 0 && scaleProbes > 0) {
    return `Mode: scale probe (${scaleProbes} point${scaleProbes === 1 ? "" : "s"}, no prop combos)`;
  }

  const capNote = report.warnings?.find((w) => w.includes("prop combos"));
  const generated = capNote?.match(/of (\d+) prop combos/)?.[1];
  return generated
    ? `Mode: prop combos (${measured} measured of ${generated} generated${probeSuffix})`
    : `Mode: prop combos (${measured} measured${probeSuffix})`;
}
