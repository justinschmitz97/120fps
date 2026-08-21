import { describe, it, expect } from "vitest";
import { buildCurveReport, buildMatrixReport, formatTable, type CalibrationResult, type ComboReport, type MatrixAxis, type Report, type Thresholds, type TimingWithCV } from "../../src/report.js";
import type { ReactOptimizations } from "../../src/react-profiler.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";

// commerce-F1: Gallery and VariantSelector auto-activate curve mode because
// their only interesting props are arrays, and curve mode never ran the React
// analysis pass at all — so the Gallery → GridTileImage → Label → Price
// fan-out that combo-mode siblings disclose in full was absent from console
// and JSON alike, with no note that the pass had been skipped.

const calibration: CalibrationResult = { totalDuration: 10, scriptDuration: 5 };
const thresholds: Thresholds = {
  mountMs: 50, interactionMs: 400, interactionStepMs: 67, relativeMount: 2.0, rerenderMs: 16,
};
const machine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};

const FAN_OUT: ReactOptimizations = {
  memoBailout: false,
  contextFanOut: false,
  renderAttribution: [
    { component: "Price", selfDurationMs: 105, renderCount: 169 },
    { component: "Label", selfDurationMs: 40.5, renderCount: 12 },
  ],
};

function timing(median: number): TimingWithCV {
  return { samples: [median], median, p95: median, cv: 0, unstable: false };
}

function shell(overrides: Partial<Report>): Report {
  return {
    version: 1,
    timestamp: "2026-08-21T00:00:00.000Z",
    machine,
    componentPath: "./gallery.tsx",
    componentName: "Gallery",
    calibration,
    combos: [],
    thresholds,
    pass: true,
    ...overrides,
  };
}

function cell(comboIndex: number, props: Record<string, unknown>, opts?: ReactOptimizations): ComboReport {
  return {
    comboIndex,
    props,
    mount: timing(3 + comboIndex),
    unmount: timing(0.5),
    rerender: timing(1),
    domNodeCount: 8,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 0.3,
    verdict: "pass",
    tier: "T1",
    ...(opts ? { reactOptimizations: opts } : {}),
  };
}

describe("render attribution reads the same in every mode that measured it", () => {
  it("prints the section for a matrix run", () => {
    const combos = [cell(0, { open: false }, FAN_OUT), cell(1, { open: true })];
    const axes: MatrixAxis[] = [{ propName: "open", values: [false, true] }];
    const report = shell({
      mode: "matrix",
      combos,
      matrixReport: buildMatrixReport({ axes, combos }),
    });
    const table = formatTable(report);
    expect(table).toContain("React Optimizations");
    expect(table).toContain("Render attribution:");
    expect(table).toContain("Price: 105.0ms self (169 renders)");
  });

  it("prints the section for a curve run, labelled by N", () => {
    const scalePoints = [1, 3, 5];
    const mounts: MountResult[] = scalePoints.map((_, i) => ({
      comboIndex: i,
      props: {},
      mount: { samples: [2 + i], median: 2 + i, p95: 2 + i },
      unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
      domNodeCount: 5 * (i + 1),
    }));
    const rerenders: RerenderResult[] = scalePoints.map((_, i) => ({
      comboIndex: i, props: {}, stable: { samples: [1], median: 1, p95: 1 },
    }));
    const explores: ExploreResult[] = scalePoints.map((_, i) => {
      const nodes = new Map();
      nodes.set("a", { id: "a", depth: 0, interactions: [], pathFromRoot: [] });
      const graph: StateGraph = { nodes, edges: [], initialNodeId: "a", wallClockMs: 10 };
      return { graph, comboIndex: i, props: {} };
    });
    const curve = buildCurveReport({
      propName: "images",
      propKind: "array",
      reason: "array prop",
      scalePoints,
      mounts,
      rerenders,
      explores,
      heapDeltas: scalePoints.map(() => 0),
      calibration,
      thresholds,
    });
    curve.points[2].reactOptimizations = FAN_OUT;

    const table = formatTable(shell({ mode: "curve", scalingCurveReport: curve }));
    expect(table).toContain("React Optimizations");
    expect(table).toContain("N=5:");
    expect(table).toContain("Price: 105.0ms self (169 renders)");
  });

  it("prints no section in a mode whose measurement produced no snapshot", () => {
    const combos = [cell(0, { open: false }), cell(1, { open: true })];
    const axes: MatrixAxis[] = [{ propName: "open", values: [false, true] }];
    const report = shell({ mode: "matrix", combos, matrixReport: buildMatrixReport({ axes, combos }) });
    expect(formatTable(report)).not.toContain("React Optimizations");
  });

  it("keeps combo mode's own section byte-identical", () => {
    const combos = [cell(0, { open: false }, FAN_OUT)];
    const table = formatTable(shell({ combos }));
    expect(table).toContain("React Optimizations");
    expect(table).toContain("    Price: 105.0ms self (169 renders)");
  });
});
