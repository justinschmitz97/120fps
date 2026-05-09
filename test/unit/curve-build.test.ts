import { describe, it, expect } from "vitest";
import { buildCurveReport, computeCurveVerdict } from "../../src/report.js";
import { computeScalingCurve, type ScalingCurve } from "../../src/metrics.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";
import type { ExploreResult } from "../../src/explorer.js";
import type { CalibrationResult, Thresholds, ScalingPoint } from "../../src/report.js";

function makeMountResult(comboIndex: number, mountMedian: number, unmountMedian: number, dom: number, heap: number): MountResult {
  return {
    comboIndex,
    props: { __120fps_scaleN: comboIndex },
    mount: { samples: [mountMedian, mountMedian, mountMedian], median: mountMedian, p95: mountMedian },
    unmount: { samples: [unmountMedian, unmountMedian, unmountMedian], median: unmountMedian, p95: unmountMedian },
    domNodeCount: dom,
    heapDelta: heap,
    mountTraces: [],
  };
}

function makeRerenderResult(comboIndex: number, stableMedian: number): RerenderResult {
  return {
    comboIndex,
    props: { __120fps_scaleN: comboIndex },
    stable: { samples: [stableMedian, stableMedian, stableMedian], median: stableMedian, p95: stableMedian },
  };
}

function makeExploreResult(comboIndex: number): ExploreResult {
  return {
    comboIndex,
    props: {},
    graph: { nodes: new Map(), edges: [], initialNodeId: "root", wallClockMs: 0 },
  };
}

const CALIBRATION: CalibrationResult = { totalDuration: 10, scriptDuration: 5 };
const THRESHOLDS: Thresholds = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

describe("buildCurveReport", () => {
  it("produces ScalingCurveReport with correct points", () => {
    const scalePoints = [1, 5, 20];
    const mounts = [
      makeMountResult(0, 1.0, 0.1, 8, 1000),
      makeMountResult(1, 3.0, 0.3, 36, 5000),
      makeMountResult(2, 10.0, 1.0, 141, 20000),
    ];
    const rerenders = [
      makeRerenderResult(0, 0.5),
      makeRerenderResult(1, 1.2),
      makeRerenderResult(2, 4.0),
    ];
    const explores = [
      makeExploreResult(0),
      makeExploreResult(1),
      makeExploreResult(2),
    ];
    const result = buildCurveReport({
      propName: "items",
      propKind: "array",
      reason: "array prop",
      scalePoints,
      mounts,
      rerenders,
      explores,
      heapDeltas: [1000, 5000, 20000],
      calibration: CALIBRATION,
      thresholds: THRESHOLDS,
    });

    expect(result.propName).toBe("items");
    expect(result.propKind).toBe("array");
    expect(result.points.length).toBe(3);
    expect(result.points[0].n).toBe(1);
    expect(result.points[1].n).toBe(5);
    expect(result.points[2].n).toBe(20);
    expect(result.points[0].mount.median).toBe(1.0);
    expect(result.points[2].mount.median).toBe(10.0);
  });

  it("computes growth curves for all dimensions", () => {
    const scalePoints = [1, 5, 20, 50];
    const mounts = scalePoints.map((n, i) =>
      makeMountResult(i, n * 0.3, n * 0.05, n * 7, n * 1000),
    );
    const rerenders = scalePoints.map((n, i) =>
      makeRerenderResult(i, n * 0.1),
    );
    const explores = scalePoints.map((_, i) => makeExploreResult(i));
    const result = buildCurveReport({
      propName: "count",
      propKind: "number",
      reason: "numeric prop",
      scalePoints,
      mounts,
      rerenders,
      explores,
      heapDeltas: scalePoints.map((n) => n * 1000),
      calibration: CALIBRATION,
      thresholds: THRESHOLDS,
    });

    expect(result.mountCurve).toBeDefined();
    expect(result.rerenderCurve).toBeDefined();
    expect(result.unmountCurve).toBeDefined();
    expect(result.domGrowth).toBeDefined();
    expect(result.heapGrowth).toBeDefined();
  });

  it("sets interactionCurves for interactions present at ≥2 points", () => {
    const scalePoints = [1, 5, 20];
    const mounts = scalePoints.map((n, i) =>
      makeMountResult(i, n, n * 0.1, n * 7, n * 1000),
    );
    const rerenders = scalePoints.map((n, i) => makeRerenderResult(i, n * 0.1));
    const explores: ExploreResult[] = scalePoints.map((_, i) => ({
      comboIndex: i,
      props: {},
      graph: {
        nodes: new Map(),
        edges: i >= 1
          ? [{
              id: "e1",
              fromId: "root",
              toId: "state-1",
              interaction: { selector: "button", type: "click" as const, label: "Next" },
              samples: [5, 5, 5],
              median: 5,
              p95: 5,
              traces: [],
            }]
          : [],
        initialNodeId: "root",
        wallClockMs: 0,
      },
    }));

    const result = buildCurveReport({
      propName: "items",
      propKind: "array",
      reason: "array prop",
      scalePoints,
      mounts,
      rerenders,
      explores,
      heapDeltas: scalePoints.map((n) => n * 1000),
      calibration: CALIBRATION,
      thresholds: THRESHOLDS,
    });

    expect(result.interactionCurves["Next"]).toBeDefined();
  });

  it("excludes interaction curves for interactions present at only 1 point", () => {
    const scalePoints = [1, 5, 20];
    const mounts = scalePoints.map((n, i) =>
      makeMountResult(i, n, n * 0.1, n * 7, n * 1000),
    );
    const rerenders = scalePoints.map((n, i) => makeRerenderResult(i, n * 0.1));
    const explores: ExploreResult[] = scalePoints.map((_, i) => ({
      comboIndex: i,
      props: {},
      graph: {
        nodes: new Map(),
        edges: i === 2
          ? [{
              id: "e1",
              fromId: "root",
              toId: "state-1",
              interaction: { selector: "button", type: "click" as const, label: "Rare" },
              samples: [5],
              median: 5,
              p95: 5,
              traces: [],
            }]
          : [],
        initialNodeId: "root",
        wallClockMs: 0,
      },
    }));

    const result = buildCurveReport({
      propName: "items",
      propKind: "array",
      reason: "array prop",
      scalePoints,
      mounts,
      rerenders,
      explores,
      heapDeltas: scalePoints.map((n) => n * 1000),
      calibration: CALIBRATION,
      thresholds: THRESHOLDS,
    });

    expect(result.interactionCurves["Rare"]).toBeUndefined();
  });
});

describe("computeCurveVerdict", () => {
  function makeLinearCurve(): ScalingCurve {
    return { slope: 0.1, intercept: 1, r2: 0.95, growthClass: "linear" };
  }

  function makeQuadraticCurve(): ScalingCurve {
    return { slope: 0.01, intercept: 1, r2: 0.95, growthClass: "quadratic" };
  }

  it("returns pass for linear growth within budget", () => {
    const points: ScalingPoint[] = [
      { n: 1, mount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false }, rerender: { samples: [0.3], median: 0.3, p95: 0.3, cv: 0, unstable: false }, unmount: { samples: [0.1], median: 0.1, p95: 0.1, cv: 0, unstable: false }, domNodeCount: 8, heapDelta: 1000, interactions: [] },
      { n: 50, mount: { samples: [18], median: 18, p95: 18, cv: 0, unstable: false }, rerender: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false }, unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false }, domNodeCount: 351, heapDelta: 240000, interactions: [] },
    ];
    const verdict = computeCurveVerdict(points, makeLinearCurve(), THRESHOLDS);
    expect(verdict).toBe("pass");
  });

  it("returns fail for super-linear (quadratic) growth", () => {
    const points: ScalingPoint[] = [
      { n: 1, mount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false }, rerender: { samples: [0.3], median: 0.3, p95: 0.3, cv: 0, unstable: false }, unmount: { samples: [0.1], median: 0.1, p95: 0.1, cv: 0, unstable: false }, domNodeCount: 8, heapDelta: 1000, interactions: [] },
    ];
    const verdict = computeCurveVerdict(points, makeQuadraticCurve(), THRESHOLDS);
    expect(verdict).toBe("fail");
  });

  it("returns fail when highest-N point exceeds mount budget", () => {
    const points: ScalingPoint[] = [
      { n: 1, mount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false }, rerender: { samples: [0.3], median: 0.3, p95: 0.3, cv: 0, unstable: false }, unmount: { samples: [0.1], median: 0.1, p95: 0.1, cv: 0, unstable: false }, domNodeCount: 8, heapDelta: 1000, interactions: [] },
      { n: 50, mount: { samples: [80], median: 80, p95: 80, cv: 0, unstable: false }, rerender: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false }, unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false }, domNodeCount: 351, heapDelta: 240000, interactions: [] },
    ];
    const verdict = computeCurveVerdict(points, makeLinearCurve(), THRESHOLDS);
    expect(verdict).toBe("fail");
  });

  it("returns warn when highest-N mount is >75% of budget", () => {
    const points: ScalingPoint[] = [
      { n: 1, mount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false }, rerender: { samples: [0.3], median: 0.3, p95: 0.3, cv: 0, unstable: false }, unmount: { samples: [0.1], median: 0.1, p95: 0.1, cv: 0, unstable: false }, domNodeCount: 8, heapDelta: 1000, interactions: [] },
      { n: 50, mount: { samples: [40], median: 40, p95: 40, cv: 0, unstable: false }, rerender: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false }, unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false }, domNodeCount: 351, heapDelta: 240000, interactions: [] },
    ];
    const verdict = computeCurveVerdict(points, makeLinearCurve(), THRESHOLDS);
    expect(verdict).toBe("warn");
  });
});
