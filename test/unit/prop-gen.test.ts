import { describe, it, expect } from "vitest";
import { extractProps } from "../../src/prop-gen.js";
import { generateCombinations } from "../../src/prop-gen-values.js";

describe("generateCombinations", () => {
  it("produces correct count for button props", async () => {
    const schema = await extractProps("./fixtures/button.tsx");
    const combos = generateCombinations(schema);

    // variant: 3 values + undefined (optional) = 4
    // disabled: 2 values + undefined (optional) = 3
    // label: 1 value (required) = 1
    // onClick: 1 value + undefined (optional) = 2
    // children: 1 value + undefined (optional) = 2
    // Total: 4 * 3 * 1 * 2 * 2 = 48 (under 64 cap)
    expect(combos.length).toBe(48);
  });

  it("every combination has a label value", async () => {
    const schema = await extractProps("./fixtures/button.tsx");
    const combos = generateCombinations(schema);
    for (const combo of combos) {
      expect(combo).toHaveProperty("label");
      expect(combo.label).not.toBeUndefined();
    }
  });

  it("includes all variant values", async () => {
    const schema = await extractProps("./fixtures/button.tsx");
    const combos = generateCombinations(schema);
    const variants = new Set(combos.map((c) => c.variant));
    expect(variants).toContain("primary");
    expect(variants).toContain("secondary");
    expect(variants).toContain("ghost");
    expect(variants).toContain(undefined);
  });

  it("respects MAX_COMBINATIONS cap", () => {
    // Artificial schema that would produce > 64 combos
    const bigSchema = [
      { name: "a", kind: "union" as const, required: true, values: [1, 2, 3, 4, 5] },
      { name: "b", kind: "union" as const, required: true, values: [1, 2, 3, 4, 5] },
      { name: "c", kind: "union" as const, required: true, values: [1, 2, 3, 4, 5] },
    ];
    // 5^3 = 125, should be capped at 64
    const combos = generateCombinations(bigSchema);
    expect(combos.length).toBeLessThanOrEqual(64);
    expect(combos.length).toBeGreaterThan(0);
  });

  it("stratified sampling covers every value at least once", () => {
    const bigSchema = [
      { name: "x", kind: "union" as const, required: true, values: ["a", "b", "c", "d", "e", "f", "g", "h"] },
      { name: "y", kind: "union" as const, required: true, values: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    ];
    // 8*9 = 72 > 64
    const combos = generateCombinations(bigSchema);
    const xValues = new Set(combos.map((c) => c.x));
    const yValues = new Set(combos.map((c) => c.y));
    for (const v of bigSchema[0].values) expect(xValues).toContain(v);
    for (const v of bigSchema[1].values) expect(yValues).toContain(v);
  });
});
