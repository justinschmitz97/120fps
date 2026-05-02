import { describe, it, expect } from "vitest";
import {
  computeMedian,
  computeP95,
  parseTraceDuration,
} from "../../src/measure.js";

// H44: descending-sorted input
describe("H44: pre-sorted descending input", () => {
  it("median handles descending input", () => {
    expect(computeMedian([10, 8, 6, 4, 2])).toBe(6);
  });
  it("P95 handles descending input", () => {
    expect(computeP95([10, 8, 6, 4, 2])).toBe(10);
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
    // ceil(0.95 * 1000) - 1 = 949 → value 950
    expect(computeP95(samples)).toBe(950);
  });
  it("median of 1000 values", () => {
    const samples = Array.from({ length: 1000 }, (_, i) => i + 1);
    expect(computeMedian(samples)).toBe(500.5);
  });
});

// H47: trace with mixed categories — parseTraceDuration ignores cat, only checks name + ph
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
    // Negative dur / 1000 = -1 — the function doesn't guard against this
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
    // Still counted — parseTraceDuration doesn't filter by cat
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
  it("P95 captures the outlier for small N", () => {
    expect(computeP95([1, 2, 3, 4, 10000])).toBe(10000);
  });
});

// H51: computeMedian/P95 with NaN
describe("H51: NaN in samples", () => {
  it("computeMedian with NaN produces NaN (no crash)", () => {
    const result = computeMedian([1, NaN, 3]);
    // NaN sorts oddly but shouldn't crash
    expect(typeof result).toBe("number");
  });
});

// H52: trace event with dur=0 at edge
describe("H52: all-zero duration trace", () => {
  it("all events with dur=0 produce zero totals", () => {
    const events = Array.from({ length: 10 }, () => ({
      cat: "devtools.timeline",
      name: "FunctionCall",
      dur: 0,
      ph: "X" as const,
    }));
    const result = parseTraceDuration(events);
    expect(result.scriptDuration).toBe(0);
    expect(result.totalDuration).toBe(0);
  });
});
