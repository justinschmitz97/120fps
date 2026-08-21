import { describe, it, expect } from "vitest";
import { buildCurveReport, formatTable, type CalibrationResult, type Report, type Thresholds } from "../../src/report.js";
import { hintsForReport } from "../../src/hints.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";

// commerce-F2: VariantSelector's N=1 point measured the component's own
// `return null` short-circuit and was fitted as an ordinary point under
// "Growth: mount linear", with only a raw DOM 0 cell to give it away.
// dub-F6 (M106 C3): six scale points, every one of them 0 DOM nodes because a
// provider was missing, printed Result: PASS.

const baseCalibration: CalibrationResult = { totalDuration: 10, scriptDuration: 5 };
const baseThresholds: Thresholds = {
  mountMs: 50, interactionMs: 400, interactionStepMs: 67, relativeMount: 2.0, rerenderMs: 16,
};

function mount(comboIndex: number, mountMs: number, domNodeCount: number, pageErrors?: MountResult["pageErrors"]): MountResult {
  return {
    comboIndex,
    props: {},
    mount: { samples: [mountMs, mountMs, mountMs], median: mountMs, p95: mountMs },
    unmount: { samples: [0.5, 0.5, 0.5], median: 0.5, p95: 0.5 },
    domNodeCount,
    ...(pageErrors ? { pageErrors } : {}),
  };
}

function rerender(comboIndex: number, ms: number): RerenderResult {
  return { comboIndex, props: {}, stable: { samples: [ms, ms, ms], median: ms, p95: ms } };
}

function explore(comboIndex: number): ExploreResult {
  const nodes = new Map();
  nodes.set("a", { id: "a", depth: 0, interactions: [], pathFromRoot: [] });
  const graph: StateGraph = { nodes, edges: [], initialNodeId: "a", wallClockMs: 10 };
  return { graph, comboIndex, props: {} };
}

// N=1 renders nothing (the component's own short-circuit); the rest grow
// linearly with a clean 5-nodes-per-item DOM.
const SCALE_POINTS = [1, 3, 5, 10];
function commerceShaped() {
  const doms = [0, 15, 25, 50];
  const mountsMs = [2.5, 3, 4, 6];
  return buildCurveReport({
    propName: "options",
    propKind: "array",
    reason: "array prop",
    scalePoints: SCALE_POINTS,
    mounts: SCALE_POINTS.map((_, i) => mount(i, mountsMs[i], doms[i])),
    rerenders: SCALE_POINTS.map((_, i) => rerender(i, mountsMs[i])),
    explores: SCALE_POINTS.map((_, i) => explore(i)),
    heapDeltas: SCALE_POINTS.map(() => 0),
    calibration: baseCalibration,
    thresholds: baseThresholds,
  });
}

function curveReportShell(curve: ReturnType<typeof buildCurveReport>, pass = true): Report {
  return {
    version: 1,
    timestamp: "2026-08-21T00:00:00.000Z",
    machine: { cpu: "Test", cores: 4, ramMb: 16384, os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0" },
    componentPath: "./variant-selector.tsx",
    componentName: "VariantSelector",
    calibration: baseCalibration,
    combos: [],
    thresholds: baseThresholds,
    pass,
    mode: "curve",
    scalingCurveReport: curve,
  };
}

describe("a curve point that renders nothing is not an ordinary point on the curve", () => {
  it("marks the point empty and keeps it in the report", () => {
    const curve = commerceShaped();
    expect(curve.points).toHaveLength(4);
    expect(curve.points[0].renderHealth).toBe("empty");
    expect(curve.points.slice(1).every((p) => p.renderHealth === undefined)).toBe(true);
  });

  it("excludes it from the fit and says which N was excluded", () => {
    const curve = commerceShaped();
    expect(curve.fitExcludedPoints).toEqual([1]);
    // DOM growth over the rendering points alone is exactly 5 nodes per item.
    expect(curve.domGrowth.growthClass).toBe("linear");
  });

  it("tags the row so the DOM column is not the only signal", () => {
    const table = formatTable(curveReportShell(commerceShaped()));
    expect(table).toContain("renders nothing at N=1");
  });

  it("says on the growth line which points the fit describes", () => {
    const table = formatTable(curveReportShell(commerceShaped()));
    expect(table).toMatch(/Growth: mount .*\n?.*excluded/s);
  });

  it("leaves a curve whose every point rendered untouched", () => {
    const doms = [5, 15, 25, 50];
    const curve = buildCurveReport({
      propName: "options",
      propKind: "array",
      reason: "array prop",
      scalePoints: SCALE_POINTS,
      mounts: SCALE_POINTS.map((_, i) => mount(i, 2 + i, doms[i])),
      rerenders: SCALE_POINTS.map((_, i) => rerender(i, 2 + i)),
      explores: SCALE_POINTS.map((_, i) => explore(i)),
      heapDeltas: SCALE_POINTS.map(() => 0),
      calibration: baseCalibration,
      thresholds: baseThresholds,
    });
    expect(curve.fitExcludedPoints).toBeUndefined();
    expect(formatTable(curveReportShell(curve))).not.toContain("renders nothing");
  });

  it("keeps every point in the fit when too few rendered to fit anything else", () => {
    const doms = [0, 0, 0, 12];
    const curve = buildCurveReport({
      propName: "options",
      propKind: "array",
      reason: "array prop",
      scalePoints: SCALE_POINTS,
      mounts: SCALE_POINTS.map((_, i) => mount(i, 2 + i, doms[i])),
      rerenders: SCALE_POINTS.map((_, i) => rerender(i, 2 + i)),
      explores: SCALE_POINTS.map((_, i) => explore(i)),
      heapDeltas: SCALE_POINTS.map(() => 0),
      calibration: baseCalibration,
      thresholds: baseThresholds,
    });
    expect(curve.fitExcludedPoints).toBeUndefined();
    expect(curve.points.filter((p) => p.renderHealth === "empty")).toHaveLength(3);
  });

  it("carries the point's own page errors onto the point", () => {
    const withErrors = mount(0, 2.5, 0, {
      messages: ["`Tooltip` must be used within `TooltipProvider`"],
      fatal: false,
      dropped: 0,
    });
    const curve = buildCurveReport({
      propName: "options",
      propKind: "array",
      reason: "array prop",
      scalePoints: SCALE_POINTS,
      mounts: [withErrors, mount(1, 3, 15), mount(2, 4, 25), mount(3, 6, 50)],
      rerenders: SCALE_POINTS.map((_, i) => rerender(i, 3)),
      explores: SCALE_POINTS.map((_, i) => explore(i)),
      heapDeltas: SCALE_POINTS.map(() => 0),
      calibration: baseCalibration,
      thresholds: baseThresholds,
    });
    expect(curve.points[0].renderHealth).toBe("empty");
    expect(curve.points[0].pageErrors).toEqual(["`Tooltip` must be used within `TooltipProvider`"]);
  });

  it("marks a point whose own render threw as an error, not merely empty", () => {
    const threw = mount(0, 2.5, 0, { messages: ["TypeError: boom"], fatal: true, dropped: 0 });
    const curve = buildCurveReport({
      propName: "options",
      propKind: "array",
      reason: "array prop",
      scalePoints: SCALE_POINTS,
      mounts: [threw, mount(1, 3, 15), mount(2, 4, 25), mount(3, 6, 50)],
      rerenders: SCALE_POINTS.map((_, i) => rerender(i, 3)),
      explores: SCALE_POINTS.map((_, i) => explore(i)),
      heapDeltas: SCALE_POINTS.map(() => 0),
      calibration: baseCalibration,
      thresholds: baseThresholds,
    });
    expect(curve.points[0].renderHealth).toBe("error");
    expect(curve.fitExcludedPoints).toEqual([1]);
  });
});

// dub-F6: six scale points, every one 0 DOM nodes. The run must not pass, and
// the flat-DOM hint must not send the reader after the scaling prop when what
// actually happened is that the component never rendered at all.
describe("a curve whose every point rendered nothing", () => {
  function emptyCurve() {
    const curve = buildCurveReport({
      propName: "options",
      propKind: "array",
      reason: "array prop",
      scalePoints: SCALE_POINTS,
      mounts: SCALE_POINTS.map((_, i) => mount(i, 2 + i, 0)),
      rerenders: SCALE_POINTS.map((_, i) => rerender(i, 1)),
      explores: SCALE_POINTS.map((_, i) => explore(i)),
      heapDeltas: SCALE_POINTS.map(() => 0),
      calibration: baseCalibration,
      thresholds: baseThresholds,
    });
    curve.domFlat = true;
    return curve;
  }

  it("keeps every point in the fit, since excluding them leaves nothing", () => {
    expect(emptyCurve().fitExcludedPoints).toBeUndefined();
  });

  it("withholds the flat-DOM hint, whose remedy names the wrong thing", () => {
    const report = curveReportShell(emptyCurve(), false);
    expect(hintsForReport(report)).not.toContain("domFlat");
  });

  it("still offers the flat-DOM hint when the points did render", () => {
    const curve = buildCurveReport({
      propName: "options",
      propKind: "array",
      reason: "array prop",
      scalePoints: SCALE_POINTS,
      mounts: SCALE_POINTS.map((_, i) => mount(i, 2 + i, 12)),
      rerenders: SCALE_POINTS.map((_, i) => rerender(i, 1)),
      explores: SCALE_POINTS.map((_, i) => explore(i)),
      heapDeltas: SCALE_POINTS.map(() => 0),
      calibration: baseCalibration,
      thresholds: baseThresholds,
    });
    curve.domFlat = true;
    expect(hintsForReport(curveReportShell(curve, false))).toContain("domFlat");
  });
});
