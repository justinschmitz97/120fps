import { describe, it, expect } from "vitest";
import { formatTotalLine } from "../../src/cli/index.js";
import type { PhaseTimings } from "../../src/report/index.js";

// M115 A1: a user who waited three minutes learned only that they waited three
// minutes. The breakdown rides on the line that already prints the wait.
const timings = (over: Partial<PhaseTimings>): PhaseTimings => ({
  preflight: 0,
  build: 0,
  calibration: 0,
  mount: 0,
  rerender: 0,
  explore: 0,
  scale: 0,
  deltas: 0,
  attribution: 0,
  analysis: 0,
  total: 0,
  ...over,
});

describe("the terminal's total line", () => {
  it("names where the minutes went", () => {
    expect(
      formatTotalLine(
        192_000,
        timings({ build: 41_000, mount: 58_000, explore: 80_000, analysis: 12_000, total: 192_000 }),
      ),
    ).toBe("Total: 3m 12s  (build 41s, mount 58s, explore 1m 20s, analysis 12s)");
  });

  it("omits a phase the run never entered", () => {
    const line = formatTotalLine(
      26_036,
      timings({ preflight: 224, build: 7_534, mount: 5_145, analysis: 1_477, total: 26_036 }),
    );
    expect(line).toBe("Total: 26.0s  (preflight 0s, build 8s, mount 5s, analysis 1s)");
    expect(line).not.toContain("scale");
    expect(line).not.toContain("deltas");
    expect(line).not.toContain("attribution");
  });

  it("prints the line it printed before this milestone when the report carries no timings", () => {
    expect(formatTotalLine(42_100, undefined)).toBe("Total: 42.1s");
    expect(formatTotalLine(252_000, timings({}))).toBe("Total: 4m 12s");
  });
});
