import path from "node:path";
import type { InteractionType } from "./discovery.js";
import type { ScalingCurve, CostAttribution } from "./metrics.js";
import type { ReactOptimizations } from "./react-profiler.js";
import { computeMedian, computeP95 } from "./measure.js";

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

  return lines.join("\n");
}

const COL_WIDTHS = [4, 12, 12, 12, 8, 14, 14, 10];

function padRow(cells: string[]): string {
  return cells.map((c, i) => c.padEnd(COL_WIDTHS[i] ?? 10)).join(" ");
}
