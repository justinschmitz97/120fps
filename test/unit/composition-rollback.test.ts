import { describe, it, expect } from "vitest";
import { shouldRollbackComposition, COMPOSITION_EMPTY_WARNING } from "../../src/composition.js";

describe("a composed scene that renders nothing is rolled back", () => {
  it("rolls back when the scene renders no elements", () => {
    expect(shouldRollbackComposition({ rootElements: 0 })).toBe(true);
  });

  it("rolls back when the trial mount threw", () => {
    expect(
      shouldRollbackComposition({ rootElements: 4, error: new Error("must be used within") }),
    ).toBe(true);
  });

  it("keeps a scene that rendered at least one element", () => {
    expect(shouldRollbackComposition({ rootElements: 1 })).toBe(false);
  });

  it("names the root and points at the escape hatch", () => {
    const warning = COMPOSITION_EMPTY_WARNING("Select");
    expect(warning).toContain("Select");
    expect(warning).toContain("--fixture");
  });
});
