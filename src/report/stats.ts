import type {
  ComponentTier,
  TierBudget,
  Thresholds,
  TimingWithCV,
  InteractionReport,
  ComboReport,
  CalibrationResult,
  ScalingCurveReport,
  ScalingPoint,
  CurveViolation,
  MatrixAxis,
  MatrixCell,
  MatrixReport,
  MatrixAxisCoverage,
  CompoundEffect,
  PropDelta,
  Report,
  ReportMode,
} from "./types.js";
import { DEFAULT_THRESHOLDS } from "./types.js";
import type { PhaseClock } from "./phases.js";
import type { ScalingCurve } from "./metrics.js";
import { computeScalingCurve, attributeCost } from "./metrics.js";
import { computeMedian, computeP95, hasPageErrors, renderDrain } from "../browser/index.js";
import { comboKey } from "../props/index.js";

// One predicate, so the growth column, the JSON and the hint can never disagree
// about what "superlinear" means.
export function isSuperlinearGrowth(curve: ScalingCurve | null | undefined): boolean {
  return curve?.growthClass === "quadratic" || curve?.growthClass === "exponential";
}

// Budgets rise monotonically T1 → T4, so "at least T3" is a floor expressed as
// a position in this order.
const TIER_ORDER: ComponentTier[] = ["T1", "T2", "T3", "T4"];

export function classifyTier(info: {
  domNodeCount: number;
  hasPortal: boolean;
  hasScaling?: boolean;
  hasAnimation: boolean;
}): ComponentTier {
  const bySize: ComponentTier =
    info.domNodeCount <= 10 ? "T1" : info.domNodeCount <= 40 ? "T2" : "T4";
  // A portal or an animation buys the component T3's headroom; it never takes
  // headroom away. A 2000-node animated table is still a 2000-node table.
  if (!info.hasPortal && !info.hasAnimation) return bySize;
  return TIER_ORDER.indexOf(bySize) >= TIER_ORDER.indexOf("T3") ? bySize : "T3";
}

export function computeCV(samples: number[]): number {
  if (samples.length <= 1) return 0;
  const n = samples.length;
  let sum = 0;
  for (const s of samples) sum += s;
  const mean = sum / n;
  const absMean = Math.abs(mean);
  if (absMean === 0) return 0;
  let variance = 0;
  for (const s of samples) variance += (s - mean) ** 2;
  // Sample variance: N measurements are a sample of the component's cost
  // distribution, not the population. The n divisor understates dispersion at
  // the sample counts this tool runs (n=3..10).
  variance /= n - 1;
  const stddev = Math.sqrt(variance);
  return (stddev / absMean) * 100;
}

// M35: driven pacing shrinks medians to their busy cost, so relative CV on a
// sub-millisecond metric explodes while absolute noise stays trivial: and an
// unstable flag would silently skip its baseline comparison (M22). Unstable
// requires both: high relative CV and noise above the 0.5ms absolute floor
// (the same floor M29 uses for normalized comparison).
export const UNSTABLE_NOISE_FLOOR_MS = 0.5;

export function buildTimingWithCV(samples: number[]): TimingWithCV {
  const median = computeMedian(samples);
  const p95 = computeP95(samples);
  const cv = computeCV(samples);
  const n = samples.length;
  const mean = n > 0 ? samples.reduce((a, b) => a + b, 0) / n : 0;
  const stddevMs = (cv / 100) * Math.abs(mean);
  return {
    samples,
    median,
    p95,
    cv,
    unstable: cv > 15 && stddevMs > UNSTABLE_NOISE_FLOOR_MS,
  };
}

// Only for translating an explicitly supplied aggregate --threshold-interaction
// into the per-event budget the verdict uses, so an existing CI flag keeps its
// meaning. Tier budgets are derived from frames, not from this.
export const REFERENCE_EVENTS = 11;

export function perStepCost(interaction: InteractionReport): number {
  const events = interaction.steps && interaction.steps > 0 ? interaction.steps : 1;
  return interaction.timing.median / events;
}

export function computeVerdict(
  combo: ComboReport,
  thresholds: Thresholds,
  options?: { tierBudget?: TierBudget; explicitInteraction?: boolean },
): "pass" | "warn" | "fail" {
  // M59: nothing rendered and the page threw. The timings are real, but they
  // describe React mounting and unmounting a broken tree, so no budget
  // comparison on them means anything.
  if (combo.renderHealth === "error") return "fail";
  const mountMs = options?.tierBudget?.mountMs ?? thresholds.mountMs;
  const rerenderMs = options?.tierBudget?.rerenderMs ?? thresholds.rerenderMs;
  const interactionMs = options?.tierBudget?.interactionMs ?? thresholds.interactionMs;
  if (combo.mount.median > mountMs) return "fail";
  if (!options?.tierBudget && combo.relativeMount > thresholds.relativeMount) return "fail";
  if (combo.rerender.median > rerenderMs) return "fail";
  if (combo.rerenderChange && combo.rerenderChange.median > rerenderMs * 1.5) {
    if (options?.tierBudget) return "warn";
    return "fail";
  }
  // `Thresholds` is public and predates `interactionStepMs`, so a caller
  // constructing it by hand must not silently disable the interaction check.
  const perStepMs = options?.explicitInteraction
    ? interactionMs / REFERENCE_EVENTS
    : options?.tierBudget?.interactionStepMs
      ?? thresholds.interactionStepMs
      ?? DEFAULT_THRESHOLDS.interactionStepMs;
  for (const interaction of combo.interactions) {
    if (perStepCost(interaction) > perStepMs) return "fail";
  }
  if (combo.mount.unstable || combo.unmount.unstable) return "warn";
  if (combo.rerender.unstable) return "warn";
  if (combo.rerenderChange?.unstable) return "warn";
  for (const interaction of combo.interactions) {
    if (interaction.timing.unstable) return "warn";
  }
  if (options?.tierBudget && combo.relativeMount > thresholds.relativeMount) return "warn";
  return "pass";
}

// M83 #1 (element-plus-F2): a combo marked "renderHealth: empty" and a
// sibling in the same `combos` array (a discrete prop combo or an M61
// scale-probe row) that measured a nonzero DOM count are not two different
// facts to reconcile — they come from the exact same `countComponentNodes`
// computation, so a disagreement between them is a same-run inconsistency,
// not proof the component renders nothing. Detection only: this never
// decides *why* they disagree.
export function detectRenderHealthInconsistency(combos: ComboReport[]): string | undefined {
  const emptyIndices = combos
    .filter((c) => c.renderHealth === "empty")
    .map((c) => c.comboIndex);
  if (emptyIndices.length === 0) return undefined;
  const nonEmptyIndices = combos
    .filter((c) => c.domNodeCount > 0)
    .map((c) => c.comboIndex);
  if (nonEmptyIndices.length === 0) return undefined;
  return RENDER_HEALTH_INCONSISTENT_WARNING(emptyIndices, nonEmptyIndices);
}

export const RENDER_HEALTH_INCONSISTENT_WARNING = (
  emptyIndices: number[],
  nonEmptyIndices: number[],
): string =>
  `combo(s) #${emptyIndices.join(", #")} rendered 0 DOM nodes while combo(s) #${nonEmptyIndices.join(", #")} ` +
  "rendered a nonzero count in the same run: this disagreement was not resolved, so it is reported " +
  "rather than asserted as 'the component renders nothing'.";

export interface BuildCurveReportInput {
  propName: string;
  propKind: "array" | "number";
  reason: string;
  scalePoints: number[];
  mounts: import("../browser/index.js").MountResult[];
  rerenders: import("../browser/index.js").RerenderResult[];
  explores: import("../analysis/index.js").ExploreResult[];
  heapDeltas: number[];
  calibration: CalibrationResult;
  thresholds: Thresholds;
  skipAttribution?: boolean;
  // M115 C2: curve mode's attribution work belongs to the `attribution` phase,
  // exactly as combo and matrix mode charge it.
  phaseClock?: Pick<PhaseClock, "addAttribution">;
}

export function buildCurveReport(input: BuildCurveReportInput): ScalingCurveReport {
  const points: ScalingPoint[] = [];

  for (let i = 0; i < input.scalePoints.length; i++) {
    const n = input.scalePoints[i];
    const mount = input.mounts[i];
    const rerender = input.rerenders[i];
    const exploreResult = input.explores[i];

    const interactions: InteractionReport[] = [];
    if (exploreResult?.graph.edges) {
      for (const edge of exploreResult.graph.edges) {
        interactions.push({
          selector: edge.interaction.selector,
          type: edge.interaction.type,
          label: edge.interaction.label,
          timing: buildTimingWithCV(edge.samples),
          relativeTiming: input.calibration.totalDuration > 0
            ? computeMedianLocal(edge.samples) / input.calibration.totalDuration
            : 0,
          ...(edge.interaction.portal ? { portal: true } : {}),
          ...(edge.stressPattern ? { stressPattern: edge.stressPattern } : {}),
        });
      }
    }

    const point: ScalingPoint = {
      n,
      mount: buildTimingWithCV(mount?.mount.samples ?? [0]),
      rerender: buildTimingWithCV(rerender?.stable.samples ?? [0]),
      unmount: buildTimingWithCV(mount?.unmount.samples ?? [0]),
      domNodeCount: mount?.domNodeCount ?? 0,
      heapDelta: input.heapDeltas[i] ?? 0,
      interactions,
    };

    if (!input.skipAttribution && mount?.mountTraces && mount.mountTraces.length > 0) {
      const attributionStart = Date.now();
      point.costAttribution = attributeCost(mount.mountTraces);
      input.phaseClock?.addAttribution(Date.now() - attributionStart);
    }

    // M104 (commerce-F2) / M106 C3 (dub-F6): the same split combo mode draws.
    // A point that rendered nothing measured a render that did not happen —
    // its timings are real and its growth contribution is not.
    if (point.domNodeCount === 0) {
      point.renderHealth = mount?.pageErrors?.fatal ? "error" : "empty";
    }
    if (mount?.pageErrors && hasPageErrors(mount.pageErrors)) {
      point.pageErrors = renderDrain(mount.pageErrors);
    }

    points.push(point);
  }

  // Fitting a growth class over a point that rendered nothing puts a
  // non-render in the same series as the renders. Excluded only while at
  // least two rendering points remain: below that there is no curve to fit
  // either way, and `domFlat` / `renderErrorPoints` already describe that run.
  const rendering = points.filter((p) => p.domNodeCount > 0);
  const fitPoints = rendering.length >= 2 ? rendering : points;
  const fitExcludedPoints = points.filter((p) => !fitPoints.includes(p)).map((p) => p.n);

  const mountCurve = computeScalingCurve(fitPoints.map((p) => ({ n: p.n, metric: p.mount.median })));
  const rerenderCurve = computeScalingCurve(fitPoints.map((p) => ({ n: p.n, metric: p.rerender.median })));
  const unmountCurve = computeScalingCurve(fitPoints.map((p) => ({ n: p.n, metric: p.unmount.median })));
  const domGrowth = computeScalingCurve(fitPoints.map((p) => ({ n: p.n, metric: p.domNodeCount })));
  const heapGrowth = computeScalingCurve(fitPoints.map((p) => ({ n: p.n, metric: p.heapDelta })));

  const interactionCurves: Record<string, ScalingCurve> = {};
  const interactionsByLabel = new Map<string, { n: number; metric: number }[]>();
  for (const point of points) {
    for (const interaction of point.interactions) {
      const existing = interactionsByLabel.get(interaction.label) ?? [];
      existing.push({ n: point.n, metric: interaction.timing.median });
      interactionsByLabel.set(interaction.label, existing);
    }
  }
  for (const [label, curvePoints] of interactionsByLabel) {
    if (curvePoints.length >= 2) {
      interactionCurves[label] = computeScalingCurve(curvePoints);
    }
  }

  const { violation } = evaluateCurve(points, mountCurve, input.thresholds);

  return {
    propName: input.propName,
    propKind: input.propKind,
    reason: input.reason,
    points,
    mountCurve,
    rerenderCurve,
    unmountCurve,
    interactionCurves,
    domGrowth,
    heapGrowth,
    ...(fitExcludedPoints.length > 0 ? { fitExcludedPoints } : {}),
    ...(violation ? { violation } : {}),
  };
}

function computeMedianLocal(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function computeCurveVerdict(
  points: ScalingPoint[],
  mountCurve: ScalingCurve,
  thresholds: Thresholds,
): "pass" | "warn" | "fail" {
  return evaluateCurve(points, mountCurve, thresholds).verdict;
}

// The walk that decides the verdict already knows which budget broke and at
// which N; returning it costs one object and saves the reader a manual diff.
export function evaluateCurve(
  points: ScalingPoint[],
  mountCurve: ScalingCurve,
  thresholds: Thresholds,
): { verdict: "pass" | "warn" | "fail"; violation?: CurveViolation } {
  if (isSuperlinearGrowth(mountCurve)) {
    return {
      verdict: "fail",
      violation: { kind: "growth", metric: "mount", growthClass: mountCurve.growthClass },
    };
  }

  for (let i = 0; i < points.length; i++) {
    const point = points[i];
    // Every earlier point cleared both budgets, so points[i-1] is the largest
    // measured N still under whichever budget breaks here.
    const lastPassingN = i > 0 ? { lastPassingN: points[i - 1].n } : {};
    if (point.mount.median > thresholds.mountMs) {
      return {
        verdict: "fail",
        violation: {
          kind: "budget",
          metric: "mount",
          budgetMs: thresholds.mountMs,
          crossingN: point.n,
          ...lastPassingN,
          medianMs: point.mount.median,
        },
      };
    }
    if (point.rerender.median > thresholds.rerenderMs) {
      return {
        verdict: "fail",
        violation: {
          kind: "budget",
          metric: "rerender",
          budgetMs: thresholds.rerenderMs,
          crossingN: point.n,
          ...lastPassingN,
          medianMs: point.rerender.median,
        },
      };
    }
  }

  const lastPoint = points[points.length - 1];
  if (lastPoint) {
    if (lastPoint.mount.median > thresholds.mountMs * 0.75) return { verdict: "warn" };
    if (lastPoint.rerender.median > thresholds.rerenderMs * 0.75) return { verdict: "warn" };
  }

  return { verdict: "pass" };
}

export interface BuildMatrixReportInput {
  axes: MatrixAxis[];
  heldAbsentProps?: string[];
  // The matrix cells ARE the combos (M21). Projecting them keeps cell verdicts
  // and the run-level pass/fail derived from one computation instead of two
  // that drift: the combo verdict already accounts for interactions.
  combos: ComboReport[];
  propDeltas?: PropDelta[];
}

export function buildMatrixReport(input: BuildMatrixReportInput): MatrixReport {
  const cells: MatrixCell[] = input.combos.map((combo) => ({
    comboIndex: combo.comboIndex,
    props: combo.props,
    mount: combo.mount,
    rerender: combo.rerender,
    unmount: combo.unmount,
    domNodeCount: combo.domNodeCount,
    tier: combo.tier ?? "T1",
    verdict: combo.verdict,
    worstInteractionMs:
      combo.interactions.length > 0
        ? Math.max(...combo.interactions.map((i) => i.timing.median))
        : null,
    ...(combo.disclosureReason !== undefined ? { disclosureReason: combo.disclosureReason } : {}),
  }));

  const sorted = [...cells].sort((a, b) => b.mount.median - a.mount.median);
  const hotCells = sorted.slice(0, 5);
  const coldCells = [...cells].sort((a, b) => a.mount.median - b.mount.median).slice(0, 3);
  const failingCells = cells.filter((c) => c.verdict === "fail");

  let compoundEffects: CompoundEffect[] = [];
  if (input.propDeltas && input.propDeltas.length > 0 && input.axes.length >= 2) {
    const anchorProps: Record<string, unknown> = {};
    for (const axis of input.axes) {
      anchorProps[axis.propName] = axis.values[0];
    }
    const anchorCell = cells.find((c) => {
      for (const axis of input.axes) {
        if (c.props[axis.propName] !== anchorProps[axis.propName]) return false;
      }
      return true;
    });
    const anchorMount = anchorCell?.mount.median ?? 0;

    for (const cell of hotCells) {
      let diffCount = 0;
      let expectedMount = anchorMount;
      for (const axis of input.axes) {
        if (cell.props[axis.propName] !== anchorProps[axis.propName]) {
          diffCount++;
          const delta = input.propDeltas.find(
            (d) => d.propName === axis.propName && d.flipValue === cell.props[axis.propName],
          );
          if (delta) expectedMount += delta.mountDelta;
        }
      }
      if (diffCount < 2) continue;
      if (expectedMount <= 0) continue;

      const compoundDelta = cell.mount.median - expectedMount;
      const ratio = cell.mount.median / expectedMount;
      const significance: CompoundEffect["significance"] =
        ratio >= 1.5 ? "high" : ratio >= 1.2 ? "medium" : "low";

      compoundEffects.push({
        props: cell.props,
        expectedMount,
        actualMount: cell.mount.median,
        compoundDelta,
        significance,
      });
    }
  }

  // M104 (twenty-F3): derived from the cells that were measured, never from
  // the axis declaration, so the cap's effect on the run is visible.
  const axisCoverage: MatrixAxisCoverage[] = input.axes.map((axis) => {
    const seen = new Map<string, unknown>();
    for (const c of cells) seen.set(comboKey(c.props[axis.propName]), c.props[axis.propName]);
    const coverage: MatrixAxisCoverage = {
      propName: axis.propName,
      declaredValues: axis.declaredValueCount ?? axis.values.length,
      measuredValues: seen.size,
    };
    if (seen.size === 1) coverage.heldValue = [...seen.values()][0];
    return coverage;
  });

  return {
    axes: input.axes,
    axisCoverage,
    ...(input.heldAbsentProps && input.heldAbsentProps.length > 0
      ? { heldAbsentProps: input.heldAbsentProps }
      : {}),
    cells,
    hotCells,
    coldCells,
    failingCells,
    compoundEffects,
  };
}

// The one place a report's mode is decided. `report.mode` wins when present;
// otherwise the populated fields answer it, which keeps reports written before
// the field readable.
export function deriveReportMode(report: Report): ReportMode {
  if (report.mode) return report.mode;
  if (report.isolation) return "isolation";
  if (report.scalingCurveReport) return "curve";
  if (report.matrixReport) return "matrix";
  return "combo";
}

// M32 D3: curve mode auto-activates, empties `combos`, and prints a different
// table. Without this line the reader cannot tell which measurement they got.
export function describeMode(report: Report): string {
  switch (deriveReportMode(report)) {
    case "isolation":
      return "Mode: isolation";
    case "curve": {
      const c = report.scalingCurveReport;
      return c ? `Mode: curve over "${c.propName}" (${c.reason})` : "Mode: curve";
    }
    case "matrix":
      return "Mode: prop matrix";
  }

  // M61: the sibling-copies scale probe is not a prop combo: counting it in
  // "measured" without a matching "generated" is exactly the contradiction
  // dogfooding found ("12 measured of 8 generated").
  const propCombos = report.combos.filter((c) => c.scaleProbe === undefined);
  const scaleProbes = report.combos.length - propCombos.length;
  const measured = propCombos.length;
  const probeSuffix = scaleProbes > 0
    ? `, +${scaleProbes} scale probe${scaleProbes === 1 ? "" : "s"}`
    : "";

  if (measured === 0 && scaleProbes > 0) {
    return `Mode: scale probe (${scaleProbes} point${scaleProbes === 1 ? "" : "s"}, no prop combos)`;
  }

  const capNote = report.warnings?.find((w) => w.includes("prop combos"));
  const generated = capNote?.match(/of (\d+) prop combos/)?.[1];
  return generated
    ? `Mode: prop combos (${measured} measured of ${generated} generated${probeSuffix})`
    : `Mode: prop combos (${measured} measured${probeSuffix})`;
}
