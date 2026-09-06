import path from "node:path";
import { isVueFile } from "../project/index.js";
import { toPosix } from "../shared/index.js";
import type { ComboReport, CurveViolation, MatrixCell, MatrixReport, Report } from "./types.js";
import { MEASUREMENT_BASIS_LINE } from "./hints.js";
import { describeMode, perStepCost } from "./stats.js";
import {
  appendEmptyRenderNote,
  appendHints,
  appendPageErrors,
  appendReactSection,
  appendScaleProbeWarnRollup,
  appendWarnings,
  appendWarnRollup,
  formatBaselineSection,
  formatStylesheetsLine,
  padRow,
} from "./terminal.js";

export function formatTable(report: Report): string {
  const lines: string[] = [];

  lines.push(`120fps: ${report.componentName}`);
  lines.push(`Machine: ${report.machine.cpu} (${report.machine.cores} cores), ${Math.round(report.machine.ramMb / 1024)}GB RAM, ${report.machine.os}`);
  lines.push(`Node ${report.machine.nodeVersion}, Chromium ${report.machine.chromiumVersion}`);
  lines.push(describeMode(report));
  // First-run users read 14ms and think their button takes 14ms.
  lines.push(MEASUREMENT_BASIS_LINE);
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
    const details: string[] = [];
    if (report.reactCompiler.version) details.push(`v${report.reactCompiler.version}`);
    // Beside the version, so a React 18 project reads which React the output assumes.
    if (report.reactCompiler.target) details.push(`target ${report.reactCompiler.target}`);
    const suffix = details.length > 0 ? ` (${details.join(", ")})` : "";
    lines.push(`React Compiler: active${suffix}`);
  } else if (report.reactCompiler?.skipped) {
    const { target, missingModule } = report.reactCompiler.skipped;
    lines.push(`React Compiler: skipped (target ${target}: ${missingModule} not installed)`);
  }
  lines.push("");

  // Nothing was measured, so every table, comparison and suggestion below would describe a
  // run that did not happen.
  if (report.cached) {
    return formatCachedOutput(lines, report);
  }

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
    // A scale probe's curve is over sibling copies, so it must never read as "auto: <prop>".
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
      // The planned count stops `x 3 steps` reading as a complete open-close-10 cycle.
      const truncatedSuffix = interaction.stepsPlanned
        ? ` [truncated: ${interaction.steps ?? 0} of ${interaction.stepsPlanned} steps, explore budget]`
        : "";
      lines.push(
        `    ${interaction.label} (${interaction.type}): ${interaction.timing.median.toFixed(2)}ms${stepSuffix} [${interaction.relativeTiming.toFixed(2)}x cal]${portalSuffix}${patternSuffix}${truncatedSuffix}`,
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
  // Prop combos only, the same filter `describeMode` applies.
  appendWarnRollup(
    lines,
    report,
    report.combos.filter((c) => c.scaleProbe === undefined).map((c) => c.verdict),
    "combos",
  );
  // report/ci.ts reads `combos.some(v === "warn")` unfiltered, scale probes included.
  appendScaleProbeWarnRollup(lines, report);

  if (hasUnstable) {
    lines.push("⚠ Unstable results (CV>15%): consider increasing sample count");
  }

  appendWarnings(lines, report);

  appendEmptyRenderNote(lines, report);

  const totalInteractions = report.combos.reduce((sum, c) => sum + c.interactions.length, 0);
  // A fixture cannot fix a component that throws, so the suggestion is withheld.
  const hasRenderError = report.combos.some((c) => c.renderHealth === "error");
  if (totalInteractions === 0 && !report.fixturePath && !hasRenderError) {
    const stem = path.basename(report.componentPath, path.extname(report.componentPath));
    const dir = path.dirname(report.componentPath);
    // detectFixture accepts only `.fixture.vue` for a Vue target, so the name must match.
    const suggestedExt = isVueFile(report.componentPath) ? "vue" : "tsx";
    // A suggested path is meant to be pasted, and a backslash survives no shell that matters.
    const hint = toPosix(path.join(dir, `${stem}.fixture.${suggestedExt}`));
    lines.push(`0 interactions found. Consider creating ${hint} with composed children.`);
  }

  if (report.baseline?.hasBaseline) {
    formatBaselineSection(lines, report.baseline);
  }

  appendHints(lines, report);

  return lines.join("\n");
}

// On the verdict cell, so a 0 in the DOM column needs no section further down.
function renderHealthMarks(combo: ComboReport): string {
  const marks: string[] = [];
  if (combo.renderHealth === "error") marks.push("render error");
  else if (combo.renderHealth === "empty") marks.push("no DOM");
  else if (combo.disclosureReason === "uncomposed") marks.push("uncomposed");
  else if (combo.disclosureReason === "propsExcluded") marks.push("props excluded");
  // Independent of the marks above: a healthy row can still have applied no props.
  if (combo.measuredWithoutProps) marks.push("no props applied");
  // No other column can show that the render drew nothing.
  if ((combo.unresolvedSpriteRefs?.length ?? 0) > 0) marks.push("unresolved sprite");
  // Beside "render error": this mark is what says the failure is not the component's.
  if (combo.harnessFault) marks.push(`harness fault: ${combo.harnessFault.propName}`);
  const count = combo.pageErrors?.length ?? 0;
  if (count > 0 && combo.renderHealth !== "error") {
    marks.push(`${count} page error${count === 1 ? "" : "s"}`);
  }
  // The arrow says the second set came from a different combo's props.
  const transition = combo.transitionPageErrors;
  if (transition && transition.errors.length > 0) {
    const n = transition.errors.length;
    marks.push(`→ #${transition.toComboIndex}: ${n} page error${n === 1 ? "" : "s"}`);
  }
  return marks.map((mark) => ` [${mark}]`).join("");
}

// The one sentence a reused run is allowed to say about what it did.
export const VERDICT_REUSED_LINE =
  "Verdict reused from baseline, nothing re-measured (--no-cache measures fresh numbers).";

// No table, no comparison, no suggestion: the verdict and the disclosures that came with it.
function formatCachedOutput(lines: string[], report: Report): string {
  lines.push(VERDICT_REUSED_LINE);
  lines.push("");
  lines.push(report.pass ? "Result: PASS" : "Result: FAIL");
  appendWarnings(lines, report);
  appendHints(lines, report);
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
  appendWarnings(lines, report);
  appendHints(lines, report);

  if (report.baseline?.hasBaseline) {
    formatBaselineSection(lines, report.baseline);
  }

  return lines.join("\n");
}

function formatCurveOutput(lines: string[], report: Report): string {
  const cr = report.scalingCurveReport!;
  lines.push(`Scaling: ${cr.propName} (${cr.propKind}, ${cr.reason})`);
  lines.push("");

  const header = padCurveRow(["N", "Mount", "Rerender", "Unmount", "DOM", "Heap", "Growth"]);
  lines.push(header);
  lines.push("-".repeat(header.length));

  // Mirrors renderHealthMarks's bracket convention, so a broken point never reads as healthy.
  const brokenNs = new Set((cr.renderErrorPoints ?? []).map((p) => p.n));
  for (let i = 0; i < cr.points.length; i++) {
    const p = cr.points[i];
    const isLast = i === cr.points.length - 1;
    let growth = isLast ? cr.mountCurve.growthClass : "";
    if (brokenNs.has(p.n)) growth += " [render error]";
    // A DOM of 0 is otherwise the only signal that this row measured no render.
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
  // Every curve `hintsForReport` reads, so no hint cites a class this screen omits.
  lines.push(`Growth: mount ${cr.mountCurve.growthClass}, rerender ${cr.rerenderCurve.growthClass}`);
  // The excluded points belong next to the class, never further down.
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

  // Curve mode auto-activates, so this section must disclose what combo mode would.
  appendReactSection(
    lines,
    cr.points.map((p) => ({ label: `N=${p.n}`, opts: p.reactOptimizations })),
    { labelEveryEntry: true },
  );

  appendWarnings(lines, report);

  appendHints(lines, report);

  return lines.join("\n");
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

// The mode line alone reads like success when an explicit --curve fell back.
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

// A MatrixCell carries no renderHealth, pageErrors or harnessFault to mark.
function matrixCellDisclosureMark(cell: MatrixCell): string {
  if (cell.disclosureReason === "uncomposed") return " [uncomposed]";
  if (cell.disclosureReason === "propsExcluded") return " [props excluded]";
  return "";
}

// The header claims every axis was crossed; a cell cap can leave one of them held.
function appendAxisCoverage(lines: string[], mr: MatrixReport): void {
  const coverage = mr.axisCoverage ?? [];
  const held = coverage.filter((a) => a.measuredValues <= 1);
  if (held.length === 0) return;
  const heldLabel = held
    .map((a) => `${a.propName}=${a.measuredValues === 0 ? "absent" : formatCellValue(a.heldValue)}`)
    .join(", ");
  // "crossed" alone would hide an axis truncated to fit the matrix.
  const crossed = coverage
    .filter((a) => a.measuredValues > 1)
    .map((a) =>
      a.measuredValues < a.declaredValues
        ? `${a.propName}: ${a.measuredValues} of ${a.declaredValues} values crossed`
        : a.propName,
    );
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

  // Hottest cells alone can print an all-PASS table above a FAIL result.
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
  if (mr.heldAbsentProps && mr.heldAbsentProps.length > 0) {
    lines.push(
      `Held absent (no value in any cell): ${mr.heldAbsentProps.join(", ")}.`,
    );
  }
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
      // A cell can cost less than its parts predict, so the word follows the sign.
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
  // Page errors live only on the combo, never on the cell.
  appendPageErrors(lines, report);
  appendEmptyRenderNote(lines, report);
  // Matrix cells are combos, so this reads the same field combo mode reads.
  appendReactSection(
    lines,
    report.combos.map((c) => ({ label: `Combo #${c.comboIndex}`, opts: c.reactOptimizations })),
  );
  appendWarnings(lines, report);
  appendHints(lines, report);

  return lines.join("\n");
}
