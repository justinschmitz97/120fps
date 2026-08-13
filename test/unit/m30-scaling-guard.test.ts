import { describe, it, expect } from "vitest";
import { isDomFlat, SCALING_NO_EFFECT_WARNING } from "../../src/metrics.js";

const point = (n: number, domNodeCount: number) => ({ n, domNodeCount });

describe("m30 F2b — a flat DOM is not a growth class", () => {
  it("is flat when every scale point has the same node count", () => {
    expect(isDomFlat([point(1, 9), point(5, 9), point(20, 9)])).toBe(true);
  });

  it("is not flat when any point differs", () => {
    expect(isDomFlat([point(1, 9), point(5, 13), point(20, 43)])).toBe(false);
  });

  it("is not flat for a single point (nothing was compared)", () => {
    expect(isDomFlat([point(1, 9)])).toBe(false);
  });

  it("is not flat for an empty set", () => {
    expect(isDomFlat([])).toBe(false);
  });

  it("ignores points with an unknown node count", () => {
    expect(isDomFlat([point(1, 9), { n: 5 }, point(20, 9)])).toBe(true);
  });

  it("names the prop in the warning so the report is actionable", () => {
    expect(SCALING_NO_EFFECT_WARNING("lines")).toContain("lines");
    expect(SCALING_NO_EFFECT_WARNING("lines").toLowerCase()).toContain("dom");
  });
});
