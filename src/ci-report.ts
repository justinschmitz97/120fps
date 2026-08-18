import type { Report, ScalingCurveReport, Thresholds } from "./report.js";
import { computeCurveVerdict, deriveReportMode } from "./report.js";
import type { IsolationReport } from "./isolation.js";
import { CHURN_DEGRADATION_LIMIT, LEAK_BYTES_PER_CYCLE } from "./isolation.js";

// Both formats derive from `Report` alone: no measurement state, no filesystem,
// no network. 120fps emits what forges consume and never talks to a forge.

// M55: curve, isolation, and cached reports ship `combos: []` — the mode's
// real data lives in a different field. One dispatch point per serializer
// (per M55's design) keeps a future mode from silently rendering as "empty".
type ReportMode = "combo" | "cached" | "curve" | "isolation" | "empty";

// Serializer dispatch is about which field carries the numbers, so the combo
// and cached shapes are still checked here. The curve/isolation split comes
// from the report's own mode discriminator (M64) rather than a second guess.
function reportMode(report: Report): ReportMode {
  if (report.combos.length > 0) return "combo";
  if (report.cached) return "cached";
  const mode = deriveReportMode(report);
  if (mode === "curve" && report.scalingCurveReport) return "curve";
  if (mode === "isolation" && report.isolation) return "isolation";
  return "empty";
}

function isolationWarnSignal(iso: IsolationReport): boolean {
  // computeIsolationVerdict (src/isolation.ts) never fails a run on StrictMode
  // overhead by design — it only warns. That is the one isolation-native warn
  // condition; anything else that flips `pass` is already a hard fail.
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

// Table-cell content for the mount/rerender columns. Curve and isolation
// reports carry real numbers elsewhere on `Report`; only a genuinely
// unrecognized shape (no combos, no cached/curve/isolation field) has nothing
// to show.
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
      // No new measurement was taken — a dash here is correct, not a bug.
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

// Points-with-growth-class for a curve report and, on failure, which
// classification broke the verdict. Shared by the markdown detail block and
// the JUnit failure body so both surfaces name the same numbers.
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

// Isolation's own fail conditions (src/isolation.ts computeIsolationVerdict):
// leak suspected, churn degradation past the limit, or mount past its budget.
// Leak and churn are checked with the exact constants the pipeline uses, so
// they never drift from what actually failed the run. Mount has no stored
// budget on `Report` (isolation resolves a tiered budget analyze.ts does not
// persist) — reported by elimination only when nothing else explains the fail.
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
    lines.push("DOM node count never changed across scale points — growth class reflects no structural growth.");
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

export function formatMarkdown(reports: Report[]): string {
  const failing = reports.filter((r) => !r.pass);
  const regressionCount = reports.reduce(
    (sum, r) => sum + (r.baseline?.regressions.length ?? 0),
    0,
  );

  const lines: string[] = [
    "## 120fps",
    "",
    `${failing.length === 0 ? "**PASS**" : "**FAIL**"} — ${reports.length} ` +
    `component${reports.length === 1 ? "" : "s"}, ${regressionCount} ` +
    `regression${regressionCount === 1 ? "" : "s"}`,
    "",
    "| component | mount | rerender | verdict | vs baseline |",
    "|---|---|---|---|---|",
  ];

  for (const report of reports) {
    const timings = modeTimings(report);
    const cached = report.cached ? " _(cached)_" : "";
    lines.push(
      `| \`${escapeMdCell(report.componentPath)}\`${cached} | ${timings.mount} | ` +
      `${timings.rerender} | ${VERDICT_MARK[worstVerdict(report)]} | ${baselineDelta(report)} |`,
    );
  }

  // Regression numbers go behind a fold: a sweep of thirty components must not
  // outgrow a forge comment, and the JSON file remains the full reference.
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

  // Curve and isolation reports carry more than two numbers; the summary row
  // shows the headline value, this fold shows every scale point / phase, and
  // on failure the same lines the JUnit failure body carries. Unlike the
  // regressions fold, this one is not gated on failure — the M55 contract
  // treats these numbers as always-relevant, and both modes are typically run
  // one component at a time, so it does not threaten comment size the way a
  // thirty-component regression list would.
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
        // M59: a render error fails without any budget being exceeded, so
        // naming a tier here would send the reader after the wrong number.
        if (combo.renderHealth === "error") {
          lines.push(
            `combo ${combo.comboIndex}: rendered 0 DOM nodes while the page threw — ` +
            (combo.pageErrors ?? []).join("; "),
          );
          continue;
        }
        lines.push(
          `combo ${combo.comboIndex}: mount ${combo.mount.median.toFixed(2)}ms, ` +
          `rerender ${combo.rerender.median.toFixed(2)}ms — over budget for tier ${combo.tier ?? "?"}`,
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

export function formatJUnit(reports: Report[]): string {
  const failures = reports.filter((r) => !r.pass).length;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="120fps" tests="${reports.length}" failures="${failures}">`,
    `  <testsuite name="120fps" tests="${reports.length}" failures="${failures}">`,
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

  lines.push("  </testsuite>", "</testsuites>");
  return lines.join("\n") + "\n";
}
