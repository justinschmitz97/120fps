import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/props/index.js";

const M84 = path.resolve("./fixtures/m84");
const fixture = (name: string): string => path.join(M84, name);

// A name-based value heuristic must apply at every nesting depth, not only the top level.
describe("M84: nested currencyCode synthesizes the same value as top-level", () => {
  it("label.currencyCode synthesizes USD, not the generic string placeholder", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("nested-currency-code.tsx"));
    const label = schemas.find((s) => s.name === "label");
    expect(label).toBeDefined();
    expect(label?.kind).toBe("object");
    const value = label?.values[0] as Record<string, unknown> | undefined;
    expect(value?.currencyCode).toBe("USD");
  });

  it("the outer object schema carries heuristic provenance from its nested field", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("nested-currency-code.tsx"));
    const label = schemas.find((s) => s.name === "label");
    expect(label?.provenance).toBe("heuristic");
  });
});
