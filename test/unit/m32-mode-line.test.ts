import { describe, it, expect } from "vitest";
import { describeMode } from "../../src/report.js";
import type { Report } from "../../src/report.js";

function report(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-08-01T00:00:00.000Z",
    machine: {
      cpu: "x",
      cores: 8,
      ramMb: 16000,
      os: "Windows_NT",
      nodeVersion: "v24",
      chromiumVersion: "147",
    },
    componentPath: "./Button.tsx",
    componentName: "Button",
    calibration: { totalDuration: 100, scriptDuration: 1 },
    combos: [],
    thresholds: { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 },
    pass: true,
    ...overrides,
  } as Report;
}

describe("m32 D3 — the report states its mode", () => {
  it("names curve mode and the prop that triggered it", () => {
    const line = describeMode(
      report({
        scalingCurveReport: {
          propName: "lines",
          propKind: "array",
          reason: "array prop",
        } as never,
      }),
    );
    expect(line.toLowerCase()).toContain("curve");
    expect(line).toContain("lines");
  });

  it("names matrix mode", () => {
    expect(describeMode(report({ matrixReport: { axes: [], cells: [] } as never })).toLowerCase())
      .toContain("matrix");
  });

  it("names isolation mode", () => {
    expect(describeMode(report({ isolation: { phases: {} } as never })).toLowerCase())
      .toContain("isolation");
  });

  it("names combo mode with the measured count", () => {
    const line = describeMode(
      report({ combos: [{ comboIndex: 0 } as never, { comboIndex: 1 } as never] }),
    );
    expect(line.toLowerCase()).toContain("combo");
    expect(line).toContain("2");
  });

  it("states generated count when the cap dropped combos", () => {
    const line = describeMode(
      report({
        combos: [{ comboIndex: 0 } as never],
        warnings: ["measured 8 of 27 prop combos; 19 were dropped to bound the run."],
      }),
    );
    expect(line).toContain("27");
  });

  it("never returns an empty line", () => {
    expect(describeMode(report()).trim().length).toBeGreaterThan(0);
  });
});
