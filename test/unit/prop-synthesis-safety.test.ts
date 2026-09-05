import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps } from "../../src/props/index.js";
import { resolveAnchorValue } from "../../src/props/index.js";
import type { PropSchema } from "../../src/props/index.js";

const M81 = path.resolve("./fixtures/m81");
const fixture = (name: string): string => path.join(M81, name);

const get = (schemas: PropSchema[], name: string): PropSchema => {
  const found = schemas.find((s) => s.name === name);
  if (!found) throw new Error(`no schema for ${name}: ${schemas.map((s) => s.name).join(",")}`);
  return found;
};

// M81 3a: a structural iterable must get a real array, not opaqueReason's generic {} fallback.
describe("M81 3a: Iterable<T> synthesizes a real array", () => {
  it("items is a real array, not an opaque object", async () => {
    const schemas = await extractProps(fixture("iterable-prop.tsx"));
    const items = get(schemas, "items");
    expect(Array.isArray(items.values[0])).toBe(true);
  });

  it("the synthesized array does not throw inside new Set(...)", async () => {
    const schemas = await extractProps(fixture("iterable-prop.tsx"));
    const items = get(schemas, "items");
    expect(() => new Set(items.values[0] as unknown[])).not.toThrow();
  });

  it("the array carries real, distinguishable string entries", async () => {
    const schemas = await extractProps(fixture("iterable-prop.tsx"));
    const items = get(schemas, "items");
    const value = items.values[0] as unknown[];
    expect(value.length).toBeGreaterThan(0);
    expect(new Set(value).size).toBe(value.length);
  });
});

// M81 3b: ReactElement | render-function must not classify as reactnode; it's degenerate.
describe("M81 3b: ReactElement | Function is not ReactNode", () => {
  it("render classifies as an opaque object, not reactnode", async () => {
    const schemas = await extractProps(fixture("render-prop.tsx"));
    const render = get(schemas, "render");
    expect(render.kind).toBe("object");
    expect(render.degenerate).toMatch(/requires a real element or render function/);
  });

  it("a plain ReactNode prop is unaffected", async () => {
    const schemas = await extractProps("./fixtures/button.tsx");
    expect(get(schemas, "children").kind).toBe("reactnode");
    expect(get(schemas, "children").degenerate).toBeUndefined();
  });
});

// M81 3c: a degenerate schema resolves to undefined, never a fabricated stand-in.
describe("M81 3c: degenerate schemas never fabricate a stand-in value", () => {
  it("resolveAnchorValue returns undefined for a degenerate object schema", () => {
    const schema: PropSchema = {
      name: "render",
      kind: "object",
      required: false,
      values: [{}],
      degenerate: "SomeType requires a real element or render function",
    };
    expect(resolveAnchorValue(schema)).toBeUndefined();
  });

  it("resolveAnchorValue returns undefined for a degenerate reactnode schema", () => {
    const schema: PropSchema = {
      name: "icon",
      kind: "reactnode",
      required: false,
      values: [],
      degenerate: "some placeholder is unsafe here",
    };
    expect(resolveAnchorValue(schema)).toBeUndefined();
  });

  it("a non-degenerate object schema is unaffected: resolveAnchorValue still returns its value", () => {
    const schema: PropSchema = {
      name: "style",
      kind: "object",
      required: false,
      values: [{ color: "red" }],
    };
    expect(resolveAnchorValue(schema)).toEqual({ color: "red" });
  });

  it("render's own resolved anchor value is undefined end to end", async () => {
    const schemas = await extractProps(fixture("render-prop.tsx"));
    expect(resolveAnchorValue(get(schemas, "render"))).toBeUndefined();
  });
});

// M81 3d (commerce-F1): a named allowlist replaces the placeholder for Intl-validated strings.
describe("M81 3d: named runtime-validated string conventions", () => {
  it("currencyCode synthesizes a real ISO 4217 code, not the generic placeholder", async () => {
    const schemas = await extractProps(fixture("currency-prop.tsx"));
    const currencyCode = get(schemas, "currencyCode");
    expect(currencyCode.values[0]).not.toBe("test");
    expect(currencyCode.values[0]).toBe("USD");
  });

  it("locale synthesizes a real BCP 47 tag", async () => {
    const schemas = await extractProps(fixture("currency-prop.tsx"));
    expect(get(schemas, "locale").values[0]).toBe("en-US");
  });

  it("Intl.NumberFormat accepts the synthesized currency code", async () => {
    const schemas = await extractProps(fixture("currency-prop.tsx"));
    const code = get(schemas, "currencyCode").values[0] as string;
    const locale = get(schemas, "locale").values[0] as string;
    expect(() => new Intl.NumberFormat(locale, { style: "currency", currency: code })).not.toThrow();
  });

  it("a plain string prop outside the allowlist still gets the generic placeholder", async () => {
    const schemas = await extractProps("./fixtures/button.tsx");
    expect(get(schemas, "label").values).toEqual(["test"]);
  });
});
