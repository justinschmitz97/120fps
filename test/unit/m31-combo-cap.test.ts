import { describe, it, expect } from "vitest";
import { selectRepresentativeCombos, DEFAULT_MEASURED_COMBOS } from "../../src/prop-gen-values.js";
import { selectExploreCombos } from "../../src/explorer.js";
import { COMBO_CAP_WARNING } from "../../src/analyze.js";

describe("m31 C2 — measured combos are capped representatively", () => {
  it("keeps everything when the count is within the cap", () => {
    expect(selectRepresentativeCombos(5, 8)).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps the ends of the value space", () => {
    const picked = selectRepresentativeCombos(27, 8);
    expect(picked.length).toBe(8);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(26);
  });

  it("spreads instead of taking a prefix", () => {
    expect(selectRepresentativeCombos(16, 4)).toEqual([0, 5, 10, 15]);
  });

  it("is the same algorithm the explorer uses", () => {
    for (const [n, k] of [[27, 8], [64, 5], [3, 8], [1, 2]] as const) {
      expect(selectExploreCombos(n, k)).toEqual(selectRepresentativeCombos(n, k));
    }
  });

  it("defaults to 8 measured combos", () => {
    expect(DEFAULT_MEASURED_COMBOS).toBe(8);
  });

  it("discloses both counts when combos are dropped", () => {
    const warning = COMBO_CAP_WARNING(8, 27);
    expect(warning).toContain("8");
    expect(warning).toContain("19");
  });

  it("handles degenerate inputs", () => {
    expect(selectRepresentativeCombos(0, 8)).toEqual([]);
    expect(selectRepresentativeCombos(10, 0)).toEqual([]);
    expect(selectRepresentativeCombos(-3, 8)).toEqual([]);
  });
});
