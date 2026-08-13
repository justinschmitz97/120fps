import { describe, it, expect } from "vitest";
import {
  computeMedian,
  computeP95,
  parseTraceDuration,
  tryCollectGarbage,
} from "../../src/measure.js";

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
