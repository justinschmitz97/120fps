import { describe, it, expect } from "vitest";
import { generateCombinations, countCombinationSpace } from "../../src/prop-gen-values.js";
import { STRATIFIED_SAMPLE_WARNING } from "../../src/analyze.js";
import type { PropSchema } from "../../src/prop-gen.js";

function boolSchema(name: string): PropSchema {
  return { name, kind: "boolean", required: true, values: [] };
}

describe("countCombinationSpace", () => {
  it("matches the cartesian count when under the cap", () => {
    const schemas = [boolSchema("a"), boolSchema("b")];
    expect(countCombinationSpace(schemas)).toBe(4);
    expect(generateCombinations(schemas)).toHaveLength(4);
  });

  it("reports the true raw total even when stratified sampling truncates it", () => {
    const schemas = Array.from({ length: 7 }, (_, i) => boolSchema(`p${i}`));
    const raw = countCombinationSpace(schemas);
    expect(raw).toBe(128);
    const combos = generateCombinations(schemas);
    // MAX_COMBINATIONS caps the sample at 64, so raw always exceeds it here.
    expect(combos.length).toBeLessThanOrEqual(64);
    expect(raw).toBeGreaterThan(combos.length);
  });

  it("stays a finite number for large but realistic prop spaces", () => {
    const schemas = Array.from({ length: 40 }, (_, i) => boolSchema(`p${i}`));
    expect(Number.isFinite(countCombinationSpace(schemas))).toBe(true);
  });

  it("returns 1 for no props", () => {
    expect(countCombinationSpace([])).toBe(1);
  });
});

describe("STRATIFIED_SAMPLE_WARNING", () => {
  it("names both the raw total and the sampled count", () => {
    const warning = STRATIFIED_SAMPLE_WARNING(128, 64);
    expect(warning).toContain("128");
    expect(warning).toContain("64");
    expect(warning.toLowerCase()).toContain("stratified sample");
  });

  it("caps an astronomically large raw count instead of printing it verbatim", () => {
    const astronomical = 2 ** 100; // ~1.27e30 — finite, but not fit for display
    const warning = STRATIFIED_SAMPLE_WARNING(astronomical, 64);
    expect(warning).not.toContain("Infinity");
    expect(warning).not.toContain("NaN");
    expect(warning).toContain(">1,000,000,000");
  });

  it("handles a literally infinite input without leaking Infinity into the message", () => {
    const warning = STRATIFIED_SAMPLE_WARNING(Infinity, 64);
    expect(warning).not.toContain("Infinity");
    expect(warning).toContain(">1,000,000,000");
  });
});
