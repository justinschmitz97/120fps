import { describe, it, expect } from "vitest";
import { detectScalingProps, type ScalingPropMatch } from "../../src/prop-gen.js";
import { generateScalingCombos } from "../../src/prop-gen-values.js";
import type { PropSchema } from "../../src/prop-gen.js";

describe("detectScalingProps", () => {
  it("detects array prop with items-like name", () => {
    const schemas: PropSchema[] = [
      { name: "items", kind: "array", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("array");
    expect(matches[0].reason).toBe("array prop with items-like name");
  });

  it("detects plain array prop", () => {
    const schemas: PropSchema[] = [
      { name: "stuff", kind: "array", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("array");
    expect(matches[0].reason).toBe("array prop");
  });

  it("detects numeric prop with scaling name", () => {
    const schemas: PropSchema[] = [
      { name: "count", kind: "number", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("numeric");
    expect(matches[0].reason).toBe("numeric prop name matches scaling pattern");
  });

  it("detects numeric shorthand prop (n, numItems)", () => {
    const schemas: PropSchema[] = [
      { name: "n", kind: "number", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("numeric");
    expect(matches[0].reason).toBe("numeric prop");
  });

  it("detects numItems as shorthand", () => {
    const schemas: PropSchema[] = [
      { name: "numItems", kind: "number", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches).toHaveLength(1);
    expect(matches[0].kind).toBe("numeric");
  });

  it("returns empty for no scaling-eligible props", () => {
    const schemas: PropSchema[] = [
      { name: "disabled", kind: "boolean", required: true, values: [] },
      { name: "label", kind: "string", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches).toHaveLength(0);
  });

  it("prioritizes items-like array over plain array", () => {
    const schemas: PropSchema[] = [
      { name: "stuff", kind: "array", required: true, values: [] },
      { name: "options", kind: "array", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches[0].schema.name).toBe("options");
  });

  it("prioritizes array over numeric", () => {
    const schemas: PropSchema[] = [
      { name: "count", kind: "number", required: true, values: [] },
      { name: "data", kind: "array", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches[0].schema.name).toBe("data");
  });

  it("matches items-like names case-insensitively", () => {
    for (const name of ["Items", "OPTIONS", "Data", "Children", "entries", "Records", "Elements", "List"]) {
      const schemas: PropSchema[] = [
        { name, kind: "array", required: true, values: [] },
      ];
      const matches = detectScalingProps(schemas);
      expect(matches[0].reason).toBe("array prop with items-like name");
    }
  });

  it("matches scaling numeric names", () => {
    for (const name of ["count", "size", "length", "limit", "max", "total", "depth", "level", "columns", "rows", "pages"]) {
      const schemas: PropSchema[] = [
        { name, kind: "number", required: true, values: [] },
      ];
      const matches = detectScalingProps(schemas);
      expect(matches[0].reason).toBe("numeric prop name matches scaling pattern");
    }
  });

  it("does not match non-scaling number props", () => {
    const schemas: PropSchema[] = [
      { name: "opacity", kind: "number", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches).toHaveLength(0);
  });

  it("does not match non-number/array kinds", () => {
    const schemas: PropSchema[] = [
      { name: "items", kind: "string", required: true, values: [] },
      { name: "count", kind: "boolean", required: true, values: [] },
    ];
    const matches = detectScalingProps(schemas);
    expect(matches).toHaveLength(0);
  });
});

describe("generateScalingCombos", () => {
  it("generates numeric scaling combos at default points", () => {
    const schemas: PropSchema[] = [
      { name: "count", kind: "number", required: true, values: [1, 5, 20] },
      { name: "label", kind: "string", required: true, values: ["test"] },
    ];
    const match: ScalingPropMatch = {
      schema: schemas[0],
      kind: "numeric",
      reason: "numeric prop name matches scaling pattern",
    };
    const combos = generateScalingCombos(schemas, match, [1, 5, 20, 50]);
    expect(combos).toHaveLength(4);
    expect(combos[0]).toEqual({ count: 1, label: "test" });
    expect(combos[1]).toEqual({ count: 5, label: "test" });
    expect(combos[2]).toEqual({ count: 20, label: "test" });
    expect(combos[3]).toEqual({ count: 50, label: "test" });
  });

  it("generates array scaling combos with string items", () => {
    const schemas: PropSchema[] = [
      { name: "items", kind: "array", required: true, values: [] },
    ];
    const match: ScalingPropMatch = {
      schema: schemas[0],
      kind: "array",
      reason: "array prop with items-like name",
    };
    const combos = generateScalingCombos(schemas, match, [1, 5, 20, 50]);
    expect(combos).toHaveLength(4);
    expect(combos[0]).toEqual({ items: ["item-1"] });
    expect(combos[1].items).toHaveLength(5);
    expect((combos[1].items as string[])[4]).toBe("item-5");
    expect(combos[2].items).toHaveLength(20);
    expect(combos[3].items).toHaveLength(50);
  });

  it("uses anchor values for non-scaling props", () => {
    const schemas: PropSchema[] = [
      { name: "items", kind: "array", required: true, values: [] },
      { name: "disabled", kind: "boolean", required: true, values: [] },
      { name: "variant", kind: "union", required: true, values: ["primary", "ghost"] },
    ];
    const match: ScalingPropMatch = {
      schema: schemas[0],
      kind: "array",
      reason: "array prop with items-like name",
    };
    const combos = generateScalingCombos(schemas, match, [1, 5]);
    expect(combos[0].disabled).toBe(false);
    expect(combos[0].variant).toBe("primary");
    expect(combos[1].disabled).toBe(false);
    expect(combos[1].variant).toBe("primary");
  });

  it("respects custom scale points", () => {
    const schemas: PropSchema[] = [
      { name: "count", kind: "number", required: true, values: [1] },
    ];
    const match: ScalingPropMatch = {
      schema: schemas[0],
      kind: "numeric",
      reason: "numeric prop name matches scaling pattern",
    };
    const combos = generateScalingCombos(schemas, match, [10, 100, 1000]);
    expect(combos).toHaveLength(3);
    expect(combos[0].count).toBe(10);
    expect(combos[1].count).toBe(100);
    expect(combos[2].count).toBe(1000);
  });
});
