import { describe, it, expect } from "vitest";
import {
  isMatrixEligible,
  shouldAutoActivateMatrix,
  generatePropMatrix,
} from "../../src/prop-gen-values.js";
import type { PropSchema } from "../../src/prop-gen.js";

function makeSchema(overrides: Partial<PropSchema> & { name: string; kind: PropSchema["kind"] }): PropSchema {
  return { required: true, values: [], ...overrides };
}

describe("isMatrixEligible", () => {
  it("boolean prop is eligible", () => {
    expect(isMatrixEligible(makeSchema({ name: "disabled", kind: "boolean" }))).toBe(true);
  });

  it("union with 3 values is eligible", () => {
    expect(isMatrixEligible(makeSchema({ name: "variant", kind: "union", values: ["a", "b", "c"] }))).toBe(true);
  });

  it("union with 8 values is eligible", () => {
    expect(isMatrixEligible(makeSchema({ name: "size", kind: "union", values: Array.from({ length: 8 }, (_, i) => `v${i}`) }))).toBe(true);
  });

  it("union with 9 values is not eligible", () => {
    expect(isMatrixEligible(makeSchema({ name: "size", kind: "union", values: Array.from({ length: 9 }, (_, i) => `v${i}`) }))).toBe(false);
  });

  it("union with 0 values is not eligible", () => {
    expect(isMatrixEligible(makeSchema({ name: "x", kind: "union", values: [] }))).toBe(false);
  });

  it("number prop is not eligible", () => {
    expect(isMatrixEligible(makeSchema({ name: "count", kind: "number" }))).toBe(false);
  });

  it("string prop is not eligible", () => {
    expect(isMatrixEligible(makeSchema({ name: "label", kind: "string" }))).toBe(false);
  });

  it("array prop is not eligible", () => {
    expect(isMatrixEligible(makeSchema({ name: "items", kind: "array" }))).toBe(false);
  });

  it("function prop is not eligible", () => {
    expect(isMatrixEligible(makeSchema({ name: "onClick", kind: "function" }))).toBe(false);
  });

  it("object prop is not eligible", () => {
    expect(isMatrixEligible(makeSchema({ name: "style", kind: "object" }))).toBe(false);
  });
});

describe("shouldAutoActivateMatrix", () => {
  it("returns true for 2 boolean props (4 cells)", () => {
    expect(shouldAutoActivateMatrix([
      makeSchema({ name: "a", kind: "boolean" }),
      makeSchema({ name: "b", kind: "boolean" }),
    ])).toBe(true);
  });

  it("returns false for 1 boolean prop", () => {
    expect(shouldAutoActivateMatrix([
      makeSchema({ name: "a", kind: "boolean" }),
    ])).toBe(false);
  });

  it("returns false for 0 eligible props", () => {
    expect(shouldAutoActivateMatrix([
      makeSchema({ name: "count", kind: "number" }),
    ])).toBe(false);
  });

  it("returns true for boolean + union(3) = 6 cells", () => {
    expect(shouldAutoActivateMatrix([
      makeSchema({ name: "disabled", kind: "boolean" }),
      makeSchema({ name: "variant", kind: "union", values: ["a", "b", "c"] }),
    ])).toBe(true);
  });

  it("returns false when product exceeds 64", () => {
    expect(shouldAutoActivateMatrix([
      makeSchema({ name: "a", kind: "union", values: Array.from({ length: 8 }, (_, i) => `a${i}`) }),
      makeSchema({ name: "b", kind: "union", values: Array.from({ length: 8 }, (_, i) => `b${i}`) }),
      makeSchema({ name: "c", kind: "boolean" }),
    ])).toBe(false); // 8*8*2 = 128 > 64
  });

  it("returns true when product is exactly 64", () => {
    expect(shouldAutoActivateMatrix([
      makeSchema({ name: "a", kind: "union", values: Array.from({ length: 8 }, (_, i) => `a${i}`) }),
      makeSchema({ name: "b", kind: "union", values: Array.from({ length: 8 }, (_, i) => `b${i}`) }),
    ])).toBe(true); // 8*8 = 64
  });

  it("ignores non-eligible props in count", () => {
    expect(shouldAutoActivateMatrix([
      makeSchema({ name: "a", kind: "boolean" }),
      makeSchema({ name: "b", kind: "boolean" }),
      makeSchema({ name: "count", kind: "number" }),
      makeSchema({ name: "label", kind: "string" }),
    ])).toBe(true); // 2 eligible, product = 4
  });
});

describe("generatePropMatrix", () => {
  it("produces 4 cells for 2 boolean props", () => {
    const schemas = [
      makeSchema({ name: "a", kind: "boolean" }),
      makeSchema({ name: "b", kind: "boolean" }),
    ];
    const cells = generatePropMatrix(schemas);
    expect(cells).toHaveLength(4);
  });

  it("produces 6 cells for boolean + union(3)", () => {
    const schemas = [
      makeSchema({ name: "disabled", kind: "boolean" }),
      makeSchema({ name: "variant", kind: "union", values: ["primary", "secondary", "ghost"] }),
    ];
    const cells = generatePropMatrix(schemas);
    expect(cells).toHaveLength(6);
  });

  it("holds non-matrix props at anchor value", () => {
    const schemas = [
      makeSchema({ name: "disabled", kind: "boolean" }),
      makeSchema({ name: "variant", kind: "union", values: ["primary", "secondary"] }),
      makeSchema({ name: "count", kind: "number", values: [1, 5, 20] }),
    ];
    const cells = generatePropMatrix(schemas);
    for (const cell of cells) {
      expect(cell.count).toBe(1); // anchor for number
    }
  });

  it("every cell has all prop keys", () => {
    const schemas = [
      makeSchema({ name: "disabled", kind: "boolean" }),
      makeSchema({ name: "variant", kind: "union", values: ["a", "b"] }),
      makeSchema({ name: "label", kind: "string", values: ["hello"] }),
    ];
    const cells = generatePropMatrix(schemas);
    for (const cell of cells) {
      expect("disabled" in cell).toBe(true);
      expect("variant" in cell).toBe(true);
      expect("label" in cell).toBe(true);
    }
  });

  it("produces deterministic output", () => {
    const schemas = [
      makeSchema({ name: "a", kind: "boolean" }),
      makeSchema({ name: "b", kind: "union", values: ["x", "y", "z"] }),
    ];
    const cells1 = generatePropMatrix(schemas);
    const cells2 = generatePropMatrix(schemas);
    expect(JSON.stringify(cells1)).toBe(JSON.stringify(cells2));
  });

  it("returns single anchor cell when no eligible props", () => {
    const schemas = [
      makeSchema({ name: "count", kind: "number", values: [1, 5] }),
      makeSchema({ name: "label", kind: "string", values: ["test"] }),
    ];
    const cells = generatePropMatrix(schemas);
    expect(cells).toHaveLength(1);
    expect(cells[0].count).toBe(1);
    expect(cells[0].label).toBe("test");
  });

  it("returns single anchor cell for empty schemas", () => {
    const cells = generatePropMatrix([]);
    expect(cells).toHaveLength(1);
    expect(Object.keys(cells[0])).toHaveLength(0);
  });

  it("caps at 256 cells via pairwise covering", () => {
    const schemas = [
      makeSchema({ name: "a", kind: "union", values: Array.from({ length: 8 }, (_, i) => `a${i}`) }),
      makeSchema({ name: "b", kind: "union", values: Array.from({ length: 8 }, (_, i) => `b${i}`) }),
      makeSchema({ name: "c", kind: "union", values: Array.from({ length: 8 }, (_, i) => `c${i}`) }),
    ];
    const cells = generatePropMatrix(schemas); // 8*8*8 = 512, should use pairwise
    expect(cells.length).toBeLessThanOrEqual(256);
    expect(cells.length).toBeGreaterThan(0);
  });

  it("pairwise covering includes every value pair", () => {
    const schemas = [
      makeSchema({ name: "a", kind: "union", values: ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7"] }),
      makeSchema({ name: "b", kind: "union", values: ["b0", "b1", "b2", "b3", "b4", "b5", "b6", "b7"] }),
      makeSchema({ name: "c", kind: "union", values: ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"] }),
    ];
    const cells = generatePropMatrix(schemas);
    // Check that every pair (a=X, b=Y) appears in at least one cell
    for (const av of schemas[0].values) {
      for (const bv of schemas[1].values) {
        const found = cells.some((c) => c.a === av && c.b === bv);
        expect(found).toBe(true);
      }
    }
    // Check (a=X, c=Y)
    for (const av of schemas[0].values) {
      for (const cv of schemas[2].values) {
        const found = cells.some((c) => c.a === av && c.c === cv);
        expect(found).toBe(true);
      }
    }
    // Check (b=X, c=Y)
    for (const bv of schemas[1].values) {
      for (const cv of schemas[2].values) {
        const found = cells.some((c) => c.b === bv && c.c === cv);
        expect(found).toBe(true);
      }
    }
  });
});
