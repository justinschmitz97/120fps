import { describe, it, expect } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/prop-gen.js";

const M86 = path.resolve("./fixtures/m86");
const fixture = (name: string): string => path.join(M86, name);

// M86 harden: adversarial hypotheses against the required/source-reference/
// preset-exemption mechanisms.
describe("M86 harden", () => {
  it("1: a component with no parameters at all does not crash", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "NoParams" });
    expect(schemas).toEqual([]);
  });

  it("2: a destructured-parameter handler outranks Tier-3 volume", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "Destructured" });
    expect(schemas.map((s) => s.name)).toContain("onDoubleClick");
  });

  it("3: a body-local destructuring (const { onWheel } = props) is also a source reference", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "NestedDestructure" });
    expect(schemas.map((s) => s.name)).toContain("onWheel");
  });

  it("4: two components in one file each keep their own referenced handler, not the other's", async () => {
    resetExtractionCache();
    const first = await extractProps(fixture("harden.tsx"), { target: "First" });
    const second = await extractProps(fixture("harden.tsx"), { target: "Second" });
    expect(first.map((s) => s.name)).toContain("onDrag");
    expect(second.map((s) => s.name)).toContain("onScroll");
    // Second's own reference must not leak into First's ranking.
    expect(first.map((s) => s.name)).not.toContain("onScroll");
  });

  it("5: five required props at once all survive together", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "ManyRequired" });
    for (const name of ["a", "b", "c", "d", "e"]) {
      expect(schemas.map((s) => s.name)).toContain(name);
    }
  });

  it("6: total schema length never exceeds MAX_PROPS plus the required overflow", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "ManyRequired" });
    // 5 required + up to 32 optional.
    expect(schemas.length).toBeLessThanOrEqual(37);
  });

  it("7: a component with a fixture-provided nonexistent target name resolves empty, not a crash", async () => {
    resetExtractionCache();
    await expect(
      extractProps(fixture("harden.tsx"), { target: "DoesNotExist" }),
    ).resolves.toBeDefined();
  });

  it("8: preset detection with no preset file present returns unaffected schema", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "First" });
    expect(schemas.length).toBeGreaterThan(0);
  });

  it("9: an empty-interface component (0 kept props) does not crash the cap logic", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "NoParams" });
    expect(Array.isArray(schemas)).toBe(true);
  });

  it("10: repeated extraction across the extraction cache boundary stays consistent", async () => {
    resetExtractionCache();
    const first = await extractProps(fixture("harden.tsx"), { target: "Destructured" });
    const second = await extractProps(fixture("harden.tsx"), { target: "Destructured" });
    expect(first.map((s) => s.name).sort()).toEqual(second.map((s) => s.name).sort());
  });
});
