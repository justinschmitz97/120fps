import { describe, it, expect } from "vitest";
import {
  formatTable,
  buildTimingWithCV,
  type Report,
  type Thresholds,
  type BaselineComparison,
} from "../../src/report.js";
import { ZERO_PROPS_WARNING } from "../../src/analyze.js";

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

describe("D6: Report.warnings printed by formatTable", () => {
  it("prints each warning line when warnings present", () => {
    const output = formatTable(makeReport({ warnings: [ZERO_PROPS_WARNING] }));
    expect(output).toContain(ZERO_PROPS_WARNING);
  });

  it("no warning lines when warnings is absent", () => {
    const output = formatTable(makeReport());
    expect(output).not.toContain("No props extracted");
  });

  it("no warning lines when warnings is an empty array", () => {
    const output = formatTable(makeReport({ warnings: [] }));
    expect(output).not.toContain("No props extracted");
    expect(output).toContain("Result: PASS");
  });

  it("zero-props warning text matches the D6 hint", () => {
    expect(ZERO_PROPS_WARNING).toContain("No props extracted");
    expect(ZERO_PROPS_WARNING).toContain("extraction may have failed");
  });
});

describe("D6: baseline missingInteractions printed as warnings, never FAIL", () => {
  it("prints missing interactions in the baseline section", () => {
    const comparison: BaselineComparison = {
      hasBaseline: true,
      regressions: [],
      improvements: [],
      missingInteractions: ["click button", "hover card"],
    };
    const output = formatTable(makeReport({ baseline: comparison }));
    expect(output).toContain("click button");
    expect(output).toContain("hover card");
    expect(output).toContain("Result: PASS");
  });

  it("tolerates comparisons without missingInteractions (old shape)", () => {
    const comparison: BaselineComparison = {
      hasBaseline: true,
      regressions: [],
      improvements: [],
    };
    const output = formatTable(makeReport({ baseline: comparison }));
    expect(output).toContain("Baseline comparison:");
  });

  it("empty missingInteractions prints nothing extra", () => {
    const comparison: BaselineComparison = {
      hasBaseline: true,
      regressions: [],
      improvements: [],
      missingInteractions: [],
    };
    const output = formatTable(makeReport({ baseline: comparison }));
    expect(output).not.toContain("not measured");
  });
});
