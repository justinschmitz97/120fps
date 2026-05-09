import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";
import {
  isMatrixEligible,
  shouldAutoActivateMatrix,
  generatePropMatrix,
  pairwiseCover,
} from "../../src/prop-gen-values.js";
import {
  buildMatrixReport,
  buildTimingWithCV,
  formatTable,
  type MatrixReport,
  type MatrixCell,
  type PropDelta,
  type Report,
  type Thresholds,
} from "../../src/report.js";
import type { PropSchema } from "../../src/prop-gen.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";

function makeSchema(overrides: Partial<PropSchema> & { name: string; kind: PropSchema["kind"] }): PropSchema {
  return { required: true, values: [], ...overrides };
}

function makeMountResult(comboIndex: number, mountMedian: number, dom: number, props: Record<string, unknown> = {}): MountResult {
  return {
    comboIndex,
    props,
    mount: { samples: [mountMedian, mountMedian, mountMedian], median: mountMedian, p95: mountMedian },
    unmount: { samples: [0.1, 0.1, 0.1], median: 0.1, p95: 0.1 },
    domNodeCount: dom,
    heapDelta: 0,
    mountTraces: [],
  };
}

function makeRerenderResult(comboIndex: number, stableMedian: number): RerenderResult {
  return {
    comboIndex,
    props: {},
    stable: { samples: [stableMedian, stableMedian, stableMedian], median: stableMedian, p95: stableMedian },
  };
}

const THRESHOLDS: Thresholds = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

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

describe("H1: 0 eligible props with explicit --matrix", () => {
  it("generatePropMatrix returns single anchor cell", () => {
    const schemas = [
      makeSchema({ name: "count", kind: "number", values: [1, 5] }),
      makeSchema({ name: "label", kind: "string", values: ["test"] }),
    ];
    const cells = generatePropMatrix(schemas);
    expect(cells).toHaveLength(1);
    expect(cells[0].count).toBe(1);
    expect(cells[0].label).toBe("test");
  });
});

describe("H2: 1 eligible prop with --matrix", () => {
  it("works but compound effects empty", () => {
    const schemas = [makeSchema({ name: "disabled", kind: "boolean" })];
    const cells = generatePropMatrix(schemas);
    expect(cells).toHaveLength(2);

    const mounts = cells.map((c, i) => makeMountResult(i, (i + 1) * 2.0, 8, c));
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const result = buildMatrixReport({
      axes: [{ propName: "disabled", values: [false, true] }],
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
      propDeltas: [{ propName: "disabled", baseValue: false, flipValue: true, mountDelta: 2, rerenderDelta: 0 }],
    });
    expect(result.compoundEffects).toHaveLength(0);
  });
});

describe("H3: all cells same mount timing", () => {
  it("hotCells and coldCells handled without error", () => {
    const mounts = Array.from({ length: 4 }, (_, i) => makeMountResult(i, 5.0, 10));
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const result = buildMatrixReport({
      axes: [{ propName: "a", values: [false, true] }, { propName: "b", values: [false, true] }],
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
    });
    expect(result.hotCells).toHaveLength(4);
    expect(result.coldCells).toHaveLength(3);
  });
});

describe("H4: pairwise covering with 3 axes of 8 values", () => {
  it("produces ≤256 rows covering all pairs", () => {
    const axes = [
      { name: "a", values: Array.from({ length: 8 }, (_, i) => `a${i}`) },
      { name: "b", values: Array.from({ length: 8 }, (_, i) => `b${i}`) },
      { name: "c", values: Array.from({ length: 8 }, (_, i) => `c${i}`) },
    ];
    const rows = pairwiseCover(axes, 256);
    expect(rows.length).toBeLessThanOrEqual(256);

    for (let i = 0; i < axes.length; i++) {
      for (let j = i + 1; j < axes.length; j++) {
        for (const vi of axes[i].values) {
          for (const vj of axes[j].values) {
            const found = rows.some((r) => r[axes[i].name] === vi && r[axes[j].name] === vj);
            expect(found).toBe(true);
          }
        }
      }
    }
  });
});

describe("H5: deterministic output", () => {
  it("generatePropMatrix produces identical output on repeated calls", () => {
    const schemas = [
      makeSchema({ name: "disabled", kind: "boolean" }),
      makeSchema({ name: "variant", kind: "union", values: ["a", "b", "c"] }),
    ];
    const r1 = JSON.stringify(generatePropMatrix(schemas));
    const r2 = JSON.stringify(generatePropMatrix(schemas));
    expect(r1).toBe(r2);
  });
});

describe("H6: non-matrix props don't affect cell count", () => {
  it("adding function/number props doesn't change matrix size", () => {
    const base = [
      makeSchema({ name: "a", kind: "boolean" }),
      makeSchema({ name: "b", kind: "boolean" }),
    ];
    const extended = [
      ...base,
      makeSchema({ name: "onClick", kind: "function" }),
      makeSchema({ name: "count", kind: "number", values: [1, 5, 20] }),
      makeSchema({ name: "items", kind: "array" }),
    ];
    expect(generatePropMatrix(base).length).toBe(generatePropMatrix(extended).length);
  });
});

describe("H7: --matrix and --no-matrix together", () => {
  it("both flags stored", () => {
    const args = parseArgs(["./Button.tsx", "--matrix", "--no-matrix"]);
    expect(args.matrix).toBe(true);
    expect(args.noMatrix).toBe(true);
    expect(args.error).toBeUndefined();
  });
});

describe("H8: --matrix and --curve together", () => {
  it("both flags parsed without error", () => {
    const args = parseArgs(["./Button.tsx", "--matrix", "--curve"]);
    expect(args.matrix).toBe(true);
    expect(args.curve).toBe(true);
    expect(args.error).toBeUndefined();
  });
});

describe("H9: --matrix with --no-deltas", () => {
  it("buildMatrixReport without propDeltas produces no compound effects", () => {
    const mounts = [
      makeMountResult(0, 1.0, 8, { a: false, b: false }),
      makeMountResult(1, 5.0, 8, { a: true, b: true }),
    ];
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const result = buildMatrixReport({
      axes: [{ propName: "a", values: [false, true] }, { propName: "b", values: [false, true] }],
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
    });
    expect(result.compoundEffects).toHaveLength(0);
  });
});

describe("H10: compound significance boundaries", () => {
  it("1.49x is medium, 1.50x is high", () => {
    const anchorMount = 1.0;
    const mounts = [
      makeMountResult(0, anchorMount, 8, { a: "x", b: "x" }),
      makeMountResult(1, 1.49 * (anchorMount + 0.5 + 0.3), 8, { a: "y", b: "y" }),
      makeMountResult(2, 1.50 * (anchorMount + 0.5 + 0.3), 8, { a: "z", b: "z" }),
    ];
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const deltas: PropDelta[] = [
      { propName: "a", baseValue: "x", flipValue: "y", mountDelta: 0.5, rerenderDelta: 0 },
      { propName: "a", baseValue: "x", flipValue: "z", mountDelta: 0.5, rerenderDelta: 0 },
      { propName: "b", baseValue: "x", flipValue: "y", mountDelta: 0.3, rerenderDelta: 0 },
      { propName: "b", baseValue: "x", flipValue: "z", mountDelta: 0.3, rerenderDelta: 0 },
    ];
    const result = buildMatrixReport({
      axes: [{ propName: "a", values: ["x", "y", "z"] }, { propName: "b", values: ["x", "y", "z"] }],
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
      propDeltas: deltas,
    });
    const medEffect = result.compoundEffects.find((e) => e.props.a === "y" && e.props.b === "y");
    const highEffect = result.compoundEffects.find((e) => e.props.a === "z" && e.props.b === "z");
    expect(medEffect?.significance).toBe("medium");
    expect(highEffect?.significance).toBe("high");
  });
});

describe("H11: matrix with fixture", () => {
  it("shouldAutoActivateMatrix is pure — fixture check is in analyze", () => {
    // Matrix auto-activation is schema-level; fixture skipping is in analyze.ts.
    // Verify the function itself works on valid schemas.
    const schemas = [
      makeSchema({ name: "a", kind: "boolean" }),
      makeSchema({ name: "b", kind: "boolean" }),
    ];
    expect(shouldAutoActivateMatrix(schemas)).toBe(true);
  });
});

describe("H12: union with 9 values excluded", () => {
  it("not eligible for matrix", () => {
    const schema = makeSchema({ name: "x", kind: "union", values: Array.from({ length: 9 }, (_, i) => `v${i}`) });
    expect(isMatrixEligible(schema)).toBe(false);
  });

  it("excluded from matrix axes", () => {
    const schemas = [
      makeSchema({ name: "big", kind: "union", values: Array.from({ length: 9 }, (_, i) => `v${i}`) }),
      makeSchema({ name: "a", kind: "boolean" }),
      makeSchema({ name: "b", kind: "boolean" }),
    ];
    const cells = generatePropMatrix(schemas);
    expect(cells).toHaveLength(4); // 2x2 from booleans only
    // big is at anchor
    for (const cell of cells) {
      expect(cell.big).toBe("v0");
    }
  });
});

describe("H13: optional boolean has 2 matrix values, no undefined", () => {
  it("produces 2 values (false, true)", () => {
    const schemas = [
      makeSchema({ name: "a", kind: "boolean", required: false }),
      makeSchema({ name: "b", kind: "boolean" }),
    ];
    const cells = generatePropMatrix(schemas);
    expect(cells).toHaveLength(4); // 2x2, not 3x2
    const aValues = new Set(cells.map((c) => c.a));
    expect(aValues.has(false)).toBe(true);
    expect(aValues.has(true)).toBe(true);
    expect(aValues.has(undefined)).toBe(false);
  });
});

describe("H14: formatMatrixOutput with 0 compound effects", () => {
  it("omits compound effects section", () => {
    const mr: MatrixReport = {
      axes: [{ propName: "v", values: ["a", "b"] }],
      cells: [makeCell({ v: "a" }, 1), makeCell({ v: "b" }, 2)],
      hotCells: [makeCell({ v: "b" }, 2), makeCell({ v: "a" }, 1)],
      coldCells: [makeCell({ v: "a" }, 1)],
      compoundEffects: [],
    };
    const output = formatTable(makeReport({ matrixReport: mr }));
    expect(output).not.toContain("Compound");
  });
});

describe("H15: every cell has all prop keys including non-matrix", () => {
  it("non-matrix props present at anchor value", () => {
    const schemas = [
      makeSchema({ name: "disabled", kind: "boolean" }),
      makeSchema({ name: "variant", kind: "union", values: ["a", "b"] }),
      makeSchema({ name: "count", kind: "number", values: [42] }),
    ];
    const cells = generatePropMatrix(schemas);
    for (const cell of cells) {
      expect(cell).toHaveProperty("disabled");
      expect(cell).toHaveProperty("variant");
      expect(cell).toHaveProperty("count");
      expect(cell.count).toBe(42);
    }
  });
});

describe("H16: fewer than 5 total cells", () => {
  it("hotCells = all cells", () => {
    const mounts = [makeMountResult(0, 1, 8), makeMountResult(1, 2, 8)];
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const result = buildMatrixReport({
      axes: [{ propName: "a", values: [false, true] }],
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
    });
    expect(result.hotCells).toHaveLength(2);
  });
});

describe("H17: fewer than 3 total cells", () => {
  it("coldCells = all cells", () => {
    const mounts = [makeMountResult(0, 1, 8), makeMountResult(1, 2, 8)];
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const result = buildMatrixReport({
      axes: [{ propName: "a", values: [false, true] }],
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
    });
    expect(result.coldCells).toHaveLength(2);
  });
});

describe("H18: JSON round-trip of matrixReport", () => {
  it("serializes and deserializes correctly", () => {
    const mr: MatrixReport = {
      axes: [{ propName: "v", values: ["a", "b"] }],
      cells: [makeCell({ v: "a" }, 1), makeCell({ v: "b" }, 2)],
      hotCells: [makeCell({ v: "b" }, 2)],
      coldCells: [makeCell({ v: "a" }, 1)],
      compoundEffects: [{
        props: { v: "b" },
        expectedMount: 1,
        actualMount: 2,
        compoundDelta: 1,
        significance: "medium" as const,
      }],
    };
    const report = makeReport({ matrixReport: mr });
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json);
    expect(parsed.matrixReport.axes[0].propName).toBe("v");
    expect(parsed.matrixReport.cells).toHaveLength(2);
    expect(parsed.matrixReport.compoundEffects[0].significance).toBe("medium");
  });
});
