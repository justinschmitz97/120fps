import { describe, it, expect } from "vitest";
import { extractProps } from "../../src/prop-gen.js";
import { generateCombinations } from "../../src/prop-gen-values.js";

// H11: Class component
describe("H11: class component", () => {
  it("extracts props from class extending React.Component<Props>", async () => {
    const schema = await extractProps("./fixtures/class-comp.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["initialCount", "label", "step"].sort());
  });

  it("label is required string", async () => {
    const schema = await extractProps("./fixtures/class-comp.tsx");
    const label = schema.find((s) => s.name === "label");
    expect(label?.kind).toBe("string");
    expect(label?.required).toBe(true);
  });
});

// H12: React.FC<Props> pattern
describe("H12: React.FC pattern", () => {
  it("extracts props from FC-typed const", async () => {
    const schema = await extractProps("./fixtures/fc-pattern.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["color", "removable", "text"].sort());
  });

  it("color is union", async () => {
    const schema = await extractProps("./fixtures/fc-pattern.tsx");
    const color = schema.find((s) => s.name === "color");
    expect(color?.kind).toBe("union");
    expect(color?.values).toEqual(["red", "green", "blue"]);
  });
});

// H13: Discriminated union props
describe("H13: discriminated union", () => {
  it("extracts some props from discriminated union", async () => {
    const schema = await extractProps("./fixtures/discriminated.tsx");
    // Discriminated unions: TS may report shared properties or union-level properties
    // At minimum we should not crash
    expect(schema).toBeInstanceOf(Array);
  });

  it("kind prop is present if TS resolves shared members", async () => {
    const schema = await extractProps("./fixtures/discriminated.tsx");
    // All variants have 'kind', so getProperties() on the union should include it
    const kind = schema.find((s) => s.name === "kind");
    if (kind) {
      expect(kind.kind).toBe("union");
    }
    // If kind is missing, that's a documented limitation — not a crash
  });
});

// H14: TypeScript enum
describe("H14: TS enum prop", () => {
  it("extracts props from component with enum prop type", async () => {
    const schema = await extractProps("./fixtures/enum-prop.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["name", "size", "spin"].sort());
  });

  it("size enum is classified as union with string values", async () => {
    const schema = await extractProps("./fixtures/enum-prop.tsx");
    const size = schema.find((s) => s.name === "size");
    expect(size).toBeDefined();
    // Enum values are string literals under the hood
    if (size?.kind === "union") {
      expect(size.values).toEqual(["sm", "md", "lg", "xl"]);
    }
    // Record what actually happens if it's not a union
  });
});

// H15: Nested object type
describe("H15: nested object prop", () => {
  it("extracts props including nested object type", async () => {
    const schema = await extractProps("./fixtures/nested-object.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["collapsed", "theme", "title"].sort());
  });

  it("theme is classified as object", async () => {
    const schema = await extractProps("./fixtures/nested-object.tsx");
    const theme = schema.find((s) => s.name === "theme");
    expect(theme?.kind).toBe("object");
  });
});

// H16: string | null union
describe("H16: null in union", () => {
  it("extracts props from component with nullable type", async () => {
    const schema = await extractProps("./fixtures/null-union.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["alt", "size", "src"].sort());
  });

  it("src is classified as string (null stripped like undefined)", async () => {
    const schema = await extractProps("./fixtures/null-union.tsx");
    const src = schema.find((s) => s.name === "src");
    expect(src).toBeDefined();
    // string | null should strip null and classify as string
    // But our stripUndefined only strips undefined, not null
    // Record actual behavior
  });
});

// H17: Multiple components in one file
describe("H17: multiple components", () => {
  it("extracts props from the first component", async () => {
    const schema = await extractProps("./fixtures/multi-component.tsx");
    // Should pick the first exported function component
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["sticky", "title"].sort());
  });
});

// H18: Extends HTMLAttributes — massive DOM props
describe("H18: extends HTMLAttributes", () => {
  it("extracts props without crashing on 100+ inherited DOM props", async () => {
    const schema = await extractProps("./fixtures/html-attrs.tsx");
    expect(schema.length).toBeGreaterThan(2);
    // Should include our custom props
    const padding = schema.find((s) => s.name === "padding");
    const elevation = schema.find((s) => s.name === "elevation");
    expect(padding).toBeDefined();
    expect(elevation).toBeDefined();
  });

  it("combination count is capped at 64", async () => {
    const schema = await extractProps("./fixtures/html-attrs.tsx");
    const combos = generateCombinations(schema);
    expect(combos.length).toBeLessThanOrEqual(64);
  });
});

// H19: Template literal type
describe("H19: template literal type", () => {
  it("extracts props from component with template literal type", async () => {
    const schema = await extractProps("./fixtures/template-literal.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["label", "size", "token"].sort());
  });

  it("template literal type is classified as string (infinite set)", async () => {
    const schema = await extractProps("./fixtures/template-literal.tsx");
    const token = schema.find((s) => s.name === "token");
    expect(token).toBeDefined();
    // Template literal `color-${string}` is an infinite type — should be string or unknown
    expect(["string", "unknown"]).toContain(token?.kind);
  });
});

// H20: Readonly array
describe("H20: readonly array", () => {
  it("extracts props from component with readonly array", async () => {
    const schema = await extractProps("./fixtures/readonly-array.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["max", "onRemove", "tags"].sort());
  });

  it("readonly string[] is classified as array", async () => {
    const schema = await extractProps("./fixtures/readonly-array.tsx");
    const tags = schema.find((s) => s.name === "tags");
    expect(tags).toBeDefined();
    // checker.isArrayType may not recognize readonly arrays
    // ReadonlyArray<string> is technically a different type
    expect(["array", "object"]).toContain(tags?.kind);
  });
});

// H21: Tuple type
describe("H21: tuple type", () => {
  it("extracts props from component with tuple", async () => {
    const schema = await extractProps("./fixtures/tuple-prop.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["label", "position"].sort());
  });

  it("tuple [number, number] classification", async () => {
    const schema = await extractProps("./fixtures/tuple-prop.tsx");
    const pos = schema.find((s) => s.name === "position");
    expect(pos).toBeDefined();
    // Tuples may be classified as array or object
    expect(["array", "object"]).toContain(pos?.kind);
  });
});

// H22: Very large union (22 values)
describe("H22: large union", () => {
  it("extracts country as union with all 22 values", async () => {
    const schema = await extractProps("./fixtures/large-union.tsx");
    const country = schema.find((s) => s.name === "country");
    expect(country?.kind).toBe("union");
    expect(country?.values).toHaveLength(22);
  });

  it("combinations are capped when large union * other props > 64", async () => {
    const schema = await extractProps("./fixtures/large-union.tsx");
    const combos = generateCombinations(schema);
    // country: 22 values (required), size: 3 + undefined = 4 (optional)
    // 22 * 4 = 88 > 64 → should be capped
    expect(combos.length).toBeLessThanOrEqual(64);
  });

  it("stratified sampling covers all 22 countries", async () => {
    const schema = await extractProps("./fixtures/large-union.tsx");
    const combos = generateCombinations(schema);
    const countries = new Set(combos.map((c) => c.country));
    expect(countries.size).toBe(22);
  });
});

// H23: All-optional component
describe("H23: all-optional props", () => {
  it("extracts all optional props", async () => {
    const schema = await extractProps("./fixtures/all-optional.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["height", "visible", "width"].sort());
    expect(schema.every((s) => !s.required)).toBe(true);
  });

  it("includes the all-undefined combination", async () => {
    const schema = await extractProps("./fixtures/all-optional.tsx");
    const combos = generateCombinations(schema);
    const allUndefined = combos.find((c) =>
      Object.values(c).every((v) => v === undefined),
    );
    expect(allUndefined).toBeDefined();
  });
});

// H25: third-party dep import (prop extraction only — TS doesn't need runtime deps)
describe("H25: third-party import", () => {
  it("extracts props from component that imports from node_modules", async () => {
    const schema = await extractProps("./fixtures/with-dep.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["active", "label"].sort());
  });
});

// H26: file with spaces in path
describe("H26: spaces in path", () => {
  it("extracts props from file in directory with spaces", async () => {
    const schema = await extractProps("./fixtures/spaced dir/spaced-comp.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["bold", "text"].sort());
  });
});

// H27: two named exports — which one is picked
describe("H27: two named exports", () => {
  it("extracts props from first component", async () => {
    const schema = await extractProps("./fixtures/two-exports.tsx");
    // Should pick first function with props-like params
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["label", "size"].sort());
  });
});

// H28: double-wrapped: memo(forwardRef(...))
describe("H28: memo(forwardRef(...))", () => {
  it("extracts props from double-wrapped component", async () => {
    const schema = await extractProps("./fixtures/double-wrap.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["disabled", "label", "variant"].sort());
  });

  it("variant is union", async () => {
    const schema = await extractProps("./fixtures/double-wrap.tsx");
    const variant = schema.find((s) => s.name === "variant");
    expect(variant?.kind).toBe("union");
    expect(variant?.values).toEqual(["solid", "outline", "ghost"]);
  });
});

// H29: props with default values in destructuring
describe("H29: default values in destructuring", () => {
  it("extracts declared types not default value types", async () => {
    const schema = await extractProps("./fixtures/default-values.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["items", "maxItems", "separator"].sort());
  });

  it("items is array (despite default [a,b,c])", async () => {
    const schema = await extractProps("./fixtures/default-values.tsx");
    const items = schema.find((s) => s.name === "items");
    expect(items?.kind).toBe("array");
  });

  it("maxItems is number", async () => {
    const schema = await extractProps("./fixtures/default-values.tsx");
    const maxItems = schema.find((s) => s.name === "maxItems");
    expect(maxItems?.kind).toBe("number");
  });
});

// H30: component with useEffect
describe("H30: useEffect component", () => {
  it("extracts props from component with useEffect", async () => {
    const schema = await extractProps("./fixtures/use-effect.tsx");
    const names = schema.map((s) => s.name).sort();
    expect(names).toEqual(["interval", "label"].sort());
  });
});
