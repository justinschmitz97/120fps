import ts from "typescript";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { buildAndServe, detectComponentExport, detectProjectTransforms, discoverGlobalCss, detectScaleExport, detectWrapper, findProjectRoot, resolveReactCompilerState, assertReactDomClient, rendererFor, detectBundlerReactDomAlias, BUNDLER_PREACT_ALIAS_WARNING, stylesheetRuleCount, hasAnyEnvFile, NO_ENV_FILE_REMEDY_NOTE, loadTsconfigAliases, presentBundlerFailure, stylesheetReadFailureTarget, CSS_UNREADABLE_DROPPED_WARNING, type HarnessResult } from "./harness.js";
import {
  attachPageErrorCapture,
  gotoWithErrorContext,
  hasPageErrors,
  mergeDrains,
  renderDrain,
  retagPhaseError,
  waitForReadyOrFatal,
} from "./page-errors.js";
import { extractProps, extractPropsDetailed, extractExports, extractAllProps, detectScalingProps, projectSourceFiles, isVuePropsScopeExclusionWarning, projectCompilerOptions, type PropSchema, type ScalingPropMatch } from "./prop-gen.js";
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
  isPresetRef,
  UNKNOWN_PRESET_PROPS_WARNING,
} from "./prop-presets.js";
import {
  runPreflight,
  preflightFailureMessage,
  providerCandidateLabels,
  providersFromEntry,
  isDirectProviderHit,
  NODE_BUILTIN_WARNING,
  PROJECT_TRANSFORM_WARNING,
  PREFLIGHT_BYPASSED_WARNING,
  PreflightHardRejectionError,
  classifyPreprocessorAvailability,
} from "./preflight.js";
import {
  inferComposition,
  shouldRollbackComposition,
  buildFixtureScaffold,
  fixtureScaffoldPath,
  COMPOSITION_EMPTY_WARNING,
  declaredCompositionSiblings,
  extractRelativeTypeImports,
  scanJsxComposedLocalImports,
  UNCOMPOSED_SIBLINGS_WARNING,
  type CompositionTree,
} from "./composition.js";
import { detectFramework, runReactAnalysis, hasReactWarning, type ReactOptimizations } from "./react-profiler.js";
import { findWorkspaceRoot } from "./project-model.js";
import { isVueFile, loadVueCompiler, VUE_COMPILER_MISSING } from "./vue-sfc.js";
import {
  generateCombinations,
  generateDeltaPairs,
  generateScalingCombos,
  generatePropMatrix,
  shouldAutoActivateMatrix,
  selectRepresentativeCombos,
  selectMatrixCombos,
  countCombinationSpace,
  countDeltaPairSpace,
  DEFAULT_MEASURED_COMBOS,
  type PropCombination,
} from "./prop-gen-values.js";
import { applyWrapperViewport, createBrowserPool, measureMount, measureRerender, measureWrapperOverhead, openMeasurementSession, settleStyles, reportFontSettle, suspendThrottle, CONTEXT_RETRY_WARNING, HARNESS_NAV_WAIT, type BrowserPool, type MeasurementSession, type MountResult, type RerenderResult } from "./measure.js";
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
  CURVE_NOT_ACTIVATED_WARNING,
  classifyTier,
  computeVerdict,
  deriveReportMode,
  detectRenderHealthInconsistency,
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
  type PropProvenance,
  formatStylesheetsLine,
} from "./report.js";

// M40: the numbers are real, but they describe a transient scene. Warn, never
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

export const MATRIX_CELL_CAP_WARNING = (kept: number, total: number): string =>
  `measured ${kept} of ${total} matrix cells; ${total - kept} were dropped to bound the run. ` +
  `Raise it with --max-combos <n>.`;

// M61: the most lenient tier budget the tool has. A component whose single
// instance already costs this much will not cost less per copy at N=5/20/50:
// quadrupling the instance count is exactly the shape of dogfooding's 46.9s
// single-probe reproduction.
export const SCALE_PROBE_GATE_MS = TIER_BUDGETS.T4.mountMs;

export const SCALE_PROBE_COST_WARNING = (
  probeN: number,
  probeMs: number,
  skipped: number[],
): string =>
  `scale probe: N=${probeN} already mounts at ${probeMs.toFixed(1)}ms (over the ${SCALE_PROBE_GATE_MS}ms ` +
  `T4 budget): skipped N=${skipped.join(", ")} to avoid a multi-minute probe. Raise the ceiling with --scale.`;

// Pure decision over an already-measured probe cost: no browser involved, so
// it is unit-testable independent of the measurement call that produces
// `probeMs`.
export function boundScalePointsByProbeCost(
  scalePoints: number[],
  probeMs: number,
  gateMs: number = SCALE_PROBE_GATE_MS,
): { points: number[]; skipped: number[] } {
  if (scalePoints.length <= 1 || probeMs <= gateMs) return { points: scalePoints, skipped: [] };
  const probeN = Math.min(...scalePoints);
  return { points: [probeN], skipped: scalePoints.filter((n) => n !== probeN) };
}

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
  `cell): coverage is not exhaustive.`;

export const MATRIX_AUTO_ACTIVATED_NOTICE = (cellCount: number): string =>
  `Matrix mode auto-activated: measuring all ${cellCount} prop combinations, which multiplies run time ` +
  `roughly ${cellCount}x versus a single combo. Use --no-matrix to disable.`;

// M83 #4a (twenty-F6): a run is one whole-run mode or the other; an explicit
// --matrix silently lost to an auto-activated curve mode before this existed.
export const MATRIX_SUPPRESSED_BY_CURVE_WARNING = (propName: string): string =>
  `--matrix did not activate: curve mode auto-activated on ${propName} first, and a run is one ` +
  "whole-run mode or the other. Re-run with --no-curve to force matrix instead.";

// M83 #4c (commerce-F5): an explicit --matrix bypasses shouldAutoActivateMatrix's
// 2-eligible-axis floor; when the component genuinely has none, the run still
// prints a matrix table with one anchor-combo cell and no explanation.
export const MATRIX_NO_AXES_WARNING =
  "matrix mode found no boolean or small-union prop to cross: the single cell shown is the anchor " +
  "combo, not a real matrix. Re-run --explain-props to see why no prop qualified as an axis.";

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
    // verification of a real run: both must measure.
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
  // never creates or closes one: single-component runs gain nothing.
  serverPool?: import("./harness.js").ServerPool;
  // M39: force measurement even when a fingerprinted baseline would allow
  // reusing the stored verdict.
  noCache?: boolean;
  // M42: attempt the run even when the graph reaches a server boundary.
  noPreflight?: boolean;
  // M48: skip the project's own Vite transforms.
  noTransforms?: boolean;
  // M65: the export to import and bind props to (`<file>#Export`). Absent, the
  // M58/M65 selection order picks one.
  target?: string;
  // M65: one line per pipeline phase boundary. Defaulted by the CLI to stdout,
  // silenced entirely in CI mode.
  onProgress?: (line: string) => void;
  // Item A (M90 follow-up): mirrors every warning this run discovers (the
  // `Stylesheets:` decision line, then each `runWarnings` entry as it is
  // pushed) out to a caller-supplied sink in real time, not only at the end
  // -- so a caller that also owns a *different* failure-arrival surface
  // (cli.ts's process-level `unhandledRejection` handler, which runs on a
  // separate call stack with no access to this function's own locals) can
  // still disclose everything discovered before whatever crashed it.
  onWarning?: (warning: string) => void;
}

// M65: `--ci` owns stdout for JSON (M22), so it wins over an explicit sink.
export function resolveProgressReporter(
  options: Pick<AnalyzeOptions, "ci" | "onProgress">,
  write: (chunk: string) => void = (chunk) => process.stdout.write(chunk),
): (line: string) => void {
  if (options.ci) return () => {};
  const sink = options.onProgress;
  if (sink) return (line) => sink(line);
  return (line) => write(line + "\n");
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
  // M80: a combo rendered something, but not the whole component. Applied
  // once, after the per-combo loop, to every combo without a renderHealth
  // value already: renderHealth already fully discloses the combo's shape,
  // so a combo that has it is left untouched by this field and its verdict.
  disclosureReason?: "uncomposed" | "propsExcluded";
  nextJsShims?: string[];
  scalingCurveReport?: ScalingCurveReport;
  matrixReport?: import("./report.js").MatrixReport;
  // M85: consumed to attribute a fatal render crash to a harness-synthesized
  // value rather than the component (see detectHarnessFault). Optional and
  // read defensively — `provenance` is Lane B's field (src/prop-gen.ts,
  // M84) and may not exist on a given schema; when it is absent everywhere,
  // no combo is ever exonerated (see detectHarnessFault).
  schemas?: Array<PropSchema & { provenance?: PropProvenance }>;
}

// M85: mirrors isHarnessInternalNoise's (src/page-errors.ts) principle for a
// network request — a harness-caused failure is not the component's — but
// generalized to a render crash. Requires positive evidence per provenance
// class, never fires on presence alone: most placeholder/heuristic values
// never cause a crash, so a schema's risky provenance is necessary but not
// sufficient. Returns undefined whenever no schema explains the crash,
// including when `schemas` is absent entirely (M84 not yet landed, or a
// caller that never had a schema list to begin with, e.g. a fixture/matrix
// path this milestone does not touch).
function detectHarnessFault(
  combo: ComboReport,
  schemas: Array<PropSchema & { provenance?: PropProvenance }> | undefined,
): ComboReport["harnessFault"] | undefined {
  if (!schemas || schemas.length === 0) return undefined;
  const errorText = (combo.pageErrors ?? []).join(" ");

  // Contract props first: a prop whose truthiness imposes a requirement on
  // sibling props (asChild, as, render...) is inherently a harness risk once
  // truthy, by M84's own definition of "contract" provenance — the
  // synthesizer flagged this exact uncertainty when it chose the value.
  for (const schema of schemas) {
    if (schema.provenance !== "contract") continue;
    if (!(schema.name in combo.props)) continue;
    const value = combo.props[schema.name];
    if (!value) continue;
    return {
      propName: schema.name,
      value,
      provenance: "contract",
      evidence:
        errorText ||
        `${schema.name} was synthesized truthy with no value supplied for the props it constrains`,
    };
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

    const rerenderResult = input.rerenders?.find(
      (r) => r.comboIndex === mount.comboIndex,
    );

    const rerenderTiming = rerenderResult
      ? buildTimingWithCV(rerenderResult.stable.samples)
      : buildTimingWithCV([0]);

    // M61: `__120fps_scaleN` is the harness trigger key for the sibling-copies
    // probe, not a real prop: it never belongs in the report's `props`.
    // `scaleProbe` is where that identity now lives instead.
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
      measuredState: mount.measuredState ?? "settled",
      ...(isScaleProbe ? { scaleProbe: scaleProbeValue as number } : {}),
    };

    if (rerenderResult?.change) {
      combo.rerenderChange = buildTimingWithCV(rerenderResult.change.samples);
    }

    if (inp !== undefined) {
      combo.inp = inp;
    }

    if (!input.skipAttribution && mount.mountTraces && mount.mountTraces.length > 0) {
      combo.costAttribution = attributeCost(mount.mountTraces);
    }

    // M59: mount and rerender each watched the page over their own window; the
    // combo is what the reader sees, so both windows land on it.
    const pageErrors = mergeDrains(mount.pageErrors, rerenderResult?.pageErrors);
    if (hasPageErrors(pageErrors)) {
      combo.pageErrors = renderDrain(pageErrors!);
    }
    if (combo.domNodeCount === 0) {
      // Fatal means an uncaught exception, never console.error output: React
      // and Vue log dev warnings there, and a verdict must not turn on those.
      combo.renderHealth = pageErrors?.fatal ? "error" : "empty";
    }

    combo.verdict = computeVerdict(combo, input.thresholds);
    combos.push(combo);
  }

  // M83 #1 (element-plus-F2): computed here, before the scale-probe curve fit
  // below can add more combos to reconcile against, and pushed onto
  // report.warnings once the report exists — same array every other
  // buildReport-time warning reaches, so the JSON report carries it too.
  const renderHealthInconsistencyWarning = detectRenderHealthInconsistency(combos);

  // M61: domNodeCount growth used to be fitted across every combo: mixing
  // the sibling-copies probe's real N-copies growth with whatever incidental
  // DOM differences unrelated real prop combos happened to have, then
  // stamping the result onto all of them (the GameControls fabrication:
  // r²=0.9999 "linear" scaling on two function props that never scaled
  // anything). The probe combos carry their own true independent variable
  // (scaleProbe), and only they receive the fit.
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
        // M59: the synthetic scale probe is exempt from budgets, never from
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

  // M85: a fatal crash traceable to a harness-synthesized value is not
  // charged to the component. Runs after the tier pass so it sees the same
  // verdict a reader would; only ever narrows a "fail" it can positively
  // explain, never a general crash-suppressor (see detectHarnessFault).
  for (const combo of combos) {
    if (combo.verdict !== "fail" || combo.renderHealth !== "error") continue;
    const fault = detectHarnessFault(combo, input.schemas);
    if (fault) {
      combo.harnessFault = fault;
      combo.verdict = "warn";
    }
  }

  // M85: stated directly, not just left to follow from the verdict demotion
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

  // M80: never overrides an honest renderHealth ("error"/"empty") combo —
  // that already fully discloses what happened. Only a combo that rendered
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
      // is the *timing* comparison: which environment the baseline came from
      // is a fact about the file, not about the machine's mood, so the
      // classification and its mismatch detail survive.
      if (report.noise?.level === "hostile") {
        comparison.regressions = [];
        comparison.improvements = [];
        comparison.skippedNoisy = true;
      }

      report.baseline = comparison;
      // A noisy run's regressions are reported but do not fail: the same
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
  // M80: see BuildReportInput.disclosureReason. Curve mode and isolation
  // mode compute their own pass/fail independently of buildReport and never
  // read this; only the combo/matrix path (both call buildReport) does.
  disclosureReason?: "uncomposed" | "propsExcluded";
  wrapper?: WrapperReport;
  cssReport?: CssReport;
  runWarnings: string[];
  onWarning: (warning: string) => void;
  // M65: one line per phase boundary, already silenced in CI mode.
  progress: (line: string) => void;
  getSchemas: () => Promise<PropSchema[]>;
  getSourceFingerprint: () => Promise<string>;
  attachHarnessContext: (report: Report) => void;
}

// M83 #3 (element-plus-F4): per M46's precedent (a hostile run skips baseline
// comparison entirely), a hostile run's leak signal does not unilaterally
// fail the isolation run either — this is a coupling, not a retraction: the
// raw `isolation.memory.leakSuspected: true` signal is untouched.
export const LEAK_VERDICT_NOISE_QUALIFIED_WARNING = (cvPercent: number): string =>
  `leak suspected (heap growth crossed the per-cycle threshold), but this run's machine noise was ` +
  `hostile (probe CV ${Math.round(cvPercent)}%): the FAIL this would otherwise cause is withheld ` +
  "until a quieter run confirms it.";

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

  ctx.progress(`isolation: ${phases.join(", ")}`);
  const run = await runIsolationPhases(harness, {
    phases,
    comboA: selection.comboA,
    comboB: selection.comboB,
    degenerate: selection.degenerate,
    samples: ctx.samples,
    cpuThrottle: ctx.cpuThrottle,
    memoryCycles: isolationOptions.memoryCycles ?? DEFAULT_MEMORY_CYCLES,
    pool: ctx.pool,
    // M73: font-settle and session warnings raised inside a phase reach the
    // same sink every other phase already uses.
    onWarning: ctx.onWarning,
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

  const componentName = detectComponentName(ctx.metadataPath, ctx.options.target);
  // M83 #3 (element-plus-F4): `pass` is a placeholder here — isolation-mode
  // reports always carry `combos: []`, so `attachHarnessContext`'s noise
  // computation (unstableFraction) is structurally 0 for this mode, and only
  // `probeCv` can classify the run. Computing the real verdict before that
  // classification exists means a hostile run's leak signal has no noise
  // level to check against. `report.pass` is reassigned below, after
  // attachHarnessContext has populated `report.noise`.
  const report: Report = {
    version: 1,
    timestamp: new Date().toISOString(),
    machine: ctx.machine,
    componentPath: ctx.componentPath,
    componentName,
    calibration: ctx.calibration,
    combos: [],
    thresholds,
    pass: false,
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

  report.pass = computeIsolationVerdict(run.isolation, mountBudgetMs, report.noise?.level);
  // The memory branch's FAIL was withheld because the run's own sentinel
  // called it hostile: the raw signal (isolation.memory.leakSuspected) stays
  // true in the JSON, unchanged — only the FAIL rollup is qualified, and the
  // report says why.
  if (run.isolation.memory?.leakSuspected && report.noise?.level === "hostile") {
    report.warnings = [
      ...(report.warnings ?? []),
      LEAK_VERDICT_NOISE_QUALIFIED_WARNING(report.noise.signals.probeCv),
    ];
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
        // M82: cssReport is now always constructed, even for "none" — gate on
        // files.length so a no-CSS project's fingerprint bytes stay unchanged.
        ...(ctx.cssReport && ctx.cssReport.files.length > 0 ? { css: ctx.cssReport.files } : {}),
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
  report.mode = deriveReportMode(report);
  const target = path.resolve(jsonPath ?? "120fps-report.json");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(report, mapReplacer, 2), "utf-8");
}

// The curve run activates on an explicit --curve flag or on the first
// detected scaling prop; fixtures and composed scenes never take it.
async function resolveCurveMatch(ctx: ModeContext): Promise<ScalingPropMatch | undefined> {
  const { curveMode } = ctx.options;
  if (curveMode === false) return undefined;
  // M63: a curve the user asked for and did not get must say so; auto-detection
  // that finds nothing asked for nothing.
  const explicit = curveMode === true || typeof curveMode === "object";
  if (ctx.useFixture || ctx.composed) {
    if (explicit) {
      ctx.runWarnings.push(
        CURVE_NOT_ACTIVATED_WARNING(
          ctx.useFixture ? "the run measures a fixture file" : "the run measures a composed scene",
        ),
      );
    }
    return undefined;
  }
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
  if (matches.length === 0) {
    if (explicit) {
      ctx.runWarnings.push(
        CURVE_NOT_ACTIVATED_WARNING("no array or list prop was found in the extracted schema"),
      );
    }
    return undefined;
  }
  return matches[0];
}

async function runCurveMode(ctx: ModeContext, match: ScalingPropMatch): Promise<Report> {
  const { options, harness, samples, cpuThrottle, warmupRuns, pool, onWarning, runWarnings, machine, calibration, thresholds } = ctx;
  const curveScalePoints = options.scalePoints ?? [1, 3, 5, 10, 20, 50];
  const scaleCombos = generateScalingCombos(await ctx.getSchemas(), match, curveScalePoints);

  ctx.progress(`mount: ${scaleCombos.length} scale points`);
  const curveMounts = await measureMount(harness, {
    samples,
    cpuThrottle,
    warmupRuns,
    combos: scaleCombos,
    pool,
    onWarning,
  });
  ctx.progress(`rerender: ${scaleCombos.length} scale points`);
  const curveRerenders = await measureRerender(harness, {
    samples,
    cpuThrottle,
    warmupRuns,
    combos: scaleCombos,
    animatedComboIndices: animatedIndices(curveMounts),
    pool,
    onWarning,
  });
  ctx.progress(`explore: ${scaleCombos.length} scale points`);
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
  const componentName = detectComponentName(ctx.metadataPath, ctx.options.target);

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

  // M59: a curve report has scale points, not combos, so the per-combo gate
  // cannot reach it. A point that rendered nothing while the page threw still
  // has to fail the run: every other point on the curve measured the same
  // broken render.
  const brokenPoints = curveMounts.filter(
    (m) => m.domNodeCount === 0 && m.pageErrors?.fatal,
  );
  if (brokenPoints.length > 0) {
    // M79 gap: the structural counterpart to CURVE_RENDER_ERROR_WARNING's
    // formatted string below, populated at the same point so the two never
    // drift by construction rather than by convention.
    curveReport.renderErrorPoints = brokenPoints.map((broken) => ({
      n: curveScalePoints[broken.comboIndex] ?? broken.comboIndex,
      pageErrors: renderDrain(broken.pageErrors!),
    }));
  }
  for (const broken of brokenPoints) {
    runWarnings.push(
      CURVE_RENDER_ERROR_WARNING(
        curveScalePoints[broken.comboIndex] ?? broken.comboIndex,
        renderDrain(broken.pageErrors!),
      ),
    );
  }

  const curveVerdict = computeCurveVerdict(curveReport.points, curveReport.mountCurve, thresholds);
  const pass = curveVerdict !== "fail" && brokenPoints.length === 0;

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
  let matrixCombos = generatePropMatrix(schemas);
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

  // M83 #4c (commerce-F5): an explicit --matrix bypasses shouldAutoActivateMatrix's
  // 2-axis floor entirely; a component with zero boolean/small-union props
  // still gets here and would otherwise print an unexplained "Prop Matrix ()".
  if (matrixAxes.length === 0) {
    runWarnings.push(MATRIX_NO_AXES_WARNING);
  }

  // M61: --max-combos previously did nothing once matrix mode auto-activated
  //: a 4-prop badge ran all 64 cells regardless of the flag or the implicit
  // default. The same cap (default 8) now bounds cells measured, keeping the
  // base cell and single-axis deviations first.
  const matrixComboCap = options.maxCombos ?? DEFAULT_MEASURED_COMBOS;
  if (matrixCombos.length > matrixComboCap) {
    const keptIndices = selectMatrixCombos(matrixCombos, matrixAxes, matrixComboCap);
    runWarnings.push(MATRIX_CELL_CAP_WARNING(keptIndices.length, matrixCombos.length));
    matrixCombos = keptIndices.map((i) => matrixCombos[i]);
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

  // Same cost throttle the plain-combo path applies: a forced --matrix run
  // with many cells must not skip it just because it took the matrix branch
  // instead.
  const matrixEffectiveSamples = computeEffectiveSamples(matrixCombos.length, samples);
  if (matrixEffectiveSamples < samples) {
    runWarnings.push(
      EFFECTIVE_SAMPLES_WARNING(matrixEffectiveSamples, samples, matrixCombos.length),
    );
  }

  ctx.progress(`mount: ${matrixCombos.length} matrix cells`);
  const matrixMounts = await measureMount(harness, {
    samples: matrixEffectiveSamples,
    cpuThrottle,
    warmupRuns,
    combos: matrixCombos,
    pool,
    onWarning,
  });
  ctx.progress(`rerender: ${matrixCombos.length} matrix cells`);
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
  if (hotCombos.length > 0) ctx.progress(`explore: ${hotCombos.length} hottest cells`);
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
  const componentName = detectComponentName(ctx.metadataPath, ctx.options.target);
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
    ...(schemas ? { schemas } : {}),
    ...(ctx.disclosureReason !== undefined ? { disclosureReason: ctx.disclosureReason } : {}),
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
    // M89 gap (taxonomy control failure): measureMount/measureRerender tag
    // their own thrown errors "mount"/"rerender" (measure.ts), which caps
    // any stall hint at --no-attribution regardless of who called them —
    // wrong here, since this pass never runs attribution tracing at all.
    // retagPhaseError re-enriches the untagged original cause under "delta"
    // so the hint names the flag that actually skips this code path.
    const deltaPhaseContext = { phase: "delta" as const, component: path.basename(harness.componentPath) };
    let extraMounts: MountResult[];
    try {
      extraMounts = await measureMount(harness, {
        samples: effectiveSamples,
        cpuThrottle,
        warmupRuns,
        combos: needed,
        pool,
        onWarning,
      });
    } catch (err) {
      throw retagPhaseError(err, deltaPhaseContext);
    }
    let extraRerenders: RerenderResult[];
    try {
      extraRerenders = await measureRerender(harness, {
        samples: effectiveSamples,
        cpuThrottle,
        warmupRuns,
        combos: needed,
        animatedComboIndices: animatedIndices(extraMounts),
        pool,
        onWarning,
      });
    } catch (err) {
      throw retagPhaseError(err, deltaPhaseContext);
    }
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

  // M61: the sibling-copies probe already carries its own scale-probe curve
  // (buildReport): overwriting it here with the real detected-prop curve
  // would silently replace a synthetic-copies fact with an unrelated one
  // under the same field. Only combos that are not scale probes take this
  // curve.
  if (mountPoints.length >= 2) {
    const curve = computeScalingCurve(mountPoints);
    for (const combo of report.combos) {
      if (combo.scaleProbe === undefined) combo.scalingCurve = curve;
    }
  }
  if (rerenderPoints.length >= 2) {
    const rerenderCurve = computeScalingCurve(rerenderPoints);
    for (const combo of report.combos) {
      if (combo.scaleProbe === undefined) combo.rerenderScalingCurve = rerenderCurve;
    }
  }

  if (isDomFlat(scaleMounts.map((m) => ({ n: scalePoints[m.comboIndex], domNodeCount: m.domNodeCount })))) {
    runWarnings.push(SCALING_NO_EFFECT_WARNING(match.schema.name));
  }

  report.autoScalingProp = match.schema.name;
  report.autoScalingReason = match.reason;
}

// M61: measures the cheapest requested scale point alone (3 samples: a
// go/no-go check, not a reported number) and applies the pure gate to decide
// whether the rest are worth measuring. The cheapest point is remeasured
// inside the main batch rather than spliced in: measureMount assigns
// comboIndex by array position, and every downstream pass (measureRerender,
// explore, runReactAnalysis) relies on that, so this keeps one array owned
// end to end instead of reshuffling a spliced result into it. The remeasure
// costs one extra small mount, bounded by construction since it is the
// cheapest of the requested points.
async function gateScalePoints(
  ctx: Pick<ModeContext, "harness" | "cpuThrottle" | "warmupRuns" | "pool" | "onWarning" | "samples">,
  scalePoints: number[],
): Promise<{ points: number[]; warning?: string }> {
  if (scalePoints.length <= 1) return { points: scalePoints };
  const { harness, cpuThrottle, warmupRuns, pool, onWarning, samples } = ctx;
  const probeN = Math.min(...scalePoints);
  const [probe] = await measureMount(harness, {
    samples: Math.min(3, samples),
    cpuThrottle,
    warmupRuns,
    combos: [{ __120fps_scaleN: probeN }],
    pool,
    onWarning,
  });
  if (!probe) return { points: scalePoints };
  const { points, skipped } = boundScalePointsByProbeCost(scalePoints, probe.mount.median);
  if (skipped.length === 0) return { points };
  return { points, warning: SCALE_PROBE_COST_WARNING(probeN, probe.mount.median, skipped) };
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
    const gated = await gateScalePoints(ctx, scalePoints);
    if (gated.warning) runWarnings.push(gated.warning);
    combos = gated.points.map((n) => ({ __120fps_scaleN: n }));
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
    const gated = await gateScalePoints(ctx, scalePoints);
    if (gated.warning) runWarnings.push(gated.warning);
    const scaleCombos = gated.points.map((n) => ({ __120fps_scaleN: n }));
    combos = [...combos, ...scaleCombos];
  }

  const effectiveSamples = computeEffectiveSamples(combos.length, samples);
  if (effectiveSamples < samples) {
    runWarnings.push(EFFECTIVE_SAMPLES_WARNING(effectiveSamples, samples, combos.length));
  }

  ctx.progress(`mount: ${combos.length} combos x ${effectiveSamples} samples`);
  const mounts = await measureMount(harness, {
    samples: effectiveSamples,
    cpuThrottle,
    warmupRuns,
    combos,
    pool,
    onWarning,
  });

  const heapDeltas: number[] = mounts.map((m) => m.heapDelta ?? 0);

  ctx.progress(`rerender: ${combos.length} combos`);
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
  ctx.progress(
    `explore: ${exploreCombos.length} combos, budget ${Math.round(exploreWallClockPerCombo / 1000)}s each`,
  );
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
    ctx.progress("prop deltas");
    propDeltas = await measureStandardPropDeltas(ctx, schemas, mounts, rerenders, effectiveSamples);
  }

  const componentName = detectComponentName(ctx.metadataPath, ctx.options.target);

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
    ...(schemas ? { schemas } : {}),
    ...(ctx.disclosureReason !== undefined ? { disclosureReason: ctx.disclosureReason } : {}),
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

  // M92 (element-plus-F3): a zero-prop count already explained by a Vue
  // scope-exclusion disclosure ("declares props through ... a runtime form
  // ADR 0002 deliberately does not read") must not also get the generic
  // "extraction may have failed" text stacked on top -- that phrase floats a
  // possible malfunction the run already knows is not what happened.
  if (zeroPropsExtracted && ctx.disclosureReason !== "propsExcluded") {
    report.warnings = [...(report.warnings ?? []), ZERO_PROPS_WARNING];
  }

  if (ctx.wrapper) attachWrapperReport(report, ctx.wrapper);
  ctx.attachHarnessContext(report);

  if (propDeltas) {
    report.propDeltas = propDeltas;
  }

  if (!fixtureHasScale && !useFixture && !composed && !options.skipAutoScale && schemas && schemas.length > 0) {
    ctx.progress("scaling curves");
    await applyAutoScalingCurves(ctx, report, schemas);
  }

  // --- React optimization detection (separate pass) ---
  // M57: `ctx.framework` already folds the flag, the manifest and the measured
  // file's own type together. A Vue run never reaches this and never carries a
  // ReactOptimizations block.
  const shouldRunReact = !options.skipReactAnalysis && ctx.framework === "react";

  if (shouldRunReact) {
    ctx.progress("react analysis");
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
      // M70: this pass runs after ctx.attachHarnessContext(report) already
      // flushed runWarnings into report.warnings above, so routing through
      // the shared onWarning would push into an array nothing reads again.
      // Writing straight onto the already-built report is order-independent.
      onWarning: (warning) => {
        if (!(report.warnings ?? []).includes(warning)) {
          report.warnings = [...(report.warnings ?? []), warning];
        }
      },
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
    // M82: cssReport is now always constructed, even for "none" — gate on
    // files.length so a no-CSS project's fingerprint bytes stay unchanged.
    ...(ctx.cssReport && ctx.cssReport.files.length > 0 ? { css: ctx.cssReport.files } : {}),
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

  ctx.progress("report");
  writeReportJson(report, options.jsonPath);

  return report;
}

// M58: the report names the component the harness imports and renders, so both
// read the same resolver. The filename fallback lives inside it.
export function detectComponentName(componentPath: string, target?: string): string {
  return detectComponentExport(componentPath, target).name;
}

const JSX_COMPOSED_CHILD_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

// Plain extension-probe resolution for an already-resolved (extensionless)
// candidate base path.
function resolveJsxChildCandidates(base: string): string | undefined {
  const candidates = [
    ...JSX_COMPOSED_CHILD_EXTENSIONS.map((ext) => base + ext),
    ...JSX_COMPOSED_CHILD_EXTENSIONS.map((ext) => path.join(base, "index" + ext)),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

// M91 (commerce-F3) / M92: a relative specifier resolves against the
// importing file's own directory by plain extension probing. A bare
// specifier -- commerce's real app/page.tsx composes its async children as
// baseUrl-relative bare specifiers ("components/carousel", no leading "./"),
// which the old dot-prefix check excluded outright, so the one-hop walk
// found zero composed children for exactly the file it exists to cover --
// resolves through the same tsconfig baseUrl/paths machinery runPreflight's
// own import-graph walk already uses (ts.resolveModuleName), not a string
// match on a leading dot. A bare specifier that resolves into node_modules
// is a real dependency, not a local composed child, and is excluded exactly
// like the rest of the graph walk excludes package internals.
function resolveRelativeJsxChild(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return resolveJsxChildCandidates(path.resolve(path.dirname(fromFile), specifier));
  }
  const compilerOptions = projectCompilerOptions(fromFile);
  const resolved = ts.resolveModuleName(specifier, fromFile, compilerOptions, ts.sys).resolvedModule;
  if (!resolved) return undefined;
  const target = path.normalize(resolved.resolvedFileName);
  if (resolved.isExternalLibraryImport || /[\\/]node_modules[\\/]/.test(target)) return undefined;
  return fs.existsSync(target) ? target : undefined;
}

// M91 (commerce-F3): runPreflight's async-component check only inspects
// entries[0] — a sync component whose JSX composes an async server
// component one hop away is invisible to it. Reused unmodified (Lane A's
// file, src/preflight.ts): each JSX-composed local import gets its own
// preflight pass, entries[0] set to the child, reproducing exactly the
// rejection a direct `120fps ./child.tsx` invocation already produces
// correctly. Only hard hits are merged back — soft/transform/provider
// signals one hop into a child's own graph are not this milestone's concern.
function composedChildPreflightHits(
  targetFile: string,
  projectRoot: string,
): import("./preflight.js").PreflightHit[] {
  if (isVueFile(targetFile)) return [];
  let sourceText: string;
  try {
    sourceText = fs.readFileSync(targetFile, "utf-8");
  } catch {
    return [];
  }
  const composed = scanJsxComposedLocalImports(sourceText, targetFile);
  if (composed.length === 0) return [];

  const targetRel = path.relative(projectRoot, targetFile).replace(/\\/g, "/");
  const hits: import("./preflight.js").PreflightHit[] = [];
  for (const { specifier } of composed) {
    const resolved = resolveRelativeJsxChild(targetFile, specifier);
    if (!resolved || isVueFile(resolved)) continue;
    const childName = detectComponentExport(resolved).name;
    const childResult = runPreflight({ projectRoot, entries: [resolved], componentName: childName });
    for (const hit of childResult.hard) {
      hits.push({ ...hit, chain: [targetRel, ...hit.chain] });
    }
  }
  return hits;
}

// --- M65 C1: --explain-props ---------------------------------------------

export interface ExplainedProp {
  name: string;
  kind: PropSchema["kind"];
  required: boolean;
  values: unknown[];
  degenerate?: string;
}

export interface PropsExplanation {
  componentPath: string;
  componentName: string;
  target?: string;
  // projectRoot-relative posix path, and the 1-based line of the declaration
  // the schema bound to. Absent for a Vue SFC and for a file with no component.
  bindingFile?: string;
  bindingLine?: number;
  exports: string[];
  props: ExplainedProp[];
  curve?: { propName: string; reason: string };
  matrixWouldActivate: boolean;
  // M83 #5 (base-ui-F6): the "Curve mode: would (not) activate" line only
  // predicts detectScalingProps's whole-run auto-activation. The M61
  // sibling-copies scale probe is a separate, unconditional mechanism
  // appended to every default combo-mode run for a non-fixture target with
  // no curve match — this predicts *that*, so the dry run's stated mode
  // matches what a real run on the same target would actually do.
  scaleProbeWillRun: boolean;
  presetPath?: string;
  warnings: string[];
}

// The same resolution the pipeline performs, stopped before its first side
// effect: no harness directory, no dev server, no browser, no report file.
export async function explainProps(
  componentPath: string,
  options: { target?: string; noPreflight?: boolean } = {},
): Promise<PropsExplanation> {
  const resolvedPath = path.resolve(componentPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Component file not found: ${componentPath}`);
  }

  const { projectRoot } = resolveProjectPaths(resolvedPath);
  const componentName = detectComponentExport(resolvedPath, options.target).name;

  const warnings: string[] = [];

  // M91 (preact-app-F2): computed here, in the same order the full run
  // computes them, so a dry run's warnings are the same set a real run would
  // print for everything decidable without a browser. All four resolvers
  // are read-only filesystem probes (existing detection functions the full
  // run already calls) with no build/browser cost, so this function's own
  // "no side effect" contract (no harness dir, no dev server, no browser) is
  // unaffected.
  const framework = resolveFramework("auto", projectRoot, resolvedPath, (w) => warnings.push(w));
  resolveCssFiles({}, projectRoot, warnings);
  resolveWrapPath({}, projectRoot, framework, warnings);
  // M92/M95 (nuxt-ui-F2): the full run's harness build always calls this
  // (src/harness.ts:2464) and its TSCONFIG_EXTENDS_BROKEN_WARNING is what
  // connects a broken `extends` chain to the empty prop schema it causes; a
  // dry run never called it at all, so nuxt-ui's --explain-props reported "0
  // props" on every candidate with no cause named while the full run (once
  // it got far enough) correctly joined the two. extractPropsDetailed below
  // uses a separate, checker-only tsconfig read (src/prop-gen.ts) that never
  // saw this diagnostic either.
  loadTsconfigAliases(projectRoot, warnings);

  // M78: the comment at this function's cli.ts call site has always promised
  // "before every check that exists to protect a measurement, because it
  // never starts one" — this call is what makes that true. Same gate order
  // buildAndServe uses: preflight's graph-walk hard-hits first (bypassable
  // via --no-preflight), then the always-on react-dom gate, at zero build
  // cost (no harness dir, no dev server), matching this function's own
  // "measures nothing" contract.
  const preflight = runPreflight({ projectRoot, entries: [resolvedPath], componentName });
  // M91 (commerce-F3): folded in before the hard/soft handling below runs,
  // so a one-hop-composed async server component gates identically here and
  // in the full run.
  preflight.hard.push(...composedChildPreflightHits(resolvedPath, projectRoot));
  for (const hit of preflight.soft) warnings.push(NODE_BUILTIN_WARNING(hit));
  if (preflight.hard.length > 0) {
    if (options.noPreflight) warnings.push(PREFLIGHT_BYPASSED_WARNING(preflight.hard));
    else throw new Error(preflightFailureMessage(preflight.hard));
  }
  if (rendererFor(resolvedPath) === "react") {
    const bundlerAlias = detectBundlerReactDomAlias(projectRoot);
    if (bundlerAlias) {
      warnings.push(BUNDLER_PREACT_ALIAS_WARNING(bundlerAlias.configFile, bundlerAlias.target));
    }
    // M91 (preact-app-F2): the alias warning above must be computed and
    // pushed before this call, not after — assertReactDomClient throws
    // before a dry run ever reaches a later check, so the old ordering
    // (assert first, alias second) meant the alias note was never seen
    // whenever the version gate itself also failed, exactly preact-app's
    // repro. Wrapped so the throw still carries every warning collected so
    // far, matching the full run's own accumulated-warnings behavior.
    try {
      assertReactDomClient(projectRoot);
    } catch (err) {
      if (err instanceof Error) {
        throw new Error(err.message + formatAccumulatedWarnings(warnings), { cause: err });
      }
      throw err;
    }
  }

  const detail = await extractPropsDetailed(resolvedPath, {
    ...(options.target ? { target: options.target } : {}),
    // A sink, not stderr: a dry run prints its diagnostics in its own output.
    onWarning: () => {},
  });
  warnings.push(...detail.warnings);

  let schemas = detail.schemas;
  const presetPath = detectPropPresets(resolvedPath);
  const presets = presetPath ? loadPropPresets(presetPath, projectRoot) : undefined;
  if (presets) {
    const applied = applyPropPresets(schemas, presets);
    schemas = applied.schemas;
    if (applied.unknown.length > 0) {
      warnings.push(UNKNOWN_PRESET_PROPS_WARNING(presets.path, applied.unknown));
    }
  }
  // M92 (element-plus-F3): same suppression as runComboMode -- a zero-prop
  // count `detail.warnings` already attributes to a Vue scope exclusion does
  // not also get the generic "extraction may have failed" text.
  if (schemas.length === 0 && !detail.warnings.some(isVuePropsScopeExclusionWarning)) {
    warnings.push(ZERO_PROPS_WARNING);
  }

  const exports = isVueFile(resolvedPath)
    ? [componentName]
    : (await extractExports(resolvedPath)).map((e) => e.name);
  const curveMatch = detectScalingProps(schemas)[0];

  // M83 #8 (chakra-ui-F7): detectComponentExport resolving to the file's own
  // marked `export default` is correct by JS/TS export semantics, not a bug
  // (Chakra's own authoring choice) — no change to *which* export is picked.
  // Only the escape hatch was undisclosed: when the resolved export carries a
  // degenerate-flagged required prop (M60) and an unpicked export in the same
  // file has an all-non-degenerate schema, name it and its #ExportName
  // override.
  if (!options.target && exports.length > 1 && schemas.some((s) => s.required && s.degenerate)) {
    for (const altName of exports) {
      if (altName === componentName) continue;
      let altSchemas: PropSchema[];
      try {
        altSchemas = await extractProps(resolvedPath, { target: altName, onWarning: () => {} });
      } catch {
        continue; // not every export is a component; skip ones extraction rejects
      }
      if (altSchemas.length > 0 && altSchemas.every((s) => !s.degenerate)) {
        warnings.push(ALTERNATIVE_EXPORT_WITHOUT_DEGENERATE_PROPS_NOTE(componentName, altName));
        break;
      }
    }
  }

  return {
    componentPath,
    componentName,
    ...(options.target ? { target: options.target } : {}),
    ...(detail.targetLine !== undefined
      ? {
          bindingFile: path.relative(projectRoot, resolvedPath).replace(/\\/g, "/"),
          bindingLine: detail.targetLine,
        }
      : {}),
    exports,
    props: schemas.map((s) => ({
      name: s.name,
      kind: s.kind,
      required: s.required,
      values: s.values,
      ...(s.degenerate ? { degenerate: s.degenerate } : {}),
    })),
    ...(curveMatch
      ? { curve: { propName: curveMatch.schema.name, reason: curveMatch.reason } }
      : {}),
    // M83 #5: the same gating condition runComboMode's non-curve, non-fixture
    // branch uses. Accurate for the common case this predicts; an
    // auto-composed scene is not cheaply detectable inside a dry run's scope,
    // so this may be imprecise for that shape — an accepted, stated limit,
    // not silently glossed over.
    scaleProbeWillRun: !isFixturePath(resolvedPath) && !curveMatch,
    matrixWouldActivate: shouldAutoActivateMatrix(schemas),
    ...(presets ? { presetPath: presets.path } : {}),
    warnings,
  };
}

const EXPLAIN_VALUE_CAP = 4;
const EXPLAIN_VALUE_WIDTH = 40;

function explainValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "function") return "[Function]";
  // M92 (1.5d, heroui): a preset pool's non-literal entry (a function/JSX/
  // variable reference, which cannot cross the CDP boundary) is stored as a
  // PresetRef sentinel -- {__120fps_preset, index} -- resolved from the real
  // preset module only at render time inside the browser. A dry run has no
  // browser to resolve it against, so the real value genuinely is not known
  // here; the internal marker itself must never be the displayed value in
  // its place, matching the [Function] convention just above.
  if (isPresetRef(value)) return "[preset value]";
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > EXPLAIN_VALUE_WIDTH
    ? text.slice(0, EXPLAIN_VALUE_WIDTH - 1) + "…"
    : text;
}

function explainValues(values: unknown[]): string {
  if (values.length === 0) return "(no values)";
  const shown = values.slice(0, EXPLAIN_VALUE_CAP).map(explainValue).join(", ");
  const rest = values.length - Math.min(values.length, EXPLAIN_VALUE_CAP);
  return rest > 0 ? `${shown}, +${rest} more` : shown;
}

export function formatExplainProps(explained: PropsExplanation): string {
  const lines: string[] = [];
  lines.push(`Component: ${explained.componentName}`);
  lines.push(`  file:     ${explained.componentPath}`);
  if (explained.target) lines.push(`  target:   ${explained.target} (explicit #Export)`);
  lines.push(
    explained.bindingLine !== undefined
      ? `  binding:  ${explained.bindingFile}:${explained.bindingLine}`
      : "  binding:  no component declaration (props read from the file itself)",
  );
  lines.push(
    `  exports:  ${explained.exports.length > 0 ? explained.exports.join(", ") : "(none)"}`,
  );
  if (explained.presetPath) lines.push(`  presets:  ${explained.presetPath}`);

  lines.push("");
  lines.push(`Props (${explained.props.length}):`);
  if (explained.props.length === 0) {
    lines.push("  (none extracted)");
  } else {
    const nameWidth = Math.max(...explained.props.map((p) => p.name.length));
    const kindWidth = Math.max(...explained.props.map((p) => p.kind.length));
    for (const prop of explained.props) {
      const required = prop.required ? "required" : "optional";
      let line = `  ${prop.name.padEnd(nameWidth)}  ${prop.kind.padEnd(kindWidth)}  ${required}  ${explainValues(prop.values)}`;
      if (prop.degenerate) line += `  [degenerate: ${prop.degenerate}]`;
      lines.push(line);
    }
  }

  lines.push("");
  lines.push(
    explained.curve
      ? `Curve mode:   would activate on ${explained.curve.propName} (${explained.curve.reason})`
      : "Curve mode:   would not activate: no array or numeric scaling prop",
  );
  // M83 #5 (base-ui-F6): a separate mechanism from curve mode above — the M61
  // sibling-copies scale probe runs unconditionally on a non-fixture target
  // whenever curve mode does not, regardless of whether the component has
  // any array/numeric prop at all.
  if (explained.scaleProbeWillRun) {
    lines.push(
      "Scale probe:  would still run N=1/5/20/50 synthetic copies and report a growth class, " +
      "independent of curve mode",
    );
  }
  lines.push(
    explained.matrixWouldActivate
      ? "Matrix mode:  would auto-activate"
      : "Matrix mode:  would not auto-activate",
  );

  if (explained.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of explained.warnings) lines.push(`  ${warning}`);
  }

  lines.push("");
  lines.push("Dry run: nothing was measured, no report was written.");
  return lines.join("\n");
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
// measuring. Explicit mode enables always measure: auto-activation is a
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

  // Machine identity only: no page, no calibration. A single calibration
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
    // gate and the run measures: reuse errs towards measuring, never towards
    // a mismatched verdict.
    samples: args.samples,
    mode: "combo",
    framework: args.framework,
    // M82: cssReport is now always constructed, even for "none" — gate on
    // files.length so a no-CSS project's fingerprint bytes stay unchanged.
    ...(args.cssReport && args.cssReport.files.length > 0 ? { css: args.cssReport.files } : {}),
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
    componentName: detectComponentName(args.metadataPath, args.options.target),
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

// M79 (1b): generalizes the old transformHits-only special case. Every
// warning already computed by the time of a throw is worth as much on the
// way out as it would have been in a successful report — a
// preprocessor-config-ignored or unsupported-style-engine warning explains a
// crash the bare error message alone would not. Module-level (not a closure
// inside analyze()) so M91's explainProps can reuse the identical format for
// its own dry-run parity fix. Exported (Item A, M90 follow-up) so cli.ts's
// surface-3 (async unhandledRejection) handler can build the identical
// block from the warnings it independently accumulated via
// AnalyzeOptions.onWarning, instead of duplicating the wording.
export function formatAccumulatedWarnings(warnings: string[]): string {
  return ["", "", "Warnings recorded before this failure:", ...warnings.map((w) => `  ${w}`)].join("\n");
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

  const progress = resolveProgressReporter(options);

  let fixturePath: string | undefined = options.fixturePath;
  let fixtureAutoDetected = false;
  const inputIsFixture = isFixturePath(componentPath);

  // M65: `<file>#Export` names one export to render, so a fixture: which owns
  // its whole scene: cannot also apply. Validated here, before any harness
  // directory exists, so a typo costs a source read rather than a boot.
  if (options.target) {
    if (options.fixturePath || inputIsFixture) throw new Error(TARGET_WITH_FIXTURE_ERROR);
    detectComponentExport(resolvedPath, options.target);
  }

  if (inputIsFixture) {
    fixturePath = componentPath;
  } else if (!fixturePath && !options.target) {
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
  // infer: auto-composition is skipped for Vue, not adapted to it. Reached
  // only when no fixture applies, so the measured file is componentPath.
  const rendererIsVue = isVueFile(componentPath);

  let compositionTree: CompositionTree | undefined;
  let componentExports: import("./composition.js").ExportInfo[] | undefined;
  // M80: set when a run's combos measured less than the whole component
  // (radix's dual-family/bare-alias shape, base-ui's cross-file parts, or
  // Vue's Options-API prop exclusion). Held locally until `runWarnings`
  // exists (it is declared further down this function) because the check
  // below can fire before that point.
  let disclosureReason: "uncomposed" | "propsExcluded" | undefined;
  let uncomposedWarning: string | undefined;
  // M65: an explicit target names the one export to render, which is the
  // opposite of inferring a scene from several.
  if (!fixturePath && !inputIsFixture && !options.skipAutoCompose && !rendererIsVue && !options.target) {
    componentExports = await extractExports(resolvedPath);
    if (componentExports.length > 1) {
      const allSchemas = await extractAllProps(resolvedPath);
      const tree = inferComposition(componentExports, allSchemas);
      if (tree) compositionTree = tree;
    }
    // M80: composition either never attempted (a single-export file, e.g.
    // base-ui's TabsRoot.tsx) or attempted and failed to find a root (radix's
    // dual prefixed/bare-alias shape defeats findRoot's prefix check). Either
    // way the run is about to measure the bare export alone; check whether
    // the file itself still declares recognized sibling parts.
    if (!compositionTree) {
      const boundName = detectComponentExport(resolvedPath, options.target).name;
      const typeImportNames = await extractRelativeTypeImports(resolvedPath);
      const siblingExports = componentExports.filter((e) => e.name !== boundName);
      const siblings = declaredCompositionSiblings(boundName, siblingExports, typeImportNames);
      if (siblings.length > 0) {
        disclosureReason = "uncomposed";
        uncomposedWarning = UNCOMPOSED_SIBLINGS_WARNING(boundName, siblings.map((s) => s.name));
      }
    }
  }

  const useFixture = fixturePath !== undefined;
  const useComposition = compositionTree !== undefined;
  const harnessPath = useFixture ? fixturePath! : componentPath;
  const metadataPath = inputIsFixture ? componentPath : resolvedPath;

  const { projectRoot, relativeComponent } = resolveProjectPaths(resolvedPath);
  // M57: resolved before the wrapper, because a Vue project's wrapper is an SFC
  // and a `.tsx` one left lying around could not render the component at all.
  // Collected before the run's warning list exists; folded into it below.
  const frameworkWarnings: string[] = [];
  const framework = resolveFramework(options.framework ?? "auto", projectRoot, harnessPath, (w) =>
    frameworkWarnings.push(w),
  );
  // M76: what the wrapper probe had to fall back to, folded into the run's
  // warnings below alongside frameworkWarnings and cssWarnings.
  const wrapWarnings: string[] = [];
  const { wrapPath, wrapAutoDetected } = resolveWrapPath(options, projectRoot, framework, wrapWarnings);
  // M71: what discovery had to guess at, folded into the run's warnings below.
  const cssWarnings: string[] = [];
  const resolvedCss = resolveCssFiles(options, projectRoot, cssWarnings);
  // M82: always constructed, even for "none" — the fingerprint call sites
  // below guard on files.length so a no-CSS project's fingerprint bytes stay
  // unchanged despite cssReport no longer being undefined for that case.
  const cssReport: CssReport = {
    files: resolvedCss.files.map((f) => path.relative(projectRoot, f).replace(/\\/g, "/")),
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
        file: path.relative(projectRoot, f).replace(/\\/g, "/"),
        bytes,
        rules: stylesheetRuleCount(f),
      };
    }),
    ...(resolvedCss.runtimeEngines !== undefined ? { runtimeEngines: resolvedCss.runtimeEngines } : {}),
    ...(resolvedCss.onlyCandidate !== undefined ? { onlyCandidate: resolvedCss.onlyCandidate } : {}),
    ...(resolvedCss.noEntryInPackage !== undefined
      ? { noEntryInPackage: resolvedCss.noEntryInPackage }
      : {}),
  };
  // M90 (ant-design-F6, dub-F3, nuxt-ui-F4, mantine-F5, calcom-F6,
  // shadcn-ui-F3): computed once, right where the decision is made, so it
  // survives any later throw regardless of where in the pipeline it lands.
  // Deliberately kept out of `runWarnings`/`cssWarnings` (which become
  // `report.warnings` on a successful run): the decision already has its own
  // dedicated `Stylesheets:` line there, and folding this in too would print
  // it twice. It is threaded only into the crash-path catch below.
  const cssDecisionWarning = formatStylesheetsLine(cssReport);
  // Item A (ant-design-F5/F7/F9 follow-up): mirrored out immediately, same
  // reasoning as the internal `onWarning` closure below -- a surface-3 async
  // rejection needs this available before this function's own local catch
  // ever gets a chance to build `combined`, since that catch's stack frame
  // is exactly what a detached rejection never reaches.
  options.onWarning?.(cssDecisionWarning);
  // M44: a fixture already owns its scene, so presets never apply there.
  const presetPath = useFixture ? undefined : detectPropPresets(resolvedPath);
  const presets = presetPath ? loadPropPresets(presetPath, projectRoot) : undefined;

  // M65: provider-dependent imports found by the preflight walk.
  let providerCandidates: string[] = [];
  // M92 gap 3: the subset of providerCandidates reached only transitively --
  // see isDirectProviderHit (src/preflight.ts) and report.ts's own comment.
  let transitiveProviderCandidates: string[] = [];
  // M48: kept outside the try so a failure on the way out can still name them.
  let transformHits: import("./preflight.js").PreflightHit[] = [];
  let activeTransforms: string[] | undefined;
  const runWarnings: string[] = [
    ...frameworkWarnings,
    ...cssWarnings,
    ...wrapWarnings,
    ...(uncomposedWarning ? [uncomposedWarning] : []),
  ];
  // M46: counted before dedup: one surviving reload is a noise signal, and the
  // warning list deliberately shows it once however often it happened.
  let contextRetries = 0;
  let noiseProbe: number[] = [];
  const onWarning = (warning: string): void => {
    if (warning === CONTEXT_RETRY_WARNING) contextRetries++;
    // Deduped: a reload during a 27-combo run would otherwise print 27 times.
    if (!runWarnings.includes(warning)) {
      runWarnings.push(warning);
      // M90/Item A: mirrors the warning out to a caller-supplied sink as it
      // is discovered, not only at the end -- a fire-and-forget async
      // rejection (surface 3, cli.ts's unhandledRejection handler) can crash
      // this run's promise chain from outside this closure entirely, after
      // this point has already run but before this function ever returns
      // (or throws) normally. That handler has no other way to see anything
      // accumulated here: it runs on a separate call stack with no access to
      // this closure's locals.
      options.onWarning?.(warning);
    }
  };

  // Preset values replace a prop's pool everywhere schemas are read, so combos,
  // deltas, matrix cells and curve anchors all measure the same data.
  const presetApplied = new Set<string>();
  const extractSchemas = async (file: string): Promise<PropSchema[]> => {
    // M80 scope 2: extractPropsDetailed's warnings (not just the Vue one)
    // used to be dropped on this, the real measurement path, even though
    // --explain-props's extractPropsDetailed call already passed onWarning.
    // M92 (element-plus-F3): covers both Vue scope exclusions ADR 0002
    // defines -- Options-API props and a <script setup> runtime-object
    // defineProps({...}) call -- so either one downgrades to the same
    // disclosure instead of the generic "extraction may have failed" text.
    let sawPropsScopeExclusion = false;
    const raw = await extractProps(file, {
      ...(options.target ? { target: options.target } : {}),
      onWarning: (warning) => {
        if (isVuePropsScopeExclusionWarning(warning)) sawPropsScopeExclusion = true;
        onWarning(warning);
      },
    });
    // The producer for BuildReportInput.disclosureReason's "propsExcluded"
    // value (M80 scope 1 built the downgrade; nothing produced this value
    // until now). `disclosureReason` is untouched by the auto-composition
    // guard above for a Vue run (rendererIsVue skips it entirely), so this is
    // the only place a Vue run can set it.
    if (raw.length === 0 && sawPropsScopeExclusion && disclosureReason === undefined) {
      disclosureReason = "propsExcluded";
    }
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
  // M89 defect 3: a thunk, not a frozen value -- `resolvedCss.files`/
  // `cssReport.files` can still change after this point (a stylesheet
  // dropped mid-run because it could not be read), and a verdict cached or
  // saved under a fingerprint that still names the dropped file would be
  // indistinguishable from one measured with it. Read fresh on every actual
  // (non-memoized) call instead of captured once here.
  const buildFingerprintConfig = (): string =>
    JSON.stringify({
      // M48: a transform changes the code that gets measured, exactly like the
      // React Compiler does, so it belongs in the identity of a cached verdict.
      transforms: options.noTransforms ? [] : detectProjectTransforms(projectRoot).map((t) => t.code),
      css: cssReport?.files ?? [],
      wrap: wrapPath ? path.relative(projectRoot, wrapPath).replace(/\\/g, "/") : null,
      reactCompiler: options.reactCompiler ?? "auto",
      // Only present when targeted, so an untargeted run's fingerprint: and
      // every baseline already stored against it: is byte-identical.
      ...(options.target ? { target: options.target } : {}),
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
    extras.push(...projectConfigFingerprintFiles(projectRoot));
    fingerprintValue = computeSourceFingerprint(
      projectRoot,
      [...graph, ...extras],
      buildFingerprintConfig(),
    );
    return fingerprintValue;
  };

  const attachHarnessContext = (report: Report): void => {
    if (runWarnings.length > 0) {
      report.warnings = [...(report.warnings ?? []), ...runWarnings];
    }
    if (cssReport) report.css = cssReport;

    // M65: a static import is not a finding. It becomes one only once a render
    // actually failed, which is what keeps a healthy run's report unchanged.
    if (providerCandidates.length > 0 && renderFailed(report)) {
      report.providerCandidates = providerCandidates;
      // M92 gap 3: additive, only when there is at least one -- a report
      // whose every candidate is direct stays exactly as it printed before.
      if (transitiveProviderCandidates.length > 0) {
        report.transitiveProviderCandidates = transitiveProviderCandidates;
      }
    }

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
    progress("preflight: walking the import graph");
    const preflight = runPreflight({
      projectRoot,
      entries: [harnessPath, ...(wrapPath ? [wrapPath] : [])],
      // The export the entry actually mounts, not the display name.
      componentName: detectComponentExport(harnessPath, options.target).name,
      ...(vueCompiler ? { vueCompiler } : {}),
    });
    // M91 (commerce-F3): folded in before the hard-hit check below runs, so
    // a sync component whose JSX composes an async server component one hop
    // away gates identically to targeting that child directly.
    preflight.hard.push(...composedChildPreflightHits(harnessPath, projectRoot));
    // M92 (dub button.tsx): entries above is [harnessPath, wrapPath?] -- see
    // providersFromEntry's own comment (src/preflight.ts) for why a hit
    // discovered only through the wrapper is excluded here rather than
    // mislabeled as something the component imports.
    const componentEntryRelative = path
      .relative(projectRoot, path.resolve(harnessPath))
      .replace(/\\/g, "/");
    const componentOwnProviders = providersFromEntry(preflight.providers, componentEntryRelative);
    // M65: recorded now, published only if a combo actually fails to render.
    providerCandidates = providerCandidateLabels(componentOwnProviders);
    // M92 gap 3: the same labels, restricted to hits reached only
    // transitively -- providerCandidateLabels' own dedup runs independently
    // over this filtered subset, so a label present in both arrays is
    // byte-identical between them (hints.ts matches by exact string).
    transitiveProviderCandidates = providerCandidateLabels(
      componentOwnProviders.filter((hit) => !isDirectProviderHit(hit)),
    );
    for (const hit of preflight.soft) runWarnings.push(NODE_BUILTIN_WARNING(hit));

    // M48: only warn about transforms the harness will not apply. A project
    // whose plugin is on the supported list and installed gets it loaded, and
    // crying wolf about a transform that worked is worse than silence.
    const loadableTransforms = new Set(
      (options.noTransforms ? [] : detectProjectTransforms(projectRoot)).map((t) => t.code),
    );
    // M79 (twenty-F3, half 2): a css-preprocessor hit fires unconditionally
    // (recognizeTransform performs no availability check by design). Vite's
    // own CSS pipeline resolves sass/less/stylus directly, so an installed
    // preprocessor needs no warning at all, and a declared-but-uninstalled
    // one needs different wording than the genuinely-neither case.
    const preprocessorWorkspaceRoot = findWorkspaceRoot(projectRoot);
    const candidateTransformHits = preflight.transforms
      .filter((hit) => !hit.transformCode || !loadableTransforms.has(hit.transformCode))
      .map((hit) => ({
        hit,
        availability: classifyPreprocessorAvailability(hit, projectRoot, preprocessorWorkspaceRoot),
      }))
      .filter(({ availability }) => availability !== "installed");
    transformHits = candidateTransformHits.map(({ hit }) => hit);
    // Named up front, and again on the way out if the run dies: a transform
    // the harness cannot apply is the first thing to check.
    for (const { hit, availability } of candidateTransformHits) {
      runWarnings.push(PROJECT_TRANSFORM_WARNING(hit, availability));
    }
    if (loadableTransforms.size > 0) {
      activeTransforms = [...loadableTransforms].sort();
    }
    // M78 loose end: wired into --explain-props (explainProps, above) but
    // never into the default run's own warning list. Zero cost when the
    // project has no next.config/webpack.config matching the shape (a single
    // probe-order file read).
    if (framework === "react") {
      const bundlerAlias = detectBundlerReactDomAlias(projectRoot);
      if (bundlerAlias) {
        runWarnings.push(BUNDLER_PREACT_ALIAS_WARNING(bundlerAlias.configFile, bundlerAlias.target));
      }
    }
    if (preflight.hard.length > 0) {
      if (options.noPreflight) {
        runWarnings.push(PREFLIGHT_BYPASSED_WARNING(preflight.hard));
      } else {
        // M79/M78: a preflight hard-rejection, not a build/runtime failure —
        // nothing has been built yet, so the diagnosis is already complete.
        // The marker lets the outer catch below skip stacking accumulated
        // warnings (e.g. an unrelated css-preprocessor note) on top of it.
        throw new PreflightHardRejectionError(preflightFailureMessage(preflight.hard));
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
      ...(options.target ? { target: options.target } : {}),
    };
    const composedHarnessOpts: import("./harness.js").BuildHarnessOptions = {
      ...baseHarnessOpts,
      ...(useComposition ? { composition: compositionTree!, exports: componentExports } : {}),
    };
    progress("harness: building");
    harness = await buildAndServe(harnessPath, composedHarnessOpts);
    if (harness.warnings) runWarnings.push(...harness.warnings);

    // M35: calibration, trial mount, and wrapper overhead run under the same
    // driven frame pacing as the measurement passes they normalize.
    msession = await openMeasurementSession({
      driven: true,
      onWarning,
      pool,
      harnessDirName: path.basename(harness.harnessDir),
    });
    const page = msession.page;
    const pageErrors = msession.errorCapture;
    const cdp = msession.session.cdp;

    const chromiumVersion = msession.browser.version();
    const machine = await collectMachineInfo(chromiumVersion);

    const enterHarnessPage = async (): Promise<void> => {
      await gotoWithErrorContext(page, harness!.url, pageErrors, "component harness", {
        waitUntil: HARNESS_NAV_WAIT,
      });
      // M79 gap 3b: races readiness against a fatal page error (a
      // synchronous throw during module evaluation, e.g. a next.config.mjs
      // env-validation failure) instead of always waiting out the full
      // timeout.
      await waitForReadyOrFatal(
        () =>
          page.waitForFunction(
            () => typeof (window as any).__120fps === "object",
            undefined,
            { timeout: 30000 },
          ),
        pageErrors,
        "component harness",
        () => {
          const projectRoot = path.dirname(harness!.harnessDir);
          return hasAnyEnvFile(projectRoot) ? undefined : NO_ENV_FILE_REMEDY_NOTE;
        },
      );

      await applyWrapperViewport(page);
      // M74 (B10): threads both the settle-timeout warning and, when a
      // @font-face 404'd or failed to decode, the failed-family warning
      // through the same sink every other settleStyles call site uses.
      reportFontSettle(await settleStyles(page, harness!), onWarning);
    };

    try {
      await enterHarnessPage();
    } catch (err) {
      // M89 defect 3 (shadcn-ui, live proof): a discovered stylesheet can
      // resolve fine on disk and still fail to compile because something
      // IT references internally does not (Tailwind v4's generated
      // tailwind.css, gitignored/build-only) -- entryStylesheetImports'
      // own resolution never sees that nested reference, only Vite's real
      // PostCSS pipeline does, at this first real request. Governing
      // policy (specs/milestones/m95-*.md): skip unresolvable build
      // artifacts and measure anyway wherever possible -- the component
      // still renders, just unstyled. Scoped to ENOENT alone
      // (stylesheetReadFailureTarget), so a stylesheet that resolves and
      // then fails to *compile* (a real project error, e.g. twenty's sass
      // "Undefined mixin") is untouched and still fails the run loudly.
      const message = err instanceof Error ? err.message : String(err);
      const missingTarget =
        resolvedCss.files.length > 0 ? stylesheetReadFailureTarget(message) : undefined;
      if (!missingTarget) throw err;
      const droppedFiles = [...cssReport.files];
      onWarning(CSS_UNREADABLE_DROPPED_WARNING(missingTarget, droppedFiles));
      resolvedCss.files = [];
      cssReport.files = [];
      cssReport.layer = "unreadable";
      cssReport.details = [];
      delete cssReport.onlyCandidate;
      delete cssReport.noEntryInPackage;
      delete cssReport.runtimeEngines;
      // The early cache-lookup fingerprint (tryReuseStoredVerdict, above)
      // may already have memoized a value computed with the now-dropped
      // file still in it; un-memoize so a later --save-baseline call
      // recomputes against the stylesheet this run actually measured with
      // (none), not the one it started out intending to use.
      fingerprintValue = undefined;
      await harness!.cleanup();
      harness = await buildAndServe(harnessPath, { ...composedHarnessOpts, cssFiles: undefined });
      if (harness.warnings) runWarnings.push(...harness.warnings);
      // Not wrapped again: a second failure here is a different, genuine
      // problem (or the same page never recovering for an unrelated
      // reason) and must propagate and fail the run like any other.
      await enterHarnessPage();
    }

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
        // M80: the rolled-back mount is about to measure the bare root
        // alone, same shape as the never-composed case above. Checked before
        // `compositionTree`/`componentExports` are cleared below: a root
        // that self-wraps in one element (nonzero domNodeCount, so
        // renderHealth never fires) but still declares recognized sibling
        // parts must not read as an unqualified pass.
        {
          const rootName = compositionTree!.root;
          const typeImportNames = await extractRelativeTypeImports(resolvedPath);
          const siblingExports = (componentExports ?? []).filter((e) => e.name !== rootName);
          const siblings = declaredCompositionSiblings(rootName, siblingExports, typeImportNames);
          if (siblings.length > 0) {
            disclosureReason = "uncomposed";
            runWarnings.push(UNCOMPOSED_SIBLINGS_WARNING(rootName, siblings.map((s) => s.name)));
          }
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

    // M46: unthrottled and outside every traced window: the question is what
    // the machine is doing, not what the component costs.
    noiseProbe = await suspendThrottle(cdp, cpuThrottle, () => probeMachineNoise(page));

    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuThrottle });

    progress("calibration");
    const calibrationMetrics = await createCalibrationTrace(page, cdp);
    const calibration: CalibrationResult = {
      totalDuration: calibrationMetrics.totalDuration,
      scriptDuration: calibrationMetrics.scriptDuration,
    };

    if (calibration.totalDuration === 0) {
      throw new Error("Calibration produced zero duration: measurement environment is broken");
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
      // M80 scope 2 (cross-boundary fix, see Lane G report): a plain
      // value-spread here would snapshot `disclosureReason` at ctx
      // construction time, which is always before getSchemas() -- and thus
      // extractSchemas's own, later "propsExcluded" assignment -- ever runs.
      // A getter re-reads the outer binding live, so a Vue run's disclosure
      // (computed lazily, on first getSchemas() call) still reaches
      // BuildReportInput.disclosureReason below. The "uncomposed" producer is
      // unaffected: it already assigns before this object is constructed.
      get disclosureReason() {
        return disclosureReason;
      },
      ...(wrapper !== undefined ? { wrapper } : {}),
      ...(cssReport !== undefined ? { cssReport } : {}),
      runWarnings,
      onWarning,
      progress,
      getSchemas: async () => (schemas ??= await extractSchemas(harness!.componentPath)),
      getSourceFingerprint,
      attachHarnessContext,
    };

    // --- Isolation mode ---
    if (options.isolation) {
      progress(`mode: isolation (${options.isolation.phases.join(",")})`);
      return await runIsolationMode(ctx, options.isolation);
    }

    // --- Curve mode check ---
    const curveMatch = await resolveCurveMatch(ctx);
    if (curveMatch) {
      // M83 #4a (twenty-F6): the CLI already rejects an explicit --curve
      // combined with an explicit --matrix at parse time, so a truthy
      // curveMatch here alongside an explicit --matrix can only be an
      // auto-activation winning a mode conflict the user did not ask to lose
      // silently.
      if (options.matrixMode === true) {
        runWarnings.push(MATRIX_SUPPRESSED_BY_CURVE_WARNING(curveMatch.schema.name));
      }
      progress(`mode: curve on ${curveMatch.schema.name}`);
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
      progress("mode: prop matrix");
      return await runMatrixMode(ctx, matrixAutoActivated);
    }

    progress("mode: prop combos");
    return await runComboMode(ctx, fixtureHasScale);
  } catch (err) {
    // M79/M78: a preflight hard-rejection already names a complete, correct
    // fix (nothing was built yet); stacking accumulated warnings on top of it
    // is exactly the compounding-note bug (excalidraw-F3's "needs a CSS
    // preprocessor" note glued onto an unrelated "nothing installed" hard
    // rejection).
    if (err instanceof PreflightHardRejectionError) throw err;
    // M79 (1b): subsumes the old transformHits-only special case —
    // transformHits's own warnings are already in runWarnings (pushed above),
    // and 1a's harness.ts throw sites attach their own buildWarnings on the
    // error itself, so both sources fold into one block here.
    // M90 (ant-design-F5): `cssDecisionWarning` is always a non-empty
    // string, so `combined` is never empty and every throw that reaches here
    // gets the block — including a thrown value that is not `instanceof
    // Error` (ant-design's raw esbuild resolve failure took exactly this
    // shape, and the old `if (err instanceof Error)` guard silently dropped
    // accumulation for it).
    const carried =
      err instanceof Error ? ((err as Error & { warnings?: string[] }).warnings ?? []) : [];
    const combined = [...new Set([cssDecisionWarning, ...runWarnings, ...carried])];
    const message = err instanceof Error ? err.message : String(err);
    // M92: surface 2 of the shared pipeline (presentBundlerFailure,
    // src/harness.ts) -- the dev server booted fine (buildAndServe's own
    // catch, surface 1, never saw this) and a transform failed afterwards on
    // a real request, arriving as page-error text inside a "did not become
    // ready" / fatal-page-error message (twenty's sass "Undefined mixin",
    // shadcn-ui's postcss ENOENT and Vite import-resolve failure). Harmless
    // to run on every other throw that reaches this catch too: the diagnosers
    // match only specific raw bundler shapes, and the fallback stripper is
    // conservative (keeps a frame pointing into the target repo).
    const presented = presentBundlerFailure(message, projectRoot, combined);
    throw new Error(presented + formatAccumulatedWarnings(combined), { cause: err });
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
  "No props extracted: component measured with empty props only; if the component has typed props, extraction may have failed";

// M83 #8 (chakra-ui-F7): the resolved export is correct by JS/TS export
// semantics; this only surfaces the existing #ExportName escape hatch when
// it would trade a degenerate required prop away.
export const ALTERNATIVE_EXPORT_WITHOUT_DEGENERATE_PROPS_NOTE = (
  resolved: string,
  alternative: string,
): string =>
  `${resolved} has a required prop this tool cannot synthesize a real value for; this file also ` +
  `exports ${alternative}, whose props are all synthesizable. Target it with #${alternative} if it is ` +
  "the component you meant to measure.";

// M65: `<file>#Export` and `--fixture` both decide what gets rendered.
export const TARGET_WITH_FIXTURE_ERROR =
  "A named export target (<file>#Export) cannot be combined with --fixture: a fixture already decides what renders";

// M65: whether M59's gate (per combo) or its curve-mode equivalent (a run
// warning) declared this run's render broken.
export function renderFailed(report: Report): boolean {
  if (report.combos.some((combo) => combo.renderHealth === "error")) return true;
  return (report.warnings ?? []).some((warning) => /^scale point N=/.test(warning));
}

// M59: curve mode's equivalent of the per-combo render-health gate.
export const CURVE_RENDER_ERROR_WARNING = (n: number, messages: string[]): string =>
  `scale point N=${n} rendered 0 DOM nodes while the page threw, so the curve describes a ` +
  `broken render: ${messages.join("; ")}`;

// --no-css wins over an explicit --css, matching --no-wrap/--wrap. Explicit
// paths resolve against process.cwd() and suppress detection. M71: detection
// follows the project's own entry imports first and can return several files,
// in import order; whatever it had to guess at travels in `warningsOut`.
// M82: layer travels with the resolution so analyzeComponent can build a
// CssReport unconditionally — layer is what makes "found nothing" and "found
// nothing because --no-css" distinguishable in the disclosed report.
export function resolveCssFiles(
  options: Pick<AnalyzeOptions, "cssFiles" | "noCss">,
  projectRoot: string,
  warningsOut?: string[],
): {
  files: string[];
  autoDetected: boolean;
  layer: CssReport["layer"];
  onlyCandidate?: boolean;
  noEntryInPackage?: boolean;
  runtimeEngines?: string[];
} {
  if (options.noCss) return { files: [], autoDetected: false, layer: "disabled" };

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
    return { files, autoDetected: false, layer: "explicit" };
  }

  const discovered = discoverGlobalCss(projectRoot, warningsOut);
  const layer: CssReport["layer"] =
    discovered.source === "entry"
      ? "entry-chain"
      : discovered.source === "candidate"
        ? "known-name"
        : discovered.source === "fallback"
          ? "largest-fallback"
          : discovered.source === "runtime"
            ? "runtime"
            : "none";
  return {
    files: discovered.files,
    autoDetected: discovered.files.length > 0,
    layer,
    ...(discovered.onlyCandidate !== undefined ? { onlyCandidate: discovered.onlyCandidate } : {}),
    ...(discovered.noEntryInPackage !== undefined
      ? { noEntryInPackage: discovered.noEntryInPackage }
      : {}),
    ...(discovered.runtimeEngines !== undefined ? { runtimeEngines: discovered.runtimeEngines } : {}),
  };
}

// M76: chakra-ui-F2's finding is exactly that a wrapper placed at the natural
// monorepo root produces total silence, identical to no wrapper existing at
// all — a wrapper that loads from an unexpected level must say so.
export function WRAPPER_FROM_WORKSPACE_ROOT_WARNING(wrapPath: string, projectRoot: string): string {
  return (
    `${wrapPath} was found at the workspace root, not in ${projectRoot}; the component's own package ` +
    "declares no 120fps.setup.* wrapper of its own"
  );
}

// --no-wrap wins over an explicit --wrap, matching --no-isolate/--isolate.
export function resolveWrapPath(
  options: Pick<AnalyzeOptions, "wrapPath" | "noWrap">,
  projectRoot: string,
  framework?: string,
  warningsOut?: string[],
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
  if (detected) return { wrapPath: detected, wrapAutoDetected: true };

  const workspaceRoot = findWorkspaceRoot(projectRoot);
  if (workspaceRoot !== projectRoot) {
    const fromRoot = detectWrapper(workspaceRoot, framework);
    if (fromRoot) {
      warningsOut?.push(WRAPPER_FROM_WORKSPACE_ROOT_WARNING(fromRoot, projectRoot));
      return { wrapPath: fromRoot, wrapAutoDetected: true };
    }
  }
  return { wrapAutoDetected: false };
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

// Tooling configs and lockfiles belong to the identity of a cached verdict. In
// a workspace they sit at the root the member never mentions, so a root
// lockfile bump used to leave every member's baseline valid. Member level
// first: a name found there is the one that applies.
const PROJECT_CONFIG_FINGERPRINT_FILES = [
  "tailwind.config.js",
  "tailwind.config.ts",
  "tailwind.config.mjs",
  "postcss.config.js",
  "postcss.config.mjs",
  "postcss.config.cjs",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
];

export function projectConfigFingerprintFiles(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): string[] {
  const roots = [...new Set([memberRoot, workspaceRoot])];
  const found: string[] = [];
  for (const name of PROJECT_CONFIG_FINGERPRINT_FILES) {
    for (const root of roots) {
      const candidate = path.join(root, name);
      if (fs.existsSync(candidate)) {
        found.push(candidate);
        break;
      }
    }
  }
  return found;
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
    `Baselines now live at the package root: re-run with --save-baseline to migrate.`
  );
}

// Explicit --framework react|vue|vanilla skips detection; auto detects from the
// project's package.json. A `.vue` file overrides both: no flag can make React
// render an SFC, so the file's own type is the stronger evidence.
//
// M83 #4b (preact-app-F4): `rendererFor` (src/harness.ts) decides the mount
// template purely by file extension and never reads --framework; the flag
// only ever gates which *post-mount analysis* pass runs. An explicit,
// non-"auto" request that disagrees with what will actually mount (by the
// same extension check performed here) now says so instead of being
// silently discarded in either direction.
export function resolveFramework(
  mode: "react" | "vue" | "vanilla" | "auto",
  projectRoot: string,
  componentPath?: string,
  onWarning?: (warning: string) => void,
): "react" | "vue" | "vanilla" {
  const mounts = componentPath && isVueFile(componentPath) ? "vue" : "react";
  if (mode !== "auto" && mode !== mounts) {
    onWarning?.(FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING(mode, mounts));
  }
  if (componentPath && isVueFile(componentPath)) return "vue";
  return mode === "auto" ? detectFramework(projectRoot, onWarning) : mode;
}

export const FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING = (requested: string, mounts: string): string =>
  `--framework ${requested} does not change how this file mounts: a component always mounts by its ` +
  `file extension (this file mounts as ${mounts}). The flag only selects which post-mount analysis ` +
  "pass runs.";

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
