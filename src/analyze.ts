import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { buildAndServe, detectComponentExport, detectProjectTransforms, detectGlobalCss, detectScaleExport, detectWrapper, findProjectRoot, resolveReactCompilerState, type HarnessResult } from "./harness.js";
import { attachPageErrorCapture, enrichTimeoutError } from "./page-errors.js";
import { extractProps, extractExports, extractAllProps, detectScalingProps, projectSourceFiles, type PropSchema, type ScalingPropMatch } from "./prop-gen.js";
import { hintsForReport } from "./hints.js";
import {
  probeMachineNoise,
  buildNoiseReport,
  NOISY_RUN_WARNING,
  HOSTILE_RUN_WARNING,
} from "./noise.js";
import {
  detectPropPresets,
  loadPropPresets,
  applyPropPresets,
  UNKNOWN_PRESET_PROPS_WARNING,
} from "./prop-presets.js";
import {
  runPreflight,
  preflightFailureMessage,
  transformFailureNote,
  NODE_BUILTIN_WARNING,
  PROJECT_TRANSFORM_WARNING,
  PREFLIGHT_BYPASSED_WARNING,
} from "./preflight.js";
import {
  inferComposition,
  shouldRollbackComposition,
  buildFixtureScaffold,
  fixtureScaffoldPath,
  COMPOSITION_EMPTY_WARNING,
  type CompositionTree,
} from "./composition.js";
import { detectFramework, runReactAnalysis, hasReactWarning, type ReactOptimizations } from "./react-profiler.js";
import { isVueFile, loadVueCompiler, VUE_COMPILER_MISSING } from "./vue-sfc.js";
import {
  generateCombinations,
  generateDeltaPairs,
  generateScalingCombos,
  generatePropMatrix,
  shouldAutoActivateMatrix,
  selectRepresentativeCombos,
  countCombinationSpace,
  countDeltaPairSpace,
  DEFAULT_MEASURED_COMBOS,
  type PropCombination,
} from "./prop-gen-values.js";
import { applyWrapperViewport, createBrowserPool, measureMount, measureRerender, measureWrapperOverhead, openMeasurementSession, settleStyles, suspendThrottle, CONTEXT_RETRY_WARNING, FONT_SETTLE_WARNING, HARNESS_NAV_WAIT, type BrowserPool, type MeasurementSession, type MountResult, type RerenderResult } from "./measure.js";
import {
  explore,
  restoreComboIndices,
  EXPLORE_BUDGET_WARNING,
  VOLATILE_DOM_NOTICE,
  type ExploreResult,
} from "./explorer.js";
import {
  createCalibrationTrace,
  computeScalingCurve,
  attributeCost,
  computeINP,
  isDomFlat,
  SCALING_NO_EFFECT_WARNING,
  type ScalingCurve,
} from "./metrics.js";
import {
  loadBudgetConfig,
  loadBaseline,
  saveBaseline as saveBaselineFile,
  resolveComponentBudget,
  resolveTolerances,
  compareBaseline,
  buildEnvFingerprint,
  computeSourceFingerprint,
  computeEnvKey,
  parseBaselineKey,
  selectBaselineEntry,
  sameMachineIdentity,
  envAdvisory,
  NO_ENV_BASELINE_WARNING,
  PRUNED_SLOTS_NOTICE,
  type BaselineEntry,
  type BaselineEnvPolicy,
  type BaselineMetrics,
} from "./budget.js";
import {
  computeIsolationVerdict,
  isolationBaselineMetrics,
  parseIsolationPhases,
  runIsolationPhases,
  selectIsolationCombos,
  strictModeUnsupported,
  DEFAULT_MEMORY_CYCLES,
  VUE_STRICTMODE_ERROR,
} from "./isolation.js";
import {
  attachWrapperReport,
  buildTimingWithCV,
  buildCurveReport,
  computeCurveVerdict,
  classifyTier,
  computeVerdict,
  DEFAULT_THRESHOLDS,
  TIER_BUDGETS,
  type CalibrationResult,
  type ComboReport,
  type InteractionReport,
  type MachineInfo,
  type MeasuredState,
  type PropDelta,
  type Report,
  buildMatrixReport,
  type MatrixAxis,
  type MatrixReport,
  type ScalingCurveReport,
  type TierBudget,
  type Thresholds,
  type TimingWithCV,
  type CssReport,
  type EnvFingerprint,
  type WrapperReport,
} from "./report.js";

// M40: the numbers are real, but they describe a transient scene. Warn, never
// fail — the defect would be presenting the skeleton's cost as the whole story.
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

export {
  runPreflight,
  preflightFailureMessage,
  transformFailureNote,
  recognizeTransform,
  NODE_BUILTIN_WARNING,
  PROJECT_TRANSFORM_WARNING,
  PREFLIGHT_BYPASSED_WARNING,
  TRANSFORM_RECOGNIZERS,
} from "./preflight.js";

export const COMBO_CAP_WARNING = (kept: number, total: number): string =>
  `measured ${kept} of ${total} prop combos; ${total - kept} were dropped to bound the run. ` +
  `Raise it with --max-combos <n>.`;

// The raw cartesian prop space can be astronomically large (many multi-valued
// props); display, not arithmetic, is what needs the cap.
const RAW_COMBO_SPACE_DISPLAY_CAP = 1_000_000_000;

function formatComboSpace(n: number): string {
  // Pinned locale: this text is parsed by nothing, but it must read the same
  // on every machine regardless of the host's default locale.
  return Number.isFinite(n) && n <= RAW_COMBO_SPACE_DISPLAY_CAP
    ? n.toLocaleString("en-US")
    : `>${RAW_COMBO_SPACE_DISPLAY_CAP.toLocaleString("en-US")}`;
}

export const STRATIFIED_SAMPLE_WARNING = (raw: number, sampled: number): string =>
  `prop space has ${formatComboSpace(raw)} combinations; measured a stratified sample of ${sampled}.`;

export const DELTA_PAIR_CAP_WARNING = (measured: number, total: number): string =>
  `measured ${measured} of ${total} possible delta pairs; ${total - measured} were dropped to bound the run.`;

export const MATRIX_PAIRWISE_COVER_WARNING = (covered: number, full: number): string =>
  `matrix has ${full} possible cells; measured ${covered} via pairwise cover (every value pair, not every ` +
  `cell) — coverage is not exhaustive.`;

export const MATRIX_AUTO_ACTIVATED_NOTICE = (cellCount: number): string =>
  `Matrix mode auto-activated: measuring all ${cellCount} prop combinations, which multiplies run time ` +
  `roughly ${cellCount}x versus a single combo. Use --no-matrix to disable.`;

// Shared by the plain-combo and forced-matrix paths so a large cell/combo
// count throttles samples identically in either mode.
export function computeEffectiveSamples(comboCount: number, samples: number): number {
  return comboCount > 20
    ? Math.max(3, Math.min(samples, Math.floor(200 / comboCount)))
    : samples;
}

// M54: the matrix path returns before the baseline workflow ever runs, so a
// baseline flag on a matrix run does nothing at all. Per-cell baselines are a
// feature with their own schema; the run's job here is to stop pretending.
export const MATRIX_BASELINE_WARNING =
  "matrix runs do not participate in baselines: --save-baseline stores nothing and " +
  "--check/--budget compare nothing. Re-run with --no-matrix to save or check a baseline " +
  "for this component.";

// --no-baseline suppresses the comparison only, so a save still counts.
export function baselineWorkflowRequested(
  options: Pick<AnalyzeOptions, "saveBaseline" | "check" | "noBaseline">,
): boolean {
  if (options.saveBaseline) return true;
  return !!options.check && !options.noBaseline;
}

function modeDisabledOrAbsent(mode: AnalyzeOptions["curveMode"]): boolean {
  return mode === undefined || mode === false;
}

// M39/M54: the option-only half of the verdict-reuse gate. The rest of it needs
// the baseline file, the source fingerprint, and a machine probe.
export function optionsAllowVerdictReuse(
  options: Pick<
    AnalyzeOptions,
    | "check"
    | "noCache"
    | "noBaseline"
    | "saveBaseline"
    | "isolation"
    | "curveMode"
    | "matrixMode"
    | "baselineEnv"
  >,
): boolean {
  return (
    !!options.check &&
    !options.noCache &&
    !options.noBaseline &&
    !options.saveBaseline &&
    !options.isolation &&
    // An explicit *enable* changes what gets measured beyond anything the
    // fingerprint records, so it always measures. An explicit *disable* does
    // not: the mode it resolves to is `combo`, which the stored env already
    // carries, so the run reproduces exactly the distribution the slot holds.
    modeDisabledOrAbsent(options.curveMode) &&
    modeDisabledOrAbsent(options.matrixMode) &&
    // "ignore" explicitly requests a raw comparison and "strict" a hard
    // verification of a real run — both must measure.
    (options.baselineEnv ?? "normalize") === "normalize"
  );
}

export const EFFECTIVE_SAMPLES_WARNING = (
  effective: number,
  requested: number,
  comboCount: number,
): string =>
  `measured ${effective} samples per combo instead of the requested ${requested}: ${comboCount} combos ` +
  `exceed the per-run sample budget. Dispersion (CV, P95) is estimated from ${effective} samples.`;

export interface AnalyzeOptions {
  samples?: number;
  maxCombos?: number;
  initFixture?: boolean;
  exploreBudgetMs?: number;
  cpuThrottle?: number;
  warmupRuns?: number;
  seed?: number;
  jsonPath?: string;
  ci?: boolean;
  thresholds?: Partial<Thresholds>;
  fixturePath?: string;
  scalePoints?: number[];
  skipDeltas?: boolean;
  skipAutoScale?: boolean;
  flatThresholds?: boolean;
  skipAttribution?: boolean;
  skipAutoCompose?: boolean;
  skipReactAnalysis?: boolean;
  framework?: "react" | "vue" | "vanilla" | "auto";
  noShims?: boolean;
  curveMode?: boolean | { propName: string; propKind: "array" | "number" };
  matrixMode?: boolean;
  saveBaseline?: boolean;
  check?: boolean;
  noBaseline?: boolean;
  baselineEnv?: BaselineEnvPolicy;
  isolation?: { phases: string[]; memoryCycles?: number };
  wrapPath?: string;
  noWrap?: boolean;
  cssFiles?: string[];
  noCss?: boolean;
  reactCompiler?: boolean;
  // M37: share pooled browsers across runs (the CLI passes one pool for a
  // whole multi-component sweep). analyze() creates and closes its own pool
  // when none is provided.
  browserPool?: BrowserPool;
  // M38: share one dev server per config tuple across a sweep. analyze()
  // never creates or closes one — single-component runs gain nothing.
  serverPool?: import("./harness.js").ServerPool;
  // M39: force measurement even when a fingerprinted baseline would allow
  // reusing the stored verdict.
  noCache?: boolean;
  // M42: attempt the run even when the graph reaches a server boundary.
  noPreflight?: boolean;
  // M48: skip the project's own Vite transforms.
  noTransforms?: boolean;
}

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
  compositionTree?: import("./composition.js").CompositionTree;
  nextJsShims?: string[];
  scalingCurveReport?: ScalingCurveReport;
  matrixReport?: import("./report.js").MatrixReport;
}

export function buildReport(input: BuildReportInput): Report {
  const combos: ComboReport[] = [];

  for (const mount of input.mounts) {
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
        interactions.push(report);
      }
    }

    // Interaction to Next Paint across every interaction explored for this
    // combo. Edges retain their raw per-sample traces (M4), so this needs no
    // extra measurement pass — only present when exploration produced traces.
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

    const rerenderResult = input.rerenders?.find(
      (r) => r.comboIndex === mount.comboIndex,
    );

    const rerenderTiming = rerenderResult
      ? buildTimingWithCV(rerenderResult.stable.samples)
      : buildTimingWithCV([0]);

    const combo: ComboReport = {
      comboIndex: mount.comboIndex,
      props: mount.props as Record<string, unknown>,
      mount: buildTimingWithCV(mount.mount.samples),
      unmount: buildTimingWithCV(mount.unmount.samples),
      rerender: rerenderTiming,
      domNodeCount: mount.domNodeCount,
      heapDelta: input.heapDeltas[mount.comboIndex] ?? 0,
      interactions,
      scalingCurve: null,
      relativeMount,
      verdict: "pass",
      measuredState: mount.measuredState ?? "settled",
    };

    if (rerenderResult?.change) {
      combo.rerenderChange = buildTimingWithCV(rerenderResult.change.samples);
    }

    if (inp !== undefined) {
      combo.inp = inp;
    }

    if (!input.skipAttribution && mount.mountTraces && mount.mountTraces.length > 0) {
      const allEvents = mount.mountTraces.flat();
      combo.costAttribution = attributeCost(allEvents);
    }

    combo.verdict = computeVerdict(combo, input.thresholds);
    combos.push(combo);
  }

  const distinctDomSizes = new Set(combos.map((c) => c.domNodeCount));
  if (distinctDomSizes.size >= 2) {
    const points = combos.map((c) => ({ n: c.domNodeCount, metric: c.mount.median }));
    const curve = computeScalingCurve(points);
    for (const combo of combos) {
      combo.scalingCurve = curve;
    }

    const rerenderPoints = combos.map((c) => ({ n: c.domNodeCount, metric: c.rerender.median }));
    const rerenderCurve = computeScalingCurve(rerenderPoints);
    for (const combo of combos) {
      combo.rerenderScalingCurve = rerenderCurve;
    }
  }

  if (!input.flatThresholds) {
    for (const combo of combos) {
      const isScaleCombo = "__120fps_scaleN" in combo.props;
      const hasPortal = combo.interactions.some((i) => i.portal === true);
      const hasScaling = combo.scalingCurve != null || combo.rerenderScalingCurve != null;
      const mountResult = input.mounts.find((m) => m.comboIndex === combo.comboIndex);
      const hasAnimation = mountResult?.hasAnimation ?? false;
      const tier = classifyTier({ domNodeCount: combo.domNodeCount, hasPortal, hasScaling, hasAnimation });
      combo.tier = tier;
      combo.hasAnimation = hasAnimation;
      if (isScaleCombo) {
        combo.verdict = "pass";
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

  const pass = combos.every((c) => c.verdict !== "fail");

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

interface BaselineWorkflowContext {
  options: AnalyzeOptions;
  projectRoot: string;
  relativeComponent: string;
  componentDir: string;
  currentEnv: EnvFingerprint;
  envPolicy: BaselineEnvPolicy;
  // M39: stored with the entry on save so unchanged components can reuse it.
  sourceFingerprint?: string;
}

// Shared by every output mode: the isolation branch returns before the combo
// path would reach its own copy, and both compare the same three metrics.
function applyBaselineWorkflow(
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
      // M45: a slot from another machine can inform, never fail. Without a slot
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
      // M46: on a hostile machine the run is not measuring the component, so
      // its deltas would only manufacture false alarms. What noise invalidates
      // is the *timing* comparison — which environment the baseline came from
      // is a fact about the file, not about the machine's mood, so the
      // classification and its mismatch detail survive.
      if (report.noise?.level === "hostile") {
        comparison.regressions = [];
        comparison.improvements = [];
        comparison.skippedNoisy = true;
      }

      report.baseline = comparison;
      // A noisy run's regressions are reported but do not fail — the same
      // philosophy as M22's unstable-metric downgrade, run-scoped instead of
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
    const entry: BaselineEntry = {
      mount: metrics.mount,
      rerender: metrics.rerender,
      unmount: metrics.unmount,
      domNodeCount: metrics.domNodeCount,
      interactions: metrics.interactions,
      tier: metrics.tier,
      env: ctx.currentEnv,
      ...(ctx.sourceFingerprint ? { sourceFingerprint: ctx.sourceFingerprint } : {}),
      pass: report.pass,
      ...(metrics.measuredState ? { measuredState: metrics.measuredState } : {}),
    };
    const { pruned } = saveBaselineFile(baselinePath, entry, ctx.relativeComponent);
    if (pruned.length > 0) {
      report.warnings = [...(report.warnings ?? []), PRUNED_SLOTS_NOTICE(pruned)];
    }
  }
}

// Everything the mode branches (isolation, curve, matrix, standard combos)
// share once the harness is built, the session calibrated, and composition
// rollback settled. Built exactly once per run, right before mode dispatch.
interface ModeContext {
  options: AnalyzeOptions;
  harness: HarnessResult;
  pool: BrowserPool;
  machine: MachineInfo;
  calibration: CalibrationResult;
  thresholds: Thresholds;
  explicitThresholds: Partial<Record<keyof TierBudget, boolean>>;
  samples: number;
  cpuThrottle: number;
  warmupRuns: number;
  seed: number;
  componentPath: string;
  resolvedPath: string;
  metadataPath: string;
  projectRoot: string;
  relativeComponent: string;
  inputIsFixture: boolean;
  useFixture: boolean;
  // M57: which renderer mounted the scene. Gates the React optimization pass
  // and travels into the baseline environment record.
  framework: "react" | "vue" | "vanilla";
  fixturePath?: string;
  fixtureAutoDetected: boolean;
  composed: boolean;
  compositionTree?: CompositionTree;
  wrapper?: WrapperReport;
  cssReport?: CssReport;
  runWarnings: string[];
  onWarning: (warning: string) => void;
  getSchemas: () => Promise<PropSchema[]>;
  getSourceFingerprint: () => Promise<string>;
  attachHarnessContext: (report: Report) => void;
}

async function runIsolationMode(
  ctx: ModeContext,
  isolationOptions: NonNullable<AnalyzeOptions["isolation"]>,
): Promise<Report> {
  const { options, harness, thresholds } = ctx;
  const phases = parseIsolationPhases(isolationOptions.phases.join(","));
  if (phases.length === 0) {
    throw new Error(
      "--isolate requires at least one phase (mount, rerender, unmount, memory, strictmode, all)",
    );
  }
  // The CLI rejects this first; the guard is here for direct API callers, whose
  // Vue "strict" pass would otherwise re-measure the identical page and report
  // 0% overhead as a clean double-invoke.
  if (strictModeUnsupported(phases, [harness.componentPath])) {
    throw new Error(VUE_STRICTMODE_ERROR);
  }

  const isolationCombos =
    ctx.useFixture || ctx.composed ? [{}] : generateCombinations(await ctx.getSchemas());
  const selection = selectIsolationCombos(isolationCombos);

  const run = await runIsolationPhases(harness, {
    phases,
    comboA: selection.comboA,
    comboB: selection.comboB,
    degenerate: selection.degenerate,
    samples: ctx.samples,
    cpuThrottle: ctx.cpuThrottle,
    memoryCycles: isolationOptions.memoryCycles ?? DEFAULT_MEMORY_CYCLES,
    pool: ctx.pool,
  });

  // Discovery does not run in isolation mode, so there is no portal signal.
  const tier = classifyTier({
    domNodeCount: run.domNodeCount ?? 0,
    hasPortal: false,
    hasAnimation: run.hasAnimation ?? false,
  });
  const flatMountBudget =
    options.flatThresholds || options.thresholds?.mountMs !== undefined;
  const mountBudgetMs = flatMountBudget
    ? thresholds.mountMs
    : resolveComponentBudget(loadBudgetConfig(ctx.projectRoot), ctx.relativeComponent, tier).mountMs;

  const componentName = detectComponentName(ctx.metadataPath);
  const report: Report = {
    version: 1,
    timestamp: new Date().toISOString(),
    machine: ctx.machine,
    componentPath: ctx.componentPath,
    componentName,
    calibration: ctx.calibration,
    combos: [],
    thresholds,
    pass: computeIsolationVerdict(run.isolation, mountBudgetMs),
    isolation: run.isolation,
    ...(harness.nextJsShims && harness.nextJsShims.length > 0
      ? { nextJsShims: harness.nextJsShims }
      : {}),
  };

  if (ctx.useFixture) {
    report.fixturePath = ctx.inputIsFixture ? ctx.componentPath : ctx.fixturePath;
    report.fixtureAutoDetected = ctx.fixtureAutoDetected;
  }
  if (ctx.composed) {
    report.autoComposition = true;
    report.compositionTree = ctx.compositionTree!;
  }

  if (ctx.wrapper) attachWrapperReport(report, ctx.wrapper);
  ctx.attachHarnessContext(report);
  if (run.warnings.length > 0) {
    report.warnings = [...(report.warnings ?? []), ...run.warnings];
  }

  applyBaselineWorkflow(
    report,
    isolationBaselineMetrics(run.isolation, tier, run.domNodeCount ?? 0),
    {
      options,
      projectRoot: ctx.projectRoot,
      relativeComponent: ctx.relativeComponent,
      componentDir: path.dirname(ctx.resolvedPath),
      currentEnv: buildEnvFingerprint({
        machine: ctx.machine,
        calibration: ctx.calibration,
        cpuThrottle: ctx.cpuThrottle,
        samples: ctx.samples,
        mode: "isolation",
        framework: ctx.framework,
        ...(ctx.cssReport ? { css: ctx.cssReport.files } : {}),
        ...(ctx.wrapper ? { wrapper: ctx.wrapper.path } : {}),
        ...(harness.reactCompiler?.active ? { reactCompiler: true } : {}),
      }),
      envPolicy: options.baselineEnv ?? "normalize",
      ...(options.saveBaseline ? { sourceFingerprint: await ctx.getSourceFingerprint() } : {}),
    },
  );

  writeReportJson(report, options.jsonPath);

  return report;
}

function writeReportJson(report: Report, jsonPath: string | undefined): void {
  const target = path.resolve(jsonPath ?? "120fps-report.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, mapReplacer, 2), "utf-8");
}

// The curve run activates on an explicit --curve flag or on the first
// detected scaling prop; fixtures and composed scenes never take it.
async function resolveCurveMatch(ctx: ModeContext): Promise<ScalingPropMatch | undefined> {
  const { curveMode } = ctx.options;
  if (curveMode === false || ctx.useFixture || ctx.composed) return undefined;
  if (typeof curveMode === "object") {
    const schemas = await ctx.getSchemas();
    return {
      schema:
        schemas.find((s) => s.name === curveMode.propName) ??
        { name: curveMode.propName, kind: curveMode.propKind, values: [], required: false },
      kind: curveMode.propKind === "number" ? "numeric" : "array",
      reason: "explicit --curve flag",
    };
  }
  // Extraction is cached by getSchemas: the matrix check and the standard path
  // would otherwise re-extract the same file (M34, ~1.4s each on a real
  // Next.js project).
  const matches = detectScalingProps(await ctx.getSchemas());
  return matches.length > 0 ? matches[0] : undefined;
}

async function runCurveMode(ctx: ModeContext, match: ScalingPropMatch): Promise<Report> {
  const { options, harness, samples, cpuThrottle, warmupRuns, pool, onWarning, runWarnings, machine, calibration, thresholds } = ctx;
  const curveScalePoints = options.scalePoints ?? [1, 3, 5, 10, 20, 50];
  const scaleCombos = generateScalingCombos(await ctx.getSchemas(), match, curveScalePoints);

  const curveMounts = await measureMount(harness, {
    samples,
    cpuThrottle,
    warmupRuns,
    combos: scaleCombos,
    pool,
    onWarning,
  });
  const curveRerenders = await measureRerender(harness, {
    samples,
    cpuThrottle,
    warmupRuns,
    combos: scaleCombos,
    animatedComboIndices: animatedIndices(curveMounts),
    pool,
    onWarning,
  });
  const curveExplores = await explore(harness, {
    samples: Math.min(samples, 5),
    cpuThrottle,
    warmupRuns,
    seed: ctx.seed,
    combos: scaleCombos,
    maxWallClockMs: 30000,
    pool,
    onWarning,
  });

  const curveHeapDeltas = curveMounts.map((m) => m.heapDelta ?? 0);
  const componentName = detectComponentName(ctx.metadataPath);

  const curveReport = buildCurveReport({
    propName: match.schema.name,
    propKind: match.kind === "numeric" ? "number" : "array",
    reason: match.reason,
    scalePoints: curveScalePoints,
    mounts: curveMounts,
    rerenders: curveRerenders,
    explores: curveExplores,
    heapDeltas: curveHeapDeltas,
    calibration,
    thresholds,
    skipAttribution: options.skipAttribution,
  });

  // A sweep that never moved the DOM measured no growth. The verdict still
  // stands on the timings; only the growth class is disowned.
  if (isDomFlat(curveReport.points)) {
    curveReport.domFlat = true;
    runWarnings.push(SCALING_NO_EFFECT_WARNING(curveReport.propName));
  }

  const curveVerdict = computeCurveVerdict(curveReport.points, curveReport.mountCurve, thresholds);
  const pass = curveVerdict !== "fail";

  const report: Report = {
    version: 1,
    timestamp: new Date().toISOString(),
    machine,
    componentPath: ctx.componentPath,
    componentName,
    calibration,
    combos: [],
    thresholds,
    pass,
    scalingCurveReport: curveReport,
    ...(harness.nextJsShims && harness.nextJsShims.length > 0 ? { nextJsShims: harness.nextJsShims } : {}),
  };

  if (ctx.wrapper) attachWrapperReport(report, ctx.wrapper);
  ctx.attachHarnessContext(report);

  writeReportJson(report, options.jsonPath);

  return report;
}

async function runMatrixMode(ctx: ModeContext, matrixAutoActivated: boolean): Promise<Report> {
  const { options, harness, samples, cpuThrottle, warmupRuns, pool, onWarning, runWarnings, machine, calibration, thresholds, explicitThresholds } = ctx;
  const schemas = await ctx.getSchemas();
  const matrixCombos = generatePropMatrix(schemas);
  const matrixAxes: MatrixAxis[] = schemas
    .filter((s) => s.kind === "boolean" || (s.kind === "union" && s.values.length >= 1 && s.values.length <= 8))
    .map((s) => ({
      propName: s.name,
      values: s.kind === "boolean" ? [false, true] : s.values,
    }));

  // Full cartesian cell count the axes describe, independent of whichever
  // fallback generatePropMatrix used to fit MAX_MATRIX_CELLS.
  const fullMatrixCells = matrixAxes.reduce((acc, a) => acc * a.values.length, 1);
  if (fullMatrixCells > matrixCombos.length) {
    runWarnings.push(MATRIX_PAIRWISE_COVER_WARNING(matrixCombos.length, fullMatrixCells));
  }

  // M54: this path returns before applyBaselineWorkflow, so every baseline
  // flag on it is a no-op. Auto-activated or asked for, the run says so.
  if (baselineWorkflowRequested(options)) {
    runWarnings.push(MATRIX_BASELINE_WARNING);
  }

  // Upfront, before measurement starts: the reader should know the run is
  // about to multiply before it does, not after. --ci stays JSON-only.
  if (matrixAutoActivated && !options.ci) {
    process.stdout.write(MATRIX_AUTO_ACTIVATED_NOTICE(matrixCombos.length) + "\n");
  }

  // Same cost throttle the plain-combo path applies — a forced --matrix run
  // with many cells must not skip it just because it took the matrix branch
  // instead.
  const matrixEffectiveSamples = computeEffectiveSamples(matrixCombos.length, samples);
  if (matrixEffectiveSamples < samples) {
    runWarnings.push(
      EFFECTIVE_SAMPLES_WARNING(matrixEffectiveSamples, samples, matrixCombos.length),
    );
  }

  const matrixMounts = await measureMount(harness, {
    samples: matrixEffectiveSamples,
    cpuThrottle,
    warmupRuns,
    combos: matrixCombos,
    pool,
    onWarning,
  });
  const matrixRerenders = await measureRerender(harness, {
    samples: matrixEffectiveSamples,
    cpuThrottle,
    warmupRuns,
    combos: matrixCombos,
    animatedComboIndices: animatedIndices(matrixMounts),
    pool,
    onWarning,
  });

  // Explore only hot cells (top 5 by mount median)
  const sortedMounts = [...matrixMounts].sort((a, b) => b.mount.median - a.mount.median);
  const hotIndices = sortedMounts.slice(0, 5).map((m) => m.comboIndex);
  const hotCombos = hotIndices.map((i) => matrixCombos[i]);
  const rawExplores = hotCombos.length > 0
    ? await explore(harness, {
        samples: Math.min(samples, 5),
        cpuThrottle,
        warmupRuns,
        seed: ctx.seed,
        combos: hotCombos,
        maxWallClockMs: 30000,
        pool,
        onWarning,
      })
    : [];
  const matrixExplores = restoreComboIndices(rawExplores, hotIndices);

  // Delta analysis for compound effects
  let matrixDeltas: PropDelta[] | undefined;
  if (!options.skipDeltas && schemas.length > 0) {
    const deltaPairs = generateDeltaPairs(schemas);
    const totalDeltaPairs = countDeltaPairSpace(schemas);
    if (totalDeltaPairs > deltaPairs.length) {
      runWarnings.push(DELTA_PAIR_CAP_WARNING(deltaPairs.length, totalDeltaPairs));
    }
    const measured = new Map<string, { mount: MountResult; rerender?: RerenderResult }>();
    for (const m of matrixMounts) {
      measured.set(JSON.stringify(m.props), { mount: m, rerender: matrixRerenders.find((r) => r.comboIndex === m.comboIndex) });
    }
    const missingPairs = deltaPairs.filter((p) => !measured.has(JSON.stringify(p.baseCombo)) || !measured.has(JSON.stringify(p.flipCombo)));
    if (missingPairs.length > 0) {
      const missingCombos = [...new Set(missingPairs.flatMap((p) => [JSON.stringify(p.baseCombo), JSON.stringify(p.flipCombo)]))].filter((k) => !measured.has(k)).map((k) => JSON.parse(k) as PropCombination);
      if (missingCombos.length > 0) {
        // Same effective count as the sweep: a cell measured at full N
        // would merge a differently-estimated number into one report.
        const extraMounts = await measureMount(harness, { samples: matrixEffectiveSamples, cpuThrottle, warmupRuns, combos: missingCombos, pool });
        const extraRerenders = await measureRerender(harness, { samples: matrixEffectiveSamples, cpuThrottle, warmupRuns, combos: missingCombos, animatedComboIndices: animatedIndices(extraMounts), pool });
        for (const m of extraMounts) measured.set(JSON.stringify(m.props), { mount: m, rerender: extraRerenders.find((r) => r.comboIndex === m.comboIndex) });
      }
    }
    matrixDeltas = [];
    for (const pair of deltaPairs) {
      const base = measured.get(JSON.stringify(pair.baseCombo));
      const flip = measured.get(JSON.stringify(pair.flipCombo));
      if (base && flip) {
        matrixDeltas.push({
          propName: pair.propName,
          baseValue: pair.baseValue,
          flipValue: pair.flipValue,
          mountDelta: flip.mount.mount.median - base.mount.mount.median,
          rerenderDelta: (flip.rerender?.stable.median ?? 0) - (base.rerender?.stable.median ?? 0),
        });
      }
    }
  }

  const heapDeltas = matrixMounts.map((m) => m.heapDelta ?? 0);
  const componentName = detectComponentName(ctx.metadataPath);
  const report = buildReport({
    componentPath: ctx.componentPath,
    componentName,
    machine,
    calibration,
    mounts: matrixMounts,
    explores: matrixExplores,
    heapDeltas,
    thresholds,
    rerenders: matrixRerenders,
    flatThresholds: options.flatThresholds,
    explicitThresholds,
    skipAttribution: options.skipAttribution,
    ...(harness.nextJsShims && harness.nextJsShims.length > 0 ? { nextJsShims: harness.nextJsShims } : {}),
  });

  report.matrixReport = buildMatrixReport({
    axes: matrixAxes,
    combos: report.combos,
    propDeltas: matrixDeltas,
  });

  if (matrixDeltas) report.propDeltas = matrixDeltas;
  if (ctx.wrapper) attachWrapperReport(report, ctx.wrapper);
  ctx.attachHarnessContext(report);

  writeReportJson(report, options.jsonPath);

  return report;
}

// M11: pairwise deltas for the standard combo path. Pairs whose combos the
// sweep already measured reuse those numbers; the rest are measured at the
// same effective sample count. Sorted by absolute mount impact.
async function measureStandardPropDeltas(
  ctx: ModeContext,
  schemas: PropSchema[],
  mounts: MountResult[],
  rerenders: RerenderResult[],
  effectiveSamples: number,
): Promise<PropDelta[] | undefined> {
  const { harness, cpuThrottle, warmupRuns, pool, onWarning, runWarnings } = ctx;
  const pairs = generateDeltaPairs(schemas);
  const totalDeltaPairs = countDeltaPairSpace(schemas);
  if (totalDeltaPairs > pairs.length) {
    runWarnings.push(DELTA_PAIR_CAP_WARNING(pairs.length, totalDeltaPairs));
  }
  if (pairs.length === 0) return undefined;

  const measured = new Map<string, { mount: number; rerender: number }>();
  for (const m of mounts) {
    const key = JSON.stringify(m.props);
    measured.set(key, { mount: m.mount.median, rerender: 0 });
  }
  for (const r of rerenders) {
    const key = JSON.stringify(r.props);
    const existing = measured.get(key);
    if (existing) {
      existing.rerender = r.stable.median;
    }
  }

  const needed: PropCombination[] = [];
  for (const pair of pairs) {
    for (const combo of [pair.baseCombo, pair.flipCombo]) {
      const key = JSON.stringify(combo);
      if (!measured.has(key)) {
        needed.push(combo);
        measured.set(key, { mount: 0, rerender: 0 });
      }
    }
  }

  if (needed.length > 0) {
    const extraMounts = await measureMount(harness, {
      samples: effectiveSamples,
      cpuThrottle,
      warmupRuns,
      combos: needed,
      pool,
      onWarning,
    });
    const extraRerenders = await measureRerender(harness, {
      samples: effectiveSamples,
      cpuThrottle,
      warmupRuns,
      combos: needed,
      animatedComboIndices: animatedIndices(extraMounts),
      pool,
      onWarning,
    });
    for (const m of extraMounts) {
      measured.set(JSON.stringify(m.props), { mount: m.mount.median, rerender: 0 });
    }
    for (const r of extraRerenders) {
      const key = JSON.stringify(r.props);
      const existing = measured.get(key);
      if (existing) {
        existing.rerender = r.stable.median;
      }
    }
  }

  const propDeltas = pairs.map((pair) => {
    const baseKey = JSON.stringify(pair.baseCombo);
    const flipKey = JSON.stringify(pair.flipCombo);
    const base = measured.get(baseKey) ?? { mount: 0, rerender: 0 };
    const flip = measured.get(flipKey) ?? { mount: 0, rerender: 0 };
    return {
      propName: pair.propName,
      baseValue: pair.baseValue,
      flipValue: pair.flipValue,
      mountDelta: flip.mount - base.mount,
      rerenderDelta: flip.rerender - base.rerender,
    };
  });
  propDeltas.sort((a, b) => Math.abs(b.mountDelta) - Math.abs(a.mountDelta));
  return propDeltas;
}

// M12: auto-scaling sweep on the standard path. Attaches mount/rerender
// scaling curves for the first detected scaling prop to every combo of an
// already-built report; measured at the full requested sample count.
async function applyAutoScalingCurves(
  ctx: ModeContext,
  report: Report,
  schemas: PropSchema[],
): Promise<void> {
  const { options, harness, samples, cpuThrottle, warmupRuns, pool, onWarning, runWarnings } = ctx;
  const matches = detectScalingProps(schemas);
  if (matches.length === 0) return;

  const match = matches[0];
  const scalePoints = options.scalePoints ?? [1, 5, 20, 50];
  const scaleCombos = generateScalingCombos(schemas, match, scalePoints);

  const scaleMounts = await measureMount(harness, {
    samples,
    cpuThrottle,
    warmupRuns,
    combos: scaleCombos,
    pool,
    onWarning,
  });
  const scaleRerenders = await measureRerender(harness, {
    samples,
    cpuThrottle,
    warmupRuns,
    combos: scaleCombos,
    animatedComboIndices: animatedIndices(scaleMounts),
    pool,
    onWarning,
  });

  const mountPoints = scaleMounts.map((m) => ({
    n: scalePoints[m.comboIndex],
    metric: m.mount.median,
  }));
  const rerenderPoints = scaleRerenders.map((r) => ({
    n: scalePoints[r.comboIndex],
    metric: r.stable.median,
  }));

  if (mountPoints.length >= 2) {
    const curve = computeScalingCurve(mountPoints);
    for (const combo of report.combos) {
      combo.scalingCurve = curve;
    }
  }
  if (rerenderPoints.length >= 2) {
    const rerenderCurve = computeScalingCurve(rerenderPoints);
    for (const combo of report.combos) {
      combo.rerenderScalingCurve = rerenderCurve;
    }
  }

  if (isDomFlat(scaleMounts.map((m) => ({ n: scalePoints[m.comboIndex], domNodeCount: m.domNodeCount })))) {
    runWarnings.push(SCALING_NO_EFFECT_WARNING(match.schema.name));
  }

  report.autoScalingProp = match.schema.name;
  report.autoScalingReason = match.reason;
}

// The standard path: stratified prop combos plus scale anchors, mount /
// rerender / explore passes, deltas, auto-scaling, React analysis, and the
// baseline workflow.
async function runComboMode(ctx: ModeContext, fixtureHasScale: boolean): Promise<Report> {
  const { options, harness, samples, cpuThrottle, warmupRuns, seed, pool, onWarning, runWarnings, machine, calibration, thresholds, explicitThresholds, useFixture, composed } = ctx;

  const scalePoints = options.scalePoints ?? [1, 5, 20, 50];
  let combos: PropCombination[];
  let schemas: PropSchema[] | undefined;
  let zeroPropsExtracted = false;
  if (fixtureHasScale) {
    combos = scalePoints.map((n) => ({ __120fps_scaleN: n }));
  } else if (useFixture || composed) {
    combos = [{}];
  } else {
    schemas = await ctx.getSchemas();
    zeroPropsExtracted = schemas.length === 0;
    const rawComboSpace = countCombinationSpace(schemas);
    combos = generateCombinations(schemas);
    if (combos.length === 0) combos = [{}];
    if (rawComboSpace > combos.length) {
      runWarnings.push(STRATIFIED_SAMPLE_WARNING(rawComboSpace, combos.length));
    }
    const comboCap = options.maxCombos ?? DEFAULT_MEASURED_COMBOS;
    if (combos.length > comboCap) {
      const kept = selectRepresentativeCombos(combos.length, comboCap);
      runWarnings.push(COMBO_CAP_WARNING(kept.length, combos.length));
      combos = kept.map((i) => combos[i]);
    }
    const scaleCombos = scalePoints.map((n) => ({ __120fps_scaleN: n }));
    combos = [...combos, ...scaleCombos];
  }

  const effectiveSamples = computeEffectiveSamples(combos.length, samples);
  if (effectiveSamples < samples) {
    runWarnings.push(EFFECTIVE_SAMPLES_WARNING(effectiveSamples, samples, combos.length));
  }

  const mounts = await measureMount(harness, {
    samples: effectiveSamples,
    cpuThrottle,
    warmupRuns,
    combos,
    pool,
    onWarning,
  });

  const heapDeltas: number[] = mounts.map((m) => m.heapDelta ?? 0);

  const rerenders = await measureRerender(harness, {
    samples: effectiveSamples,
    cpuThrottle,
    warmupRuns,
    combos,
    animatedComboIndices: animatedIndices(mounts),
    pool,
    onWarning,
  });

  const exploreCombos = combos.filter((c) => !("__120fps_scaleN" in c));
  const exploreWallClockPerCombo = exploreCombos.length > 1
    ? Math.max(10000, Math.floor(60000 / exploreCombos.length))
    : 60000;
  const explores = await explore(harness, {
    samples: Math.min(samples, 5),
    cpuThrottle,
    warmupRuns,
    seed,
    combos: exploreCombos,
    maxWallClockMs: exploreWallClockPerCombo,
    ...(options.exploreBudgetMs !== undefined ? { totalWallClockMs: options.exploreBudgetMs } : {}),
    pool,
    onWarning,
  });
  if (explores.length < exploreCombos.length) {
    runWarnings.push(EXPLORE_BUDGET_WARNING(explores.length, exploreCombos.length));
  }

  // M47: a component that renders non-deterministically is worth knowing about
  // in its own right, not just as a reason exploration behaved differently.
  for (const result of explores) {
    if (result.volatileRegions) {
      runWarnings.push(VOLATILE_DOM_NOTICE(result.comboIndex, result.volatileRegions));
    }
  }

  let propDeltas: PropDelta[] | undefined;
  if (!useFixture && !composed && !options.skipDeltas && schemas && schemas.length > 0) {
    propDeltas = await measureStandardPropDeltas(ctx, schemas, mounts, rerenders, effectiveSamples);
  }

  const componentName = detectComponentName(ctx.metadataPath);

  const report = buildReport({
    componentPath: ctx.componentPath,
    componentName,
    machine,
    calibration,
    mounts,
    explores,
    heapDeltas,
    thresholds,
    rerenders,
    flatThresholds: options.flatThresholds,
    explicitThresholds,
    skipAttribution: options.skipAttribution,
    ...(useFixture
      ? {
          fixturePath: ctx.inputIsFixture ? ctx.componentPath : ctx.fixturePath,
          fixtureAutoDetected: ctx.fixtureAutoDetected,
        }
      : {}),
    ...(composed
      ? {
          autoComposition: true,
          compositionTree: ctx.compositionTree!,
        }
      : {}),
    nextJsShims: harness.nextJsShims,
  });

  if (zeroPropsExtracted) {
    report.warnings = [...(report.warnings ?? []), ZERO_PROPS_WARNING];
  }

  if (ctx.wrapper) attachWrapperReport(report, ctx.wrapper);
  ctx.attachHarnessContext(report);

  if (propDeltas) {
    report.propDeltas = propDeltas;
  }

  if (!fixtureHasScale && !useFixture && !composed && !options.skipAutoScale && schemas && schemas.length > 0) {
    await applyAutoScalingCurves(ctx, report, schemas);
  }

  // --- React optimization detection (separate pass) ---
  // M57: `ctx.framework` already folds the flag, the manifest and the measured
  // file's own type together. A Vue run never reaches this and never carries a
  // ReactOptimizations block.
  const shouldRunReact = !options.skipReactAnalysis && ctx.framework === "react";

  if (shouldRunReact) {
    const fnPropNames = schemas
      ? schemas.filter((s) => s.kind === "function").map((s) => s.name)
      : [];

    const reactResults = await runReactAnalysis(harness, {
      combos,
      samples: Math.min(samples, 3),
      cpuThrottle,
      warmupRuns: 1,
      fnPropNames,
      pool,
    });

    for (const combo of report.combos) {
      const opts = reactResults.get(combo.comboIndex);
      if (opts) {
        combo.reactOptimizations = opts;
        if (combo.verdict === "pass" && hasReactWarning(opts)) {
          combo.verdict = "warn";
        }
      }
    }
  }

  const envPolicy: BaselineEnvPolicy = options.baselineEnv ?? "normalize";
  const currentEnv = buildEnvFingerprint({
    machine,
    calibration,
    cpuThrottle,
    // The count the numbers were actually estimated from: baselines measured
    // at different real N are not a like-for-like comparison.
    samples: effectiveSamples,
    mode: "combo",
    framework: ctx.framework,
    ...(ctx.cssReport ? { css: ctx.cssReport.files } : {}),
    ...(ctx.wrapper ? { wrapper: ctx.wrapper.path } : {}),
    ...(harness.reactCompiler?.active ? { reactCompiler: true } : {}),
  });

  const primary = report.combos[0];
  let comboMetrics: BaselineMetrics | undefined;
  if (primary) {
    const unstable = new Set<string>();
    if (primary.mount?.unstable) unstable.add("mount");
    if (primary.rerender?.unstable) unstable.add("rerender");
    if (primary.unmount?.unstable) unstable.add("unmount");

    const interactions: Record<string, number> = {};
    for (const ix of primary.interactions) {
      interactions[ix.label] = ix.timing.median;
    }

    comboMetrics = {
      mount: primary.mount.median,
      rerender: primary.rerender.median,
      unmount: primary.unmount.median,
      domNodeCount: primary.domNodeCount,
      interactions,
      unstable,
      tier: (primary.tier ?? "T1") as BaselineEntry["tier"],
      ...(primary.measuredState ? { measuredState: primary.measuredState } : {}),
    };
  }

  applyBaselineWorkflow(report, comboMetrics, {
    options,
    projectRoot: ctx.projectRoot,
    relativeComponent: ctx.relativeComponent,
    componentDir: path.dirname(ctx.resolvedPath),
    currentEnv,
    envPolicy,
    ...(options.saveBaseline ? { sourceFingerprint: await ctx.getSourceFingerprint() } : {}),
  });

  // M51: recorded before serialization so the JSON carries the same ids the
  // terminal prints.
  const hintIds = hintsForReport(report);
  if (hintIds.length > 0) report.hints = hintIds;

  writeReportJson(report, options.jsonPath);

  return report;
}

function detectComponentName(componentPath: string): string {
  const source = fs.readFileSync(componentPath, "utf-8");

  const defaultFn = source.match(
    /export\s+default\s+function\s+([A-Z]\w*)/,
  );
  if (defaultFn) return defaultFn[1];

  const defaultConst = source.match(
    /export\s+default\s+([A-Z]\w*)/,
  );
  if (defaultConst) return defaultConst[1];

  const namedExport = source.match(
    /export\s+(?:const|function)\s+([A-Z]\w*)/,
  );
  if (namedExport) return namedExport[1];

  const reExport = source.match(
    /export\s+\{\s*([A-Z]\w*)\s*\}/,
  );
  if (reExport) return reExport[1];

  const basename = path.basename(componentPath, path.extname(componentPath));
  return basename.charAt(0).toUpperCase() + basename.slice(1);
}

// Opt-in only: writing into a project unasked is a side effect the NFRs rule
// out, and an existing fixture is either the user's work or a scaffold they
// already edited.
function writeFixtureScaffold(
  componentPath: string,
  exports: import("./composition.js").ExportInfo[],
  tree: CompositionTree,
): string {
  const target = fixtureScaffoldPath(componentPath);
  if (fs.existsSync(target)) {
    return `--init-fixture skipped: ${target} already exists`;
  }
  const stem = path.basename(componentPath, path.extname(componentPath));
  fs.writeFileSync(target, buildFixtureScaffold(stem, exports, tree), "utf8");
  return `wrote fixture scaffold ${target}; edit it to render the real composition, then re-run`;
}

// One untimed mount, before calibration, purely to find out whether the
// inferred tree renders. Errors are returned rather than thrown: an invalid
// composition is a fallback signal, not a run failure.
async function trialMountComposition(
  page: import("playwright").Page,
): Promise<import("./composition.js").CompositionTrial> {
  try {
    await page.evaluate(() => (window as any).__120fps.mount({}));
    const rootElements = await page.evaluate(
      () => document.getElementById("root")?.querySelectorAll("*").length ?? 0,
    );
    await page.evaluate(() => (window as any).__120fps.unmount());
    return { rootElements };
  } catch (error) {
    return { rootElements: 0, error };
  }
}

async function collectMachineInfo(
  chromiumVersion: string,
): Promise<MachineInfo> {
  const cpus = os.cpus();
  return {
    cpu: cpus.length > 0 ? cpus[0].model : "unknown",
    cores: cpus.length,
    ramMb: Math.round(os.totalmem() / (1024 * 1024)),
    os: `${os.type()} ${os.release()}`,
    nodeVersion: process.version,
    chromiumVersion,
  };
}

// M39: identical source in an identical environment redraws the same
// distribution, so a check-mode run may reuse the stored verdict instead of
// measuring. Explicit mode enables always measure — auto-activation is a
// function of the fingerprinted source, flags are not. Returns the reused
// report, or undefined when the run must measure.
async function tryReuseStoredVerdict(args: {
  options: AnalyzeOptions;
  pool: BrowserPool;
  projectRoot: string;
  relativeComponent: string;
  componentPath: string;
  metadataPath: string;
  thresholds: Thresholds;
  samples: number;
  cpuThrottle: number;
  cssReport?: CssReport;
  wrapPath?: string;
  framework: "react" | "vue" | "vanilla";
  getSourceFingerprint: () => Promise<string>;
}): Promise<Report | undefined> {
  const { options, projectRoot } = args;
  if (!optionsAllowVerdictReuse(options)) return undefined;

  // M45: only this environment's own slot can carry a reusable verdict.
  // A cross-machine slot is informational and must never short-circuit a run.
  const baselineFile = loadBaseline(path.join(projectRoot, "120fps-baseline.json"));
  const slots = Object.entries(baselineFile?.entries ?? {}).filter(
    ([key]) => parseBaselineKey(key).componentPath === args.relativeComponent,
  );
  const entry = slots.map(([, value]) => value).find((candidate) => candidate?.env);
  if (!entry?.sourceFingerprint || entry.pass === undefined || !entry.env) return undefined;

  const fingerprint = await args.getSourceFingerprint();
  if (fingerprint !== entry.sourceFingerprint) return undefined;

  // Machine identity only — no page, no calibration. A single calibration
  // sample swings 20–40% on a real machine, and thermal drift changes
  // measured values, never the verdict of unchanged code
  // (sameMachineIdentity). Features are the current run's real ones, so a
  // hand-edited or drifted env record breaks reuse.
  const browser = await args.pool.acquire(true);
  const machine = await collectMachineInfo(browser.version());
  const probeEnv = buildEnvFingerprint({
    machine,
    calibration: { totalDuration: 0, scriptDuration: 0 },
    cpuThrottle: args.cpuThrottle,
    // The requested count: combos are not extracted yet, so the effective one
    // is unknown here. A stored entry that was throttled therefore fails the
    // gate and the run measures — reuse errs towards measuring, never towards
    // a mismatched verdict.
    samples: args.samples,
    mode: "combo",
    framework: args.framework,
    ...(args.cssReport ? { css: args.cssReport.files } : {}),
    ...(args.wrapPath
      ? { wrapper: path.relative(projectRoot, args.wrapPath).replace(/\\/g, "/") }
      : {}),
    ...(resolveReactCompilerState(projectRoot, options.reactCompiler).active
      ? { reactCompiler: true }
      : {}),
  });
  if (!sameMachineIdentity(entry.env, probeEnv)) return undefined;

  const report: Report = {
    version: 1,
    timestamp: new Date().toISOString(),
    machine,
    componentPath: args.componentPath,
    componentName: detectComponentName(args.metadataPath),
    // The calibration of the run whose verdict is being reused.
    calibration: {
      totalDuration: entry.env.calibrationTotalDuration,
      scriptDuration: entry.env.calibrationScriptDuration,
    },
    combos: [],
    thresholds: args.thresholds,
    pass: entry.pass,
    cached: true,
    baseline: {
      hasBaseline: true,
      regressions: [],
      improvements: [],
      missingInteractions: [],
      envMatch: "identical",
      envMismatches: [],
    },
  };
  // M40: a reused verdict repeats the disclosure that came with it.
  if (entry.measuredState && entry.measuredState !== "settled") {
    report.warnings = [MEASURED_STATE_WARNING(entry.measuredState)];
  }
  writeReportJson(report, options.jsonPath);
  return report;
}

export async function analyze(
  componentPath: string,
  options: AnalyzeOptions = {},
): Promise<Report> {
  const resolvedPath = path.resolve(componentPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Component file not found: ${componentPath}`);
  }

  const thresholds: Thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...options.thresholds,
  };

  // Under tiered budgets a threshold the user typed must override the tier's,
  // so every mode that builds combos needs to know which ones were explicit.
  const explicitThresholds: Partial<Record<keyof TierBudget, boolean>> = {};
  if (options.thresholds?.mountMs !== undefined) explicitThresholds.mountMs = true;
  if (options.thresholds?.rerenderMs !== undefined) explicitThresholds.rerenderMs = true;
  if (options.thresholds?.interactionMs !== undefined) explicitThresholds.interactionMs = true;

  const samples = options.samples ?? 10;
  const cpuThrottle = options.cpuThrottle ?? 4;
  const warmupRuns = options.warmupRuns ?? 2;
  const seed = options.seed ?? 42;

  // M37: every browser-using pass draws from one pool (two processes for the
  // whole run); a CLI-provided pool outlives this run and is not closed here.
  const pool = options.browserPool ?? createBrowserPool();
  const ownsPool = options.browserPool === undefined;

  let fixturePath: string | undefined = options.fixturePath;
  let fixtureAutoDetected = false;
  const inputIsFixture = isFixturePath(componentPath);

  if (inputIsFixture) {
    fixturePath = componentPath;
  } else if (!fixturePath) {
    const detected = detectFixture(resolvedPath);
    if (detected) {
      fixturePath = detected;
      fixtureAutoDetected = true;
    }
  }

  if (fixturePath && !inputIsFixture) {
    const resolvedFixture = path.resolve(fixturePath);
    if (!fs.existsSync(resolvedFixture)) {
      throw new Error(`Fixture file not found: ${fixturePath}`);
    }
  }

  // M57: one component per SFC, so there is nothing for the suffix taxonomy to
  // infer — auto-composition is skipped for Vue, not adapted to it. Reached
  // only when no fixture applies, so the measured file is componentPath.
  const rendererIsVue = isVueFile(componentPath);

  let compositionTree: CompositionTree | undefined;
  let componentExports: import("./composition.js").ExportInfo[] | undefined;
  if (!fixturePath && !inputIsFixture && !options.skipAutoCompose && !rendererIsVue) {
    componentExports = await extractExports(resolvedPath);
    if (componentExports.length > 1) {
      const allSchemas = await extractAllProps(resolvedPath);
      const tree = inferComposition(componentExports, allSchemas);
      if (tree) compositionTree = tree;
    }
  }

  const useFixture = fixturePath !== undefined;
  const useComposition = compositionTree !== undefined;
  const harnessPath = useFixture ? fixturePath! : componentPath;
  const metadataPath = inputIsFixture ? componentPath : resolvedPath;

  const { projectRoot, relativeComponent } = resolveProjectPaths(resolvedPath);
  // M57: resolved before the wrapper, because a Vue project's wrapper is an SFC
  // and a `.tsx` one left lying around could not render the component at all.
  const framework = resolveFramework(options.framework ?? "auto", projectRoot, harnessPath);
  const { wrapPath, wrapAutoDetected } = resolveWrapPath(options, projectRoot, framework);
  const resolvedCss = resolveCssFiles(options, projectRoot);
  const cssReport: CssReport | undefined =
    resolvedCss.files.length > 0
      ? {
          files: resolvedCss.files.map((f) => path.relative(projectRoot, f).replace(/\\/g, "/")),
          autoDetected: resolvedCss.autoDetected,
        }
      : undefined;
  // M44: a fixture already owns its scene, so presets never apply there.
  const presetPath = useFixture ? undefined : detectPropPresets(resolvedPath);
  const presets = presetPath ? loadPropPresets(presetPath, projectRoot) : undefined;

  let fontsSettled = true;
  // M48: kept outside the try so a failure on the way out can still name them.
  let transformHits: import("./preflight.js").PreflightHit[] = [];
  let activeTransforms: string[] | undefined;
  const runWarnings: string[] = [];
  // M46: counted before dedup — one surviving reload is a noise signal, and the
  // warning list deliberately shows it once however often it happened.
  let contextRetries = 0;
  let noiseProbe: number[] = [];
  const onWarning = (warning: string): void => {
    if (warning === CONTEXT_RETRY_WARNING) contextRetries++;
    // Deduped: a reload during a 27-combo run would otherwise print 27 times.
    if (!runWarnings.includes(warning)) runWarnings.push(warning);
  };

  // Preset values replace a prop's pool everywhere schemas are read, so combos,
  // deltas, matrix cells and curve anchors all measure the same data.
  const presetApplied = new Set<string>();
  const extractSchemas = async (file: string): Promise<PropSchema[]> => {
    const raw = await extractProps(file);
    if (!presets) return raw;
    const result = applyPropPresets(raw, presets);
    for (const name of result.applied) presetApplied.add(name);
    if (result.unknown.length > 0) {
      onWarning(UNKNOWN_PRESET_PROPS_WARNING(presets.path, result.unknown));
    }
    return result.schemas;
  };

  // M39: everything that shapes what gets measured, hashed together with the
  // measured sources. Feature drift lives here, so the environment probe only
  // has to guard the machine.
  const fingerprintConfig = JSON.stringify({
    // M48: a transform changes the code that gets measured, exactly like the
    // React Compiler does, so it belongs in the identity of a cached verdict.
    transforms: options.noTransforms ? [] : detectProjectTransforms(projectRoot).map((t) => t.code),
    css: cssReport?.files ?? [],
    wrap: wrapPath ? path.relative(projectRoot, wrapPath).replace(/\\/g, "/") : null,
    reactCompiler: options.reactCompiler ?? "auto",
    samples,
    cpuThrottle,
  });
  let fingerprintValue: string | undefined;
  const getSourceFingerprint = async (): Promise<string> => {
    if (fingerprintValue) return fingerprintValue;
    const graph = await projectSourceFiles(path.resolve(harnessPath));
    const extras: string[] = [];
    if (wrapPath) extras.push(wrapPath);
    // M44: nothing imports the preset module from the component graph, so an
    // edited preset would otherwise reuse a verdict about different values.
    if (presets) extras.push(presets.absolutePath);
    extras.push(...resolvedCss.files);
    if (path.resolve(metadataPath) !== path.resolve(harnessPath)) {
      extras.push(path.resolve(metadataPath));
    }
    for (const name of [
      "tailwind.config.js",
      "tailwind.config.ts",
      "tailwind.config.mjs",
      "postcss.config.js",
      "postcss.config.mjs",
      "postcss.config.cjs",
      "pnpm-lock.yaml",
      "package-lock.json",
      "yarn.lock",
    ]) {
      const candidate = path.join(projectRoot, name);
      if (fs.existsSync(candidate)) extras.push(candidate);
    }
    fingerprintValue = computeSourceFingerprint(
      projectRoot,
      [...graph, ...extras],
      fingerprintConfig,
    );
    return fingerprintValue;
  };

  const attachHarnessContext = (report: Report): void => {
    if (runWarnings.length > 0) {
      report.warnings = [...(report.warnings ?? []), ...runWarnings];
    }
    if (cssReport) report.css = cssReport;

    // M46: assembled from signals the run already produced, plus the one probe.
    // A run whose machine was busy must say so before anyone reads its numbers.
    if (noiseProbe.length > 0) {
      let unstableCount = 0;
      let metricCount = 0;
      for (const combo of report.combos) {
        for (const metric of [combo.mount, combo.rerender, combo.unmount]) {
          if (!metric) continue;
          metricCount++;
          if (metric.unstable) unstableCount++;
        }
      }
      const noise = buildNoiseReport({
        probeSamples: noiseProbe,
        unstableCount,
        metricCount,
        contextRetries,
      });
      report.noise = noise;
      if (noise.level === "noisy") {
        report.warnings = [...(report.warnings ?? []), NOISY_RUN_WARNING];
      } else if (noise.level === "hostile") {
        report.warnings = [...(report.warnings ?? []), HOSTILE_RUN_WARNING];
      }
    }

    if (presets && presetApplied.size > 0) {
      report.propPresets = { path: presets.path, props: [...presetApplied].sort() };
    }
    // M48: which of the project's own transforms compiled this run.
    if (activeTransforms && activeTransforms.length > 0) {
      report.projectTransforms = activeTransforms;
    }
    const compiler = harness?.reactCompiler;
    if (compiler && (compiler.detected || compiler.active)) {
      report.reactCompiler = {
        active: compiler.active,
        detected: compiler.detected,
        ...(compiler.version ? { version: compiler.version } : {}),
      };
    }
    if (compiler?.warning) {
      report.warnings = [...(report.warnings ?? []), compiler.warning];
    }
    if (!fontsSettled) {
      report.warnings = [...(report.warnings ?? []), FONT_SETTLE_WARNING];
    }
  };

  let harness: HarnessResult | undefined;
  let msession: MeasurementSession | undefined;

  try {
    const reused = await tryReuseStoredVerdict({
      options,
      pool,
      projectRoot,
      relativeComponent,
      componentPath,
      metadataPath,
      thresholds,
      samples,
      cpuThrottle,
      framework,
      ...(cssReport !== undefined ? { cssReport } : {}),
      ...(wrapPath !== undefined ? { wrapPath } : {}),
      getSourceFingerprint,
    });
    if (reused) return reused;

    // M57: the project's own SFC parser, loaded once. A `.vue` target without
    // it cannot be read at all, so the run fails here naming the missing
    // dependency rather than deep inside Vite minutes later.
    const vueCompiler = framework === "vue" ? await loadVueCompiler(projectRoot) : undefined;
    if (framework === "vue" && !vueCompiler && isVueFile(harnessPath)) {
      throw new Error(VUE_COMPILER_MISSING(projectRoot));
    }

    // M42: before any harness directory or dev server exists. A component whose
    // graph reaches server-only code cannot mount in a browser at all, and the
    // check costs a source walk, not a boot.
    const preflight = runPreflight({
      projectRoot,
      entries: [harnessPath, ...(wrapPath ? [wrapPath] : [])],
      // The export the entry actually mounts, not the display name.
      componentName: detectComponentExport(harnessPath).name,
      ...(vueCompiler ? { vueCompiler } : {}),
    });
    for (const hit of preflight.soft) runWarnings.push(NODE_BUILTIN_WARNING(hit));

    // M48: only warn about transforms the harness will not apply. A project
    // whose plugin is on the supported list and installed gets it loaded, and
    // crying wolf about a transform that worked is worse than silence.
    const loadableTransforms = new Set(
      (options.noTransforms ? [] : detectProjectTransforms(projectRoot)).map((t) => t.code),
    );
    transformHits = preflight.transforms.filter(
      (hit) => !hit.transformCode || !loadableTransforms.has(hit.transformCode),
    );
    // Named up front, and again on the way out if the run dies — a transform
    // the harness cannot apply is the first thing to check.
    for (const hit of transformHits) runWarnings.push(PROJECT_TRANSFORM_WARNING(hit));
    if (loadableTransforms.size > 0) {
      activeTransforms = [...loadableTransforms].sort();
    }
    if (preflight.hard.length > 0) {
      if (options.noPreflight) {
        runWarnings.push(PREFLIGHT_BYPASSED_WARNING(preflight.hard));
      } else {
        throw new Error(preflightFailureMessage(preflight.hard));
      }
    }

    const baseHarnessOpts: import("./harness.js").BuildHarnessOptions = {
      ...(options.noShims ? { noShims: true } : {}),
      ...(wrapPath ? { wrapPath } : {}),
      ...(resolvedCss.files.length > 0 ? { cssFiles: resolvedCss.files } : {}),
      ...(options.reactCompiler !== undefined ? { reactCompiler: options.reactCompiler } : {}),
      ...(options.serverPool ? { serverPool: options.serverPool } : {}),
      ...(presets ? { presetPath: presets.absolutePath } : {}),
      ...(options.noTransforms ? { noTransforms: true } : {}),
    };
    const composedHarnessOpts: import("./harness.js").BuildHarnessOptions = {
      ...baseHarnessOpts,
      ...(useComposition ? { composition: compositionTree!, exports: componentExports } : {}),
    };
    harness = await buildAndServe(harnessPath, composedHarnessOpts);
    if (harness.warnings) runWarnings.push(...harness.warnings);

    // M35: calibration, trial mount, and wrapper overhead run under the same
    // driven frame pacing as the measurement passes they normalize.
    msession = await openMeasurementSession({ driven: true, onWarning, pool });
    const page = msession.page;
    const pageErrors = msession.errorCapture;
    const cdp = msession.session.cdp;

    const chromiumVersion = msession.browser.version();
    const machine = await collectMachineInfo(chromiumVersion);

    const enterHarnessPage = async (): Promise<void> => {
      await page.goto(harness!.url, { waitUntil: HARNESS_NAV_WAIT });
      try {
        await page.waitForFunction(
          () => typeof (window as any).__120fps === "object",
          undefined,
          { timeout: 30000 },
        );
      } catch (err) {
        throw enrichTimeoutError(err, pageErrors, "component harness");
      }

      await applyWrapperViewport(page);
      fontsSettled = await settleStyles(page, harness!);
    };

    await enterHarnessPage();

    // A structurally inferred tree can violate a library's nesting rules and
    // mount to an empty root. Measuring that produces confident numbers about
    // a scene nobody wrote, so prove it renders before trusting it.
    if (useComposition) {
      const trial = await trialMountComposition(page);
      if (shouldRollbackComposition(trial)) {
        runWarnings.push(COMPOSITION_EMPTY_WARNING(compositionTree!.root));
        if (options.initFixture) {
          runWarnings.push(
            writeFixtureScaffold(resolvedPath, componentExports ?? [], compositionTree!),
          );
        }
        compositionTree = undefined;
        componentExports = undefined;
        await harness.cleanup();
        harness = await buildAndServe(harnessPath, baseHarnessOpts);
        if (harness.warnings) runWarnings.push(...harness.warnings);
        await enterHarnessPage();
      }
    }
    const composed = compositionTree !== undefined;

    // M46: unthrottled and outside every traced window — the question is what
    // the machine is doing, not what the component costs.
    noiseProbe = await suspendThrottle(cdp, cpuThrottle, () => probeMachineNoise(page));

    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });

    const calibrationMetrics = await createCalibrationTrace(page, cdp);
    const calibration: CalibrationResult = {
      totalDuration: calibrationMetrics.totalDuration,
      scriptDuration: calibrationMetrics.scriptDuration,
    };

    if (calibration.totalDuration === 0) {
      throw new Error("Calibration produced zero duration — measurement environment is broken");
    }

    let wrapper: WrapperReport | undefined;
    if (wrapPath) {
      const overhead = await measureWrapperOverhead(page, cdp, samples);
      wrapper = {
        path: path.relative(projectRoot, wrapPath).replace(/\\/g, "/"),
        autoDetected: wrapAutoDetected,
        overheadMs: overhead.overheadMs,
        domNodes: overhead.domNodes,
        ...(overhead.hasSetup ? { hasSetup: true } : {}),
      };
    }

    await msession.close();
    msession = undefined;

    let schemas: import("./prop-gen.js").PropSchema[] | undefined;
    const fixtureHasScale = useFixture && detectScaleExport(path.resolve(harnessPath));

    const ctx: ModeContext = {
      options,
      harness,
      pool,
      machine,
      calibration,
      thresholds,
      explicitThresholds,
      samples,
      cpuThrottle,
      warmupRuns,
      seed,
      componentPath,
      resolvedPath,
      metadataPath,
      projectRoot,
      relativeComponent,
      inputIsFixture,
      useFixture,
      framework,
      ...(fixturePath !== undefined ? { fixturePath } : {}),
      fixtureAutoDetected,
      composed,
      ...(compositionTree !== undefined ? { compositionTree } : {}),
      ...(wrapper !== undefined ? { wrapper } : {}),
      ...(cssReport !== undefined ? { cssReport } : {}),
      runWarnings,
      onWarning,
      getSchemas: async () => (schemas ??= await extractSchemas(harness!.componentPath)),
      getSourceFingerprint,
      attachHarnessContext,
    };

    // --- Isolation mode ---
    if (options.isolation) {
      return await runIsolationMode(ctx, options.isolation);
    }

    // --- Curve mode check ---
    const curveMatch = await resolveCurveMatch(ctx);
    if (curveMatch) {
      return await runCurveMode(ctx, curveMatch);
    }

    // --- Matrix mode check ---
    const matrixDisabled = options.matrixMode === false;
    let activateMatrix = false;
    // Distinct from a forced --matrix: only auto-activation is a surprise
    // worth an upfront notice, since --matrix was the user's own request.
    let matrixAutoActivated = false;

    if (!matrixDisabled && !useFixture && !composed) {
      if (options.matrixMode === true) {
        activateMatrix = true;
      } else {
        activateMatrix = shouldAutoActivateMatrix(await ctx.getSchemas());
        matrixAutoActivated = activateMatrix;
      }
    }

    if (activateMatrix) {
      return await runMatrixMode(ctx, matrixAutoActivated);
    }

    return await runComboMode(ctx, fixtureHasScale);
  } catch (err) {
    // M48: whatever killed the run, an unloadable project transform in the
    // graph is the likeliest cause and the least visible one. Vite's own error
    // never mentions the plugin the project relies on.
    if (transformHits.length > 0 && err instanceof Error) {
      throw new Error(err.message + transformFailureNote(transformHits), { cause: err });
    }
    throw err;
  } finally {
    if (msession) await msession.close();
    if (ownsPool) await pool.closeAll();
    if (harness) await harness.cleanup();
  }
}

// M35: rerender passes inherit animation knowledge from the mount pass over
// the same combo list, so animated combos never measure under driven pacing.
function animatedIndices(mounts: MountResult[]): number[] {
  return mounts.filter((m) => m?.hasAnimation).map((m) => m.comboIndex);
}

export const ZERO_PROPS_WARNING =
  "No props extracted — component measured with empty props only; if the component has typed props, extraction may have failed";

// --no-css wins over an explicit --css, matching --no-wrap/--wrap. Explicit
// paths resolve against process.cwd() and suppress detection; detection returns
// at most one file.
export function resolveCssFiles(
  options: Pick<AnalyzeOptions, "cssFiles" | "noCss">,
  projectRoot: string,
): { files: string[]; autoDetected: boolean } {
  if (options.noCss) return { files: [], autoDetected: false };

  if (options.cssFiles && options.cssFiles.length > 0) {
    const files: string[] = [];
    for (const raw of options.cssFiles) {
      const resolved = path.resolve(raw);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        throw new Error(`Stylesheet not found: ${raw}`);
      }
      if (!stat.isFile()) throw new Error(`Stylesheet is not a file: ${raw}`);
      if (!files.includes(resolved)) files.push(resolved);
    }
    return { files, autoDetected: false };
  }

  const detected = detectGlobalCss(projectRoot);
  return detected ? { files: [detected], autoDetected: true } : { files: [], autoDetected: false };
}

// --no-wrap wins over an explicit --wrap, matching --no-isolate/--isolate.
export function resolveWrapPath(
  options: Pick<AnalyzeOptions, "wrapPath" | "noWrap">,
  projectRoot: string,
  framework?: string,
): { wrapPath?: string; wrapAutoDetected: boolean } {
  if (options.noWrap) return { wrapAutoDetected: false };
  if (options.wrapPath) {
    const resolved = path.resolve(options.wrapPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Wrapper module not found: ${options.wrapPath}`);
    }
    return { wrapPath: resolved, wrapAutoDetected: false };
  }
  const detected = detectWrapper(projectRoot, framework);
  return detected ? { wrapPath: detected, wrapAutoDetected: true } : { wrapAutoDetected: false };
}

// Root for 120fps.config.json / 120fps-baseline.json: nearest ancestor of the
// component containing package.json, falling back to the component's directory.
export function resolveProjectPaths(resolvedPath: string): {
  projectRoot: string;
  relativeComponent: string;
} {
  const componentDir = path.dirname(resolvedPath);
  const projectRoot = findProjectRoot(componentDir) ?? componentDir;
  const relativeComponent =
    "./" + path.relative(projectRoot, resolvedPath).replace(/\\/g, "/");
  return { projectRoot, relativeComponent };
}

export function legacyBaselineWarning(
  projectRoot: string,
  componentDir: string,
): string | undefined {
  if (componentDir === projectRoot) return undefined;
  if (!fs.existsSync(path.join(componentDir, "120fps-baseline.json"))) return undefined;
  return (
    `no baseline entry found at ${path.join(projectRoot, "120fps-baseline.json")}, ` +
    `but a legacy 120fps-baseline.json exists next to the component in ${componentDir}. ` +
    `Baselines now live at the package root — re-run with --save-baseline to migrate.`
  );
}

// Explicit --framework react|vue|vanilla skips detection; auto detects from the
// project's package.json. A `.vue` file overrides both: no flag can make React
// render an SFC, so the file's own type is the stronger evidence.
export function resolveFramework(
  mode: "react" | "vue" | "vanilla" | "auto",
  projectRoot: string,
  componentPath?: string,
): "react" | "vue" | "vanilla" {
  if (componentPath && isVueFile(componentPath)) return "vue";
  return mode === "auto" ? detectFramework(projectRoot) : mode;
}

export function hasScaleExport(source: string): boolean {
  return /export\s+(?:function|const)\s+scale\b/.test(source);
}

export function isFixturePath(filePath: string): boolean {
  return /\.fixture\.([jt]sx?|vue)$/.test(filePath);
}

export function detectFixture(componentPath: string): string | undefined {
  const ext = path.extname(componentPath);
  const stem = componentPath.slice(0, -ext.length);
  // A compound Vue component composes in a .fixture.vue: one component per SFC
  // leaves auto-composition nothing to infer.
  const candidates = isVueFile(componentPath)
    ? [`${stem}.fixture.vue`]
    : [`${stem}.fixture.tsx`, `${stem}.fixture.ts`];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function mapReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(value);
  }
  return value;
}
