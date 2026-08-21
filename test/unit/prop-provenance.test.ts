import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/prop-gen.js";

const M84 = path.resolve("./fixtures/m84");
const fixture = (name: string): string => path.join(M84, name);

// M84 cross-lane deliverable: every synthesized value carries provenance,
// one of "declared" | "preset" | "heuristic" | "placeholder" | "contract".
describe("M84: every schema carries provenance", () => {
  it("a plain literal union member is declared", async () => {
    resetExtractionCache();
    const schemas = await extractProps(path.resolve("./fixtures/m81/table-indexed-variant.tsx"));
    const variant = schemas.find((s) => s.name === "variant");
    expect(variant?.provenance).toBe("declared");
  });

  it("a generic string with no heuristic match is placeholder", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("mixed-union.tsx"));
    const description = schemas.find((s) => s.name === "description");
    expect(description?.values[0]).toBe("test");
    expect(description?.provenance).toBe("placeholder");
  });

  it("asChild is tagged contract", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("contract-prop.tsx"));
    const asChild = schemas.find((s) => s.name === "asChild");
    expect(asChild?.provenance).toBe("contract");
  });

  it("no schema is left with an undefined provenance", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("mixed-union.tsx"));
    for (const schema of schemas) {
      expect(schema.provenance, `${schema.name} provenance`).toBeDefined();
    }
  });
});

// M84 invariant: provenance is one of the five documented values, never a
// stray string.
describe("M84: provenance is always one of the five documented values", () => {
  it("every schema's provenance (when present) is a valid PropProvenance", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("nested-currency-code.tsx"));
    const valid = new Set(["declared", "preset", "heuristic", "placeholder", "contract"]);
    for (const schema of schemas) {
      if (schema.provenance !== undefined) {
        expect(valid.has(schema.provenance)).toBe(true);
      }
    }
  });
});
