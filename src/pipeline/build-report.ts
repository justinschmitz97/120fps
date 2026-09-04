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

// The numbers are real, but they describe a transient scene. Warn, never
// fail: the defect would be presenting the skeleton's cost as the whole story.
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
  // A combo rendered something, but not the whole component. Applied
  // once, after the per-combo loop, to every combo without a renderHealth
  // value already: renderHealth already fully discloses the combo's shape,
  // so a combo that has it is left untouched by this field and its verdict.
  disclosureReason?: "uncomposed" | "propsExcluded";
  // Set when the combo list is the single `{}` a fixture or an
  // auto-composed scene produces, so every combo built from it carries the
  // fact on the row rather than leaving `props: {}` to be interpreted.
  measuredWithoutProps?: boolean;
  nextJsShims?: string[];
  scalingCurveReport?: ScalingCurveReport;
  matrixReport?: import("../report/index.js").MatrixReport;
  // Consumed to attribute a fatal render crash to a harness-synthesized
  // value rather than the component (see detectHarnessFault). Optional and
  // read defensively — `provenance` (props/schema.ts) may not exist on a
  // given schema; when it is absent everywhere, no combo is ever exonerated
  // (see detectHarnessFault).
  schemas?: Array<PropSchema & { provenance?: PropProvenance }>;
  // `attributeCost` runs per combo inside this function, between the mount
  // phase and the report boundary, so its window is handed back to the
  // clock here and carved out of whichever phase was open. No progress line
  // names it; the report's `attribution` key is where it shows up.
  phaseClock?: Pick<PhaseClock, "addAttribution">;
}

// Mirrors isHarnessInternalNoise's (browser/page-errors.ts) principle for a
// network request — a harness-caused failure is not the component's — but
// generalized to a render crash. Requires positive evidence per provenance
// class, never fires on presence alone: most placeholder/heuristic values
// never cause a crash, so a schema's risky provenance is necessary but not
// sufficient. Returns undefined whenever no schema explains the crash,
// including when `schemas` is absent entirely (a caller that never had a
// schema list to begin with, e.g. a fixture/matrix path).
function detectHarnessFault(
  combo: ComboReport,
  schemas: Array<PropSchema & { provenance?: PropProvenance }> | undefined,
): ComboReport["harnessFault"] | undefined {
  if (!schemas || schemas.length === 0) return undefined;
  const errorText = (combo.pageErrors ?? []).join(" ");

  // Contract props first: a prop whose truthiness imposes a requirement on
  // sibling props (asChild, as, render...) is inherently a harness risk once
  // truthy, by "contract" provenance's own definition — the synthesizer
  // flagged this exact uncertainty when it chose the value. Truthiness is
  // necessary and not sufficient: this branch requires positive evidence in
  // `errorText`, the same bar the placeholder branch below applies, so a
  // crash thrown unconditionally before any asChild branching cannot
  // exonerate whichever combos happened to draw `asChild: true` while the
  // identical crash keeps failing everywhere else.
  for (const schema of schemas) {
    if (schema.provenance !== "contract") continue;
    if (!(schema.name in combo.props)) continue;
    const value = combo.props[schema.name];
    if (!value) continue;
    if (!contractEvidencedInText(schema.name, errorText)) continue;
    return { propName: schema.name, value, provenance: "contract", evidence: errorText };
  }

  // Placeholder/heuristic props: only when the synthesized value (or, for an
  // object/array prop, one of its own scalar descendant values) shows up
  // verbatim in the page's own captured error text — presence of a risky
  // value in the combo is not by itself evidence it caused this crash.
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

// The mechanisms a truthy `asChild` routes a render
// through, matched case-insensitively because the libraries that raise them
// spell them differently (`Slottable` in Radix's own text, "failed to slot
// onto its children" in the sentence before it, React's own
// `React.Children.only` and "not valid as a React child" when a Slot receives
// something it cannot clone). These are evidence about `asChild` specifically:
// `as` and `render` substitute an element without going through Slot, so a
// slot/clone failure says nothing about them.
const SLOT_MECHANISM_TERMS = [
  "aschild",
  "slot",
  "slottable",
  "cloneelement",
  "react.children.only",
  "not valid as a react child",
];

// `CONTRACT_PROP_NAME` (props/synthesize.ts) is /^(asChild|as|render)$/,
// and two of its three members are ordinary English words that appear in
// unrelated JS failure prose (e.g. `Cannot read properties of undefined
// (reading 'render')`), so a bare name-quoted-or-behind-a-`.` match would
// exonerate a component for its own crash. Two evidence forms survive, each
// unambiguous on its own:
//
//   1. a slot/clone mechanism phrase, for `asChild` only;
//   2. the prop's own name followed by the word "prop" (`The "as" prop must
//      be a valid element type.`), which is about a prop by construction and
//      cannot be produced by a property-read message.
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

// Word-boundary, not plain substring: a short/generic value ("0", "1", "id")
// must not "match" merely because it happens to appear inside an unrelated
// number or identifier in the error text (e.g. a placeholder `0` matching
// "...at line 10"). Evidence has to be the value appearing as itself.
function matchesAsWord(needle: string, haystack: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`).test(haystack);
}

// Depth-bounded (object/array props are shallow prop-shaped data, not
// arbitrary trees) so this cannot loop on a cyclic or pathological value.
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

  // A pass that stopped early leaves holes in
  // `mounts`/`rerenders`. `for...of` yields `undefined` for a hole and
  // `Array.prototype.find` calls its predicate with it, so every consumer here
  // asks for the measured entries.
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

    // Interaction to Next Paint across every interaction explored for this
    // combo. Edges retain their raw per-sample traces (M4), so this needs no
    // extra measurement pass: only present when exploration produced traces.
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

    // `__120fps_scaleN` is the harness trigger key for the sibling-copies
    // probe, not a real prop: it never belongs in the report's `props`.
    // `scaleProbe` carries that identity instead.
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

    // Mount and rerender each watched the page over their own window; the
    // combo is what the reader sees, so both windows land on it. "Both
    // windows" means only this combo's own two windows: the rerender pass's
    // third window — the prop-delta sub-probe driving this combo's tree
    // into `combos[ci+1]`'s props — is kept separate below. Every
    // downstream exclusion (renderHealth, harnessFault, verdict) follows
    // from not merging it here, rather than from filters that could drift
    // apart.
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
      // Fatal means an uncaught exception, never console.error output: React
      // and Vue log dev warnings there, and a verdict must not turn on those.
      combo.renderHealth = pageErrors?.fatal ? "error" : "empty";
    }

    combo.verdict = computeVerdict(combo, input.thresholds);
    combos.push(combo);
  }

  // Computed here, before the scale-probe curve fit
  // below can add more combos to reconcile against, and pushed onto
  // report.warnings once the report exists — same array every other
  // buildReport-time warning reaches, so the JSON report carries it too.
  const renderHealthInconsistencyWarning = detectRenderHealthInconsistency(combos);

  // domNodeCount growth is fitted only across the sibling-copies probe
  // combos, never mixed with incidental DOM differences unrelated real prop
  // combos happen to have: the probe combos carry their own true
  // independent variable (scaleProbe), and only they receive the fit.
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
    // The exemption below describes the augmentation probe -- N synthetic
    // copies appended *beside* the real prop combos, whose cost is the copy
    // count and not the component's. On a scale-export fixture
    // (`runComboMode`'s `fixtureHasScale` branch) every combo is a probe,
    // so exempting all of them would make the run unfailable on any budget.
    // The exemption applies only where the contrast it rests on exists.
    const probesAccompanyPropCombos = combos.some((c) => c.scaleProbe === undefined);
    for (const combo of combos) {
      // `combo.props` has the `__120fps_scaleN` trigger key stripped (see
      // above), so a probe must be identified through the `scaleProbe`
      // field, not a `"__120fps_scaleN" in combo.props` test against the
      // stripped props.
      const isScaleCombo = combo.scaleProbe !== undefined && probesAccompanyPropCombos;
      const hasPortal = combo.interactions.some((i) => i.portal === true);
      const hasScaling = combo.scalingCurve != null || combo.rerenderScalingCurve != null;
      const mountResult = measuredOnly(input.mounts).find((m) => m.comboIndex === combo.comboIndex);
      const hasAnimation = mountResult?.hasAnimation ?? false;
      const tier = classifyTier({ domNodeCount: combo.domNodeCount, hasPortal, hasScaling, hasAnimation });
      combo.tier = tier;
      combo.hasAnimation = hasAnimation;
      if (isScaleCombo) {
        // The synthetic scale probe is exempt from budgets, never from
        // rendering. A scale point that threw is still a broken render.
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

  // A fatal crash traceable to a harness-synthesized value is not charged
  // to the component. Runs after the tier pass so it sees the same verdict
  // a reader would; only ever narrows a "fail" it can positively explain,
  // never a general crash-suppressor (see detectHarnessFault).
  for (const combo of combos) {
    if (combo.verdict !== "fail" || combo.renderHealth !== "error") continue;
    const fault = detectHarnessFault(combo, input.schemas);
    if (fault) {
      combo.harnessFault = fault;
      combo.verdict = "warn";
    }
  }

  // Stated directly, not just left to follow from the verdict demotion
  // above — a future verdict mutation between here and this line must not
  // silently start charging a harnessFault combo again.
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

  // One entry naming every id the run saw, deduped across combos — the same
  // `#calendar` missing from ten cells is one fact about the document, not
  // ten about the component.
  const spriteRefs = [...new Set(combos.flatMap((c) => c.unresolvedSpriteRefs ?? []))];
  if (spriteRefs.length > 0) {
    report.warnings = [...(report.warnings ?? []), UNRESOLVED_SPRITE_REFS_WARNING(spriteRefs)];
  }

  if (renderHealthInconsistencyWarning) {
    report.warnings = [...(report.warnings ?? []), renderHealthInconsistencyWarning];
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

  // Never overrides an honest renderHealth ("error"/"empty") combo — that
  // already fully discloses what happened. Only a combo that rendered
  // something (the dangerous case: a real-looking DOM count with none of the
  // declared parts inside it) gets the new field and the pass->warn downgrade.
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
  // Where this run's minutes went, and the combo and sample counts it
  // spent them on, so a later dry run can scale them. Read by the estimate
  // only; it never enters the environment key or the reuse decision.
  phaseTimings?: PhaseTimings;
  phaseUnits?: { combos: number; samples: number };
}

// Shared by every output mode: the isolation branch returns before the combo
// path would reach its own copy, and both compare the same three metrics.
export function applyBaselineWorkflow(
  report: Report,
  metrics: BaselineMetrics | undefined,
  ctx: BaselineWorkflowContext,
): void {
  const baselinePath = path.join(ctx.projectRoot, "120fps-baseline.json");

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
      // A slot from another machine can inform, never fail. Without a slot
      // for this environment there is no baseline for this environment, and a
      // cross-machine delta is not evidence of a regression.
      //
      // `ignore` is the exception: it means the user asked for a raw comparison
      // across environments and accepts what that implies, including failure.
      if (selection!.crossEnvironment && ctx.envPolicy !== "ignore") {
        comparison.crossEnvironment = true;
        report.warnings = [
          ...(report.warnings ?? []),
          NO_ENV_BASELINE_WARNING(ctx.relativeComponent),
        ];
      }
      // On a hostile machine the run is not measuring the component, so
      // its deltas would only manufacture false alarms. What noise invalidates
      // is the *timing* comparison: which environment the baseline came from
      // is a fact about the file, not about the machine's mood, so the
      // classification and its mismatch detail survive.
      if (report.noise?.level === "hostile") {
        comparison.regressions = [];
        comparison.improvements = [];
        comparison.skippedNoisy = true;
      }

      report.baseline = comparison;
      // Whether a comparison was applicable is only known here, and the
      // noise text was recorded before this ran.
      if (report.noise && report.warnings) {
        const uncompared = formatNoiseWarning(report.noise, false);
        const compared = formatNoiseWarning(report.noise, true);
        if (uncompared && compared !== uncompared) {
          report.warnings = report.warnings.map((w) => (w === uncompared ? compared : w));
        }
      }
      // A noisy run's regressions are reported but do not fail: the same
      // philosophy as the unstable-metric downgrade, run-scoped instead of
      // metric-scoped. Budget breaches are unaffected; they are absolute.
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
      const legacyWarning = legacyBaselineWarning(ctx.projectRoot, ctx.componentDir);
      if (legacyWarning) {
        process.stderr.write(`Warning: ${legacyWarning}\n`);
      }
    }
  }

  if (ctx.options.saveBaseline && metrics) {
    const entry = buildBaselineEntry(metrics, report.pass, ctx);
    const { pruned } = saveBaselineFile(baselinePath, entry, ctx.relativeComponent);
    if (pruned.length > 0) {
      report.warnings = [...(report.warnings ?? []), PRUNED_SLOTS_NOTICE(pruned)];
    }
  }
}

// The entry `--save-baseline` writes. A run that recorded both its phase
// timings and the units it spent them on carries them on the entry, so a
// later dry run can scale them; a run missing either (an isolation run has
// no combos or samples) carries neither.
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

// Always constructed, even for "none": the fingerprint call sites guard on
// files.length so a no-CSS project's fingerprint bytes stay unchanged even
// though cssReport itself is always defined. Extracted from analyze() so
// the dry run formats its `Stylesheets:` line from the identical structure
// rather than a second derivation that could describe a different pick.
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
    // `discoverGlobalCss` (harness/css.ts) declares the shape,
    // `resolveCssFiles` re-exports it, and it is read as typed here; a
    // project-root-relative posix path regardless of where the producer put it.
    ...(() => {
      const declared = resolvedCss.declaredMissing;
      // An empty array is a producer that found nothing: no key at all, so a
      // report of a project with no declaration is byte-identical.
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
  };
}

// One place turns the harness's React Compiler state into the report's
// disclosure, so the JSON field and the terminal line describe the same run.
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

// A same-document `<use href="#id">` issues no request, so the network
// capture never sees it, and `<svg>` + `<use>` are two real nodes, so the
// DOM count does not either. The run measured a graphic that drew nothing,
// and only the document can say why.
export const UNRESOLVED_SPRITE_REFS_WARNING = (ids: string[]): string =>
  `this component renders an empty <svg>: ${ids.join(", ")} ${ids.length === 1 ? "is" : "are"} ` +
  "referenced by a <use> element and defined nowhere in the document. A sprite sheet injected by " +
  "the application shell is not injected by the component, so the measured render draws nothing " +
  "for it while still paying for the elements.";
