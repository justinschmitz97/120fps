import path from "node:path";
import {
  type PropSchema,
  generateCombinations,
  selectRepresentativeCombos,
  countCombinationSpace,
  DEFAULT_MEASURED_COMBOS,
  type PropCombination,
} from "../../props/index.js";
import {
  hintsForReport,
  buildEnvFingerprint,
  type BaselineEntry,
  type BaselineEnvPolicy,
  type BaselineMetrics,
  attachWrapperReport,
  TIER_BUDGETS,
  type PropDelta,
  type Report,
} from "../../report/index.js";
import {
  runReactAnalysis,
  hasReactWarning,
  explore,
  EXPLORE_BUDGET_WARNING,
  VOLATILE_DOM_NOTICE,
} from "../../analysis/index.js";
import { measureMount, measureRerender } from "../../browser/index.js";
import { writeReportJson } from "../analyze.js";
import { applyBaselineWorkflow, buildReport } from "../build-report.js";
import {
  EFFECTIVE_SAMPLES_WARNING,
  type ModeContext,
  animatedIndices,
  computeEffectiveSamples,
  detectComponentName,
} from "../modes/context.js";
import { applyAutoScalingCurves } from "../modes/curve.js";
import { measureStandardPropDeltas } from "../modes/matrix.js";
import { NO_PROPS_MEASURED_WARNING, ZERO_PROPS_WARNING, explainsZeroPropCount } from "../remedies.js";

export const COMBO_CAP_WARNING = (kept: number, total: number): string =>
  `measured ${kept} of ${total} prop combos; ${total - kept} were dropped to bound the run. ` +
  `Raise it with --max-combos <n>.`;

// The most lenient tier budget the tool has. A component whose single
// instance already costs this much will not cost less per copy at
// N=5/20/50: quadrupling the instance count only makes a slow mount slower.
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

// Measures the cheapest requested scale point alone (3 samples: a go/no-go
// check, not a reported number) and applies the pure gate to decide
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
export async function runComboMode(ctx: ModeContext, fixtureHasScale: boolean): Promise<Report> {
  const { options, harness, samples, cpuThrottle, warmupRuns, seed, pool, onWarning, runWarnings, machine, calibration, thresholds, explicitThresholds, useFixture, composed } = ctx;

  const scalePoints = options.scalePoints ?? [1, 5, 20, 50];
  let combos: PropCombination[];
  let schemas: PropSchema[] | undefined;
  let zeroPropsExtracted = false;
  let measuredWithoutProps = false;
  if (fixtureHasScale) {
    const gated = await gateScalePoints(ctx, scalePoints);
    if (gated.warning) runWarnings.push(gated.warning);
    combos = gated.points.map((n) => ({ __120fps_scaleN: n }));
  } else if (useFixture || composed) {
    // The schemas do not build the combo list here: the fixture or the
    // composed scene owns the render. But extraction's own diagnostics are
    // the same facts the dry run printed, so the call still runs to surface
    // them (e.g. an unsynthesizable prop) instead of measuring `props: {}`
    // in silence.
    schemas = await ctx.getSchemas();
    combos = [{}];
    measuredWithoutProps = true;
    // "none of this component's own extracted props were applied" implies
    // props were withheld. A component whose schema is genuinely empty had none
    // to withhold, and the zero-prop chain already describes that run.
    if (schemas.length > 0) runWarnings.push(NO_PROPS_MEASURED_WARNING(useFixture));
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

  // A component that renders non-deterministically is worth knowing about
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
    phaseClock: ctx.phaseClock,
    rerenders,
    flatThresholds: options.flatThresholds,
    explicitThresholds,
    skipAttribution: options.skipAttribution,
    ...(schemas ? { schemas } : {}),
    ...(ctx.disclosureReason !== undefined ? { disclosureReason: ctx.disclosureReason } : {}),
    ...(measuredWithoutProps ? { measuredWithoutProps: true } : {}),
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

  // A zero-prop count already explained by a Vue scope-exclusion disclosure
  // ("declares props through ... a runtime form ADR 0002 deliberately does
  // not read") must not also get the generic "extraction may have failed"
  // text stacked on top: that phrase floats a possible malfunction the run
  // already knows is not what happened. The same suppression applies on the
  // real measurement path, keyed on the warnings this run actually produced
  // rather than only on the Vue scope-exclusion signal `disclosureReason`
  // carries.
  if (
    zeroPropsExtracted &&
    ctx.disclosureReason !== "propsExcluded" &&
    !runWarnings.some(explainsZeroPropCount)
  ) {
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

  // `ctx.framework` already folds the flag, the manifest and the measured
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
      // This pass runs after ctx.attachHarnessContext(report) already
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
    // cssReport is always constructed, even for "none"; gate on files.length
    // so a no-CSS project's fingerprint bytes stay unchanged.
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
    // A reading, not a closing: the total still ends at the `report`
    // boundary a few lines below, where the JSON's own number is taken.
    phaseTimings: ctx.phaseClock.snapshot(),
    phaseUnits: { combos: combos.length, samples: effectiveSamples },
  });

  // Recorded before serialization so the JSON carries the same ids the
  // terminal prints.
  const hintIds = hintsForReport(report);
  if (hintIds.length > 0) report.hints = hintIds;

  ctx.progress("report");
  // The run's own timing breakdown travels on the report it returns.
  report.phaseTimings = ctx.phaseClock.timings();
  writeReportJson(report, options.jsonPath);

  return report;
}
