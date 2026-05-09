import { describe, it, expect } from "vitest";
import {
  buildTimingWithCV,
  formatTable,
  type MatrixReport,
  type MatrixCell,
  type MatrixAxis,
  type CompoundEffect,
  type Report,
} from "../../src/report.js";

const THRESHOLDS = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

function makeTiming(median: number) {
  return buildTimingWithCV([median, median, median]);
}

function makeCell(props: Record<string, unknown>, mountMs: number): MatrixCell {
  return {
    props,
    mount: makeTiming(mountMs),
    rerender: makeTiming(mountMs * 0.3),
    unmount: makeTiming(mountMs * 0.05),
    domNodeCount: 10,
    tier: "T1" as const,
    verdict: "pass" as const,
  };
}

function makeMatrixReport(overrides: Partial<MatrixReport> = {}): MatrixReport {
  const cells = [
    makeCell({ variant: "primary", disabled: false }, 2.0),
    makeCell({ variant: "primary", disabled: true }, 3.0),
    makeCell({ variant: "secondary", disabled: false }, 1.5),
    makeCell({ variant: "secondary", disabled: true }, 2.5),
  ];
  return {
    axes: [
      { propName: "variant", values: ["primary", "secondary"] },
      { propName: "disabled", values: [false, true] },
    ],
    cells,
    hotCells: [cells[1], cells[3], cells[0], cells[2]],
    coldCells: [cells[2], cells[0], cells[3]],
    compoundEffects: [],
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
    thresholds: THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

describe("MatrixReport type on Report", () => {
  it("accepts matrixReport field", () => {
    const report = makeReport({ matrixReport: makeMatrixReport() });
    expect(report.matrixReport).toBeDefined();
    expect(report.matrixReport!.axes).toHaveLength(2);
  });

  it("allows undefined matrixReport", () => {
    const report = makeReport();
    expect(report.matrixReport).toBeUndefined();
  });
});

describe("MatrixCell type", () => {
  it("has all required fields", () => {
    const cell = makeCell({ variant: "primary" }, 2.0);
    expect(cell.mount.median).toBe(2.0);
    expect(cell.rerender.median).toBeCloseTo(0.6);
    expect(cell.unmount.median).toBeCloseTo(0.1);
    expect(cell.domNodeCount).toBe(10);
    expect(cell.tier).toBe("T1");
    expect(cell.verdict).toBe("pass");
  });
});

describe("formatTable with matrixReport", () => {
  it("shows axis names in header", () => {
    const report = makeReport({ matrixReport: makeMatrixReport() });
    const output = formatTable(report);
    expect(output).toContain("variant");
    expect(output).toContain("disabled");
  });

  it("shows Prop Matrix header", () => {
    const report = makeReport({ matrixReport: makeMatrixReport() });
    const output = formatTable(report);
    expect(output).toContain("Prop Matrix");
  });

  it("shows cell count", () => {
    const report = makeReport({ matrixReport: makeMatrixReport() });
    const output = formatTable(report);
    expect(output).toContain("4 cells");
  });

  it("shows Mount column", () => {
    const report = makeReport({ matrixReport: makeMatrixReport() });
    const output = formatTable(report);
    expect(output).toContain("Mount");
  });

  it("shows Verdict column", () => {
    const report = makeReport({ matrixReport: makeMatrixReport() });
    const output = formatTable(report);
    expect(output).toContain("Verdict");
  });

  it("does not show matrix output when no matrixReport", () => {
    const report = makeReport();
    const output = formatTable(report);
    expect(output).not.toContain("Prop Matrix");
  });

  it("shows compound effects section when present", () => {
    const mr = makeMatrixReport({
      compoundEffects: [{
        props: { variant: "primary", disabled: true },
        expectedMount: 2.0,
        actualMount: 4.0,
        compoundDelta: 2.0,
        significance: "high" as const,
      }],
    });
    const report = makeReport({ matrixReport: mr });
    const output = formatTable(report);
    expect(output).toContain("Compound");
    expect(output).toContain("high");
  });

  it("omits compound effects section when empty", () => {
    const report = makeReport({ matrixReport: makeMatrixReport() });
    const output = formatTable(report);
    expect(output).not.toContain("Compound");
  });
});
