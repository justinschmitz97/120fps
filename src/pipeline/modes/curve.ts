import { hasPageErrors, renderDrain, measureMount, measureRerender } from "../../browser/index.js";
import {
  detectScalingProps,
  type PropSchema,
  type ScalingPropMatch,
  generateScalingCombos,
} from "../../props/index.js";
import { explore } from "../../analysis/index.js";
import {
  computeScalingCurve,
  isDomFlat,
  SCALING_NO_EFFECT_WARNING,
  attachWrapperReport,
  buildCurveReport,
  computeCurveVerdict,
  CURVE_NOT_ACTIVATED_WARNING,
  type Report,
} from "../../report/index.js";
import { writeReportJson } from "../analyze.js";
import {
  type ModeContext,
  animatedIndices,
  collectReactOptimizations,
  detectComponentName,
} from "../modes/context.js";

// The curve run activates on an explicit --curve flag or on the first
// detected scaling prop; fixtures and composed scenes never take it.
export async function resolveCurveMatch(ctx: ModeContext): Promise<ScalingPropMatch | undefined> {
  const { curveMode } = ctx.options;
  if (curveMode === false) return undefined;
  // A curve the user asked for and did not get must say so; auto-detection
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
  // Extraction is cached by getSchemas: the matrix check and the standard
  // path would otherwise re-extract the same file, which costs real time on
  // a large project.
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

export async function runCurveMode(ctx: ModeContext, match: ScalingPropMatch): Promise<Report> {
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
    phaseClock: ctx.phaseClock,
  });

  // A sweep that never moved the DOM measured no growth. The verdict still
  // stands on the timings; only the growth class is disowned.
  if (isDomFlat(curveReport.points)) {
    curveReport.domFlat = true;
    runWarnings.push(SCALING_NO_EFFECT_WARNING(curveReport.propName));
  }

  // A curve report has scale points, not combos, so the per-combo gate
  // cannot reach it. A point that rendered nothing while the page reported
  // an error still has to fail the run, whether that report arrived as a
  // throw or only as a logged error: nothing rendered and the page
  // complained about it either way. The two cases are told apart in the
  // warning text below, not in this filter.
  const brokenPoints = curveMounts.filter(
    (m) => m.domNodeCount === 0 && hasPageErrors(m.pageErrors),
  );
  if (brokenPoints.length > 0) {
    // The structural counterpart to CURVE_RENDER_ERROR_WARNING's formatted
    // string below, populated at the same point so the two never drift by
    // construction rather than by convention.
    curveReport.renderErrorPoints = brokenPoints.map((broken) => ({
      n: curveScalePoints[broken.comboIndex] ?? broken.comboIndex,
      pageErrors: renderDrain(broken.pageErrors!),
    }));
  }
  for (const broken of brokenPoints) {
    const n = curveScalePoints[broken.comboIndex] ?? broken.comboIndex;
    const messages = renderDrain(broken.pageErrors!);
    runWarnings.push(
      broken.pageErrors!.fatal
        ? CURVE_RENDER_ERROR_WARNING(n, messages)
        : CURVE_EMPTY_POINT_WITH_ERRORS_WARNING(n, messages),
    );
  }

  // A curve every one of whose points rendered nothing measured no growth
  // of anything, whether or not the page said so.
  const everyPointEmpty =
    curveReport.points.length > 0 && curveReport.points.every((p) => p.domNodeCount === 0);
  if (everyPointEmpty && brokenPoints.length === 0) {
    runWarnings.push(CURVE_ALL_POINTS_EMPTY_WARNING(curveReport.propName));
  }

  const curveVerdict = computeCurveVerdict(curveReport.points, curveReport.mountCurve, thresholds);
  const pass = curveVerdict !== "fail" && brokenPoints.length === 0 && !everyPointEmpty;

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

  // A component whose only interesting prop is an array auto-activates this
  // mode; it must still run this pass so the render fan-out combo mode's
  // siblings disclose reaches console and JSON here too, not just there.
  const curveReact = await collectReactOptimizations(ctx, scaleCombos, await ctx.getSchemas(), report);
  for (const [comboIndex, opts] of curveReact) {
    const point = curveReport.points[comboIndex];
    if (point) point.reactOptimizations = opts;
  }

  // The run's own timing breakdown travels on the report it returns.
  report.phaseTimings = ctx.phaseClock.timings();
  writeReportJson(report, options.jsonPath);

  return report;
}

// Auto-scaling sweep on the standard path. Attaches mount/rerender scaling
// curves for the first detected scaling prop to every combo of an
// already-built report; measured at the full requested sample count.
export async function applyAutoScalingCurves(
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

  // The sibling-copies probe already carries its own scale-probe curve
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

// Curve mode's equivalent of the per-combo render-health gate.
export const CURVE_RENDER_ERROR_WARNING = (n: number, messages: string[]): string =>
  `scale point N=${n} rendered 0 DOM nodes while the page threw, so the curve describes a ` +
  `broken render: ${messages.join("; ")}`;

// The same fact without the throw: React can log a missing provider through
// console.error and render nothing, so "while the page threw" would be
// false even though nothing rendered.
export const CURVE_EMPTY_POINT_WITH_ERRORS_WARNING = (n: number, messages: string[]): string =>
  `scale point N=${n} rendered 0 DOM nodes and the page reported: ${messages.join("; ")}. The ` +
  "curve describes a render that did not happen.";

// Every point empty, nothing reported. The growth class would be fitted
// over a component that rendered nothing at any N. Prefixed `scale point
// N=` — the same shape `renderFailed` (pipeline/remedies.ts) and
// hintsForReport's curve branch already match — so an all-empty curve
// publishes `providerCandidates` and reaches the provider hint. `N=all`
// names the whole sweep rather than a point that does not exist.
export const CURVE_ALL_POINTS_EMPTY_WARNING = (propName: string): string =>
  `scale point N=all rendered 0 DOM nodes: the component renders nothing across the whole ` +
  `${propName} sweep, so there is no growth to classify.`;
