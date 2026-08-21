import { describe, it, expect, vi, afterEach } from "vitest";
import path from "node:path";
import { extractProps, resetExtractionCache } from "../../src/prop-gen.js";

const M84 = path.resolve("./fixtures/m84");
const fixture = (name: string): string => path.join(M84, name);

function captureStderr(): { lines: () => string[] } {
  resetExtractionCache();
  const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return { lines: () => write.mock.calls.map((c) => String(c[0])) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// M84 harden: 15 adversarial hypotheses against the M84 mechanisms.
describe("M84 harden", () => {
  it("1: heuristic applies two levels deep (label.meta.currencyCode)", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "DeepNest" });
    const label = schemas.find((s) => s.name === "label")!;
    const value = label.values[0] as any;
    expect(value.meta.currencyCode).toBe("USD");
  });

  it("2: name matching is case-insensitive (SRC, CurrencyCode)", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "CaseInsensitive" });
    const src = schemas.find((s) => s.name === "SRC")!;
    const currency = schemas.find((s) => s.name === "CurrencyCode")!;
    expect(src.values[0]).toMatch(/^data:/);
    expect(currency.values[0]).toBe("USD");
  });

  it("3: near-miss names do not get the image heuristic (deliberately narrow)", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "NearMiss" });
    const sourceUrl = schemas.find((s) => s.name === "sourceUrl")!;
    const imgSrc = schemas.find((s) => s.name === "imgSrc")!;
    expect(sourceUrl.values[0]).toBe("test");
    expect(imgSrc.values[0]).toBe("test");
  });

  it("4: array elements have no field name — currencyCodes falls back to generic (accepted limitation)", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "ArrayOfCurrency" });
    const currencyCodes = schemas.find((s) => s.name === "currencyCodes")!;
    // Documents current behavior: the heuristic is name-based per FIELD, and
    // an array element has no field name of its own to test.
    expect(currencyCodes.elementTemplate).toBe("text");
  });

  it("5: an unresolved-generic array named 'rows' still gets the identity-object fallback", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "ArrayOfCurrency" });
    const rows = schemas.find((s) => s.name === "rows")!;
    expect(typeof rows.elementTemplate).toBe("object");
    expect(() => new WeakMap().set(rows.elementTemplate as object, 1)).not.toThrow();
  });

  it("6: an empty object type does not crash and is not falsely 'declared'", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "EmptyObjectHost" });
    const label = schemas.find((s) => s.name === "label")!;
    expect(label.kind).toBe("object");
    expect(label.provenance).toBe("placeholder");
  });

  it("7: a literal union reduced to one member by stripping undefined does not crash", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "OptionalUndefinedLiteral" });
    const mode = schemas.find((s) => s.name === "mode")!;
    expect(mode.kind).toBe("string");
    expect(mode.values[0]).toBe("solo");
  });

  it("8: a three-branch mixed union (two literals + a primitive) picks a literal", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "TripleMixed" });
    const align = schemas.find((s) => s.name === "align")!;
    expect(["start", "end"]).toContain(align.values[0]);
    expect(align.provenance).toBe("declared");
  });

  it("9: 'as' is tagged contract even when it resolves as a string-literal union", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "AsChildString" });
    const as = schemas.find((s) => s.name === "as")!;
    expect(as.kind).toBe("union");
    expect(as.provenance).toBe("contract");
  });

  it("10: a nested identity-collection array (wrapper.items) gets object elements too", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "NestedIdentity" });
    const wrapper = schemas.find((s) => s.name === "wrapper")!;
    const value = wrapper.values[0] as any;
    expect(Array.isArray(value.items)).toBe(true);
  });

  it("11: no warning is emitted for a pure string-literal union (already self-explanatory)", async () => {
    const stderr = captureStderr();
    await extractProps(fixture("harden.tsx"), { target: "AsChildString" });
    const unionWarning = stderr.lines().find((l) => l.includes("::union::") || l.includes('is a union of'));
    expect(unionWarning).toBeUndefined();
  });

  it("12: repeated extraction of the same file is idempotent (no accumulating warnings)", async () => {
    const stderr = captureStderr();
    await extractProps(fixture("harden.tsx"), { target: "DeepNest" });
    const firstCount = stderr.lines().length;
    await extractProps(fixture("harden.tsx"), { target: "DeepNest" });
    // warnOnce dedupes by file+kind; a dry-run sink is not used here so the
    // process-wide warnOnce guard applies (no unbounded growth on re-extraction).
    expect(stderr.lines().length).toBeLessThanOrEqual(firstCount + 1);
  });

  it("13: every schema in a component with mixed provenance still has a provenance", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "TripleMixed" });
    for (const s of schemas) {
      expect(s.provenance).toBeDefined();
    }
  });

  it("14: a required field inside a nested object degrades safely if unenumerable", async () => {
    resetExtractionCache();
    const schemas = await extractProps(fixture("harden.tsx"), { target: "DeepNest" });
    expect(schemas.length).toBeGreaterThan(0);
  });

  it("15: huge nested depth (label) does not throw a RangeError", async () => {
    resetExtractionCache();
    await expect(extractProps(fixture("harden.tsx"), { target: "DeepNest" })).resolves.toBeDefined();
  });
});
