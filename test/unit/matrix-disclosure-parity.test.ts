import { describe, it, expect } from "vitest";
import {
  buildMatrixReport,
  buildTimingWithCV,
  formatTable,
  type ComboReport,
  type MatrixAxis,
  type Report,
} from "../../src/report/index.js";

// M91: matrix mode dropped the [props excluded]/[uncomposed] mark combo mode already carries.

function makeCombo(
  comboIndex: number,
  mountMedian: number,
  overrides: Partial<ComboReport> = {},
): ComboReport {
  return {
    comboIndex,
    props: {},
    mount: buildTimingWithCV([mountMedian, mountMedian, mountMedian]),
    rerender: buildTimingWithCV([0.5, 0.5, 0.5]),
    unmount: buildTimingWithCV([0.1, 0.1, 0.1]),
    domNodeCount: 10,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 1,
    verdict: "warn",
    tier: "T1",
    ...overrides,
  };
}

const ONE_AXIS: MatrixAxis[] = [{ propName: "variant", values: ["primary", "secondary"] }];

const THRESHOLDS = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
    componentPath: "./Test.vue",
    componentName: "Test",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [],
    thresholds: THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

describe("M91: matrix disclosureReason parity", () => {
  it("buildMatrixReport copies disclosureReason from the projected combo onto the cell", () => {
    const combos = [
      makeCombo(0, 2.0, { props: { variant: "primary" }, disclosureReason: "propsExcluded" }),
      makeCombo(1, 2.5, { props: { variant: "secondary" } }),
    ];
    const result = buildMatrixReport({ axes: ONE_AXIS, combos });
    expect(result.cells[0].disclosureReason).toBe("propsExcluded");
    expect(result.cells[1].disclosureReason).toBeUndefined();
  });

  it("buildMatrixReport copies the uncomposed reason too", () => {
    const combos = [makeCombo(0, 2.0, { disclosureReason: "uncomposed" })];
    const result = buildMatrixReport({ axes: ONE_AXIS, combos });
    expect(result.cells[0].disclosureReason).toBe("uncomposed");
  });

  it("the console cell row carries the [props excluded] mark, matching combo mode's own mark text", () => {
    const combos = [makeCombo(0, 2.0, { props: { variant: "primary" }, disclosureReason: "propsExcluded" })];
    const matrixReport = buildMatrixReport({ axes: ONE_AXIS, combos });
    const report = makeReport({ combos, matrixReport });
    const out = formatTable(report);
    expect(out).toContain("[props excluded]");
  });

  it("the console cell row carries the [uncomposed] mark", () => {
    const combos = [makeCombo(0, 2.0, { props: { variant: "primary" }, disclosureReason: "uncomposed" })];
    const matrixReport = buildMatrixReport({ axes: ONE_AXIS, combos });
    const report = makeReport({ combos, matrixReport });
    const out = formatTable(report);
    expect(out).toContain("[uncomposed]");
  });

  it("a cell with no disclosureReason prints no mark (no regression on the common case)", () => {
    const combos = [makeCombo(0, 2.0, { props: { variant: "primary" }, verdict: "pass" })];
    const matrixReport = buildMatrixReport({ axes: ONE_AXIS, combos });
    const report = makeReport({ combos, matrixReport });
    const out = formatTable(report);
    expect(out).not.toContain("[props excluded]");
    expect(out).not.toContain("[uncomposed]");
  });
});
