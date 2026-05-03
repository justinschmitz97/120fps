import { describe, it, expect } from "vitest";
import { formatTable, type Report } from "../../src/report.js";

describe("Auto-scaling in Report", () => {
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
        mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
        unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
        rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
        domNodeCount: 10,
        heapDelta: 0,
        interactions: [],
        scalingCurve: { slope: 0.1, intercept: 1, r2: 0.95, growthClass: "linear" as const },
        relativeMount: 0.5,
        verdict: "pass",
      }],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2, rerenderMs: 8 },
      pass: true,
      ...overrides,
    };
  }

  it("Report type accepts autoScalingProp and autoScalingReason", () => {
    const report = makeReport({
      autoScalingProp: "items",
      autoScalingReason: "array prop with items-like name",
    });
    expect(report.autoScalingProp).toBe("items");
    expect(report.autoScalingReason).toBe("array prop with items-like name");
  });

  it("Report type accepts undefined autoScalingProp", () => {
    const report = makeReport();
    expect(report.autoScalingProp).toBeUndefined();
    expect(report.autoScalingReason).toBeUndefined();
  });

  it("formatTable shows auto-scaling label when autoScalingProp is set", () => {
    const report = makeReport({
      autoScalingProp: "items",
      autoScalingReason: "array prop with items-like name",
    });
    const output = formatTable(report);
    expect(output).toContain("auto: items");
  });

  it("formatTable does not show auto label when autoScalingProp is absent", () => {
    const report = makeReport();
    const output = formatTable(report);
    expect(output).not.toContain("auto:");
  });
});
