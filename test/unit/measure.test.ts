import { describe, it, expect } from "vitest";
import {
  computeMedian,
  computeP95,
  parseTraceDuration,
  tryCollectGarbage,
  reportFontSettle,
  FONT_SETTLE_WARNING,
} from "../../src/measure.js";

// M70: the one place a font-timeout run becomes a warning, shared by every
// phase (harness entry, explore, react-analysis attribution) that calls
// settleStyles and previously discarded its result.
describe("reportFontSettle", () => {
  it("calls onWarning with the font-settle warning when settling failed", () => {
    const warnings: string[] = [];
    reportFontSettle(false, (w) => warnings.push(w));
    expect(warnings).toEqual([FONT_SETTLE_WARNING]);
  });

  it("does not call onWarning when settling succeeded", () => {
    const warnings: string[] = [];
    reportFontSettle(true, (w) => warnings.push(w));
    expect(warnings).toEqual([]);
  });

  it("does not throw when settling failed and no onWarning is supplied", () => {
    expect(() => reportFontSettle(false, undefined)).not.toThrow();
  });

  it("does not throw when settling succeeded and no onWarning is supplied", () => {
    expect(() => reportFontSettle(true, undefined)).not.toThrow();
  });
});

describe("computeMedian", () => {
  it("returns middle value for odd-length array", () => {
    expect(computeMedian([3, 1, 2])).toBe(2);
  });

  it("returns average of two middle values for even-length array", () => {
    expect(computeMedian([4, 1, 3, 2])).toBe(2.5);
  });

  it("works with single element", () => {
    expect(computeMedian([42])).toBe(42);
  });

  it("works with two elements", () => {
    expect(computeMedian([10, 20])).toBe(15);
  });

  it("median of identical values", () => {
    expect(computeMedian([5, 5, 5, 5])).toBe(5);
  });

  it("does not mutate input", () => {
    const input = [3, 1, 2];
    computeMedian(input);
    expect(input).toEqual([3, 1, 2]);
  });

  it("returns 0 for empty array", () => {
    expect(computeMedian([])).toBe(0);
  });
});

describe("computeP95", () => {
  it("interpolates near the maximum for small arrays", () => {
    // type-7: h = (3-1)*0.95 = 1.9 → 2 + 0.9*(3-2)
    expect(computeP95([1, 2, 3])).toBeCloseTo(2.9, 10);
  });

  it("returns 0 for empty array", () => {
    expect(computeP95([])).toBe(0);
  });

  it("returns 95th percentile value for 20-element array", () => {
    const samples = Array.from({ length: 20 }, (_, i) => i + 1);
    // type-7: h = (20-1)*0.95 = 18.05 → 19 + 0.05*(20-19)
    expect(computeP95(samples)).toBeCloseTo(19.05, 10);
  });

  it("works with single element", () => {
    expect(computeP95([7])).toBe(7);
  });

  it("P95 of identical values", () => {
    expect(computeP95([5, 5, 5, 5])).toBe(5);
  });
});

describe("parseTraceDuration", () => {
  it("sums scripting durations from FunctionCall events", () => {
    const events = [
      { cat: "devtools.timeline", name: "FunctionCall", dur: 1000, ph: "X" },
      { cat: "devtools.timeline", name: "FunctionCall", dur: 2000, ph: "X" },
      { cat: "devtools.timeline", name: "Layout", dur: 500, ph: "X" },
    ];
    const result = parseTraceDuration(events);
    expect(result.scriptDuration).toBeCloseTo(3, 0);
  });

  it("computes total duration from all complete events", () => {
    const events = [
      { cat: "devtools.timeline", name: "FunctionCall", dur: 1000, ph: "X" },
      { cat: "devtools.timeline", name: "Layout", dur: 2000, ph: "X" },
    ];
    const result = parseTraceDuration(events);
    expect(result.totalDuration).toBeCloseTo(3, 0);
  });

  it("returns zeros for empty trace", () => {
    const result = parseTraceDuration([]);
    expect(result.scriptDuration).toBe(0);
    expect(result.totalDuration).toBe(0);
  });

  it("handles zero-duration events", () => {
    const events = [
      { cat: "devtools.timeline", name: "FunctionCall", dur: 0, ph: "X" },
    ];
    const result = parseTraceDuration(events);
    expect(result.scriptDuration).toBe(0);
    expect(result.totalDuration).toBe(0);
  });

  it("only counts X-phase events", () => {
    const events = [
      { cat: "devtools.timeline", name: "FunctionCall", dur: 1000, ph: "X" },
      { cat: "devtools.timeline", name: "FunctionCall", dur: 999, ph: "B" },
      { cat: "devtools.timeline", name: "FunctionCall", ph: "E" },
    ];
    const result = parseTraceDuration(events);
    expect(result.scriptDuration).toBeCloseTo(1, 0);
  });

  it("handles very large durations without overflow", () => {
    const events = [
      { cat: "devtools.timeline", name: "EvaluateScript", dur: 1_000_000_000, ph: "X" },
    ];
    const result = parseTraceDuration(events);
    expect(result.scriptDuration).toBeCloseTo(1_000_000, 0);
  });

  it("ignores events without dur field", () => {
    const events = [
      { cat: "devtools.timeline", name: "FunctionCall", ph: "I" },
      { cat: "devtools.timeline", name: "FunctionCall", dur: 5000, ph: "X" },
    ];
    const result = parseTraceDuration(events);
    expect(result.scriptDuration).toBeCloseTo(5, 0);
  });

  it("includes EvaluateScript in scripting duration", () => {
    const events = [
      { cat: "devtools.timeline", name: "EvaluateScript", dur: 3000, ph: "X" },
    ];
    const result = parseTraceDuration(events);
    expect(result.scriptDuration).toBeCloseTo(3, 0);
  });
});

describe("tryCollectGarbage", () => {
  it("does not throw when CDP method rejects, and reports the failure", async () => {
    const fakeCdp = { send: async () => { throw new Error("not supported"); } } as any;
    await expect(tryCollectGarbage(fakeCdp)).resolves.toBe(false);
  });

  it("reports success when CDP method succeeds", async () => {
    const fakeCdp = { send: async () => {} } as any;
    await expect(tryCollectGarbage(fakeCdp)).resolves.toBe(true);
  });
});

// H44: descending-sorted input
describe("H44: pre-sorted descending input", () => {
  it("P95 handles descending input", () => {
    expect(computeP95([10, 8, 6, 4, 2])).toBeCloseTo(9.6, 10);
  });
});

// H45: floating-point precision
describe("H45: floating-point precision", () => {
  it("median of two close floats", () => {
    expect(computeMedian([0.1 + 0.2, 0.3])).toBeCloseTo(0.3, 10);
  });
  it("P95 with micro-durations", () => {
    const tiny = Array.from({ length: 100 }, (_, i) => i * 0.001);
    expect(computeP95(tiny)).toBeCloseTo(0.094, 3);
  });
});

// H46: very large sample arrays (statistical correctness)
describe("H46: large sample arrays", () => {
  it("P95 of 1000 sequential values", () => {
    const samples = Array.from({ length: 1000 }, (_, i) => i + 1);
    // type-7: h = (1000-1)*0.95 = 949.05 → 950 + 0.05*(951-950)
    expect(computeP95(samples)).toBeCloseTo(950.05, 10);
  });
  it("median of 1000 values", () => {
    const samples = Array.from({ length: 1000 }, (_, i) => i + 1);
    expect(computeMedian(samples)).toBe(500.5);
  });
});

// H47: trace with mixed categories: parseTraceDuration ignores cat, only checks name + ph
describe("H47: mixed trace categories", () => {
  it("sums all X-phase events regardless of cat, classifies by name", () => {
    const events = [
      { cat: "devtools.timeline", name: "FunctionCall", dur: 1000, ph: "X" },
      { cat: "v8", name: "v8.compile", dur: 2000, ph: "X" },
      { cat: "loading", name: "Layout", dur: 3000, ph: "X" },
    ];
    const result = parseTraceDuration(events);
    expect(result.totalDuration).toBeCloseTo(6, 0);
    // FunctionCall + v8.compile are script events; Layout is not
    expect(result.scriptDuration).toBeCloseTo(3, 0);
  });
});

// H48: trace with negative dur (shouldn't happen, but defensive)
describe("H48: negative duration in trace event", () => {
  it("treats negative dur as valid number (passes through)", () => {
    const events = [
      { cat: "devtools.timeline", name: "FunctionCall", dur: -1000, ph: "X" },
    ];
    const result = parseTraceDuration(events);
    // Negative dur / 1000 = -1: the function doesn't guard against this
    expect(result.scriptDuration).toBe(-1);
  });
});

// H49: trace with undefined/null fields
describe("H49: malformed trace events", () => {
  it("handles event with no cat field", () => {
    const events = [
      { name: "FunctionCall", dur: 1000, ph: "X" },
    ];
    const result = parseTraceDuration(events);
    // Still counted: parseTraceDuration doesn't filter by cat
    expect(result.totalDuration).toBeCloseTo(1, 0);
  });

  it("handles completely empty event object", () => {
    const events = [{}];
    const result = parseTraceDuration(events);
    expect(result.totalDuration).toBe(0);
    expect(result.scriptDuration).toBe(0);
  });
});

// H50: samples array with outlier
describe("H50: outlier in samples", () => {
  it("median is robust to single extreme outlier", () => {
    expect(computeMedian([1, 2, 3, 4, 10000])).toBe(3);
  });
  it("P95 is dominated by the outlier for small N", () => {
    // type-7: h = 3.8 → 4 + 0.8*(10000-4)
    expect(computeP95([1, 2, 3, 4, 10000])).toBeCloseTo(8000.8, 6);
  });
});

// H51: computeMedian/P95 with NaN
describe("H51: NaN in samples", () => {
  it("computeMedian with NaN produces NaN (no crash)", () => {
    const result = computeMedian([1, NaN, 3]);
    // NaN propagates through the sort/index-pick rather than being crashed on
    expect(Number.isNaN(result)).toBe(true);
  });
});
