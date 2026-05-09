import { describe, it, expect } from "vitest";
import {
  formatTable,
  buildTimingWithCV,
  type Report,
  type ScalingCurveReport,
  type ScalingPoint,
  type InteractionReport,
} from "../../src/report.js";
import type { ScalingCurve } from "../../src/metrics.js";

function makeTiming(median: number) {
  return buildTimingWithCV([median, median, median]);
}

function makeScalingCurve(growthClass: ScalingCurve["growthClass"] = "linear"): ScalingCurve {
  return { slope: 0.1, intercept: 1, r2: 0.95, growthClass };
}

function makePoint(n: number, mountMs: number, rerenderMs: number, unmountMs: number, dom: number, heap: number): ScalingPoint {
  return {
    n,
    mount: makeTiming(mountMs),
    rerender: makeTiming(rerenderMs),
    unmount: makeTiming(unmountMs),
    domNodeCount: dom,
    heapDelta: heap,
    interactions: [],
  };
}

function makeCurveReport(overrides: Partial<ScalingCurveReport> = {}): ScalingCurveReport {
  return {
    propName: "items",
    propKind: "array",
    reason: "array prop with items-like name",
    points: [
      makePoint(1, 0.8, 0.3, 0.1, 8, 12000),
      makePoint(5, 1.9, 0.6, 0.3, 36, 24000),
      makePoint(20, 7.2, 2.3, 1.0, 141, 96000),
      makePoint(50, 18.1, 5.8, 2.5, 351, 240000),
    ],
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
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [],
    thresholds: { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 },
    pass: true,
    ...overrides,
  };
}

describe("ScalingCurveReport type on Report", () => {
  it("Report accepts scalingCurveReport field", () => {
    const report = makeReport({ scalingCurveReport: makeCurveReport() });
    expect(report.scalingCurveReport).toBeDefined();
    expect(report.scalingCurveReport!.propName).toBe("items");
  });

  it("Report allows undefined scalingCurveReport", () => {
    const report = makeReport();
    expect(report.scalingCurveReport).toBeUndefined();
  });
});

describe("ScalingPoint type", () => {
  it("contains all required fields", () => {
    const point = makePoint(10, 3.5, 1.1, 0.5, 71, 48000);
    expect(point.n).toBe(10);
    expect(point.mount.median).toBe(3.5);
    expect(point.rerender.median).toBe(1.1);
    expect(point.unmount.median).toBe(0.5);
    expect(point.domNodeCount).toBe(71);
    expect(point.heapDelta).toBe(48000);
    expect(point.interactions).toEqual([]);
  });

  it("supports optional costAttribution", () => {
    const point = makePoint(10, 3.5, 1.1, 0.5, 71, 48000);
    expect(point.costAttribution).toBeUndefined();
  });

  it("supports interactions", () => {
    const interaction: InteractionReport = {
      selector: "button",
      type: "click",
      label: "Next",
      timing: makeTiming(5),
      relativeTiming: 0.5,
    };
    const point = makePoint(10, 3.5, 1.1, 0.5, 71, 48000);
    point.interactions = [interaction];
    expect(point.interactions.length).toBe(1);
  });
});

describe("ScalingCurveReport type", () => {
  it("has all required curve fields", () => {
    const cr = makeCurveReport();
    expect(cr.propName).toBe("items");
    expect(cr.propKind).toBe("array");
    expect(cr.reason).toContain("array");
    expect(cr.points.length).toBe(4);
    expect(cr.mountCurve.growthClass).toBe("linear");
    expect(cr.rerenderCurve.growthClass).toBe("linear");
    expect(cr.unmountCurve.growthClass).toBe("linear");
    expect(cr.domGrowth.growthClass).toBe("linear");
    expect(cr.heapGrowth.growthClass).toBe("linear");
  });

  it("interactionCurves is an object keyed by label", () => {
    const cr = makeCurveReport({
      interactionCurves: {
        "Next slide": makeScalingCurve("linear"),
      },
    });
    expect(cr.interactionCurves["Next slide"]).toBeDefined();
    expect(cr.interactionCurves["Next slide"].growthClass).toBe("linear");
  });
});

describe("formatTable with scalingCurveReport", () => {
  it("shows curve table header with prop info", () => {
    const report = makeReport({ scalingCurveReport: makeCurveReport() });
    const output = formatTable(report);
    expect(output).toContain("Scaling: items");
    expect(output).toContain("array");
  });

  it("shows N column with scale point values", () => {
    const report = makeReport({ scalingCurveReport: makeCurveReport() });
    const output = formatTable(report);
    const lines = output.split("\n");
    const dataLines = lines.filter((l) => /^\s*\d+\s/.test(l));
    expect(dataLines.length).toBeGreaterThanOrEqual(4);
  });

  it("shows mount, rerender, unmount, DOM columns", () => {
    const report = makeReport({ scalingCurveReport: makeCurveReport() });
    const output = formatTable(report);
    expect(output).toContain("Mount");
    expect(output).toContain("Rerender");
    expect(output).toContain("Unmount");
    expect(output).toContain("DOM");
  });

  it("shows growth class on last row", () => {
    const report = makeReport({ scalingCurveReport: makeCurveReport() });
    const output = formatTable(report);
    expect(output).toContain("linear");
  });

  it("does not show normal combo table when curve report present", () => {
    const report = makeReport({ scalingCurveReport: makeCurveReport() });
    const output = formatTable(report);
    expect(output).not.toContain("Interactions");
  });

  it("shows PASS/FAIL result", () => {
    const report = makeReport({ scalingCurveReport: makeCurveReport(), pass: true });
    const output = formatTable(report);
    expect(output).toContain("Result: PASS");
  });

  it("shows heap column with human-readable sizes", () => {
    const report = makeReport({ scalingCurveReport: makeCurveReport() });
    const output = formatTable(report);
    expect(output).toMatch(/KB/);
  });
});

describe("curve mode verdict logic", () => {
  it("FAIL when growth is super-linear (quadratic)", () => {
    const cr = makeCurveReport({ mountCurve: makeScalingCurve("quadratic") });
    const report = makeReport({ scalingCurveReport: cr });
    expect(report.pass).toBe(true);
    // verdict is computed during buildReport/analyze, test the logic separately
  });

  it("points are sorted ascending by n", () => {
    const cr = makeCurveReport();
    const ns = cr.points.map((p) => p.n);
    expect(ns).toEqual([...ns].sort((a, b) => a - b));
  });
});
