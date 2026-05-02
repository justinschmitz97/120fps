import type { InteractionType } from "./discovery.js";
import type { ScalingCurve } from "./metrics.js";
import { computeMedian, computeP95 } from "./measure.js";

export interface Thresholds {
  mountMs: number;
  interactionMs: number;
  relativeMount: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  mountMs: 16,
  interactionMs: 100,
  relativeMount: 2.0,
};

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
}

export interface ComboReport {
  comboIndex: number;
  props: Record<string, unknown>;
  mount: TimingWithCV;
  unmount: TimingWithCV;
  domNodeCount: number;
  heapDelta: number;
  interactions: InteractionReport[];
  scalingCurve: ScalingCurve | null;
  relativeMount: number;
  verdict: "pass" | "warn" | "fail";
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
): "pass" | "warn" | "fail" {
  if (combo.mount.median > thresholds.mountMs) return "fail";
  if (combo.relativeMount > thresholds.relativeMount) return "fail";
  for (const interaction of combo.interactions) {
    if (interaction.timing.median > thresholds.interactionMs) return "fail";
  }
  if (combo.mount.unstable || combo.unmount.unstable) return "warn";
  for (const interaction of combo.interactions) {
    if (interaction.timing.unstable) return "warn";
  }
  return "pass";
}

export function formatTable(report: Report): string {
  const lines: string[] = [];

  lines.push(`120fps — ${report.componentName}`);
  lines.push(`Machine: ${report.machine.cpu} (${report.machine.cores} cores), ${Math.round(report.machine.ramMb / 1024)}GB RAM, ${report.machine.os}`);
  lines.push(`Node ${report.machine.nodeVersion}, Chromium ${report.machine.chromiumVersion}`);
  lines.push("");

  const header = padRow(["#", "Mount", "Unmount", "DOM", "Interactions", "Scaling", "Verdict"]);
  lines.push(header);
  lines.push("-".repeat(header.length));

  let hasUnstable = false;

  for (const combo of report.combos) {
    const scaling = combo.scalingCurve ? combo.scalingCurve.growthClass : "-";
    const verdictStr = combo.verdict.toUpperCase();
    lines.push(
      padRow([
        String(combo.comboIndex),
        `${combo.mount.median.toFixed(2)}ms`,
        `${combo.unmount.median.toFixed(2)}ms`,
        String(combo.domNodeCount),
        String(combo.interactions.length),
        scaling,
        verdictStr,
      ]),
    );

    if (combo.mount.unstable || combo.unmount.unstable) hasUnstable = true;
    for (const i of combo.interactions) {
      if (i.timing.unstable) hasUnstable = true;
    }

    const sorted = [...combo.interactions].sort(
      (a, b) => b.timing.median - a.timing.median,
    );
    const top3 = sorted.slice(0, 3);
    for (const interaction of top3) {
      lines.push(
        `    ${interaction.label} (${interaction.type}): ${interaction.timing.median.toFixed(2)}ms [${interaction.relativeTiming.toFixed(2)}x cal]`,
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

  return lines.join("\n");
}

const COL_WIDTHS = [4, 12, 12, 8, 14, 14, 10];

function padRow(cells: string[]): string {
  return cells.map((c, i) => c.padEnd(COL_WIDTHS[i] ?? 10)).join(" ");
}
