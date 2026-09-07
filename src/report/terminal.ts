import type {
  BaselineComparison,
  ComboReport,
  CssReport,
  EnvMatch,
  Report,
  WrapperReport,
} from "./types.js";
import type { ReactOptimizations } from "../analysis/index.js";
import type { NoiseReport } from "../browser/index.js";
import {
  HOSTILE_CV_PERCENT,
  HOSTILE_RUN_WARNING,
  HOSTILE_UNSTABLE_FRACTION,
  NOISE_CV_PERCENT,
  NOISY_RUN_WARNING,
  NOISY_UNSTABLE_FRACTION,
} from "../browser/index.js";
import { hintsForReport, formatHints } from "./hints.js";
import { detectRenderHealthInconsistency } from "./stats.js";

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

// Exported so pipeline/phases.ts can format the decision once and reuse the same text.
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
      // An unlisted engine is only an observation, so its wording names the escape hatch.
      if (css.runtimeEnginesRecognised === false) {
        return (
          "Stylesheets: none — styling appears to be generated at runtime by " +
          `${(css.runtimeEngines ?? []).join(", ")} (unrecognised engine); pass --css if a ` +
          "stylesheet is needed"
        );
      }
      return (
        `Stylesheets: none — styling is generated at runtime by ${(css.runtimeEngines ?? []).join(", ")}; ` +
        "no stylesheet was needed"
      );
    case "disabled":
      return "Stylesheets: none (--no-css)";
    case "unreadable":
      return "Stylesheets: dropped after a read failure -- measured unstyled (see warnings)";
    case "none":
      // "none found" is false when the package declared one, so the declaration replaces it.
      if (css.declaredMissingFields && css.declaredMissingFields.length > 0) {
        const named = css.declaredMissingFields
          .map((d) => `package.json "${d.field}" declares ${d.path}`)
          .join("; ");
        const build = css.declaredMissingFields.find((d) => d.buildCommand)?.buildCommand;
        return (
          `Stylesheets: none injected — ${named}, which ${css.declaredMissingFields.length === 1 ? "is" : "are"} ` +
          "not built yet; " +
          (build
            ? `run \`${build}\` in that package, then re-run`
            : "build the package, then re-run")
        );
      }
      if (css.declaredMissing && css.declaredMissing.length > 0) {
        return (
          `Stylesheets: none injected — the measured package's package.json declares ` +
          `${css.declaredMissing.join(", ")}, which ${css.declaredMissing.length === 1 ? "is" : "are"} ` +
          "not built yet; build the package, then re-run"
        );
      }
      // The generic sentence claims a search; when the run recorded what it did, that is printed.
      if (css.searchNotes && css.searchNotes.length > 0) {
        return `Stylesheets: none found (${css.searchNotes.join("; ")})`;
      }
      return (
        "Stylesheets: none found (checked the project entry, conventional filenames, and the " +
        "largest stylesheet under the project)"
      );
    default:
      // `layer` is absent on a stored report, which is not type-checked when read back.
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

// Only entries with a finding are shown; a run where none has one prints no section.
export function appendReactSection(
  lines: string[],
  entries: Array<{ label: string; opts?: ReactOptimizations }>,
  // A curve's single finding still needs its N, or it reads as describing the whole sweep.
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

export function appendPageErrors(lines: string[], report: Report): void {
  const affected = report.combos.filter(
    (c) => (c.pageErrors?.length ?? 0) > 0 || (c.transitionPageErrors?.errors.length ?? 0) > 0,
  );
  if (affected.length === 0) return;
  lines.push("");
  lines.push("Page errors");
  for (const combo of affected) {
    lines.push(`  Combo #${combo.comboIndex}:`);
    for (const message of combo.pageErrors ?? []) lines.push(`    - ${message}`);
    // Before the transition block, or "counted as a failure" reads as its verdict.
    appendComboErrorVerdict(lines, combo);
    appendTransitionPageErrors(lines, combo);
  }
}

function appendComboErrorVerdict(lines: string[], combo: ComboReport): void {
  if (combo.harnessFault) {
    // The "counted as a failure" line below is false for a harness fault.
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

// Not this combo's own render, and the window spans a re-mount: a window, not a cause.
function appendTransitionPageErrors(lines: string[], combo: ComboReport): void {
  const transition = combo.transitionPageErrors;
  if (!transition || transition.errors.length === 0) return;
  lines.push(
    `    raised while transitioning to combo #${transition.toComboIndex}'s props ` +
    `(excluded from combo ${combo.comboIndex}'s verdict):`,
  );
  for (const message of transition.errors) lines.push(`      - ${message}`);
}

// Rendering null is legal; a 0 in the DOM column alone leaves the reader inferring.
export function appendEmptyRenderNote(lines: string[], report: Report): void {
  const empty = report.combos.filter((c) => c.renderHealth === "empty");
  if (empty.length === 0) return;
  // A sibling combo with a nonzero count contradicts the claim below.
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

// A text that already leads with a warning marker keeps the one it has.
const CARRIES_ITS_OWN_PREFIX = /^(⚠|Warning:)/;

// Every output mode ends with the run's warnings, or its numbers lose their reason.
export function appendWarnings(lines: string[], report: Report): void {
  for (const warning of presentWarnings(report)) {
    lines.push(CARRIES_ITS_OWN_PREFIX.test(warning) ? warning : `⚠ ${warning}`);
  }
}

// Keyed on the exact string: two texts differing by one character are two warnings.
export function dedupeWarnings(warnings: readonly string[]): string[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const warning of warnings) {
    const seen = counts.get(warning);
    if (seen === undefined) {
      counts.set(warning, 1);
      order.push(warning);
    } else {
      counts.set(warning, seen + 1);
    }
  }
  return order.map((warning) => {
    const count = counts.get(warning)!;
    return count > 1 ? `${warning} (×${count})` : warning;
  });
}

// `report.warnings` keeps the long form for the JSON; this is the reader-facing form.
export function presentWarnings(report: Report): string[] {
  return dedupeWarnings(report.warnings ?? []).map((warning) =>
    shortenNoiseWarning(warning, report),
  );
}

// Only the signals that fired against the level's own thresholds, plus the flag that helps.
export function formatNoiseLine(noise: NoiseReport): string {
  if (noise.level === "quiet") return "";
  const hostile = noise.level === "hostile";
  const cvLimit = hostile ? HOSTILE_CV_PERCENT : NOISE_CV_PERCENT;
  const unstableLimit = hostile ? HOSTILE_UNSTABLE_FRACTION : NOISY_UNSTABLE_FRACTION;
  const { probeCv, unstableFraction, contextRetries } = noise.signals;
  const signals: string[] = [];
  if (probeCv > cvLimit) signals.push(`probe CV ${Math.round(probeCv)}%`);
  if (unstableFraction >= unstableLimit) {
    signals.push(`${Math.round(unstableFraction * 100)}% of metrics unstable`);
  }
  if (contextRetries > 0) {
    signals.push(`${contextRetries} context ${contextRetries === 1 ? "retry" : "retries"}`);
  }
  if (signals.length === 0) return "";
  return `machine: ${noise.level} (${signals.join(", ")}); raise --samples to measure through it.`;
}

// Matched on the fixed sentence, so the bare constant and the expanded text both shorten.
function shortenNoiseWarning(warning: string, report: Report): string {
  if (!warning.includes(NOISY_RUN_WARNING) && !warning.includes(HOSTILE_RUN_WARNING)) return warning;
  if (!report.noise) return warning;
  return formatNoiseLine(report.noise) || warning;
}

// WARN rows under "Result: PASS" read as a contradiction unless the rule is stated.
export function appendWarnRollup(
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

// A scale probe is not a prop combo, but a warn on one is still a warn CI reports.
export function appendScaleProbeWarnRollup(lines: string[], report: Report): void {
  if (!report.pass) return;
  const warned = report.combos.filter(
    (c) => c.scaleProbe !== undefined && c.verdict === "warn",
  ).length;
  if (warned === 0) return;
  lines.push(
    `${warned} scale probe${warned === 1 ? "" : "s"} warned; warnings do not fail the run.`,
  );
}

// Once per run, after the findings, never as a substitute for them.
export function appendHints(lines: string[], report: Report): void {
  const hints = formatHints(report.hints ?? hintsForReport(report), report);
  if (hints) lines.push(hints);
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

export function formatBaselineSection(lines: string[], comparison: BaselineComparison): void {
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

const COL_WIDTHS = [4, 12, 12, 12, 8, 14, 14, 10];

export function padRow(cells: string[], widths?: number[]): string {
  const w = widths ?? COL_WIDTHS;
  return cells.map((c, i) => c.padEnd(w[i] ?? 10)).join(" ");
}
