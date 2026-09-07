import type { Report, ScalingCurveReport, Thresholds } from "./types.js";
import { CHURN_DEGRADATION_LIMIT, LEAK_BYTES_PER_CYCLE } from "./types.js";
import { computeCurveVerdict, deriveReportMode } from "./stats.js";
import { describePhaseBreakdown } from "./phases.js";
import { presentWarnings } from "./terminal.js";
import type { IsolationReport } from "../analysis/index.js";

// Curve, isolation and cached reports ship `combos: []`; their data lives in another field.
type ReportMode = "combo" | "cached" | "curve" | "isolation" | "empty";

// The curve/isolation split comes from the report's own mode discriminator.
function reportMode(report: Report): ReportMode {
  if (report.combos.length > 0) return "combo";
  if (report.cached) return "cached";
  const mode = deriveReportMode(report);
  if (mode === "curve" && report.scalingCurveReport) return "curve";
  if (mode === "isolation" && report.isolation) return "isolation";
  return "empty";
}

function isolationWarnSignal(iso: IsolationReport): boolean {
  // computeIsolationVerdict (analysis/isolation.ts) only warns on StrictMode overhead.
  return !!iso.strictMode && !iso.strictMode.doubleInvokeClean;
}

function worstVerdict(report: Report): "pass" | "warn" | "fail" {
  if (!report.pass) return "fail";
  switch (reportMode(report)) {
    case "combo":
      return report.combos.some((c) => c.verdict === "warn") ? "warn" : "pass";
    case "curve": {
      const cr = report.scalingCurveReport!;
      const verdict = computeCurveVerdict(cr.points, cr.mountCurve, report.thresholds);
      return verdict === "warn" ? "warn" : "pass";
    }
    case "isolation":
      return isolationWarnSignal(report.isolation!) ? "warn" : "pass";
    default:
      return "pass";
  }
}

function ms(value: number | undefined): string {
  return typeof value === "number" ? `${value.toFixed(2)}ms` : "—";
}

// Only an unrecognized shape (no combos, no cached/curve/isolation field) has nothing to show.
function modeTimings(report: Report): { mount: string; rerender: string } {
  switch (reportMode(report)) {
    case "combo": {
      const combo = report.combos[0];
      return { mount: ms(combo?.mount.median), rerender: ms(combo?.rerender.median) };
    }
    case "curve": {
      const cr = report.scalingCurveReport!;
      const first = cr.points[0];
      const last = cr.points[cr.points.length - 1];
      if (!first || !last) return { mount: "—", rerender: "—" };
      const flatNote = cr.domFlat ? ", DOM flat" : "";
      const growth = ` (${cr.mountCurve.growthClass}${flatNote})`;
      const mount = first === last
        ? `${ms(first.mount.median)}${growth}`
        : `${ms(first.mount.median)} → ${ms(last.mount.median)}${growth}`;
      const rerender = first === last
        ? ms(first.rerender.median)
        : `${ms(first.rerender.median)} → ${ms(last.rerender.median)}`;
      return { mount, rerender };
    }
    case "isolation": {
      const iso = report.isolation!;
      return {
        mount: iso.mount ? ms(iso.mount.median) : "—",
        rerender: iso.rerender ? ms(iso.rerender.stable.median) : "—",
      };
    }
    case "cached":
      // No new measurement was taken: a dash here is correct, not a bug.
      return { mount: "—", rerender: "—" };
    default:
      return { mount: "no measurable data", rerender: "no measurable data" };
  }
}

function baselineDelta(report: Report): string {
  const comparison = report.baseline;
  if (!comparison?.hasBaseline) return "—";
  if (comparison.skippedNoisy) return "skipped (noisy)";
  if (comparison.crossEnvironment) return "other machine";
  const worst = [...comparison.regressions].sort((a, b) => b.deltaPercent - a.deltaPercent)[0];
  if (worst) return `+${worst.deltaPercent.toFixed(1)}% ${worst.metric}`;
  const best = [...comparison.improvements].sort((a, b) => a.deltaPercent - b.deltaPercent)[0];
  if (best) return `${best.deltaPercent.toFixed(1)}% ${best.metric}`;
  return "no change";
}

const VERDICT_MARK: Record<string, string> = { pass: "pass", warn: "warn", fail: "**FAIL**" };

// A markdown table cell breaks if the cell content itself contains a pipe.
function escapeMdCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

// Shared by the markdown detail block and the JUnit failure body, so both name the same numbers.
function curveFailureLines(cr: ScalingCurveReport, thresholds: Thresholds): string[] {
  const lines: string[] = [];
  if (cr.mountCurve.growthClass === "quadratic" || cr.mountCurve.growthClass === "exponential") {
    lines.push(
      `Growth class ${cr.mountCurve.growthClass} fails the verdict (mount cost grows faster than ` +
      `linear with ${cr.propName})`,
    );
  }
  for (const p of cr.points) {
    if (p.mount.median > thresholds.mountMs) {
      lines.push(`N=${p.n}: mount ${p.mount.median.toFixed(2)}ms exceeds budget ${thresholds.mountMs}ms`);
    }
    if (p.rerender.median > thresholds.rerenderMs) {
      lines.push(`N=${p.n}: rerender ${p.rerender.median.toFixed(2)}ms exceeds budget ${thresholds.rerenderMs}ms`);
    }
  }
  return lines;
}

// Mount has no stored budget on `Report`, so it is named by elimination only.
function isolationFailureLines(iso: IsolationReport): string[] {
  const lines: string[] = [];
  if (iso.memory?.leakSuspected) {
    lines.push(
      `Memory leak suspected: ${iso.memory.heapGrowthPerCycle.toFixed(0)} bytes/cycle exceeds limit ` +
      `${LEAK_BYTES_PER_CYCLE} bytes/cycle`,
    );
  }
  if (iso.rerender && iso.rerender.churnDegradation > CHURN_DEGRADATION_LIMIT) {
    lines.push(
      `Churn degradation ${iso.rerender.churnDegradation.toFixed(2)}x exceeds limit ` +
      `${CHURN_DEGRADATION_LIMIT.toFixed(1)}x`,
    );
  }
  if (lines.length === 0 && iso.mount) {
    lines.push(`Mount ${iso.mount.median.toFixed(2)}ms exceeds this component's mount budget`);
  }
  return lines;
}

const CACHED_FAIL_MESSAGE =
  "Reused failing verdict from baseline (source unchanged, environment identical); " +
  "rerun with --no-cache to measure fresh numbers.";

function curveDetailLines(cr: ScalingCurveReport, thresholds: Thresholds, pass: boolean): string[] {
  const lines: string[] = [];
  for (const p of cr.points) {
    lines.push(`N=${p.n}: mount ${ms(p.mount.median)}, rerender ${ms(p.rerender.median)}`);
  }
  lines.push(`Growth class (mount): ${cr.mountCurve.growthClass}`);
  if (cr.domFlat) {
    lines.push("DOM node count never changed across scale points: growth class reflects no structural growth.");
  }
  if (!pass) {
    const detail = curveFailureLines(cr, thresholds);
    lines.push(...(detail.length > 0 ? detail : ["Curve verdict failed (see JSON report for detail)."]));
  }
  return lines;
}

function isolationDetailLines(iso: IsolationReport, pass: boolean): string[] {
  const lines: string[] = [];
  if (iso.mount) lines.push(`Mount: ${ms(iso.mount.median)}`);
  if (iso.rerender) {
    lines.push(
      `Rerender: stable ${ms(iso.rerender.stable.median)}, prop-change ${ms(iso.rerender.propChange.median)}, ` +
      `churn ${ms(iso.rerender.churn.median)} (degradation ${iso.rerender.churnDegradation.toFixed(2)}x)`,
    );
  }
  if (iso.unmount) lines.push(`Unmount: ${ms(iso.unmount.median)}`);
  if (iso.memory) {
    lines.push(
      `Memory: ${iso.memory.heapGrowthPerCycle.toFixed(0)} bytes/cycle over ${iso.memory.cycles} cycles ` +
      `(leak suspected: ${iso.memory.leakSuspected ? "yes" : "no"})`,
    );
  }
  if (iso.strictMode) {
    lines.push(
      `StrictMode: +${iso.strictMode.overhead.toFixed(1)}% double-invoke overhead ` +
      `(clean: ${iso.strictMode.doubleInvokeClean ? "yes" : "no"})`,
    );
  }
  if (!pass) {
    const detail = isolationFailureLines(iso);
    lines.push(...(detail.length > 0 ? detail : ["Isolation verdict failed (see JSON report for detail)."]));
  }
  return lines;
}

// What the process is about to exit with, for a run whose failure produced no Report of its own.
export interface CiRunOutcome {
  failed?: boolean;
}

export function formatMarkdown(reports: Report[], run: CiRunOutcome = {}): string {
  const failing = reports.filter((r) => !r.pass);
  const regressionCount = reports.reduce(
    (sum, r) => sum + (r.baseline?.regressions.length ?? 0),
    0,
  );

  const lines: string[] = [
    "## 120fps",
    "",
    `${failing.length === 0 && !run.failed ? "**PASS**" : "**FAIL**"}: ${reports.length} ` +
    `component${reports.length === 1 ? "" : "s"}, ${regressionCount} ` +
    `regression${regressionCount === 1 ? "" : "s"}`,
    "",
    "| component | mount | rerender | verdict | vs baseline | phases |",
    "|---|---|---|---|---|---|",
  ];

  for (const report of reports) {
    const timings = modeTimings(report);
    const cached = report.cached ? " _(cached)_" : "";
    // A dash means no phaseTimings were recorded, never zero seconds spent.
    const phases = describePhaseBreakdown(report.phaseTimings);
    lines.push(
      `| \`${escapeMdCell(report.componentPath)}\`${cached} | ${timings.mount} | ` +
      `${timings.rerender} | ${VERDICT_MARK[worstVerdict(report)]} | ${baselineDelta(report)} | ` +
      `${phases === "" ? "-" : phases} |`,
    );
  }

  // Behind a fold: a sweep of thirty components must not outgrow a forge comment.
  const withRegressions = reports.filter((r) => (r.baseline?.regressions.length ?? 0) > 0);
  if (withRegressions.length > 0) {
    lines.push("", "<details><summary>Regressions</summary>", "");
    for (const report of withRegressions) {
      lines.push(`**\`${escapeMdCell(report.componentPath)}\`**`, "");
      for (const regression of report.baseline!.regressions) {
        lines.push(
          `- \`${regression.metric}\`: ${regression.baseline.toFixed(2)}ms → ` +
          `${regression.current.toFixed(2)}ms (+${regression.deltaPercent.toFixed(1)}%, ` +
          `tolerance ${regression.tolerance}%)`,
        );
      }
      lines.push("");
    }
    lines.push("</details>");
  }

  // Not gated on failure: both modes run one component at a time, so size is no risk.
  const modeDetails = reports
    .map((report) => {
      const mode = reportMode(report);
      if (mode === "curve") {
        return { report, lines: curveDetailLines(report.scalingCurveReport!, report.thresholds, report.pass) };
      }
      if (mode === "isolation") {
        return { report, lines: isolationDetailLines(report.isolation!, report.pass) };
      }
      return null;
    })
    .filter((entry): entry is { report: Report; lines: string[] } => entry !== null && entry.lines.length > 0);

  if (modeDetails.length > 0) {
    lines.push("", "<details><summary>Mode detail</summary>", "");
    for (const { report, lines: detail } of modeDetails) {
      lines.push(`**\`${escapeMdCell(report.componentPath)}\`**`, "");
      for (const line of detail) lines.push(`- ${line}`);
      lines.push("");
    }
    lines.push("</details>");
  }

  // README.md promises the markdown output carries the run's warnings.
  for (const report of reports) {
    const warnings = presentWarnings(report);
    if (warnings.length === 0) continue;
    lines.push(
      "",
      `<details><summary>Warnings: <code>${escapeMdCell(report.componentPath)}</code></summary>`,
      "",
    );
    for (const warning of warnings) lines.push(`- ${warning}`);
    lines.push("", "</details>");
  }

  const first = reports[0];
  if (first) {
    const machine = first.machine;
    const noise = first.noise ? `, machine ${first.noise.level}` : "";
    lines.push(
      "",
      `<sub>${machine.cpu} · ${machine.cores} cores · ${machine.os} · ` +
      `Chromium ${machine.chromiumVersion}${noise}</sub>`,
    );
  }

  return lines.join("\n") + "\n";
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function failureBody(report: Report): string {
  const lines: string[] = [];
  for (const regression of report.baseline?.regressions ?? []) {
    lines.push(
      `${regression.metric}: ${regression.baseline.toFixed(2)}ms → ${regression.current.toFixed(2)}ms ` +
      `(+${regression.deltaPercent.toFixed(1)}%, tolerance ${regression.tolerance}%)`,
    );
  }

  switch (reportMode(report)) {
    case "combo":
      for (const combo of report.combos) {
        if (combo.verdict !== "fail") continue;
        // A render error exceeds no budget, so naming a tier misdirects the reader.
        if (combo.renderHealth === "error") {
          lines.push(
            `combo ${combo.comboIndex}: rendered 0 DOM nodes while the page threw: ` +
            (combo.pageErrors ?? []).join("; "),
          );
          continue;
        }
        lines.push(
          `combo ${combo.comboIndex}: mount ${combo.mount.median.toFixed(2)}ms, ` +
          `rerender ${combo.rerender.median.toFixed(2)}ms: over budget for tier ${combo.tier ?? "?"}`,
        );
      }
      break;
    case "cached":
      lines.push(CACHED_FAIL_MESSAGE);
      break;
    case "curve": {
      const detail = curveFailureLines(report.scalingCurveReport!, report.thresholds);
      lines.push(...(detail.length > 0 ? detail : ["Curve verdict failed (see JSON report for detail)."]));
      break;
    }
    case "isolation": {
      const detail = isolationFailureLines(report.isolation!);
      lines.push(...(detail.length > 0 ? detail : ["Isolation verdict failed (see JSON report for detail)."]));
      break;
    }
    case "empty":
      lines.push("No measurable data for this report.");
      break;
  }

  return lines.join("\n") || "failed";
}

// A component that threw finished no Report, so nothing in `reports` carries its failure.
export const UNREPORTED_RUN_FAILURE_NAME = "120fps run";
export const UNREPORTED_RUN_FAILURE_MESSAGE =
  "the run exited 1 without a report for every component";

export function formatJUnit(reports: Report[], run: CiRunOutcome = {}): string {
  const reportedFailures = reports.filter((r) => !r.pass).length;
  // Without this case a sweep that threw would claim every component it finished passed.
  const unreported = !!run.failed && reportedFailures === 0;
  const failures = reportedFailures + (unreported ? 1 : 0);
  const tests = reports.length + (unreported ? 1 : 0);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="120fps" tests="${tests}" failures="${failures}">`,
    `  <testsuite name="120fps" tests="${tests}" failures="${failures}">`,
  ];

  for (const report of reports) {
    const name = escapeXml(report.componentPath);
    if (report.pass) {
      lines.push(`    <testcase name="${name}" classname="120fps" />`);
      continue;
    }
    lines.push(
      `    <testcase name="${name}" classname="120fps">`,
      `      <failure message="${escapeXml(report.componentPath)} regressed">` +
      escapeXml(failureBody(report)) +
      "</failure>",
      "    </testcase>",
    );
  }

  if (unreported) {
    lines.push(
      `    <testcase name="${UNREPORTED_RUN_FAILURE_NAME}" classname="120fps">`,
      `      <failure message="${escapeXml(UNREPORTED_RUN_FAILURE_MESSAGE)}" />`,
      "    </testcase>",
    );
  }

  lines.push("  </testsuite>", "</testsuites>");
  return lines.join("\n") + "\n";
}
