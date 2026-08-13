import { describe, it, expect } from "vitest";
import { generateDeltaPairs, countDeltaPairSpace, MAX_DELTA_PAIRS } from "../../src/prop-gen-values.js";
import { DELTA_PAIR_CAP_WARNING } from "../../src/analyze.js";
import type { PropSchema } from "../../src/prop-gen.js";

function boolSchema(name: string): PropSchema {
  return { name, kind: "boolean", required: true, values: [] };
}

describe("countDeltaPairSpace", () => {
  it("matches generateDeltaPairs' length when under the cap", () => {
    const schemas = [boolSchema("a"), boolSchema("b")];
    expect(countDeltaPairSpace(schemas)).toBe(2);
    expect(generateDeltaPairs(schemas)).toHaveLength(2);
  });

  it("reports the true total pair count even when the 128 cap truncates it", () => {
    const schemas = Array.from({ length: 200 }, (_, i) => boolSchema(`bool${i}`));
    const total = countDeltaPairSpace(schemas);
    expect(total).toBe(200);
    const pairs = generateDeltaPairs(schemas);
    expect(pairs).toHaveLength(MAX_DELTA_PAIRS);
    expect(total).toBeGreaterThan(pairs.length);
  });

  it("returns 0 for no props", () => {
    expect(countDeltaPairSpace([])).toBe(0);
  });
});

describe("DELTA_PAIR_CAP_WARNING", () => {
  it("names both the measured count and the total possible pairs", () => {
    const warning = DELTA_PAIR_CAP_WARNING(128, 200);
    expect(warning).toContain("128");
    expect(warning).toContain("200");
    expect(warning.toLowerCase()).toContain("delta pair");
  });
});
