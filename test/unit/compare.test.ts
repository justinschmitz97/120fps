import { describe, it, expect } from "vitest";
import {
  distinguishable,
  deltaPercent,
  validateCompareOptions,
  formatCompare,
  DEPENDENCY_DRIFT_ERROR,
  type CompareReport,
} from "../../src/compare.js";
import { parseArgs } from "../../src/cli.js";

// C1: the heuristic: only non-overlapping spreads say anything survived noise.
describe("distinguishability", () => {
  it("separates two sets that do not overlap", () => {
    expect(distinguishable([1, 1.1, 1.2], [5, 5.1, 5.2])).toBe(true);
  });

  it("refuses to call overlapping sets different", () => {
    expect(distinguishable([1, 3, 5], [2, 4, 6])).toBe(false);
  });

  it("treats a single shared value as overlap", () => {
    expect(distinguishable([1, 2], [2, 3])).toBe(false);
  });

  it("is symmetric", () => {
    expect(distinguishable([5, 6], [1, 2])).toBe(distinguishable([1, 2], [5, 6]));
  });

  it("says nothing about an empty set", () => {
    expect(distinguishable([], [1, 2])).toBe(false);
  });
});

// C2: the delta reads from the reference to the working tree.
describe("delta", () => {
  it("is negative when the working tree got faster", () => {
    expect(deltaPercent(10, 8)).toBeCloseTo(-20);
  });

  it("is positive when it got slower", () => {
    expect(deltaPercent(10, 12)).toBeCloseTo(20);
  });

  it("does not divide by zero", () => {
    expect(deltaPercent(0, 5)).toBe(0);
  });
});

// C3: compare informs a human; budgets and baselines own CI.
describe("mode exclusivity", () => {
  it("rejects --check", () => {
    expect(validateCompareOptions({ compare: "HEAD", check: true })).toContain("--check");
  });

  it("rejects --save-baseline", () => {
    expect(validateCompareOptions({ compare: "HEAD", saveBaseline: true })).toContain("--save-baseline");
  });

  it("rejects --isolate", () => {
    expect(validateCompareOptions({ compare: "HEAD", isolation: ["mount"] })).toContain("--isolate");
  });

  it("allows a plain compare", () => {
    expect(validateCompareOptions({ compare: "HEAD" })).toBeUndefined();
  });

  it("says nothing when compare is not in play", () => {
    expect(validateCompareOptions({ check: true, saveBaseline: true })).toBeUndefined();
  });
});

// C4: CLI parsing.
describe("the flag", () => {
  it("takes a git ref", () => {
    expect(parseArgs(["./Button.tsx", "--compare", "HEAD~1"]).compare).toBe("HEAD~1");
  });

  it("errors without one", () => {
    expect(parseArgs(["./Button.tsx", "--compare"]).error).toContain("git ref");
  });

  it("is a known flag", () => {
    expect(parseArgs(["./Button.tsx", "--compare", "HEAD"]).error).toBeUndefined();
  });
});

// C5: the output a human reads.
describe("formatting", () => {
  const report: CompareReport = {
    ref: "HEAD",
    componentPath: "src/Button.tsx",
    combos: [
      {
        comboIndex: 0,
        props: { label: "x" },
        working: { mountSamples: [8], mountMedian: 8, unmountMedian: 1, domNodeCount: 4 },
        reference: { mountSamples: [10], mountMedian: 10, unmountMedian: 1, domNodeCount: 4 },
        mountDeltaPercent: -20,
        distinguishable: true,
      },
    ],
  };

  it("shows both sides, the delta and the direction", () => {
    const text = formatCompare(report);
    expect(text).toContain("10.00ms → 8.00ms");
    expect(text).toContain("-20.0%");
    expect(text).toContain("faster");
  });

  it("calls an overlapping result indistinguishable rather than faster", () => {
    const text = formatCompare({
      ...report,
      combos: [{ ...report.combos[0], distinguishable: false }],
    });
    expect(text).toContain("indistinguishable");
    expect(text).not.toContain("faster");
  });

  it("names the ref it compared against", () => {
    expect(formatCompare(report)).toContain("vs HEAD");
  });
});

// C6: measuring one side against another side's dependencies compares the
// wrong thing.
describe("dependency drift", () => {
  it("explains what to do about it", () => {
    const message = DEPENDENCY_DRIFT_ERROR("HEAD~5");
    expect(message).toContain("HEAD~5");
    expect(message).toContain("lockfile");
  });
});
