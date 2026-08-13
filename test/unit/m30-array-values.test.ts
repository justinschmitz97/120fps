import { describe, it, expect } from "vitest";
import { extractProps, detectScalingProps, type PropSchema } from "../../src/prop-gen.js";
import { generateScalingCombos, generateCombinations } from "../../src/prop-gen-values.js";

const FIXTURE = "./fixtures/m30-typed-arrays.tsx";

function schema(props: PropSchema[], name: string): PropSchema {
  const found = props.find((p) => p.name === name);
  if (!found) throw new Error(`no schema for ${name}`);
  return found;
}

describe("m30 F2 — array elements come from the element type", () => {
  it("synthesizes an object element for an array of objects", async () => {
    const props = await extractProps(FIXTURE);
    const rows = schema(props, "rows");
    expect(rows.kind).toBe("array");
    expect(rows.elementTemplate).toEqual({ id: 1, label: "text" });
  });

  it("takes the first member of a discriminated union element", async () => {
    const props = await extractProps(FIXTURE);
    const lines = schema(props, "lines");
    expect(lines.elementTemplate).toEqual({ kind: "plain", text: "text" });
  });

  it("synthesizes a primitive element for an array of strings", async () => {
    const props = await extractProps(FIXTURE);
    expect(schema(props, "tags").elementTemplate).toBe("text");
  });

  it("synthesizes a primitive element for an array of numbers", async () => {
    const props = await extractProps(FIXTURE);
    expect(schema(props, "counts").elementTemplate).toBe(1);
  });

  it("fills scaling combos with element-typed values, not strings", async () => {
    const props = await extractProps(FIXTURE);
    const match = detectScalingProps(props).find((m) => m.schema.name === "rows");
    expect(match).toBeDefined();
    const combos = generateScalingCombos(props, match!, [1, 3]);
    expect(combos[0].rows).toEqual([{ id: 1, label: "text" }]);
    expect((combos[1].rows as unknown[]).length).toBe(3);
    for (const el of combos[1].rows as unknown[]) {
      expect(el).toEqual({ id: 1, label: "text" });
    }
  });

  it("gives each scaled element its own object identity", async () => {
    const props = await extractProps(FIXTURE);
    const match = detectScalingProps(props).find((m) => m.schema.name === "rows");
    const combos = generateScalingCombos(props, match!, [3]);
    const els = combos[0].rows as unknown[];
    expect(els[0]).not.toBe(els[1]);
  });

  it("uses the element template in normal combo generation too", async () => {
    const props = await extractProps(FIXTURE);
    const combos = generateCombinations([schema(props, "rows")]);
    const nonEmpty = combos
      .map((c) => c.rows as unknown[])
      .filter((v) => Array.isArray(v) && v.length > 0);
    expect(nonEmpty.length).toBeGreaterThan(0);
    expect(nonEmpty[0][0]).toEqual({ id: 1, label: "text" });
  });

  it("falls back to strings when the element type cannot be synthesized", async () => {
    const props = await extractProps(FIXTURE);
    const opaque = schema(props, "handlers");
    expect(opaque.elementTemplate).toBeUndefined();
    const match = { schema: opaque, kind: "array" as const, reason: "array prop" };
    const combos = generateScalingCombos([opaque], match, [2]);
    expect(combos[0].handlers).toEqual(["item-1", "item-2"]);
  });

  it("caps recursion on a self-referential element type", async () => {
    const props = await extractProps(FIXTURE);
    const tree = schema(props, "nodes");
    // Must terminate and must not nest past the depth cap.
    const depth = (v: unknown): number =>
      v && typeof v === "object" && "child" in (v as object)
        ? 1 + depth((v as { child: unknown }).child)
        : 0;
    expect(depth(tree.elementTemplate)).toBeLessThanOrEqual(3);
  });
});
