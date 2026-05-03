import { describe, it, expect } from "vitest";
import { analyze, buildReport, type BuildReportInput } from "../../src/analyze.js";
import type { MountResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";
import type { CdpMetrics } from "../../src/metrics.js";
import type { CalibrationResult, Thresholds } from "../../src/report.js";

function makeMountResult(overrides: Partial<MountResult> = {}): MountResult {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [1.5, 1.5, 1.5, 1.5, 1.5], median: 1.5, p95: 1.5 },
    unmount: { samples: [0.5, 0.5, 0.5, 0.5, 0.5], median: 0.5, p95: 0.5 },
    domNodeCount: 10,
    ...overrides,
  };
}

function makeEmptyGraph(): StateGraph {
  const nodes = new Map();
  nodes.set("abc", { id: "abc", depth: 0, interactions: [], pathFromRoot: [] });
  return { nodes, edges: [], initialNodeId: "abc", wallClockMs: 100 };
}

function makeExploreResult(overrides: Partial<ExploreResult> = {}): ExploreResult {
  return {
    graph: makeEmptyGraph(),
    comboIndex: 0,
    props: {},
    ...overrides,
  };
}

function makeCalibration(overrides: Partial<CalibrationResult> = {}): CalibrationResult {
  return { totalDuration: 10, scriptDuration: 5, ...overrides };
}

const baseMachine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};
const baseThresholds: Thresholds = { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 };

describe("buildReport", () => {
  it("produces a valid Report with version 1", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 4, ramMb: 16384,
        os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
      },
      calibration: makeCalibration(),
      mounts: [makeMountResult()],
      explores: [makeExploreResult()],
      heapDeltas: [1024],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
    };
    const report = buildReport(input);
    expect(report.version).toBe(1);
    expect(report.componentName).toBe("Button");
    expect(report.combos).toHaveLength(1);
    expect(report.pass).toBe(true);
  });

  it("computes relativeMount as mount.median / calibration.totalDuration", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 4, ramMb: 16384,
        os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
      },
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [makeMountResult({ mount: { samples: [5, 5], median: 5, p95: 5 } })],
      explores: [makeExploreResult()],
      heapDeltas: [0],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
    };
    const report = buildReport(input);
    expect(report.combos[0].relativeMount).toBeCloseTo(0.5, 2);
  });

  it("sets pass=false when any combo fails", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 4, ramMb: 16384,
        os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
      },
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [makeMountResult({ mount: { samples: [20, 20], median: 20, p95: 20 } })],
      explores: [makeExploreResult()],
      heapDeltas: [0],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
    };
    const report = buildReport(input);
    expect(report.pass).toBe(false);
    expect(report.combos[0].verdict).toBe("fail");
  });

  it("includes heapDelta from input", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 4, ramMb: 16384,
        os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
      },
      calibration: makeCalibration(),
      mounts: [makeMountResult()],
      explores: [makeExploreResult()],
      heapDeltas: [2048],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
    };
    const report = buildReport(input);
    expect(report.combos[0].heapDelta).toBe(2048);
  });

  it("extracts interactions from explore edges", () => {
    const graph = makeEmptyGraph();
    graph.edges.push({
      id: "e1",
      fromId: "abc",
      toId: "def",
      interaction: { type: "click", selector: "button", tagName: "BUTTON", label: "Submit" },
      samples: [8, 8, 8],
      median: 8,
      p95: 8,
      traces: [],
    });
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 4, ramMb: 16384,
        os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
      },
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [makeMountResult()],
      explores: [{ graph, comboIndex: 0, props: {} }],
      heapDeltas: [0],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
    };
    const report = buildReport(input);
    expect(report.combos[0].interactions).toHaveLength(1);
    expect(report.combos[0].interactions[0].label).toBe("Submit");
    expect(report.combos[0].interactions[0].relativeTiming).toBeCloseTo(0.8, 2);
  });

  it("handles missing explore result for a combo gracefully", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 4, ramMb: 16384,
        os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
      },
      calibration: makeCalibration(),
      mounts: [makeMountResult()],
      explores: [],
      heapDeltas: [0],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
    };
    const report = buildReport(input);
    expect(report.combos[0].interactions).toHaveLength(0);
  });

  it("computes scaling curve when combos have different DOM sizes", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 4, ramMb: 16384,
        os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
      },
      calibration: makeCalibration(),
      mounts: [
        makeMountResult({ comboIndex: 0, domNodeCount: 10, mount: { samples: [5], median: 5, p95: 5 } }),
        makeMountResult({ comboIndex: 1, domNodeCount: 50, mount: { samples: [25], median: 25, p95: 25 } }),
        makeMountResult({ comboIndex: 2, domNodeCount: 100, mount: { samples: [50], median: 50, p95: 50 } }),
      ],
      explores: [
        makeExploreResult({ comboIndex: 0 }),
        makeExploreResult({ comboIndex: 1 }),
        makeExploreResult({ comboIndex: 2 }),
      ],
      heapDeltas: [0, 0, 0],
      thresholds: { mountMs: 100, interactionMs: 100, relativeMount: 20.0, rerenderMs: 100 },
    };
    const report = buildReport(input);
    expect(report.combos[0].scalingCurve).not.toBeNull();
    expect(report.combos[0].scalingCurve!.growthClass).toBe("linear");
    expect(report.combos[1].scalingCurve).toEqual(report.combos[0].scalingCurve);
  });

  it("leaves scalingCurve null when all combos have same DOM size", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 4, ramMb: 16384,
        os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
      },
      calibration: makeCalibration(),
      mounts: [
        makeMountResult({ comboIndex: 0, domNodeCount: 10 }),
        makeMountResult({ comboIndex: 1, domNodeCount: 10 }),
      ],
      explores: [makeExploreResult({ comboIndex: 0 }), makeExploreResult({ comboIndex: 1 })],
      heapDeltas: [0, 0],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
    };
    const report = buildReport(input);
    expect(report.combos[0].scalingCurve).toBeNull();
  });

  it("leaves scalingCurve null for single combo", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 4, ramMb: 16384,
        os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
      },
      calibration: makeCalibration(),
      mounts: [makeMountResult()],
      explores: [makeExploreResult()],
      heapDeltas: [0],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
    };
    const report = buildReport(input);
    expect(report.combos[0].scalingCurve).toBeNull();
  });

  it("produces empty combos and pass=true for empty mounts", () => {
    const report = buildReport({
      componentPath: "./Empty.tsx",
      componentName: "Empty",
      machine: baseMachine,
      calibration: makeCalibration(),
      mounts: [],
      explores: [],
      heapDeltas: [],
      thresholds: baseThresholds,
    });
    expect(report.combos).toHaveLength(0);
    expect(report.pass).toBe(true);
  });

  it("produces 0 interactions when explore comboIndex does not match mount", () => {
    const report = buildReport({
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: makeCalibration(),
      mounts: [makeMountResult({ comboIndex: 0 })],
      explores: [makeExploreResult({ comboIndex: 99 })],
      heapDeltas: [0],
      thresholds: baseThresholds,
    });
    expect(report.combos[0].interactions).toHaveLength(0);
  });

  it("sets relativeMount=0 when calibration.totalDuration is 0", () => {
    const report = buildReport({
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: makeCalibration({ totalDuration: 0 }),
      mounts: [makeMountResult()],
      explores: [makeExploreResult()],
      heapDeltas: [0],
      thresholds: baseThresholds,
    });
    expect(report.combos[0].relativeMount).toBe(0);
  });

  it("does not crash with NaN in samples", () => {
    const report = buildReport({
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: makeCalibration(),
      mounts: [makeMountResult({ mount: { samples: [NaN, 5], median: NaN, p95: 5 } })],
      explores: [makeExploreResult()],
      heapDeltas: [0],
      thresholds: baseThresholds,
    });
    expect(report.combos).toHaveLength(1);
  });

  it("sets interaction relativeTiming=0 when calibration.totalDuration is 0", () => {
    const graph = makeEmptyGraph();
    graph.edges.push({
      id: "e1",
      fromId: "abc",
      toId: "def",
      interaction: { type: "click", selector: "button", tagName: "BUTTON", label: "OK" },
      samples: [10, 10],
      median: 10,
      p95: 10,
      traces: [],
    });
    const report = buildReport({
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: makeCalibration({ totalDuration: 0 }),
      mounts: [makeMountResult()],
      explores: [{ graph, comboIndex: 0, props: {} }],
      heapDeltas: [0],
      thresholds: baseThresholds,
    });
    expect(report.combos[0].interactions[0].relativeTiming).toBe(0);
  });

  it("uses first matching explore when duplicates exist for same comboIndex", () => {
    const graph1 = makeEmptyGraph();
    graph1.edges.push({
      id: "e1",
      fromId: "abc",
      toId: "def",
      interaction: { type: "click", selector: "button", tagName: "BUTTON", label: "First" },
      samples: [5],
      median: 5,
      p95: 5,
      traces: [],
    });
    const graph2 = makeEmptyGraph();
    graph2.edges.push({
      id: "e2",
      fromId: "abc",
      toId: "ghi",
      interaction: { type: "click", selector: "a", tagName: "A", label: "Second" },
      samples: [5],
      median: 5,
      p95: 5,
      traces: [],
    });
    graph2.edges.push({
      id: "e3",
      fromId: "abc",
      toId: "jkl",
      interaction: { type: "click", selector: "span", tagName: "SPAN", label: "Third" },
      samples: [5],
      median: 5,
      p95: 5,
      traces: [],
    });
    const report = buildReport({
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: makeCalibration(),
      mounts: [makeMountResult()],
      explores: [
        { graph: graph1, comboIndex: 0, props: {} },
        { graph: graph2, comboIndex: 0, props: {} },
      ],
      heapDeltas: [0],
      thresholds: baseThresholds,
    });
    expect(report.combos[0].interactions).toHaveLength(1);
    expect(report.combos[0].interactions[0].label).toBe("First");
  });
});

describe("analyze", () => {
  it("throws on non-existent component file", async () => {
    await expect(analyze("./nonexistent-component.tsx")).rejects.toThrow("not found");
  });
});
