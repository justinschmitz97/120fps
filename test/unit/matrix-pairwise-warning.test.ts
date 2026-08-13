import { describe, it, expect } from "vitest";
import { generatePropMatrix } from "../../src/prop-gen-values.js";
import { MATRIX_PAIRWISE_COVER_WARNING } from "../../src/analyze.js";
import type { PropSchema } from "../../src/prop-gen.js";

function unionSchema(name: string, count: number): PropSchema {
  return { name, kind: "union", required: true, values: Array.from({ length: count }, (_, i) => `${name}${i}`) };
}

describe("full cell count vs pairwise-covered count", () => {
  it("matches generatePropMatrix's fallback: 512 possible cells, <=256 covered", () => {
    const schemas = [unionSchema("a", 8), unionSchema("b", 8), unionSchema("c", 8)];
    const fullCellCount = schemas.reduce((acc, s) => acc * s.values.length, 1);
    expect(fullCellCount).toBe(512);

    const cells = generatePropMatrix(schemas);
    expect(cells.length).toBeLessThanOrEqual(256);
    expect(fullCellCount).toBeGreaterThan(cells.length);
  });

  it("does not engage the fallback (and would show no gap) when cells fit in 256", () => {
    const schemas = [unionSchema("a", 4), unionSchema("b", 4)]; // 16 cells
    const fullCellCount = schemas.reduce((acc, s) => acc * s.values.length, 1);
    const cells = generatePropMatrix(schemas);
    expect(cells.length).toBe(fullCellCount);
  });
});

describe("MATRIX_PAIRWISE_COVER_WARNING", () => {
  it("names both the full cell count and the covered count", () => {
    const warning = MATRIX_PAIRWISE_COVER_WARNING(200, 512);
    expect(warning).toContain("200");
    expect(warning).toContain("512");
    expect(warning.toLowerCase()).toContain("pairwise");
    expect(warning.toLowerCase()).toContain("not exhaustive");
  });
});
