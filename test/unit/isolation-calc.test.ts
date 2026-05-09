import { describe, it, expect } from "vitest";
import {
  parseIsolationPhases,
  computeChurnDegradation,
  buildMemoryReport,
  buildStrictModeReport,
  buildRerenderIsolation,
  type IsolationPhase,
} from "../../src/isolation.js";

describe("parseIsolationPhases", () => {
  it("parses single phase", () => {
    expect(parseIsolationPhases("mount")).toEqual(["mount"]);
  });

  it("parses multiple phases", () => {
    expect(parseIsolationPhases("mount,rerender,unmount")).toEqual(["mount", "rerender", "unmount"]);
  });

  it("expands all", () => {
    const result = parseIsolationPhases("all");
    expect(result).toHaveLength(5);
    expect(result).toContain("mount");
    expect(result).toContain("rerender");
    expect(result).toContain("unmount");
    expect(result).toContain("memory");
    expect(result).toContain("strictmode");
  });

  it("deduplicates", () => {
    expect(parseIsolationPhases("mount,mount")).toEqual(["mount"]);
  });

  it("throws on invalid phase", () => {
    expect(() => parseIsolationPhases("bogus")).toThrow("bogus");
  });

  it("trims whitespace", () => {
    expect(parseIsolationPhases(" mount , rerender ")).toEqual(["mount", "rerender"]);
  });
});

describe("computeChurnDegradation", () => {
  it("returns ~1.0 for stable samples", () => {
    const samples = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    expect(computeChurnDegradation(samples)).toBeCloseTo(1.0);
  });

  it("detects degradation", () => {
    const samples = [1, 1, 1, 1, 1, 2, 2, 2, 3, 3];
    const ratio = computeChurnDegradation(samples);
    expect(ratio).toBeGreaterThan(1.5);
  });

  it("returns 1.0 for empty samples", () => {
    expect(computeChurnDegradation([])).toBe(1.0);
  });

  it("returns 1.0 when first3 average is 0", () => {
    expect(computeChurnDegradation([0, 0, 0, 1, 1, 1])).toBe(1.0);
  });

  it("handles fewer than 6 samples", () => {
    const result = computeChurnDegradation([1, 2, 3]);
    expect(typeof result).toBe("number");
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

describe("buildMemoryReport", () => {
  it("computes growth correctly", () => {
    const report = buildMemoryReport({
      cycles: 20,
      heapBefore: 100000,
      heapAfter: 120000,
      gcPressure: 5.0,
    });
    expect(report.heapGrowth).toBe(20000);
    expect(report.heapGrowthPerCycle).toBe(1000);
    expect(report.leakSuspected).toBe(false);
  });

  it("detects leak when growth > 1KB/cycle", () => {
    const report = buildMemoryReport({
      cycles: 20,
      heapBefore: 100000,
      heapAfter: 200000,
      gcPressure: 5.0,
    });
    expect(report.heapGrowthPerCycle).toBe(5000);
    expect(report.leakSuspected).toBe(true);
  });

  it("handles zero cycles", () => {
    const report = buildMemoryReport({
      cycles: 0,
      heapBefore: 100000,
      heapAfter: 100000,
      gcPressure: 0,
    });
    expect(report.heapGrowthPerCycle).toBe(0);
    expect(report.leakSuspected).toBe(false);
  });

  it("handles negative growth (heap shrunk)", () => {
    const report = buildMemoryReport({
      cycles: 20,
      heapBefore: 200000,
      heapAfter: 180000,
      gcPressure: 2.0,
    });
    expect(report.heapGrowth).toBe(-20000);
    expect(report.leakSuspected).toBe(false);
  });
});

describe("buildStrictModeReport", () => {
  it("computes overhead percentage", () => {
    const report = buildStrictModeReport([1, 1, 1], [2, 2, 2]);
    expect(report.overhead).toBeCloseTo(100);
    expect(report.doubleInvokeClean).toBe(true);
  });

  it("doubleInvokeClean false when overhead > 110%", () => {
    const report = buildStrictModeReport([1, 1, 1], [2.2, 2.2, 2.2]);
    expect(report.overhead).toBeCloseTo(120);
    expect(report.doubleInvokeClean).toBe(false);
  });

  it("handles zero normal mount (safe)", () => {
    const report = buildStrictModeReport([0, 0, 0], [1, 1, 1]);
    expect(report.overhead).toBe(0);
    expect(report.doubleInvokeClean).toBe(true);
  });
});

describe("buildRerenderIsolation", () => {
  it("builds all three sub-modes", () => {
    const report = buildRerenderIsolation([1, 1, 1], [2, 2, 2], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(report.stable.median).toBeCloseTo(1.0);
    expect(report.propChange.median).toBeCloseTo(2.0);
    expect(report.churn.median).toBeCloseTo(1.0);
    expect(report.churnDegradation).toBeCloseTo(1.0);
  });
});
