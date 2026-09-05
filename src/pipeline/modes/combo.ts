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

// The most lenient tier budget: an instance this slow only gets slower per copy at N=5/20/50.
export const SCALE_PROBE_GATE_MS = TIER_BUDGETS.T4.mountMs;

export const SCALE_PROBE_COST_WARNING = (
  probeN: number,
  probeMs: number,
  skipped: number[],
): string =>
  `scale probe: N=${probeN} already mounts at ${probeMs.toFixed(1)}ms (over the ${SCALE_PROBE_GATE_MS}ms ` +
  `T4 budget): skipped N=${skipped.join(", ")} to avoid a multi-minute probe. Raise the ceiling with --scale.`;

// Pure decision over an already-measured probe cost, so it is testable without a browser.
export function boundScalePointsByProbeCost(
  scalePoints: number[],
  probeMs: number,
  gateMs: number = SCALE_PROBE_GATE_MS,
): { points: number[]; skipped: number[] } {
  if (scalePoints.length <= 1 || probeMs <= gateMs) return { points: scalePoints, skipped: [] };
  const probeN = Math.min(...scalePoints);
  return { points: [probeN], skipped: scalePoints.filter((n) => n !== probeN) };
}

// The raw cartesian prop space can be astronomically large; display, not arithmetic, needs a cap.
const RAW_COMBO_SPACE_DISPLAY_CAP = 1_000_000_000;

function formatComboSpace(n: number): string {
  // Pinned locale: nothing parses this text, but it must read the same on every machine.
  return Number.isFinite(n) && n <= RAW_COMBO_SPACE_DISPLAY_CAP
    ? n.toLocaleString("en-US")
    : `>${RAW_COMBO_SPACE_DISPLAY_CAP.toLocaleString("en-US")}`;
}

export const STRATIFIED_SAMPLE_WARNING = (raw: number, sampled: number): string =>
  `prop space has ${formatComboSpace(raw)} combinations; measured a stratified sample of ${sampled}.`;

// The probed point is remeasured in the main batch: measureMount assigns comboIndex by position.
async function gateScalePoints(
  ctx: Pick<ModeContext, "harness" | "cpuThrottle" | "warmupRuns" | "pool" | "onWarning" | "samples">,
  scalePoints: number[],
): Promise<{ points: number[]; warning?: string }> {
  if (scalePoints.length <= 1) return { points: scalePoints };
  const { harness, cpuThrottle, warmupRuns, pool, onWarning, samples } = ctx;
  const probeN = Math.min(...scalePoints);
  const [probe] = await measureMount(harness, {
    // Go/no-go only: this measurement is never reported.
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
    // The fixture owns the render; extraction still runs so its diagnostics are not silenced.
    schemas = await ctx.getSchemas();
    combos = [{}];
    measuredWithoutProps = true;
    // An empty schema had nothing to withhold, and the zero-prop chain already describes that run.
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

  // Non-determinism is worth reporting on its own, not only as an exploration side effect.
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

  // A disclosure that already explains the zero count suppresses the extraction-failure text.
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

  // ctx.framework already folds the flag, the manifest and the measured file's own type together.
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
      // attachHarnessContext already flushed runWarnings, so this writes onto the built report.
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
    // The count the numbers were estimated from: a different real N is not like-for-like.
    samples: effectiveSamples,
    mode: "combo",
    framework: ctx.framework,
    // cssReport exists even for "none"; gate on files.length to keep the bytes stable.
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
    // A reading, not a closing: the total still ends at the report boundary below.
    phaseTimings: ctx.phaseClock.snapshot(),
    phaseUnits: { combos: combos.length, samples: effectiveSamples },
  });

  // Recorded before serialization so the JSON carries the same ids the terminal prints.
  const hintIds = hintsForReport(report);
  if (hintIds.length > 0) report.hints = hintIds;

  ctx.progress("report");
  report.phaseTimings = ctx.phaseClock.timings();
  writeReportJson(report, options.jsonPath);

  return report;
}
