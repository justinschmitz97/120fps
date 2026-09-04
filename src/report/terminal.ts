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
      // M114 C4 (fluentui-F3): a recognised engine is a fact about the
      // measured package's dependencies, so it closes the question. An
      // unlisted package read from a `makeStyles`/`styled` import is an
      // observation, so it names the escape hatch instead of asserting that
      // no stylesheet was needed.
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
      // M112 C4: "none found" is false when the package named one. The
      // declaration is the fact the user acts on, so it replaces the sentence
      // rather than being appended to it.
      // C4: the field and the build command when the producer named them,
      // the paths alone when it did not.
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

// M64: an entry whose analysis found nothing contributes a header and a blank
// label line and no information. Only entries with a finding are shown, and a
// run where none has one prints no section at all.
// M104 (commerce-F1): extracted from formatTable so curve and matrix modes
// print the identical section for the identical data. The label is what the
// mode calls one measurement ("Combo #2", "N=50"); everything else is
// unchanged.
export function appendReactSection(
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

// M59: the messages themselves, once per combo that produced any. A gated
// combo also states why its timings were not allowed to pass.
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
    // C-17: the verdict sentence belongs to the errors above it. Printed after
    // the transition block, "counted as a failure" sat directly under
    // "excluded from combo N's verdict" and read as if the transition errors
    // were what got counted.
    appendComboErrorVerdict(lines, combo);
    appendTransitionPageErrors(lines, combo);
  }
}

function appendComboErrorVerdict(lines: string[], combo: ComboReport): void {
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

// M59: rendering null is legal, and saying so is cheaper than leaving the
// reader to infer it from a 0 in the DOM column.
export function appendEmptyRenderNote(lines: string[], report: Report): void {
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
export function appendWarnings(lines: string[], report: Report): void {
  for (const warning of presentWarnings(report)) {
    lines.push(`⚠ ${warning}`);
  }
}

// M117 C1 (dx-audit item 6): a run that rebuilds its harness collected the same
// static pre-build warning list twice, so one identical sentence printed twice.
// The key is the exact string: two texts that differ by one character are two
// warnings. The count reuses the page-error shape (src/page-errors.ts).
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

// M117 C1, C5: what a reader-facing channel prints — the terminal here, the
// markdown fold in src/ci-report.ts. One line per distinct text, and the noise
// warning shortened to the one line C5 defines. `report.warnings` itself keeps
// the long form for the JSON (C6).
export function presentWarnings(report: Report): string[] {
  return dedupeWarnings(report.warnings ?? []).map((warning) =>
    shortenNoiseWarning(warning, report),
  );
}

// M117 C5 (dx-audit item 7): the four-sentence form listed both signals at
// their raw values whether or not either crossed its threshold and named no
// flag, in the one place a reader is scanning. One line, only the signals that
// fired against the level's own thresholds, and the one flag that helps.
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

// The noise warning is the one text that differs by channel (M117 C6): the JSON
// carries the full sentences `formatNoiseWarning` builds, a reader gets one
// line. Recognized by the fixed sentence the full form is built around, so both
// the bare constant and the expanded text shorten to the same line.
function shortenNoiseWarning(warning: string, report: Report): string {
  if (!warning.includes(NOISY_RUN_WARNING) && !warning.includes(HOSTILE_RUN_WARNING)) return warning;
  if (!report.noise) return warning;
  return formatNoiseLine(report.noise) || warning;
}

// M64: WARN rows under "Result: PASS" read as a contradiction without the
// rollup rule stated. Only a fail flips `report.pass`, and that is worth one
// line whenever the table shows warnings and the result does not.
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

// C-14: scale probes are excluded from the prop-combo rollup above because
// they are not prop combos, but a warn on one is still a warn the CI surface
// reports. Named separately so the two counts stay distinguishable.
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

// M51: every mode ends with what to do about what it found. Once per run, after
// the findings, never as a substitute for them.
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
