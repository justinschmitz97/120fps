import path from "node:path";
import type { InteractionType } from "./discovery.js";
import { computeScalingCurve, attributeCost, type ScalingCurve, type CostAttribution } from "./metrics.js";
import type { ReactOptimizations } from "./react-profiler.js";
import { computeMedian, computeP95, type MountResult, type RerenderResult } from "./measure.js";

export interface Thresholds {
  mountMs: number;
  interactionMs: number;
  relativeMount: number;
  rerenderMs: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  mountMs: 50,
  interactionMs: 400,
  relativeMount: 2.0,
  rerenderMs: 16,
};

export type ComponentTier = "T1" | "T2" | "T3" | "T4";

export interface TierBudget {
  mountMs: number;
  rerenderMs: number;
  interactionMs: number;
}

export const TIER_BUDGETS: Record<ComponentTier, TierBudget> = {
  T1: { mountMs: 14, rerenderMs: 10, interactionMs: 250 },
  T2: { mountMs: 44, rerenderMs: 30, interactionMs: 300 },
  T3: { mountMs: 60, rerenderMs: 36, interactionMs: 350 },
  T4: { mountMs: 80, rerenderMs: 48, interactionMs: 400 },
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
  costAttribution?: CostAttribution;
  reactOptimizations?: ReactOptimizations;
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
}

export interface MatrixAxis {
  propName: string;
  values: unknown[];
}

export interface MatrixCell {
  props: Record<string, unknown>;
  mount: TimingWithCV;
  rerender: TimingWithCV;
  unmount: TimingWithCV;
  domNodeCount: number;
  tier: ComponentTier;
  verdict: "pass" | "warn" | "fail";
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
  compoundEffects: CompoundEffect[];
}

export interface Regression {
  metric: string;
  baseline: number;
  current: number;
  deltaPercent: number;
  tolerance: number;
}

export interface Improvement {
  metric: string;
  baseline: number;
  current: number;
  deltaPercent: number;
}

export interface BaselineComparison {
  hasBaseline: boolean;
  regressions: Regression[];
  improvements: Improvement[];
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
  variance /= n;
  const stddev = Math.sqrt(variance);
  return (stddev / absMean) * 100;
}

export function buildTimingWithCV(samples: number[]): TimingWithCV {
  const median = computeMedian(samples);
  const p95 = computeP95(samples);
  const cv = computeCV(samples);
  return { samples, median, p95, cv, unstable: cv > 15 };
}

export function computeVerdict(
  combo: ComboReport,
  thresholds: Thresholds,
  options?: { tierBudget?: TierBudget },
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
  for (const interaction of combo.interactions) {
    if (interaction.timing.median > interactionMs) return "fail";
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
  if (report.nextJsShims && report.nextJsShims.length > 0) {
    lines.push(`Next.js shims: ${report.nextJsShims.join(", ")}`);
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
      lines.push(
        `    ${interaction.label} (${interaction.type}): ${interaction.timing.median.toFixed(2)}ms [${interaction.relativeTiming.toFixed(2)}x cal]${portalSuffix}${patternSuffix}`,
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
      if (opts.memoBailout && opts.memoBailoutComponents?.length) {
        lines.push(`  Memo bailout: ${opts.memoBailoutComponents.join(", ")}`);
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

  return lines.join("\n");
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

  if (report.baseline?.hasBaseline) {
    formatBaselineSection(lines, report.baseline);
  }

  return lines.join("\n");
}

function formatBaselineSection(lines: string[], comparison: BaselineComparison): void {
  lines.push("");
  lines.push("Baseline comparison:");

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
    return;
  }

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
  mounts: MountResult[];
  rerenders: RerenderResult[];
  thresholds: Thresholds;
  flatThresholds?: boolean;
  propDeltas?: PropDelta[];
}

export function buildMatrixReport(input: BuildMatrixReportInput): MatrixReport {
  const cells: MatrixCell[] = [];

  for (const mount of input.mounts) {
    const rerender = input.rerenders.find((r) => r.comboIndex === mount.comboIndex);
    const mountTiming = buildTimingWithCV(mount.mount.samples);
    const rerenderTiming = rerender
      ? buildTimingWithCV(rerender.stable.samples)
      : buildTimingWithCV([0]);
    const unmountTiming = buildTimingWithCV(mount.unmount.samples);

    const tier = input.flatThresholds
      ? undefined
      : classifyTier({
          domNodeCount: mount.domNodeCount,
          hasPortal: false,
          hasAnimation: mount.hasAnimation ?? false,
        });

    const comboForVerdict: ComboReport = {
      comboIndex: mount.comboIndex,
      props: mount.props,
      mount: mountTiming,
      unmount: unmountTiming,
      rerender: rerenderTiming,
      domNodeCount: mount.domNodeCount,
      heapDelta: 0,
      interactions: [],
      scalingCurve: null,
      relativeMount: 1,
      verdict: "pass",
      tier,
    };

    const tierBudget = tier ? TIER_BUDGETS[tier] : undefined;
    const verdict = computeVerdict(comboForVerdict, input.thresholds, { tierBudget });

    cells.push({
      props: mount.props,
      mount: mountTiming,
      rerender: rerenderTiming,
      unmount: unmountTiming,
      domNodeCount: mount.domNodeCount,
      tier: tier ?? "T1",
      verdict,
    });
  }

  const sorted = [...cells].sort((a, b) => b.mount.median - a.mount.median);
  const hotCells = sorted.slice(0, 5);
  const coldCells = [...cells].sort((a, b) => a.mount.median - b.mount.median).slice(0, 3);

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

  return { axes: input.axes, cells, hotCells, coldCells, compoundEffects };
}

function formatMatrixOutput(lines: string[], report: Report): string {
  const mr = report.matrixReport!;
  const axisNames = mr.axes.map((a) => a.propName);
  lines.push(`Prop Matrix (${axisNames.join(" × ")})`);
  lines.push(`${mr.cells.length} cells measured, ${mr.hotCells.length} hottest shown:`);
  lines.push("");

  const cols = [...axisNames, "Mount", "Rerender", "DOM", "Verdict"];
  const widths = cols.map((c) => Math.max(c.length + 2, 10));

  lines.push(cols.map((c, i) => c.padEnd(widths[i])).join(""));
  lines.push(cols.map((_, i) => "-".repeat(widths[i] - 2).padEnd(widths[i])).join(""));

  for (const cell of mr.hotCells) {
    const vals = [
      ...axisNames.map((name) => String(cell.props[name] ?? "")),
      `${cell.mount.median.toFixed(2)}ms`,
      `${cell.rerender.median.toFixed(2)}ms`,
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

  return lines.join("\n");
}
