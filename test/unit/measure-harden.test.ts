import { describe, it, expect } from "vitest";
import {
  computeMedian,
  computeP95,
  parseTraceDuration,
} from "../../src/measure.js";

// H35: samples=1
describe("H35: single sample", () => {
  it("median of single value is that value", () => {
    expect(computeMedian([3.14])).toBe(3.14);
  });
  it("P95 of single value is that value", () => {
    expect(computeP95([3.14])).toBe(3.14);
  });
});

// H41: identical values
describe("H41: identical values", () => {
  it("median of identical values", () => {
    expect(computeMedian([5, 5, 5, 5])).toBe(5);
  });
  it("P95 of identical values", () => {
    expect(computeP95([5, 5, 5, 5])).toBe(5);
  });
});

// H42: nested/overlapping trace events
describe("H42: trace parsing edge cases", () => {
  it("only counts X-phase events", () => {
    const events = [
      { cat: "devtools.timeline", name: "FunctionCall", dur: 1000, ph: "X" },
      { cat: "devtools.timeline", name: "FunctionCall", dur: 999, ph: "B" },
      { cat: "devtools.timeline", name: "FunctionCall", ph: "E" },
    ];
    const result = parseTraceDuration(events);
    expect(result.scriptDuration).toBeCloseTo(1, 0);
  });

  it("handles zero-duration events", () => {
    const events = [
      { cat: "devtools.timeline", name: "FunctionCall", dur: 0, ph: "X" },
    ];
    const result = parseTraceDuration(events);
    expect(result.scriptDuration).toBe(0);
    expect(result.totalDuration).toBe(0);
  });

  it("handles very large durations without overflow", () => {
    const events = [
      { cat: "devtools.timeline", name: "EvaluateScript", dur: 1_000_000_000, ph: "X" },
    ];
    const result = parseTraceDuration(events);
    expect(result.scriptDuration).toBeCloseTo(1_000_000, 0);
  });
});
