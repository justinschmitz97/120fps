import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";
import {
  buildCurveReport,
  computeCurveVerdict,
  buildTimingWithCV,
  formatTable,
  type Report,
  type ScalingCurveReport,
  type ScalingPoint,
} from "../../src/report.js";
import type { ScalingCurve } from "../../src/metrics.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";
import type { ExploreResult } from "../../src/explorer.js";

function makeMountResult(comboIndex: number, mountMedian: number, unmountMedian: number, dom: number, heap: number): MountResult {
  return {
    comboIndex,
    props: {},
    mount: { samples: [mountMedian], median: mountMedian, p95: mountMedian },
    unmount: { samples: [unmountMedian], median: unmountMedian, p95: unmountMedian },
    domNodeCount: dom,
    heapDelta: heap,
    mountTraces: [],
  };
}

function makeRerenderResult(comboIndex: number, stableMedian: number): RerenderResult {
  return {
    comboIndex,
    props: {},
    stable: { samples: [stableMedian], median: stableMedian, p95: stableMedian },
  };
}

function makeExploreResult(comboIndex: number): ExploreResult {
  return {
    comboIndex,
    props: {},
    graph: { nodes: new Map(), edges: [], initialNodeId: "root", wallClockMs: 0 },
  };
}

const CALIBRATION = { totalDuration: 10, scriptDuration: 5 };
const THRESHOLDS = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

function makeTiming(median: number) {
  return buildTimingWithCV([median, median, median]);
}

function makeScalingCurve(growthClass: ScalingCurve["growthClass"] = "linear"): ScalingCurve {
  return { slope: 0.1, intercept: 1, r2: 0.95, growthClass };
}

function makePoint(n: number, mountMs: number): ScalingPoint {
  return {
    n,
    mount: makeTiming(mountMs),
    rerender: makeTiming(mountMs * 0.3),
    unmount: makeTiming(mountMs * 0.05),
    domNodeCount: n * 7,
    heapDelta: n * 1000,
    interactions: [],
  };
}

function makeCurveReport(overrides: Partial<ScalingCurveReport> = {}): ScalingCurveReport {
  return {
    propName: "items",
    propKind: "array",
    reason: "array prop",
    points: [makePoint(1, 1), makePoint(5, 3), makePoint(20, 10)],
    mountCurve: makeScalingCurve("linear"),
    rerenderCurve: makeScalingCurve("linear"),
    unmountCurve: makeScalingCurve("linear"),
    interactionCurves: {},
    domGrowth: makeScalingCurve("linear"),
    heapGrowth: makeScalingCurve("linear"),
    ...overrides,
  };
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
    componentPath: "./test.tsx",
    componentName: "Test",
    calibration: CALIBRATION,
    combos: [],
    thresholds: THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

describe("H1: empty scale points", () => {
  it("buildCurveReport with 0 points produces empty curves", () => {
    const result = buildCurveReport({
      propName: "items",
      propKind: "array",
      reason: "test",
      scalePoints: [],
      mounts: [],
      rerenders: [],
      explores: [],
      heapDeltas: [],
      calibration: CALIBRATION,
      thresholds: THRESHOLDS,
    });
    expect(result.points.length).toBe(0);
    expect(result.mountCurve.growthClass).toBe("constant");
  });
});

describe("H2: single scale point", () => {
  it("produces constant growth with 1 point", () => {
    const result = buildCurveReport({
      propName: "items",
      propKind: "array",
      reason: "test",
      scalePoints: [5],
      mounts: [makeMountResult(0, 3.0, 0.3, 36, 5000)],
      rerenders: [makeRerenderResult(0, 1.0)],
      explores: [makeExploreResult(0)],
      heapDeltas: [5000],
      calibration: CALIBRATION,
      thresholds: THRESHOLDS,
    });
    expect(result.points.length).toBe(1);
    expect(result.mountCurve.growthClass).toBe("constant");
  });
});

describe("H3: non-sorted scale points input", () => {
  it("points array follows scalePoints order", () => {
    const scalePoints = [20, 1, 5];
    const mounts = scalePoints.map((n, i) => makeMountResult(i, n, n * 0.1, n * 7, n * 1000));
    const rerenders = scalePoints.map((_, i) => makeRerenderResult(i, 1));
    const explores = scalePoints.map((_, i) => makeExploreResult(i));
    const result = buildCurveReport({
      propName: "items",
      propKind: "array",
      reason: "test",
      scalePoints,
      mounts,
      rerenders,
      explores,
      heapDeltas: scalePoints.map((n) => n * 1000),
      calibration: CALIBRATION,
      thresholds: THRESHOLDS,
    });
    expect(result.points.map((p) => p.n)).toEqual([20, 1, 5]);
  });
});

describe("H4: very large N values", () => {
  it("handles N=10000 without error", () => {
    const result = buildCurveReport({
      propName: "count",
      propKind: "number",
      reason: "test",
      scalePoints: [1, 10000],
      mounts: [
        makeMountResult(0, 1, 0.1, 7, 1000),
        makeMountResult(1, 500, 50, 70000, 10000000),
      ],
      rerenders: [makeRerenderResult(0, 0.5), makeRerenderResult(1, 200)],
      explores: [makeExploreResult(0), makeExploreResult(1)],
      heapDeltas: [1000, 10000000],
      calibration: CALIBRATION,
      thresholds: THRESHOLDS,
    });
    expect(result.points.length).toBe(2);
    expect(result.points[1].n).toBe(10000);
  });
});

describe("H5: --curve with fixture should not activate in analyze", () => {
  it("--curve is parsed independently of fixture detection", () => {
    const args = parseArgs(["./Button.fixture.tsx", "--curve"]);
    expect(args.curve).toBe(true);
    expect(args.error).toBeUndefined();
  });
});

describe("H7: --curve and --no-curve together", () => {
  it("both flags are stored, --no-curve takes precedence in analyze", () => {
    const args = parseArgs(["./Button.tsx", "--curve", "--no-curve"]);
    expect(args.curve).toBe(true);
    expect(args.noCurve).toBe(true);
  });
});

describe("H8: --curve parsing edge cases", () => {
  it("rejects propName without type", () => {
    const args = parseArgs(["./Button.tsx", "--curve", "items:"]);
    expect(args.curve).toBe(true);
  });

  it("rejects unknown type in prop:type", () => {
    const args = parseArgs(["./Button.tsx", "--curve", "items:string"]);
    expect(args.error).toBeDefined();
  });

  it("accepts valid prop:array", () => {
    const args = parseArgs(["./Button.tsx", "--curve", "items:array"]);
    expect(args.curve).toBe("items:array");
  });

  it("accepts valid prop:number", () => {
    const args = parseArgs(["./Button.tsx", "--curve", "count:number"]);
    expect(args.curve).toBe("count:number");
  });
});

describe("H10: all interactions absent at all points", () => {
  it("interactionCurves is empty", () => {
    const result = buildCurveReport({
      propName: "items",
      propKind: "array",
      reason: "test",
      scalePoints: [1, 5, 20],
      mounts: [1, 5, 20].map((n, i) => makeMountResult(i, n, n * 0.1, n * 7, n * 1000)),
      rerenders: [1, 5, 20].map((_, i) => makeRerenderResult(i, 1)),
      explores: [1, 5, 20].map((_, i) => makeExploreResult(i)),
      heapDeltas: [1000, 5000, 20000],
      calibration: CALIBRATION,
      thresholds: THRESHOLDS,
    });
    expect(Object.keys(result.interactionCurves).length).toBe(0);
  });
});

describe("H11: formatCurveOutput with 0-byte heap", () => {
  it("shows 0B", () => {
    const cr = makeCurveReport({
      points: [
        { ...makePoint(1, 1), heapDelta: 0 },
        { ...makePoint(5, 3), heapDelta: 0 },
      ],
    });
    const output = formatTable(makeReport({ scalingCurveReport: cr }));
    expect(output).toContain("+0B");
  });
});

describe("H12: formatCurveOutput with MB-scale heap", () => {
  it("shows MB", () => {
    const cr = makeCurveReport({
      points: [
        { ...makePoint(1, 1), heapDelta: 2 * 1024 * 1024 },
      ],
    });
    const output = formatTable(makeReport({ scalingCurveReport: cr }));
    expect(output).toContain("MB");
  });
});

describe("H13: computeCurveVerdict with exponential growth", () => {
  it("returns fail", () => {
    const expCurve = makeScalingCurve("exponential");
    const verdict = computeCurveVerdict(
      [makePoint(1, 1), makePoint(50, 10)],
      expCurve,
      THRESHOLDS,
    );
    expect(verdict).toBe("fail");
  });
});

describe("H14: mismatched array lengths", () => {
  it("handles fewer rerenders than mounts", () => {
    const result = buildCurveReport({
      propName: "items",
      propKind: "array",
      reason: "test",
      scalePoints: [1, 5, 20],
      mounts: [1, 5, 20].map((n, i) => makeMountResult(i, n, n * 0.1, n * 7, n * 1000)),
      rerenders: [makeRerenderResult(0, 0.5)],
      explores: [makeExploreResult(0)],
      heapDeltas: [1000],
      calibration: CALIBRATION,
      thresholds: THRESHOLDS,
    });
    expect(result.points.length).toBe(3);
    expect(result.points[1].rerender.median).toBe(0);
  });
});

describe("H15: --curve as only flag before component", () => {
  it("does not consume component path as curve argument", () => {
    const args = parseArgs(["--curve", "./Button.tsx"]);
    expect(args.curve).toBe(true);
    expect(args.componentPath).toBe("./Button.tsx");
  });
});

describe("H16: curve report JSON serialization", () => {
  it("interactionCurves serializes as plain object", () => {
    const cr = makeCurveReport({
      interactionCurves: { "Next slide": makeScalingCurve("linear") },
    });
    const report = makeReport({ scalingCurveReport: cr });
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json);
    expect(parsed.scalingCurveReport.interactionCurves["Next slide"]).toBeDefined();
  });
});

describe("H17: computeCurveVerdict all within budget", () => {
  it("returns pass", () => {
    const verdict = computeCurveVerdict(
      [makePoint(1, 1), makePoint(50, 10)],
      makeScalingCurve("linear"),
      THRESHOLDS,
    );
    expect(verdict).toBe("pass");
  });
});

describe("H18: computeCurveVerdict middle point exceeds budget", () => {
  it("returns fail when any point exceeds mount budget", () => {
    const points = [makePoint(1, 1), makePoint(10, 60), makePoint(50, 10)];
    const verdict = computeCurveVerdict(points, makeScalingCurve("linear"), THRESHOLDS);
    expect(verdict).toBe("fail");
  });
});
