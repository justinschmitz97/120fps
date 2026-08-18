import { describe, it, expect } from "vitest";
import { buildTimingWithCV } from "../../src/report.js";

// M35: driven pacing shrinks medians to their busy cost; relative CV on a
// sub-millisecond metric explodes while absolute noise stays trivial. The
// unstable flag requires both: high relative CV AND noise above the 0.5ms
// floor (M29's normalization floor).
describe("unstable flag has an absolute noise floor", () => {
  it("high relative CV with sub-floor absolute noise is stable", () => {
    const t = buildTimingWithCV([0.4, 0.6]); // cv 20%, stddev 0.1ms
    expect(t.cv).toBeGreaterThan(15);
    expect(t.unstable).toBe(false);
  });

  it("high relative CV with meaningful absolute noise is unstable", () => {
    const t = buildTimingWithCV([10, 16]); // cv ~23%, stddev 3ms
    expect(t.unstable).toBe(true);
  });

  it("low relative CV is stable regardless of magnitude", () => {
    expect(buildTimingWithCV([100, 101, 102]).unstable).toBe(false);
  });

  it("noise at the floor is stable", () => {
    const t = buildTimingWithCV([1, 1.5, 2]); // sample stddev 0.5ms
    expect(t.cv).toBeGreaterThan(15);
    expect(t.unstable).toBe(false);
  });

  it("noise just above the floor is unstable", () => {
    const t = buildTimingWithCV([1, 1.6, 2.2]); // sample stddev 0.6ms
    expect(t.unstable).toBe(true);
  });
});
