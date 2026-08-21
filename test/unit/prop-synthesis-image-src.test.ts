import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/prop-gen.js";

const M84 = path.resolve("./fixtures/m84");
const fixture = (name: string): string => path.join(M84, name);

// M84 MUST: a prop whose name identifies it as an image source synthesizes a
// value that resolves without a network request, not "test" (which
// relative-resolves against the harness origin and 404s).
describe("M84: image-source-named props synthesize a data: URI", () => {
  it("src, srcSet, and poster all synthesize an inline data: URI", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("image-src.tsx"));
    for (const name of ["src", "srcSet", "poster"]) {
      const schema = schemas.find((s) => s.name === name);
      expect(schema, `${name} schema`).toBeDefined();
      expect(schema?.kind).toBe("string");
      expect(schema?.values[0]).toMatch(/^data:/);
      expect(schema?.values[0]).not.toBe("test");
    }
  });

  it("src/srcSet/poster carry heuristic provenance", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("image-src.tsx"));
    const src = schemas.find((s) => s.name === "src");
    expect(src?.provenance).toBe("heuristic");
  });
});
