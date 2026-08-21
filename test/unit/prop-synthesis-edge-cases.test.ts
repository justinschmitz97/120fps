import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import {
  extractProps,
  extractAllProps,
  detectScalingProps,
  resetExtractionCache,
  type PropSchema,
} from "../../src/prop-gen.js";
import {
  comboKey,
  countCombinationSpace,
  fillArray,
  generateCombinations,
  generateDeltaPairs,
  selectRepresentativeCombos,
} from "../../src/prop-gen-values.js";
import { applyPropPresets } from "../../src/prop-presets.js";

const M60 = path.resolve("./fixtures/m60");
const fixture = (name: string): string => path.join(M60, name);

const get = (schemas: PropSchema[], name: string): PropSchema => {
  const found = schemas.find((s) => s.name === name);
  if (!found) throw new Error(`no schema for ${name}: ${schemas.map((s) => s.name).join(",")}`);
  return found;
};

let shapes: PropSchema[] | undefined;
const shapeProps = async (): Promise<PropSchema[]> => {
  if (!shapes) shapes = await extractProps(fixture("harden-shapes.tsx"));
  return shapes;
};

function captureStderr(): { lines: () => string[] } {
  resetExtractionCache();
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { lines: () => write.mock.calls.map((c) => String(c[0])) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prop synthesis: object/array shapes", () => {
  // H1 a self-referential type must terminate and must not fabricate nesting.
  it("H1: a recursive object type stops at the first repeat", async () => {
    const tree = get(await shapeProps(), "tree").values[0] as Record<string, unknown>;
    expect(tree.label).toBe("text");
    expect(tree.child).toBeUndefined();
  });

  // H2 a union of object types.
  it("H2: a union of object shapes takes the first member, discriminant included", async () => {
    expect(get(await shapeProps(), "either").values[0]).toEqual({ layout: "grid", cols: 1 });
  });

  // H3 optional chains all the way down.
  it("H3: optional nested members are still filled", async () => {
    expect(get(await shapeProps(), "deep").values[0]).toEqual({ a: { b: { c: "text" } } });
  });

  // H4 readonly array of objects keeps the M30 element template.
  it("H4: a readonly array of objects still yields an element template", async () => {
    const frozen = get(await shapeProps(), "frozen");
    expect(frozen.kind).toBe("array");
    expect(frozen.elementTemplate).toEqual({ id: 1 });
  });

  // H5 a Date prop must be a real Date, which the serializer carries.
  it("H5: Date and RegExp props are real instances", async () => {
    const props = await shapeProps();
    expect(get(props, "when").values[0]).toBeInstanceOf(Date);
    expect(get(props, "pattern").values[0]).toBeInstanceOf(RegExp);
  });

  // H6 nested collections and instants inside a domain object.
  it("H6: a nested Map becomes entries and a nested Date stays a Date", async () => {
    const wrapped = get(await shapeProps(), "wrapped").values[0] as Record<string, unknown>;
    expect(wrapped.size).toBe("sm");
    expect(wrapped.when).toBeInstanceOf(Date);
    expect(wrapped.index).toEqual([
      ["text-1", 1],
      ["text-2", 1],
    ]);
  });

  // H7 a nested untransportable member makes the whole prop degenerate.
  it("H7: the nested Map is named in the parent prop's degeneracy", async () => {
    expect(get(await shapeProps(), "wrapped").degenerate).toContain("Map");
  });

  // H8 an index signature has no members to synthesize.
  it("H8: Record<string, number> degrades to {} and says so", async () => {
    const lookup = get(await shapeProps(), "lookup");
    expect(lookup.values[0]).toEqual({});
    expect(lookup.degenerate).toBeDefined();
  });

  // H9/H10 degenerate tuple arities must not throw.
  it("H9: an empty tuple and a rest tuple do not crash extraction", async () => {
    const props = await shapeProps();
    expect(get(props, "none").values[0]).toEqual([]);
    const rest = get(props, "rest").values[0] as unknown[];
    expect(rest.length).toBeGreaterThan(0);
    expect(rest[0]).toBe("text");
  });

  // H11 shaped objects must not shadow the real scaling candidates.
  it("H11: array props are still the scaling candidates", async () => {
    const matches = detectScalingProps(await shapeProps()).map((m) => m.schema.name);
    expect(matches).toContain("rows");
    expect(matches).toContain("frozen");
    expect(matches).not.toContain("none");
    expect(matches).not.toContain("wrapped");
  });

  // H12 every shape in the fixture stays generatable end to end.
  it("H12: combos generate, de-duplicate and never exceed the space", async () => {
    const props = await shapeProps();
    const combos = generateCombinations(props);
    expect(combos.length).toBeGreaterThan(0);
    expect(new Set(combos.map(comboKey)).size).toBe(combos.length);
    expect(combos.length).toBeLessThanOrEqual(countCombinationSpace(props));
    expect(() => generateDeltaPairs(props)).not.toThrow();
  });
});

describe("prop synthesis: cva variants", () => {
  // H13 compound variants must not disturb the variant axes.
  it("H13: compoundVariants leaves the variant keys enumerable", async () => {
    const props = await extractProps(fixture("cva-compound.tsx"));
    expect(get(props, "tone").values).toEqual(["neutral", "danger"]);
  });

  // H14 cva's "true"/"false" variant keys are booleans, not strings.
  it("H14: a boolean variant classifies as boolean", async () => {
    const props = await extractProps(fixture("cva-compound.tsx"));
    expect(get(props, "loading")).toMatchObject({ kind: "boolean", values: [true, false] });
  });
});

describe("prop synthesis: degeneracy warnings", () => {
  // H15 a required prop with no enumerable values is a guaranteed crash.
  it("H15: a required unenumerable prop is reported", async () => {
    const stderr = captureStderr();
    const props = await extractProps(fixture("unsynthesizable.tsx"));
    expect(get(props, "store").degenerate).toBeDefined();
    expect(stderr.lines().find((l) => l.includes("store"))).toBeDefined();
  });

  // M98 (element-plus-F3): `string | number` is a union of two primitive
  // shapes, so it now carries one synthesized member per branch and the same
  // disclosure every other union gets, where it used to be an opaque
  // `unknown` with an empty pool.
  it("a required string | number prop is enumerable and disclosed", async () => {
    const stderr = captureStderr();
    const props = await extractProps(fixture("required-unknown.tsx"));
    const token = get(props, "token");
    expect(token.kind).toBe("union");
    expect(token.degenerate).toBeUndefined();
    expect(token.values.some((v) => typeof v === "string")).toBe(true);
    expect(token.values.some((v) => typeof v === "number")).toBe(true);
    expect(stderr.lines().find((l) => l.includes('prop "token"'))).toBeDefined();
  });

  // H16 an optional unenumerable prop is measured absent, which is legitimate.
  it("H16: an optional unenumerable prop warns about nothing", async () => {
    const stderr = captureStderr();
    await extractProps(fixture("optional-unknown.tsx"));
    expect(stderr.lines().find((l) => l.includes("span"))).toBeUndefined();
  });

  // H17 a props type wide enough to be a DOM surface is capped, out loud.
  it("H17: an over-wide props type is capped and disclosed", async () => {
    const stderr = captureStderr();
    const props = await extractProps(fixture("wide-props.tsx"));
    expect(props).toHaveLength(32);
    expect(stderr.lines().find((l) => l.includes("40 props"))).toBeDefined();
  });

  // H18 the escape hatch the warning names, already taken.
  it("H18: an adjacent preset file silences the degenerate warning", async () => {
    const stderr = captureStderr();
    const props = await extractProps(fixture("preset-covered.tsx"));
    expect(get(props, "byId").degenerate).toBeDefined();
    expect(stderr.lines()).toEqual([]);
  });

  // H19 presets replace the stand-in, so the mark must not survive them.
  it("H19: applying a preset clears the prop's degeneracy", async () => {
    const props = await extractProps(fixture("preset-covered.tsx"));
    const applied = applyPropPresets(props, {
      path: "preset-covered.props.tsx",
      absolutePath: fixture("preset-covered.props.tsx"),
      entries: new Map([["byId", [{ a: 1 }]]]),
    });
    expect(get(applied.schemas, "byId").degenerate).toBeUndefined();
    expect(get(applied.schemas, "label").degenerate).toBeUndefined();
  });
});

let edges: PropSchema[] | undefined;
const edgeProps = async (): Promise<PropSchema[]> => {
  if (!edges) edges = await extractProps(fixture("harden-edges.tsx"));
  return edges;
};

describe("prop synthesis: edge-case types", () => {
  // H25 an intersection over a mapped type.
  it("H25: Omit<Base, k> & { … } synthesizes the surviving members", async () => {
    expect(get(await edgeProps(), "picked").values[0]).toEqual({ alpha: "text", beta: true });
  });

  // H26 a generic with a defaulted type parameter.
  it("H26: a generic default resolves to its element shape", async () => {
    expect(get(await edgeProps(), "listing").values[0]).toEqual({ rows: [{ id: 1 }] });
  });

  // H27 numeric enum.
  it("H27: a numeric enum is a union of its members", async () => {
    expect(get(await edgeProps(), "level")).toMatchObject({ kind: "union", values: [1, 2] });
  });

  // H28 an array of instants: cloning must not flatten a Date into {}.
  it("H28: scaling an array of Dates keeps real Dates", async () => {
    const stamps = get(await edgeProps(), "stamps");
    expect(stamps.elementTemplate).toBeInstanceOf(Date);
    const filled = fillArray(stamps, 2);
    expect(filled[0]).toBeInstanceOf(Date);
    expect(filled[0]).not.toBe(filled[1]);
  });

  // H29 an array of collections.
  it("H29: an array of Maps carries entry arrays as elements", async () => {
    expect(get(await edgeProps(), "buckets").elementTemplate).toEqual([
      ["text-1", 1],
      ["text-2", 1],
    ]);
  });

  // H30 a readonly tuple is still a tuple.
  it("H30: a readonly tuple is filled per position", async () => {
    expect(get(await edgeProps(), "frozenPair").values[0]).toEqual(["text", "text"]);
  });

  // H31 a nullable object type.
  it("H31: `Base | null` is shaped, not unknown", async () => {
    expect(get(await edgeProps(), "nullable").values[0]).toEqual({ alpha: "text", omit: 1 });
  });

  // H32 an `unknown` member has nothing to offer.
  it("H32: an unknown-typed prop is degenerate, not a crash", async () => {
    expect(get(await edgeProps(), "loose")).toMatchObject({ kind: "unknown", values: [] });
  });

  // H33 local members come before inherited third-party ones.
  it("H33: locally declared props are ordered ahead of inherited ones", async () => {
    const names = (await edgeProps()).map((s) => s.name);
    expect(names.indexOf("picked")).toBeLessThan(names.indexOf("port"));
    expect(names).toContain("address");
  });

  // H34 a props type that is nothing but React's DOM surface. M81 section 2:
  // this surface is genuinely enumerable (it was never an unenumerable
  // computed type, just fully noise-filtered before the cap), so it is now
  // measured like any other inherited surface: ranked, capped at 32, and
  // disclosed by `warnPropCap` naming the true (uncapped) total — not
  // silently reported as `[]` with a misleading "could not be enumerated".
  it("H34: ComponentProps<'button'> is measured with its real DOM surface, capped honestly", async () => {
    const stderr = captureStderr();
    const schemas = await extractProps(fixture("native-button.tsx"));
    const names = schemas.map((s) => s.name);
    expect(schemas.length).toBe(32);
    expect(names).toContain("children");
    expect(names).toContain("disabled");
    const warning = stderr.lines().find((l) => l.includes("props were extracted"));
    expect(warning).toBeDefined();
    expect(warning).toContain("237 props were extracted");
  });

  // H35 every edge shape stays generatable.
  it("H35: edge-case combos generate without duplicates", async () => {
    const combos = generateCombinations(await edgeProps());
    expect(combos.length).toBeGreaterThan(0);
    expect(new Set(combos.map(comboKey)).size).toBe(combos.length);
  });
});

describe("prop synthesis: unaffected code paths", () => {
  // H20 the per-export walk composition uses is untouched.
  it("H20: extractAllProps still reports every exported component", async () => {
    const all = await extractAllProps(path.resolve("./fixtures/m58/hotspot-image.tsx"));
    expect([...all.keys()].sort()).toEqual(["HotspotImage", "Marker"]);
  });

  // H21 Vue extraction goes through the same schema builder.
  it("H21: Vue defineProps extraction is unchanged", async () => {
    const props = await extractProps("./fixtures/vue-project/Card.vue");
    expect(props.map((s) => s.name).sort()).toEqual(["compact", "heading", "items", "tone"]);
    expect(get(props, "items").elementTemplate).toEqual({ id: 1, title: "text" });
  });

  // H22 --max-combos selection is a pure function over the deduped count.
  it("H22: representative selection keeps both ends", () => {
    expect(selectRepresentativeCombos(12, 4)).toEqual([0, 4, 7, 11]);
    expect(selectRepresentativeCombos(3, 8)).toEqual([0, 1, 2]);
  });

  // H23 the tuple that M30 pinned as an object prop stays one.
  it("H23: a tuple is still kind object with no element template", async () => {
    const props = await extractProps("./fixtures/m30-array-edges.tsx");
    const pair = get(props, "pair");
    expect(pair.kind).toBe("object");
    expect(pair.elementTemplate).toBeUndefined();
    expect(pair.values[0]).toEqual([1, 1]);
  });

  // H24 the DOM surface of an HTMLAttributes-extending props type is now
  // ranked and capped rather than silently erased (M81 section 2): the
  // component's own `padding`/`elevation` (Tier 1/2) still survive, and so
  // does the inherited surface up to the 32-prop cap.
  it("H24: inherited DOM attributes are ranked and capped, not erased", async () => {
    const stderr = captureStderr();
    const props = await extractProps("./fixtures/html-attrs.tsx");
    const names = props.map((s) => s.name);
    expect(props.length).toBe(32);
    expect(names).toContain("padding");
    expect(names).toContain("elevation");
    expect(names).toContain("children");
    const warning = stderr.lines().find((l) => l.includes("props were extracted"));
    expect(warning).toBeDefined();
    expect(warning).toContain("227 props were extracted");
  });
});
