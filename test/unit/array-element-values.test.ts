import { describe, it, expect } from "vitest";
import { extractProps, detectScalingProps, type PropSchema } from "../../src/prop-gen.js";
import { fillArray, generateScalingCombos, generateCombinations } from "../../src/prop-gen-values.js";

const FIXTURE = "./fixtures/m30-typed-arrays.tsx";
const EDGES = "./fixtures/m30-array-edges.tsx";

function schema(props: PropSchema[], name: string): PropSchema {
  const found = props.find((p) => p.name === name);
  if (!found) throw new Error(`no schema for ${name}`);
  return found;
}

let cachedEdgeProps: PropSchema[] | undefined;
async function edgeProps(): Promise<PropSchema[]> {
  if (!cachedEdgeProps) cachedEdgeProps = await extractProps(EDGES);
  return cachedEdgeProps;
}

function get(all: PropSchema[], name: string): PropSchema {
  const found = all.find((p) => p.name === name);
  if (!found) throw new Error(`no schema for ${name}`);
  return found;
}

describe("array elements come from the element type", () => {
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

describe("array element synthesis", () => {
  it("H1 readonly array yields a primitive element", async () => {
    expect(get(await edgeProps(), "frozen").elementTemplate).toBe("text");
  });

  it("H2 a tuple is not an array prop and gets no element template", async () => {
    const pair = get(await edgeProps(), "pair");
    expect(pair.kind).toBe("object");
    expect(pair.elementTemplate).toBeUndefined();
  });

  it("H3 union of primitives takes the first member", async () => {
    expect(get(await edgeProps(), "mixed").elementTemplate).toBe("text");
  });

  it("H4 nested array yields a one-element inner array", async () => {
    expect(get(await edgeProps(), "grid").elementTemplate).toEqual([{ x: 1, y: 1 }]);
  });

  it("H5 unknown[] falls back to the string element", async () => {
    const loose = get(await edgeProps(), "loose");
    expect(loose.elementTemplate).toBeUndefined();
    expect(fillArray(loose, 2)).toEqual(["item-1", "item-2"]);
  });

  it("H6 optional array is still synthesized", async () => {
    expect(get(await edgeProps(), "maybe").elementTemplate).toEqual({ x: 1, y: 1 });
  });

  it("H7 boolean array yields a boolean element", async () => {
    expect(get(await edgeProps(), "flags").elementTemplate).toBe(true);
  });

  it("H8 literal union array takes the first literal", async () => {
    expect(get(await edgeProps(), "literals").elementTemplate).toBe("a");
  });

  it("H9 an element type with no properties falls back rather than emitting {}", async () => {
    const empty = get(await edgeProps(), "empty");
    expect(empty.elementTemplate).toBeUndefined();
    expect(fillArray(empty, 2)).toEqual(["item-1", "item-2"]);
  });

  it("H10 every array prop stays generatable end to end", async () => {
    const all = await edgeProps();
    expect(() => generateCombinations(all)).not.toThrow();
    expect(generateCombinations(all).length).toBeGreaterThan(0);
  });

  it("H11 fillArray(0) is empty", async () => {
    expect(fillArray(get(await edgeProps(), "grid"), 0)).toEqual([]);
  });

  it("H12 clones are deep, not shared references", async () => {
    const filled = fillArray(get(await edgeProps(), "grid"), 2) as unknown[][];
    expect(filled[0]).not.toBe(filled[1]);
    expect(filled[0][0]).not.toBe(filled[1][0]);
  });
});
