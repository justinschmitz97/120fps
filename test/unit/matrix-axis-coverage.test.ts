import { describe, it, expect } from "vitest";
import { buildMatrixReport, formatTable, type ComboReport, type MatrixAxis, type Report, type TimingWithCV } from "../../src/report.js";
import { generatePropMatrix, selectMatrixCombos, isMatrixEligible, matrixValues } from "../../src/prop-gen-values.js";
import type { PropSchema } from "../../src/prop-gen.js";

// twenty-F3: `Modal.tsx --matrix --max-combos 2` printed
// `Prop Matrix (isOpen × …)` over two cells that both carried `isOpen: false`
// — the header named an axis the run never crossed, and the two measured
// cells were the state the tool itself reports as rendering nothing.

function timing(median: number): TimingWithCV {
  return { samples: [median], median, p95: median, cv: 0, unstable: false };
}

function cell(comboIndex: number, props: Record<string, unknown>, mountMs = 3): ComboReport {
  return {
    comboIndex,
    props,
    mount: timing(mountMs),
    unmount: timing(0.5),
    rerender: timing(1),
    domNodeCount: props.isOpen ? 8 : 0,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 0.3,
    verdict: "pass",
    tier: "T1",
  };
}

const AXES: MatrixAxis[] = [
  { propName: "isOpen", values: [false, true] },
  { propName: "size", values: ["small", "large"] },
];

function matrixReportFor(combos: ComboReport[]): Report {
  const matrixReport = buildMatrixReport({ axes: AXES, combos });
  return {
    version: 1,
    timestamp: "2026-08-21T00:00:00.000Z",
    machine: { cpu: "Test", cores: 4, ramMb: 16384, os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0" },
    componentPath: "./Modal.tsx",
    componentName: "Modal",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos,
    thresholds: { mountMs: 50, interactionMs: 400, interactionStepMs: 67, relativeMount: 2.0, rerenderMs: 16 },
    pass: true,
    mode: "matrix",
    matrixReport,
  };
}

describe("a matrix header describes the axes the run actually crossed", () => {
  const cappedToAnchorPlusOne = [
    cell(0, { isOpen: false, size: "small" }),
    cell(1, { isOpen: false, size: "large" }, 4),
  ];

  it("reports the distinct values each declared axis was measured at", () => {
    const mr = buildMatrixReport({ axes: AXES, combos: cappedToAnchorPlusOne });
    expect(mr.axisCoverage).toEqual([
      { propName: "isOpen", declaredValues: 2, measuredValues: 1, heldValue: false },
      { propName: "size", declaredValues: 2, measuredValues: 2 },
    ]);
  });

  it("names the axis that was held at one value in the printed header", () => {
    const table = formatTable(matrixReportFor(cappedToAnchorPlusOne));
    expect(table).toContain("Prop Matrix (isOpen × size)");
    expect(table).toContain("Axes crossed: size.");
    expect(table).toContain("isOpen=false");
  });

  it("says nothing extra when every declared axis varies", () => {
    const full = [
      cell(0, { isOpen: false, size: "small" }),
      cell(1, { isOpen: false, size: "large" }, 4),
      cell(2, { isOpen: true, size: "small" }, 5),
      cell(3, { isOpen: true, size: "large" }, 6),
    ];
    const mr = buildMatrixReport({ axes: AXES, combos: full });
    expect(mr.axisCoverage.every((a) => a.measuredValues === a.declaredValues)).toBe(true);
    expect(formatTable(matrixReportFor(full))).not.toContain("Axes crossed:");
  });

  it("names every held axis when the cap left only the anchor", () => {
    const anchorOnly = [cell(0, { isOpen: false, size: "small" })];
    const table = formatTable(matrixReportFor(anchorOnly));
    expect(table).toContain("isOpen=false");
    expect(table).toContain("size=small");
    expect(table).not.toContain("Axes crossed: ");
  });
});

// --help's "Combo caps" section promises the anchor cell is always kept.
// twenty-F3 read as a violation of that promise; the selection (Lane B's
// src/prop-gen-values.ts) keeps it, and the report is what has to say so.
describe("the anchor cell survives every cell cap", () => {
  const SCHEMAS: PropSchema[] = [
    { name: "isOpen", kind: "boolean", required: true, values: [false, true] },
    { name: "size", kind: "union", required: false, values: ["small", "large"] },
    { name: "loading", kind: "boolean", required: false, values: [false, true] },
  ];

  const axes: MatrixAxis[] = SCHEMAS.filter(isMatrixEligible).map((s) => ({
    propName: s.name,
    values: matrixValues(s),
  }));

  function keptCells(max: number): Record<string, unknown>[] {
    const all = generatePropMatrix(SCHEMAS);
    const kept = selectMatrixCombos(all, axes, max);
    return kept.map((i) => all[i] as Record<string, unknown>);
  }

  function isAnchor(props: Record<string, unknown>): boolean {
    return axes.every((a) => props[a.propName] === a.values[0]);
  }

  it("keeps it at --max-combos 1", () => {
    const kept = keptCells(1);
    expect(kept).toHaveLength(1);
    expect(isAnchor(kept[0])).toBe(true);
  });

  it("keeps it at --max-combos 2, and the second cell is one axis away", () => {
    const kept = keptCells(2);
    expect(kept.filter(isAnchor)).toHaveLength(1);
    const other = kept.find((c) => !isAnchor(c))!;
    const differing = axes.filter((a) => other[a.propName] !== a.values[0]);
    expect(differing).toHaveLength(1);
  });

  it("reaches the report as a cell, so the header can describe it", () => {
    const kept = keptCells(2);
    const combos = kept.map((props, i) => cell(i, props));
    const mr = buildMatrixReport({ axes, combos });
    expect(mr.cells.some((c) => isAnchor(c.props))).toBe(true);
    expect(mr.axisCoverage.filter((a) => a.measuredValues === 1).length).toBe(axes.length - 1);
  });
});
