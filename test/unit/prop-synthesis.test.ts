import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import {
  extractProps,
  detectScalingProps,
  resetExtractionCache,
  type PropSchema,
} from "../../src/prop-gen.js";
import {
  generateCombinations,
  countCombinationSpace,
} from "../../src/prop-gen-values.js";

const M60 = path.resolve("./fixtures/m60");
const fixture = (name: string): string => path.join(M60, name);

const get = (schemas: PropSchema[], name: string): PropSchema => {
  const found = schemas.find((s) => s.name === name);
  if (!found) throw new Error(`no schema for ${name}: ${schemas.map((s) => s.name).join(",")}`);
  return found;
};

const stableKey = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (v === undefined ? "\u0000undefined" : v)) ?? "undefined";

function captureStderr(): { lines: () => string[] } {
  resetExtractionCache();
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { lines: () => write.mock.calls.map((c) => String(c[0])) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Bug 1: cva VariantProps
describe("cva variant unions", () => {
  it("enumerates variant keys through VariantProps<typeof x>", async () => {
    const schemas = await extractProps(fixture("cva-button.tsx"));
    expect(get(schemas, "variant")).toMatchObject({
      kind: "union",
      required: false,
      values: ["default", "destructive", "outline"],
    });
  });

  it("enumerates a second variant axis", async () => {
    const schemas = await extractProps(fixture("cva-button.tsx"));
    expect(get(schemas, "size").values).toEqual(["sm", "md"]);
  });

  it("a literal union with null classifies as a union, not unknown", async () => {
    const schemas = await extractProps("./fixtures/null-union.tsx");
    expect(get(schemas, "src").kind).toBe("string");
  });

  it("the enumerated variants reach matrix-eligible combo generation", async () => {
    const schemas = await extractProps(fixture("cva-button.tsx"));
    const variants = new Set(generateCombinations(schemas).map((c) => c.variant));
    expect(variants).toContain("destructive");
  });
});

// Bug 2: duplicate combos
describe("combo de-duplication", () => {
  it("an optional prop with an empty pool does not double the space", () => {
    const schemas: PropSchema[] = [
      { name: "label", kind: "string", required: true, values: ["test"] },
      { name: "value", kind: "unknown", required: false, values: [] },
    ];
    expect(generateCombinations(schemas)).toEqual([{ label: "test", value: undefined }]);
    expect(countCombinationSpace(schemas)).toBe(1);
  });

  it("no two generated combos are byte-identical", async () => {
    for (const file of ["cva-button.tsx", "optional-unknown.tsx", "tuple-pair.tsx"]) {
      const combos = generateCombinations(await extractProps(fixture(file)));
      const keys = combos.map(stableKey);
      expect(new Set(keys).size, `${file} produced duplicate combos`).toBe(keys.length);
    }
  });

  it("a repeated value in a pool is measured once", () => {
    const schemas: PropSchema[] = [
      { name: "tone", kind: "union", required: true, values: ["a", "a", "b"] },
    ];
    expect(generateCombinations(schemas)).toEqual([{ tone: "a" }, { tone: "b" }]);
  });

  it("de-duplication never grows the combo count", async () => {
    const schemas = await extractProps("./fixtures/button.tsx");
    expect(generateCombinations(schemas).length).toBeLessThanOrEqual(48);
  });
});

// Bug 3: tuples
describe("tuple props", () => {
  it("a 2-tuple of strings produces two real strings", async () => {
    const schemas = await extractProps(fixture("tuple-pair.tsx"));
    const images = get(schemas, "images");
    expect(images.values).toHaveLength(1);
    const value = images.values[0] as unknown[];
    expect(value).toHaveLength(2);
    expect(value.every((v) => typeof v === "string" && v.length > 0)).toBe(true);
  });

  it("positions are typed independently", async () => {
    const schemas = await extractProps(fixture("tuple-pair.tsx"));
    expect(get(schemas, "mixed").values[0]).toEqual(["text", 1, true]);
    expect(get(schemas, "origin").values[0]).toEqual([1, 1]);
  });

  it("a named optional tuple is still filled", async () => {
    const schemas = await extractProps(fixture("tuple-pair.tsx"));
    expect(get(schemas, "range").values[0]).toEqual([1, 1]);
  });

  it("a tuple is never a scaling candidate", async () => {
    const schemas = await extractProps(fixture("tuple-pair.tsx"));
    expect(detectScalingProps(schemas)).toEqual([]);
  });
});

// Bug 4: object domain types
describe("object synthesis", () => {
  it("shapes a nested domain object instead of {}", async () => {
    const schemas = await extractProps(fixture("domain-object.tsx"));
    expect(get(schemas, "board").values[0]).toEqual({
      name: "text",
      rows: 1,
      cells: [{ id: "text", value: 1, filled: true }],
      meta: { author: "text", version: 1 },
    });
  });

  it("fills every field of a flags object", async () => {
    const schemas = await extractProps(fixture("domain-object.tsx"));
    expect(get(schemas, "options").values[0]).toEqual({
      removeComments: true,
      collapseWhitespace: true,
      sortAttributes: true,
      minifyCss: true,
      minifyJs: true,
    });
  });

  it("a synthesizable object prop warns about nothing", async () => {
    const stderr = captureStderr();
    await extractProps(fixture("domain-object.tsx"));
    expect(stderr.lines()).toEqual([]);
  });

  it("keeps {} and warns when no value can be synthesized", async () => {
    const stderr = captureStderr();
    const schemas = await extractProps(fixture("unsynthesizable.tsx"));

    expect(get(schemas, "store").values[0]).toEqual({});
    expect(get(schemas, "pending").values[0]).toEqual({});

    const warning = stderr.lines().find((l) => l.includes("store"));
    expect(warning).toBeDefined();
    expect(warning).toContain("pending");
    expect(warning).toContain("unsynthesizable.props.tsx");
  });

  it("warns once per file across repeated extractions", async () => {
    const stderr = captureStderr();
    await extractProps(fixture("unsynthesizable.tsx"));
    await extractProps(fixture("unsynthesizable.tsx"));
    expect(stderr.lines().filter((l) => l.includes("store"))).toHaveLength(1);
  });
});

// Bug 5: Map / Set
describe("collection props", () => {
  it("a Map prop carries its entries instead of {}", async () => {
    const schemas = await extractProps(fixture("collections.tsx"));
    const entries = get(schemas, "byId").values[0] as [string, unknown][];
    expect(entries).toHaveLength(2);
    expect(entries[0][0]).not.toEqual(entries[1][0]);
    expect(entries[0][1]).toEqual({ id: 1, title: "text" });
  });

  it("a Set prop carries its members", async () => {
    const schemas = await extractProps(fixture("collections.tsx"));
    const members = get(schemas, "tags").values[0] as string[];
    expect(members).toHaveLength(2);
    expect(new Set(members).size).toBe(2);
  });

  it("a ReadonlyMap is handled like a Map", async () => {
    const schemas = await extractProps(fixture("collections.tsx"));
    expect((get(schemas, "frozen").values[0] as [string, number][])[0][1]).toBe(1);
  });

  it("names every collection prop in the degenerate warning", async () => {
    const stderr = captureStderr();
    await extractProps(fixture("collections.tsx"));
    const warning = stderr.lines().find((l) => l.includes("byId"));
    expect(warning).toBeDefined();
    expect(warning).toContain("tags");
    expect(warning).toContain("frozen");
    expect(warning).toContain("collections.props.tsx");
  });
});

// Bug 6: computed / foreign props types
describe("computed props types", () => {
  it("enumerates a props type whose members are declared in node_modules", async () => {
    const schemas = await extractProps(fixture("foreign-props.tsx"));
    expect(schemas.map((s) => s.name).sort()).toEqual(["address", "family", "port"]);
    expect(get(schemas, "port").kind).toBe("number");
  });

  // M81 section 2: the DOM surface of a primitive's ComponentProps is now
  // ranked and capped instead of silently erased. The primitive's own props
  // (checked: boolean -> Tier 1; orientation: literal union -> Tier 1;
  // onCheckedChange: locally declared -> Tier 2) all still survive, alongside
  // the inherited surface up to the 32-prop cap, with an honest warning
  // naming the true (uncapped) total.
  it("ranks and caps the DOM surface of a primitive's ComponentProps instead of dropping it", async () => {
    const stderr = captureStderr();
    const schemas = await extractProps(fixture("component-props.tsx"));
    const names = schemas.map((s) => s.name);
    expect(schemas.length).toBe(32);
    expect(names).toContain("checked");
    expect(names).toContain("orientation");
    expect(names).toContain("onCheckedChange");
    const warning = stderr.lines().find((l) => l.includes("props were extracted"));
    expect(warning).toBeDefined();
    expect(warning).toContain("238 props were extracted");
  });

  it("warns naming the annotation when nothing can be enumerated", async () => {
    const stderr = captureStderr();
    expect(await extractProps(fixture("opaque-computed.tsx"))).toEqual([]);

    const warning = stderr.lines().find((l) => l.includes("OpaqueWidget"));
    expect(warning).toBeDefined();
    expect(warning).toContain("ComponentProps<typeof OpaquePrimitive>");
    expect(warning).toContain("opaque-computed.props.tsx");
  });
});
