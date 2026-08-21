import { describe, it, expect } from "vitest";
import {
  shouldAutoActivateMatrix,
  generatePropMatrix,
  pairwiseCover,
} from "../../src/prop-gen-values.js";
import {
  buildMatrixReport,
  buildTimingWithCV,
  type ComboReport,
  type PropDelta,
} from "../../src/report.js";
import type { PropSchema } from "../../src/prop-gen.js";

function makeSchema(overrides: Partial<PropSchema> & { name: string; kind: PropSchema["kind"] }): PropSchema {
  return { required: true, values: [], ...overrides };
}

function makeCombo(comboIndex: number, mountMedian: number, dom: number, props: Record<string, unknown> = {}): ComboReport {
  return {
    comboIndex,
    props,
    mount: buildTimingWithCV([mountMedian, mountMedian, mountMedian]),
    rerender: buildTimingWithCV([0.5, 0.5, 0.5]),
    unmount: buildTimingWithCV([0.1, 0.1, 0.1]),
    domNodeCount: dom,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 1,
    verdict: "pass",
    tier: "T1",
  };
}

describe("H2: 1 eligible prop with --matrix", () => {
  it("works but compound effects empty", () => {
    const schemas = [makeSchema({ name: "disabled", kind: "boolean" })];
    const cells = generatePropMatrix(schemas);
    expect(cells).toHaveLength(2);

    const combos = cells.map((c, i) => makeCombo(i, (i + 1) * 2.0, 8, c));
    const result = buildMatrixReport({
      axes: [{ propName: "disabled", values: [false, true] }],
      combos,
      propDeltas: [{ propName: "disabled", baseValue: false, flipValue: true, mountDelta: 2, rerenderDelta: 0 }],
    });
    expect(result.compoundEffects).toHaveLength(0);
  });
});

describe("H3: all cells same mount timing", () => {
  it("hotCells and coldCells handled without error", () => {
    const combos = Array.from({ length: 4 }, (_, i) => makeCombo(i, 5.0, 10));
    const result = buildMatrixReport({
      axes: [{ propName: "a", values: [false, true] }, { propName: "b", values: [false, true] }],
      combos,
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

describe("H9: --matrix with --no-deltas", () => {
  it("buildMatrixReport without propDeltas produces no compound effects", () => {
    const combos = [
      makeCombo(0, 1.0, 8, { a: false, b: false }),
      makeCombo(1, 5.0, 8, { a: true, b: true }),
    ];
    const result = buildMatrixReport({
      axes: [{ propName: "a", values: [false, true] }, { propName: "b", values: [false, true] }],
      combos,
    });
    expect(result.compoundEffects).toHaveLength(0);
  });
});

describe("H10: compound significance boundaries", () => {
  it("1.49x is medium, 1.50x is high", () => {
    const anchorMount = 1.0;
    const combos = [
      makeCombo(0, anchorMount, 8, { a: "x", b: "x" }),
      makeCombo(1, 1.49 * (anchorMount + 0.5 + 0.3), 8, { a: "y", b: "y" }),
      makeCombo(2, 1.50 * (anchorMount + 0.5 + 0.3), 8, { a: "z", b: "z" }),
    ];
    const deltas: PropDelta[] = [
      { propName: "a", baseValue: "x", flipValue: "y", mountDelta: 0.5, rerenderDelta: 0 },
      { propName: "a", baseValue: "x", flipValue: "z", mountDelta: 0.5, rerenderDelta: 0 },
      { propName: "b", baseValue: "x", flipValue: "y", mountDelta: 0.3, rerenderDelta: 0 },
      { propName: "b", baseValue: "x", flipValue: "z", mountDelta: 0.3, rerenderDelta: 0 },
    ];
    const result = buildMatrixReport({
      axes: [{ propName: "a", values: ["x", "y", "z"] }, { propName: "b", values: ["x", "y", "z"] }],
      combos,
      propDeltas: deltas,
    });
    const medEffect = result.compoundEffects.find((e) => e.props.a === "y" && e.props.b === "y");
    const highEffect = result.compoundEffects.find((e) => e.props.a === "z" && e.props.b === "z");
    expect(medEffect?.significance).toBe("medium");
    expect(highEffect?.significance).toBe("high");
  });
});

describe("H12: union with 9 values crossed over a truncated value set", () => {
  it("is an axis, over its first 8 values", () => {
    const schemas = [
      makeSchema({ name: "big", kind: "union", values: Array.from({ length: 9 }, (_, i) => `v${i}`) }),
      makeSchema({ name: "a", kind: "boolean" }),
      makeSchema({ name: "b", kind: "boolean" }),
    ];
    const cells = generatePropMatrix(schemas);
    // M104 / I10 (dub-F7): 8 crossed values x 2 booleans x 2 booleans.
    expect(cells).toHaveLength(32);
    expect(new Set(cells.map((cell) => cell.big)).size).toBe(8);
    expect(cells[0].big).toBe("v0");
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
    const result = buildMatrixReport({
      axes: [{ propName: "a", values: [false, true] }],
      combos: [makeCombo(0, 1, 8), makeCombo(1, 2, 8)],
    });
    expect(result.hotCells).toHaveLength(2);
  });
});

describe("H17: fewer than 3 total cells", () => {
  it("coldCells = all cells", () => {
    const result = buildMatrixReport({
      axes: [{ propName: "a", values: [false, true] }],
      combos: [makeCombo(0, 1, 8), makeCombo(1, 2, 8)],
    });
    expect(result.coldCells).toHaveLength(2);
  });
});
