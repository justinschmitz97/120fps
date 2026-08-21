import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/prop-gen.js";
import { fillArray } from "../../src/prop-gen-values.js";

const M84 = path.resolve("./fixtures/m84");
const fixture = (name: string): string => path.join(M84, name);

// M84 MUST: an identity-keyed collection (an array of objects consumed as
// rows or items, whose element type could not be resolved) synthesizes
// object elements, not primitives — a component keying a WeakMap on its own
// rows throws `TypeError: Invalid value used as weak map key` on a
// primitive key.
describe("M84: identity-keyed array prop synthesizes object elements", () => {
  it("data's fallback element is an object, not the bare string \"item\"", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("identity-collection.tsx"));
    const data = schemas.find((s) => s.name === "data");
    expect(data).toBeDefined();
    expect(data?.kind).toBe("array");
    const sample = (data?.values[1] as unknown[])[0];
    expect(typeof sample).toBe("object");
    expect(sample).not.toBeNull();
    expect(() => new WeakMap().set(sample as object, 1)).not.toThrow();
  });

  it("fillArray (scale mode) also produces object elements, inheriting elementTemplate", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("identity-collection.tsx"));
    const data = schemas.find((s) => s.name === "data")!;
    const filled = fillArray(data, 5);
    expect(filled).toHaveLength(5);
    for (const row of filled) {
      expect(typeof row).toBe("object");
      expect(() => new WeakMap().set(row as object, 1)).not.toThrow();
    }
  });

  it("carries heuristic provenance", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("identity-collection.tsx"));
    const data = schemas.find((s) => s.name === "data");
    expect(data?.provenance).toBe("heuristic");
  });
});
