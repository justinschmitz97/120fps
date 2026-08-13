import path from "node:path";
import type { InteractionType } from "./discovery.js";
import { computeScalingCurve, attributeCost, type ScalingCurve, type CostAttribution } from "./metrics.js";
import type { ReactOptimizations } from "./react-profiler.js";
import { computeMedian, computeP95, type MeasuredState } from "./measure.js";
import type { NoiseReport } from "./noise.js";
import { hintsForReport, formatHints, MEASUREMENT_BASIS_LINE, type HintId } from "./hints.js";

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

export function classifyTier(info: {
  domNodeCount: number;
  hasPortal: boolean;
  hasScaling?: boolean;
  hasAnimation: boolean;
}): ComponentTier {
  if (info.hasPortal || info.hasAnimation) return "T3";
  if (info.domNodeCount <= 10) return "T1";
  if (info.domNodeCount <= 40) return "T2";
  return "T4";
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
  // Interaction to Next Paint, in ms — the worst input-to-paint gap across
  // this combo's explored interactions. Absent when exploration produced no
  // interaction traces for the combo.
  inp?: number;
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
}

export interface CompoundEffect {
  props: Record<string, unknown>;
  expectedMount: number;
  actualMount: number;
  compoundDelta: number;
  significance: "high" | "medium" | "low";
}

export interface MatrixReport {
  axes: MatrixAxis[];
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
}

// `detected` is the package check, `active` is what actually ran; they diverge
// when a flag overrides detection or when the package cannot be resolved.
export interface ReactCompilerReport {
  active: boolean;
  detected: boolean;
  version?: string;
}

export interface Report {
  version: 1;
  timestamp: string;
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
  // M51: finding classes this run triggered. Ids, never prose — hints can be
  // reworded without a schema change.
  hints?: HintId[];
  css?: CssReport;
  reactCompiler?: ReactCompilerReport;
  warnings?: string[];
  // M39: verdict reused from a fingerprinted baseline entry — source
  // unchanged, environment identical, nothing was measured.
  cached?: boolean;
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
// sub-millisecond metric explodes while absolute noise stays trivial — and an
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

export function formatTable(report: Report): string {
  const lines: string[] = [];

  lines.push(`120fps — ${report.componentName}`);
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
  if (report.css && report.css.files.length > 0) {
    const auto = report.css.autoDetected ? " (auto-detected)" : "";
    lines.push(`Stylesheets: ${report.css.files.join(", ")}${auto}`);
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
    const autoSuffix = report.autoScalingProp ? ` (auto: ${report.autoScalingProp})` : "";
    const scaling = combo.scalingCurve ? combo.scalingCurve.growthClass + autoSuffix : "-";
    const tierSuffix = combo.tier ? ` (${combo.tier})` : "";
    const animSuffix = combo.hasAnimation && combo.tier ? " [anim]" : "";
    const verdictStr = combo.verdict.toUpperCase() + tierSuffix + animSuffix;
    lines.push(
      padRow([
        String(combo.comboIndex),
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

  const hasReactOpts = report.combos.some((c) => c.reactOptimizations != null);
  if (hasReactOpts) {
    lines.push("");
    lines.push("React Optimizations");
    const reactCombos = report.combos.filter((c) => c.reactOptimizations != null);
    for (const combo of reactCombos) {
      const opts = combo.reactOptimizations!;
      if (reactCombos.length > 1) {
        lines.push(`  Combo #${combo.comboIndex}:`);
      }
      if (opts.durationsUnavailable) {
        lines.push("  Note: profiler durations unavailable — memo/context findings may be unreliable");
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

  if (hasUnstable) {
    lines.push("⚠ Unstable results (CV>15%) — consider increasing sample count");
  }

  appendWarnings(lines, report);

  const totalInteractions = report.combos.reduce((sum, c) => sum + c.interactions.length, 0);
  if (totalInteractions === 0 && !report.fixturePath) {
    const stem = path.basename(report.componentPath, path.extname(report.componentPath));
    const dir = path.dirname(report.componentPath);
    const hint = path.join(dir, `${stem}.fixture.tsx`);
    lines.push(`0 interactions found. Consider creating ${hint} with composed children.`);
  }

  if (report.baseline?.hasBaseline) {
    formatBaselineSection(lines, report.baseline);
  }

  appendHints(lines, report);

  return lines.join("\n");
}

// Every output mode ends with the run's warnings; a mode that swallowed them
// would hide the reason its own numbers are what they are.
function appendWarnings(lines: string[], report: Report): void {
  for (const warning of report.warnings ?? []) {
    lines.push(`⚠ ${warning}`);
  }
}

// M51: every mode ends with what to do about what it found. Once per run, after
// the findings, never as a substitute for them.
function appendHints(lines: string[], report: Report): void {
  const hints = formatHints(report.hints ?? hintsForReport(report));
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
  identical: "Environment: identical — comparing raw timings",
  normalizable: "Environment: normalizable — comparing calibration-normalized values",
  incompatible: "Environment: incompatible — comparison skipped",
  unknown: "Environment: unknown — comparing raw timings",
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
    lines.push("  All metrics within tolerance — OK");
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

  for (let i = 0; i < cr.points.length; i++) {
    const p = cr.points[i];
    const isLast = i === cr.points.length - 1;
    const growth = isLast ? cr.mountCurve.growthClass : "";
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
  lines.push(report.pass ? "Result: PASS" : "Result: FAIL");

  const hasUnstable = cr.points.some(
    (p) => p.mount.unstable || p.rerender.unstable || p.unmount.unstable,
  );
  if (hasUnstable) {
    lines.push("⚠ Unstable results (CV>15%) — consider increasing sample count");
  }

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
      point.costAttribution = attributeCost(mount.mountTraces.flat());
    }

    points.push(point);
  }

  const mountCurve = computeScalingCurve(points.map((p) => ({ n: p.n, metric: p.mount.median })));
  const rerenderCurve = computeScalingCurve(points.map((p) => ({ n: p.n, metric: p.rerender.median })));
  const unmountCurve = computeScalingCurve(points.map((p) => ({ n: p.n, metric: p.unmount.median })));
  const domGrowth = computeScalingCurve(points.map((p) => ({ n: p.n, metric: p.domNodeCount })));
  const heapGrowth = computeScalingCurve(points.map((p) => ({ n: p.n, metric: p.heapDelta })));

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
  if (mountCurve.growthClass === "quadratic" || mountCurve.growthClass === "exponential") {
    return "fail";
  }

  for (const point of points) {
    if (point.mount.median > thresholds.mountMs) return "fail";
    if (point.rerender.median > thresholds.rerenderMs) return "fail";
  }

  const lastPoint = points[points.length - 1];
  if (lastPoint) {
    if (lastPoint.mount.median > thresholds.mountMs * 0.75) return "warn";
    if (lastPoint.rerender.median > thresholds.rerenderMs * 0.75) return "warn";
  }

  return "pass";
}

export interface BuildMatrixReportInput {
  axes: MatrixAxis[];
  // The matrix cells ARE the combos (M21). Projecting them keeps cell verdicts
  // and the run-level pass/fail derived from one computation instead of two
  // that drift — the combo verdict already accounts for interactions.
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

  return { axes: input.axes, cells, hotCells, coldCells, failingCells, compoundEffects };
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
      `${cell.verdict.toUpperCase()} (${cell.tier})`,
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
      const deltaStr = effect.compoundDelta >= 0
        ? `+${effect.compoundDelta.toFixed(1)}ms`
        : `${effect.compoundDelta.toFixed(1)}ms`;
      lines.push(`  ${propParts.join(" + ")}: ${deltaStr} above additive expectation (${effect.significance})`);
    }
  }

  lines.push("");
  const pass = report.pass ? "PASS" : "FAIL";
  lines.push(`Result: ${pass}`);
  appendWarnings(lines, report);
  appendHints(lines, report);

  return lines.join("\n");
}

// M32 D3 — curve mode auto-activates, empties `combos`, and prints a different
// table. Without this line the reader cannot tell which measurement they got.
export function describeMode(report: Report): string {
  if (report.isolation) return "Mode: isolation";
  if (report.scalingCurveReport) {
    const c = report.scalingCurveReport;
    return `Mode: curve over "${c.propName}" (${c.reason})`;
  }
  if (report.matrixReport) return "Mode: prop matrix";

  const measured = report.combos.length;
  const capNote = report.warnings?.find((w) => w.includes("prop combos"));
  const generated = capNote?.match(/of (\d+) prop combos/)?.[1];
  return generated
    ? `Mode: prop combos (${measured} measured of ${generated} generated)`
    : `Mode: prop combos (${measured} measured)`;
}
