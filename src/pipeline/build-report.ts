import fs from "node:fs";
import path from "node:path";
import { stylesheetRuleCount } from "../harness/index.js";
import { type ReactCompilerState } from "../project/index.js";
import {
  hasPageErrors,
  mergeDrains,
  renderDrain,
  formatNoiseWarning,
  measuredOnly,
  type MountResult,
  type RerenderResult,
} from "../browser/index.js";
import { type PropSchema, type CompositionTree } from "../props/index.js";
import { type ExploreResult } from "../analysis/index.js";
import {
  computeScalingCurve,
  attributeCost,
  computeINP,
  loadBudgetConfig,
  loadBaseline,
  resolveBaselinePath,
  saveBaseline as saveBaselineFile,
  resolveTolerances,
  compareBaseline,
  computeEnvKey,
  selectBaselineEntry,
  envAdvisory,
  NO_ENV_BASELINE_WARNING,
  PRUNED_SLOTS_NOTICE,
  type BaselineEntry,
  type BaselineEnvPolicy,
  type BaselineMetrics,
  buildTimingWithCV,
  classifyTier,
  computeVerdict,
  detectRenderHealthInconsistency,
  TIER_BUDGETS,
  type CalibrationResult,
  type ComboReport,
  type InteractionReport,
  type MachineInfo,
  type MeasuredState,
  type Report,
  type MatrixReport,
  type ScalingCurveReport,
  type TierBudget,
  type Thresholds,
  type CssReport,
  type EnvFingerprint,
  type PropProvenance,
  type PhaseClock,
  type PhaseTimings,
  type ReactCompilerReport,
} from "../report/index.js";
import { type AnalyzeOptions } from "./analyze.js";
import { type resolveCssFiles } from "./resolve.js";
import { legacyBaselineWarning } from "./verdict-reuse.js";
import { toPosix } from "../shared/index.js";

// Warn, never fail: the numbers are real, and the defect is presenting them as the whole story.
const MEASURED_STATE_CAUSE: Record<Exclude<MeasuredState, "settled">, string> = {
  "pending-network": "fetch/XHR requests started during mount were still in flight when the sample window closed",
  "late-mutation": "the component DOM changed after the mount fence without any input",
};

export const MEASURED_STATE_WARNING = (
  state: Exclude<MeasuredState, "settled">,
  combo?: string,
): string =>
  `${combo ? `${combo} was` : "the reused baseline was"} measured in a ${state} state: ` +
  `${MEASURED_STATE_CAUSE[state]}. The numbers describe that scene, not the settled component.`;

export interface BuildReportInput {
  componentPath: string;
  componentName: string;
  machine: MachineInfo;
  calibration: CalibrationResult;
  mounts: MountResult[];
  explores: ExploreResult[];
  heapDeltas: number[];
  thresholds: Thresholds;
  fixturePath?: string;
  fixtureAutoDetected?: boolean;
  rerenders?: RerenderResult[];
  flatThresholds?: boolean;
  explicitThresholds?: Partial<Record<keyof TierBudget, boolean>>;
  skipAttribution?: boolean;
  autoComposition?: boolean;
  compositionTree?: import("../props/index.js").CompositionTree;
  // A combo rendered something, but not the whole component; a combo with renderHealth is exempt.
  disclosureReason?: "uncomposed" | "propsExcluded";
  // Set when the combo list is the single {} a fixture or composed scene makes; every row says so.
  measuredWithoutProps?: boolean;
  nextJsShims?: string[];
  scalingCurveReport?: ScalingCurveReport;
  matrixReport?: import("../report/index.js").MatrixReport;
  // Attributes a fatal crash to a synthesized value; without provenance nothing is exonerated.
  schemas?: Array<PropSchema & { provenance?: PropProvenance }>;
  // attributeCost runs per combo here, so its window is carved out of whichever phase was open.
  phaseClock?: Pick<PhaseClock, "addAttribution">;
}

// A value the harness chose reached the DOM of a combo that rendered: the verdict is not the point.
export function HARNESS_FAULT_DISCLOSURE(
  comboIndex: number,
  fault: NonNullable<ComboReport["harnessFault"]>,
): string {
  const evidence = fault.evidence.length > 160
    ? `${fault.evidence.slice(0, 160).trimEnd()}…`
    : fault.evidence;
  return (
    `[harness fault] combo ${comboIndex} rendered with the harness's own synthesized value for ` +
    `"${fault.propName}" (${JSON.stringify(fault.value)}, provenance: ${fault.provenance}), and a ` +
    `page error names it: ${evidence}. The verdict is unchanged; add a preset naming the prop to ` +
    "measure it with a real value."
  );
}

// A harness-caused crash is not the component's, but risky provenance alone is never evidence.
function detectHarnessFault(
  combo: ComboReport,
  schemas: Array<PropSchema & { provenance?: PropProvenance }> | undefined,
): ComboReport["harnessFault"] | undefined {
  if (!schemas || schemas.length === 0) return undefined;
  const errorText = (combo.pageErrors ?? []).join(" ");

  // Truthiness is necessary, not sufficient: an unconditional crash must exonerate no combo.
  for (const schema of schemas) {
    if (schema.provenance !== "contract") continue;
    if (!(schema.name in combo.props)) continue;
    const value = combo.props[schema.name];
    if (!value) continue;
    if (!contractEvidencedInText(schema.name, errorText)) continue;
    return { propName: schema.name, value, provenance: "contract", evidence: errorText };
  }

  // The synthesized value must appear verbatim in the error text; presence in the combo is not it.
  for (const schema of schemas) {
    if (schema.provenance !== "placeholder" && schema.provenance !== "heuristic") continue;
    if (!(schema.name in combo.props)) continue;
    if (!errorText) continue;
    const value = combo.props[schema.name];
    if (valueEvidencedInText(value, errorText)) {
      return { propName: schema.name, value, provenance: schema.provenance, evidence: errorText };
    }
  }

  return undefined;
}

function stringifyLeaf(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

// Evidence about asChild alone: `as` and `render` substitute an element without a Slot.
const SLOT_MECHANISM_TERMS = [
  "aschild",
  "slot",
  "slottable",
  "cloneelement",
  "react.children.only",
  "not valid as a react child",
];

// "as" and "render" are ordinary words in failure prose, so a bare name match proves nothing.
function contractEvidencedInText(propName: string, errorText: string): boolean {
  if (!errorText) return false;
  const lowered = errorText.toLowerCase();
  if (propName.toLowerCase() === "aschild") {
    for (const term of SLOT_MECHANISM_TERMS) {
      const hit = term.includes(" ") ? lowered.includes(term) : matchesAsWord(term, lowered);
      if (hit) return true;
    }
  }
  const escaped = propName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("[\"'`]?" + escaped + "[\"'`]?\\s+prop(?![A-Za-z0-9_])", "i")
    .test(errorText);
}

// Word-boundary, not substring: a placeholder "0" must not match inside "...at line 10".
function matchesAsWord(needle: string, haystack: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(haystack);
}

// Depth-bounded, so a cyclic or pathological value cannot loop this.
function valueEvidencedInText(value: unknown, errorText: string, depth = 0): boolean {
  const leaf = stringifyLeaf(value);
  if (leaf && matchesAsWord(leaf, errorText)) return true;
  if (depth >= 3 || value === null || typeof value !== "object") return false;
  for (const child of Object.values(value as Record<string, unknown>)) {
    if (valueEvidencedInText(child, errorText, depth + 1)) return true;
  }
  return false;
}

export function buildReport(input: BuildReportInput): Report {
  const combos: ComboReport[] = [];

  // A pass that stopped early leaves holes, and find() would still call its predicate on them.
  for (const mount of measuredOnly(input.mounts)) {
    const exploreResult = input.explores.find(
      (e) => e.comboIndex === mount.comboIndex,
    );

    const interactions: InteractionReport[] = [];
    if (exploreResult) {
      for (const edge of exploreResult.graph.edges) {
        const timing = buildTimingWithCV(edge.samples);
        const report: InteractionReport = {
          selector: edge.interaction.selector,
          type: edge.interaction.type,
          label: edge.interaction.label,
          timing,
          relativeTiming:
            input.calibration.totalDuration > 0
              ? timing.median / input.calibration.totalDuration
              : 0,
        };
        if (edge.interaction.portal) report.portal = true;
        if (edge.stressPattern) report.stressPattern = edge.stressPattern;
        if (edge.stressSteps) report.steps = edge.stressSteps;
        // A pattern the explore budget cut short.
        if (edge.stressTruncatedFrom) report.stepsPlanned = edge.stressTruncatedFrom;
        interactions.push(report);
      }
    }

    // Edges retain their raw per-sample traces, so INP needs no extra measurement pass.
    let inp: number | undefined;
    if (exploreResult) {
      const interactionTraces = exploreResult.graph.edges.flatMap((edge) => edge.traces);
      if (interactionTraces.length > 0) {
        inp = computeINP(interactionTraces);
      }
    }

    const relativeMount =
      input.calibration.totalDuration > 0
        ? mount.mount.median / input.calibration.totalDuration
        : 0;

    const rerenderResult = measuredOnly(input.rerenders ?? []).find(
      (r) => r.comboIndex === mount.comboIndex,
    );

    const rerenderTiming = rerenderResult
      ? buildTimingWithCV(rerenderResult.stable.samples)
      : buildTimingWithCV([0]);

    // __120fps_scaleN is a harness trigger key, not a prop; scaleProbe carries that identity.
    const rawProps = mount.props as Record<string, unknown>;
    const scaleProbeValue = rawProps["__120fps_scaleN"];
    const isScaleProbe = typeof scaleProbeValue === "number";
    const props = isScaleProbe
      ? Object.fromEntries(Object.entries(rawProps).filter(([k]) => k !== "__120fps_scaleN"))
      : rawProps;

    const combo: ComboReport = {
      comboIndex: mount.comboIndex,
      props,
      mount: buildTimingWithCV(mount.mount.samples),
      unmount: buildTimingWithCV(mount.unmount.samples),
      rerender: rerenderTiming,
      domNodeCount: mount.domNodeCount,
      heapDelta: input.heapDeltas[mount.comboIndex] ?? 0,
      interactions,
      scalingCurve: null,
      relativeMount,
      verdict: "pass",
      // The state graph already measured this; nothing else read it.
      ...(exploreResult ? { exploreWallClockMs: exploreResult.graph.wallClockMs } : {}),
      measuredState: mount.measuredState ?? "settled",
      ...(isScaleProbe ? { scaleProbe: scaleProbeValue as number } : {}),
      ...(input.measuredWithoutProps && !isScaleProbe ? { measuredWithoutProps: true } : {}),
      ...(mount.unresolvedSpriteRefs && mount.unresolvedSpriteRefs.length > 0
        ? { unresolvedSpriteRefs: mount.unresolvedSpriteRefs }
        : {}),
    };

    if (rerenderResult?.change) {
      combo.rerenderChange = buildTimingWithCV(rerenderResult.change.samples);
    }

    if (inp !== undefined) {
      combo.inp = inp;
    }

    if (!input.skipAttribution && mount.mountTraces && mount.mountTraces.length > 0) {
      const attributionStart = Date.now();
      combo.costAttribution = attributeCost(mount.mountTraces);
      input.phaseClock?.addAttribution(Date.now() - attributionStart);
    }

    // This combo's own two windows only; the prop-delta sub-probe's window stays separate below.
    const pageErrors = mergeDrains(mount.pageErrors, rerenderResult?.pageErrors);
    if (hasPageErrors(pageErrors)) {
      combo.pageErrors = renderDrain(pageErrors!);
    }
    const transition = rerenderResult?.transitionPageErrors;
    if (transition && hasPageErrors(transition.errors)) {
      combo.transitionPageErrors = {
        toComboIndex: transition.toComboIndex,
        errors: renderDrain(transition.errors),
      };
    }
    if (combo.domNodeCount === 0) {
      // Fatal is an uncaught exception, never console.error: a verdict cannot turn on dev warnings.
      combo.renderHealth = pageErrors?.fatal ? "error" : "empty";
    }

    combo.verdict = computeVerdict(combo, input.thresholds);
    combos.push(combo);
  }

  // Computed before the curve fit below adds more combos to reconcile against.
  const renderHealthInconsistencyWarning = detectRenderHealthInconsistency(combos);

  // Only the probe combos carry a true independent variable, so only they receive the fit.
  const scaleProbeCombos = combos.filter((c) => c.scaleProbe !== undefined);
  if (scaleProbeCombos.length >= 2) {
    const points = scaleProbeCombos.map((c) => ({ n: c.scaleProbe!, metric: c.mount.median }));
    const curve = computeScalingCurve(points);
    const rerenderPoints = scaleProbeCombos.map((c) => ({ n: c.scaleProbe!, metric: c.rerender.median }));
    const rerenderCurve = computeScalingCurve(rerenderPoints);
    for (const combo of scaleProbeCombos) {
      combo.scalingCurve = curve;
      combo.rerenderScalingCurve = rerenderCurve;
    }
  }

  if (!input.flatThresholds) {
    // On a scale-export fixture every combo is a probe, and exempting all would never fail.
    const probesAccompanyPropCombos = combos.some((c) => c.scaleProbe === undefined);
    for (const combo of combos) {
      // combo.props has the trigger key stripped, so only scaleProbe identifies a probe here.
      const isScaleCombo = combo.scaleProbe !== undefined && probesAccompanyPropCombos;
      const hasPortal = combo.interactions.some((i) => i.portal === true);
      const hasScaling = combo.scalingCurve != null || combo.rerenderScalingCurve != null;
      const mountResult = measuredOnly(input.mounts).find((m) => m.comboIndex === combo.comboIndex);
      const hasAnimation = mountResult?.hasAnimation ?? false;
      const tier = classifyTier({ domNodeCount: combo.domNodeCount, hasPortal, hasScaling, hasAnimation });
      combo.tier = tier;
      combo.hasAnimation = hasAnimation;
      if (isScaleCombo) {
        // A scale probe is exempt from budgets, never from rendering: a throw is still broken.
        combo.verdict = combo.renderHealth === "error" ? "fail" : "pass";
      } else {
        const tierBudget = TIER_BUDGETS[tier];
        const effectiveBudget: TierBudget = {
          mountMs: input.explicitThresholds?.mountMs ? input.thresholds.mountMs : tierBudget.mountMs,
          rerenderMs: input.explicitThresholds?.rerenderMs ? input.thresholds.rerenderMs : tierBudget.rerenderMs,
          interactionMs: input.explicitThresholds?.interactionMs ? input.thresholds.interactionMs : tierBudget.interactionMs,
          interactionStepMs: tierBudget.interactionStepMs,
        };
        combo.verdict = computeVerdict(combo, input.thresholds, {
          tierBudget: effectiveBudget,
          // An explicitly supplied aggregate threshold keeps its old meaning.
          explicitInteraction: input.explicitThresholds?.interactionMs === true,
        });
      }
    }
  }

  // After the tier pass, so it sees the verdict a reader would; it only narrows an explained fail.
  const harnessFaultDisclosures: string[] = [];
  for (const combo of combos) {
    const fault = detectHarnessFault(combo, input.schemas);
    if (!fault) continue;
    if (combo.verdict === "fail" && combo.renderHealth === "error") {
      combo.harnessFault = fault;
      combo.verdict = "warn";
      continue;
    }
    // The combo rendered, so its verdict stands; the reader is still told the value was ours.
    harnessFaultDisclosures.push(HARNESS_FAULT_DISCLOSURE(combo.comboIndex, fault));
  }

  // Stated directly: a verdict mutation added below must not start charging a harnessFault again.
  const pass = combos.every((c) => c.verdict !== "fail" || c.harnessFault !== undefined);

  const report: Report = {
    version: 1,
    timestamp: new Date().toISOString(),
    machine: input.machine,
    componentPath: input.componentPath,
    componentName: input.componentName,
    calibration: input.calibration,
    combos,
    thresholds: input.thresholds,
    pass,
  };

  const unsettled = combos.filter((c) => c.measuredState && c.measuredState !== "settled");
  if (unsettled.length > 0) {
    report.warnings = [...(report.warnings ?? [])].concat(unsettled.map((c) =>
      MEASURED_STATE_WARNING(
        c.measuredState as Exclude<MeasuredState, "settled">,
        `combo ${c.comboIndex}`,
      ),
    ));
  }

  // The same missing id across ten cells is one fact about the document, not ten about the run.
  const spriteRefs = [...new Set(combos.flatMap((c) => c.unresolvedSpriteRefs ?? []))];
  if (spriteRefs.length > 0) {
    report.warnings = [...(report.warnings ?? []), UNRESOLVED_SPRITE_REFS_WARNING(spriteRefs)];
  }

  if (renderHealthInconsistencyWarning) {
    report.warnings = [...(report.warnings ?? []), renderHealthInconsistencyWarning];
  }

  if (harnessFaultDisclosures.length > 0) {
    report.warnings = [...(report.warnings ?? []), ...harnessFaultDisclosures];
  }

  if (input.fixturePath !== undefined) {
    report.fixturePath = input.fixturePath;
    report.fixtureAutoDetected = input.fixtureAutoDetected ?? false;
  }

  if (!input.flatThresholds) {
    report.tieredBudgets = true;
  }

  if (input.autoComposition) {
    report.autoComposition = true;
  }
  if (input.compositionTree) {
    report.compositionTree = input.compositionTree;
  }

  // A renderHealth combo already discloses what happened; a plausible-looking render does not.
  if (input.disclosureReason) {
    for (const combo of combos) {
      if (combo.renderHealth) continue;
      combo.disclosureReason = input.disclosureReason;
      if (combo.verdict === "pass") combo.verdict = "warn";
    }
  }

  if (input.nextJsShims && input.nextJsShims.length > 0) {
    report.nextJsShims = input.nextJsShims;
  }

  if (input.scalingCurveReport) {
    report.scalingCurveReport = input.scalingCurveReport;
  }

  if (input.matrixReport) {
    report.matrixReport = input.matrixReport;
  }

  return report;
}

export interface BaselineWorkflowContext {
  options: AnalyzeOptions;
  projectRoot: string;
  relativeComponent: string;
  componentDir: string;
  currentEnv: EnvFingerprint;
  envPolicy: BaselineEnvPolicy;
  // Stored with the entry on save so unchanged components can reuse it.
  sourceFingerprint?: string;
  // Read by the estimate only: never part of the environment key or the reuse decision.
  phaseTimings?: PhaseTimings;
  phaseUnits?: { combos: number; samples: number };
}

// Shared by every mode, so the isolation branch compares the same three metrics as the rest.
export function applyBaselineWorkflow(
  report: Report,
  metrics: BaselineMetrics | undefined,
  ctx: BaselineWorkflowContext,
): void {
  const baselinePath = resolveBaselinePath(ctx.projectRoot, ctx.options.baselineFile);

  if (ctx.options.check && !ctx.options.noBaseline) {
    const baseline = loadBaseline(baselinePath);
    const selection = selectBaselineEntry(
      baseline,
      ctx.relativeComponent,
      computeEnvKey(ctx.currentEnv),
    );
    const entry = selection?.entry;
    if (entry) {
      const tol = resolveTolerances(loadBudgetConfig(ctx.projectRoot));
      const comparison = compareBaseline(
        entry,
        {
          mount: metrics?.mount ?? 0,
          rerender: metrics?.rerender ?? 0,
          unmount: metrics?.unmount ?? 0,
          interactions: metrics?.interactions ?? {},
          ...(metrics?.measuredState ? { measuredState: metrics.measuredState } : {}),
        },
        tol,
        metrics?.unstable ?? new Set<string>(),
        ctx.envPolicy === "ignore" ? undefined : ctx.currentEnv,
      );
      // A cross-machine delta is not evidence of a regression, unless "ignore" asked for one.
      if (selection!.crossEnvironment && ctx.envPolicy !== "ignore") {
        comparison.crossEnvironment = true;
        report.warnings = [
          ...(report.warnings ?? []),
          NO_ENV_BASELINE_WARNING(ctx.relativeComponent),
        ];
      }
      // Noise invalidates the timing comparison; the environment classification is a file fact.
      if (report.noise?.level === "hostile") {
        comparison.regressions = [];
        comparison.improvements = [];
        comparison.skippedNoisy = true;
      }

      report.baseline = comparison;
      // Whether a comparison happened is known only here, and the noise text predates this.
      if (report.noise && report.warnings) {
        const uncompared = formatNoiseWarning(report.noise, false);
        const compared = formatNoiseWarning(report.noise, true);
        if (uncompared && compared !== uncompared) {
          report.warnings = report.warnings.map((w) => (w === uncompared ? compared : w));
        }
      }
      // A noisy run reports regressions without failing; budget breaches are absolute regardless.
      const noiseDowngrade = report.noise?.level === "noisy";
      if (comparison.regressions.length > 0 && !comparison.crossEnvironment && !noiseDowngrade) {
        report.pass = false;
      }
      if (comparison.measuredStateMismatch) {
        const { baseline: was, current: now } = comparison.measuredStateMismatch;
        report.warnings = [
          ...(report.warnings ?? []),
          `Baseline measured a ${was} scene, this run a ${now} one; comparison skipped. ` +
          "Re-save with --save-baseline once the component settles the same way twice.",
        ];
      }
      const advisory = envAdvisory(comparison.envMatch, comparison.envMismatches, ctx.envPolicy);
      if (advisory.warning) {
        report.warnings = [...(report.warnings ?? []), advisory.warning];
      }
      if (advisory.fail) {
        report.pass = false;
      }
    } else {
      const legacyWarning = legacyBaselineWarning(baselinePath, ctx.projectRoot, ctx.componentDir);
      if (legacyWarning) {
        process.stderr.write(`Warning: ${legacyWarning}\n`);
      }
    }
  }

  if (ctx.options.saveBaseline && metrics) {
    const entry = buildBaselineEntry(metrics, report.pass, ctx);
    // Stored with the entry so a run that reuses this verdict repeats this run's disclosures.
    const warnings = report.warnings ?? [];
    const stored = warnings.length > 0 ? { ...entry, warnings: [...warnings] } : entry;
    const { pruned } = saveBaselineFile(baselinePath, stored, ctx.relativeComponent);
    if (pruned.length > 0) {
      report.warnings = [...(report.warnings ?? []), PRUNED_SLOTS_NOTICE(pruned)];
    }
  }
}

// Timings ride along only with their units, so a later dry run can scale them or skip them.
export function buildBaselineEntry(
  metrics: BaselineMetrics,
  pass: boolean,
  ctx: Pick<BaselineWorkflowContext, "currentEnv" | "sourceFingerprint" | "phaseTimings" | "phaseUnits">,
): BaselineEntry {
  return {
    mount: metrics.mount,
    rerender: metrics.rerender,
    unmount: metrics.unmount,
    domNodeCount: metrics.domNodeCount,
    interactions: metrics.interactions,
    tier: metrics.tier,
    env: ctx.currentEnv,
    ...(ctx.sourceFingerprint ? { sourceFingerprint: ctx.sourceFingerprint } : {}),
    pass,
    ...(metrics.measuredState ? { measuredState: metrics.measuredState } : {}),
    ...(ctx.phaseTimings && ctx.phaseUnits
      ? { phaseTimings: ctx.phaseTimings, phaseUnits: ctx.phaseUnits }
      : {}),
  };
}

// One structure for both modes, so the dry run's Stylesheets: line cannot describe another pick.
export function buildCssReport(
  resolvedCss: ReturnType<typeof resolveCssFiles>,
  projectRoot: string,
): CssReport {
  return {
    files: resolvedCss.files.map((f) => toPosix(path.relative(projectRoot, f))),
    autoDetected: resolvedCss.autoDetected,
    layer: resolvedCss.layer,
    details: resolvedCss.files.map((f) => {
      let bytes = 0;
      try {
        bytes = fs.statSync(f).size;
      } catch {
        bytes = 0;
      }
      return {
        file: toPosix(path.relative(projectRoot, f)),
        bytes,
        rules: stylesheetRuleCount(f),
      };
    }),
    // A project-root-relative posix path, wherever discoverGlobalCss (harness/css.ts) found it.
    ...(() => {
      const declared = resolvedCss.declaredMissing;
      // No key at all, so a project with no declaration reports byte-identically.
      if (declared === undefined || declared.length === 0) return {};
      const rel = (f: string): string =>
        toPosix(path.isAbsolute(f) ? path.relative(projectRoot, f) : f);
      return {
        declaredMissing: declared.map((d) => rel(d.path)),
        declaredMissingFields: declared.map((d) => ({
          field: d.field,
          path: rel(d.path),
          ...(d.buildCommand !== undefined ? { buildCommand: d.buildCommand } : {}),
        })),
      };
    })(),
    ...(resolvedCss.runtimeEngines !== undefined ? { runtimeEngines: resolvedCss.runtimeEngines } : {}),
    ...(resolvedCss.runtimeEnginesRecognised !== undefined
      ? { runtimeEnginesRecognised: resolvedCss.runtimeEnginesRecognised }
      : {}),
    ...(resolvedCss.onlyCandidate !== undefined ? { onlyCandidate: resolvedCss.onlyCandidate } : {}),
    ...(resolvedCss.noEntryInPackage !== undefined
      ? { noEntryInPackage: resolvedCss.noEntryInPackage }
      : {}),
    ...(resolvedCss.searchNotes !== undefined && resolvedCss.searchNotes.length > 0
      ? { searchNotes: resolvedCss.searchNotes }
      : {}),
  };
}

// One producer, so the JSON field and the terminal line describe the same run.
export function buildReactCompilerReport(
  state: ReactCompilerState | undefined,
): ReactCompilerReport | undefined {
  if (!state || !(state.detected || state.active || state.skipped)) return undefined;
  return {
    active: state.active,
    detected: state.detected,
    ...(state.version ? { version: state.version } : {}),
    ...(state.target ? { target: state.target } : {}),
    ...(state.skipped ? { skipped: state.skipped } : {}),
  };
}

// A same-document <use href="#id"> issues no request and counts two nodes, so nothing else sees it.
export const UNRESOLVED_SPRITE_REFS_WARNING = (ids: string[]): string =>
  `this component renders an empty <svg>: ${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} ` +
  "referenced by a <use> element and defined nowhere in the document. A sprite sheet injected by " +
  "the application shell is not injected by the component, so the measured render draws nothing " +
  "for it while still paying for the elements.";
