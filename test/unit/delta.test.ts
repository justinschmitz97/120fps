import { describe, it, expect } from "vitest";
import { generateDeltaPairs, type DeltaPair } from "../../src/prop-gen-values.js";
import type { PropSchema } from "../../src/prop-gen.js";

describe("generateDeltaPairs", () => {
  it("generates pair for a single boolean prop", () => {
    const schemas: PropSchema[] = [
      { name: "disabled", kind: "boolean", required: true, values: [] },
    ];
    const pairs = generateDeltaPairs(schemas);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].propName).toBe("disabled");
    expect(pairs[0].baseValue).toBe(false);
    expect(pairs[0].flipValue).toBe(true);
    expect(pairs[0].baseCombo).toEqual({ disabled: false });
    expect(pairs[0].flipCombo).toEqual({ disabled: true });
  });

  it("generates pairs for a union prop with 3 values", () => {
    const schemas: PropSchema[] = [
      { name: "variant", kind: "union", required: true, values: ["primary", "secondary", "ghost"] },
    ];
    const pairs = generateDeltaPairs(schemas);
    expect(pairs).toHaveLength(2);
    expect(pairs[0].propName).toBe("variant");
    expect(pairs[0].baseValue).toBe("primary");
    expect(pairs[0].flipValue).toBe("secondary");
    expect(pairs[1].propName).toBe("variant");
    expect(pairs[1].baseValue).toBe("primary");
    expect(pairs[1].flipValue).toBe("ghost");
  });

  it("generates pair for optional object prop", () => {
    const schemas: PropSchema[] = [
      { name: "config", kind: "object", required: false, values: [{ a: 1 }] },
    ];
    const pairs = generateDeltaPairs(schemas);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].propName).toBe("config");
    expect(pairs[0].baseValue).toBe(undefined);
    expect(pairs[0].flipValue).toEqual({ a: 1 });
  });

  it("skips required object props", () => {
    const schemas: PropSchema[] = [
      { name: "config", kind: "object", required: true, values: [{ a: 1 }] },
    ];
    const pairs = generateDeltaPairs(schemas);
    expect(pairs).toHaveLength(0);
  });

  it("skips function, reactnode, and unknown kinds", () => {
    const schemas: PropSchema[] = [
      { name: "onClick", kind: "function", required: true, values: [] },
      { name: "children", kind: "reactnode", required: true, values: [] },
      { name: "data", kind: "unknown", required: true, values: [] },
    ];
    const pairs = generateDeltaPairs(schemas);
    expect(pairs).toHaveLength(0);
  });

  it("returns empty for no props", () => {
    const pairs = generateDeltaPairs([]);
    expect(pairs).toHaveLength(0);
  });

  it("holds other props at anchor value while flipping one", () => {
    const schemas: PropSchema[] = [
      { name: "disabled", kind: "boolean", required: true, values: [] },
      { name: "variant", kind: "union", required: true, values: ["primary", "ghost"] },
    ];
    const pairs = generateDeltaPairs(schemas);
    const disabledPair = pairs.find((p) => p.propName === "disabled")!;
    expect(disabledPair.baseCombo.variant).toBe("primary");
    expect(disabledPair.flipCombo.variant).toBe("primary");
    const variantPair = pairs.find((p) => p.propName === "variant")!;
    expect(variantPair.baseCombo.disabled).toBe(false);
    expect(variantPair.flipCombo.disabled).toBe(false);
  });

  it("caps at 128 pairs", () => {
    const schemas: PropSchema[] = [];
    for (let i = 0; i < 200; i++) {
      schemas.push({ name: `bool${i}`, kind: "boolean", required: true, values: [] });
    }
    const pairs = generateDeltaPairs(schemas);
    expect(pairs.length).toBeLessThanOrEqual(128);
  });

  it("prioritizes booleans over unions over objects", () => {
    const schemas: PropSchema[] = [
      { name: "config", kind: "object", required: false, values: [{ x: 1 }] },
      { name: "variant", kind: "union", required: true, values: ["a", "b", "c"] },
      { name: "active", kind: "boolean", required: true, values: [] },
    ];
    const pairs = generateDeltaPairs(schemas);
    expect(pairs[0].propName).toBe("active");
  });
});
