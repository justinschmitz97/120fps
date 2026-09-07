import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps } from "../../src/props/index.js";

const fixture = (rel: string): string => path.resolve("fixtures", rel);

async function schemasFor(rel: string) {
  return extractProps(fixture(rel), { onWarning: () => {} });
}

describe("a prop that takes a tag name or a component", () => {
  it("synthesizes a tag for a required element type", async () => {
    const schemas = await schemasFor("element-type-props/empty-state.tsx");
    const icon = schemas.find((s) => s.name === "icon");
    expect(icon?.kind).toBe("string");
    expect(icon?.values).toEqual(["div"]);
    expect(icon?.provenance).toBe("heuristic");
    expect(icon?.degenerate).toBeUndefined();
  });

  it("synthesizes a tag for an optional element type too", async () => {
    const schemas = await schemasFor("element-type-props/empty-state.tsx");
    const component = schemas.find((s) => s.name === "component");
    expect(component?.values).toEqual(["div"]);
    expect(component?.provenance).toBe("heuristic");
  });

  it("leaves the contract provenance of an `as` prop alone", async () => {
    const schemas = await schemasFor("element-type-props/empty-state.tsx");
    const as = schemas.find((s) => s.name === "as");
    expect(as?.values).toEqual(["div"]);
    expect(as?.provenance).toBe("contract");
  });

  it("leaves a plain string prop beside it alone", async () => {
    const schemas = await schemasFor("element-type-props/empty-state.tsx");
    const title = schemas.find((s) => s.name === "title");
    expect(title?.values).toEqual(["test"]);
    expect(title?.provenance).toBe("placeholder");
  });

  it("leaves a hand-written tag union as the enumeration it is", async () => {
    const schemas = await schemasFor("element-type-props/tag-union.tsx");
    const level = schemas.find((s) => s.name === "level");
    expect(level?.values).toEqual(["div", "span", "button"]);
    expect(level?.provenance).toBe("declared");
  });
});
