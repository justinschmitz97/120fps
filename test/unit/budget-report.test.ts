import { describe, it, expect } from "vitest";
import {
  formatTable,
  buildTimingWithCV,
  type Report,
  type Thresholds,
  type BaselineComparison,
  type Regression,
  type Improvement,
} from "../../src/report.js";

const THRESHOLDS: Thresholds = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

function makeTiming(median: number) {
  return buildTimingWithCV([median, median, median]);
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
    componentPath: "./test.tsx",
    componentName: "Test",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [{
      comboIndex: 0,
      props: {},
      mount: makeTiming(1.0),
      unmount: makeTiming(0.1),
      rerender: makeTiming(0.5),
      domNodeCount: 8,
      heapDelta: 0,
      interactions: [],
      scalingCurve: null,
      relativeMount: 0.1,
      verdict: "pass" as const,
    }],
    thresholds: THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

describe("Report with baseline", () => {
  it("baseline field is optional on Report", () => {
    const report = makeReport();
    expect(report.baseline).toBeUndefined();
  });

  it("report accepts BaselineComparison", () => {
    const comparison: BaselineComparison = {
      hasBaseline: true,
      regressions: [{
        metric: "mount",
        baseline: 1.0,
        current: 1.2,
        deltaPercent: 20,
        tolerance: 10,
      }],
      improvements: [],
    };
    const report = makeReport({ baseline: comparison });
    expect(report.baseline!.regressions).toHaveLength(1);
  });
});

describe("formatTable with baseline", () => {
  it("includes baseline section when hasBaseline is true", () => {
    const comparison: BaselineComparison = {
      hasBaseline: true,
      regressions: [{
        metric: "mount",
        baseline: 0.82,
        current: 0.95,
        deltaPercent: 15.9,
        tolerance: 10,
      }],
      improvements: [{
        metric: "rerender",
        baseline: 0.31,
        current: 0.29,
        deltaPercent: -6.5,
      }],
    };
    const output = formatTable(makeReport({ baseline: comparison }));
    expect(output).toContain("Baseline");
    expect(output).toContain("REGRESSED");
  });

  it("omits baseline section when no baseline", () => {
    const output = formatTable(makeReport());
    expect(output).not.toContain("Baseline");
    expect(output).not.toContain("REGRESSED");
  });

  it("shows OK for non-regressed metrics", () => {
    const comparison: BaselineComparison = {
      hasBaseline: true,
      regressions: [],
      improvements: [],
    };
    const output = formatTable(makeReport({ baseline: comparison }));
    expect(output).toContain("Baseline");
    expect(output).toContain("OK");
  });

  it("shows improvement with negative delta", () => {
    const comparison: BaselineComparison = {
      hasBaseline: true,
      regressions: [],
      improvements: [{
        metric: "mount",
        baseline: 1.0,
        current: 0.8,
        deltaPercent: -20,
      }],
    };
    const output = formatTable(makeReport({ baseline: comparison }));
    expect(output).toContain("-20");
  });
});
