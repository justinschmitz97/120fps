import { describe, it, expect } from "vitest";
import { attributeCost } from "../../src/metrics.js";
import type { TraceEvent } from "../../src/measure.js";

function ev(name: string, durUs: number, tsUs: number, url?: string): TraceEvent {
  return {
    cat: "devtools.timeline",
    name,
    dur: durUs,
    ph: "X",
    ts: tsUs,
    args: url ? { data: { url } } : {},
  };
}

// One mount window: 3ms of a package, 2ms of user code, plus a 1ms layout event
// that attribution never claims.
function window(offsetUs: number): TraceEvent[] {
  return [
    ev("FunctionCall", 3000, offsetUs + 1000,
      "http://localhost:5173/node_modules/.vite/deps/motion.js"),
    ev("FunctionCall", 2000, offsetUs + 5000,
      "http://localhost:5173/src/App.tsx"),
    ev("Layout", 1000, offsetUs + 8000),
  ];
}

function bucketTotal(a: { buckets: { durationMs: number }[] }): number {
  return a.buckets.reduce((sum, b) => sum + b.durationMs, 0);
}

describe("M66: attribution covers one mount", () => {
  it("a flat array is one window", () => {
    const a = attributeCost(window(0));
    expect(a.sampleCount).toBe(1);
    expect(a.totalScriptingMs).toBeCloseTo(5, 5);
    expect(bucketTotal(a)).toBeCloseTo(5, 5);
  });

  it("N windows report the mean scripting time of one mount, not the sum", () => {
    const traces = [window(0), window(100_000), window(200_000), window(300_000)];
    const a = attributeCost(traces);
    expect(a.sampleCount).toBe(4);
    expect(a.totalScriptingMs).toBeCloseTo(20, 5);
    expect(bucketTotal(a)).toBeCloseTo(5, 5);
    expect(a.buckets.find((b) => b.source === "motion")!.durationMs).toBeCloseTo(3, 5);
    expect(a.buckets.find((b) => b.source!.includes("App.tsx"))!.durationMs).toBeCloseTo(2, 5);
  });

  it("holds the invariant sum(buckets) === totalScriptingMs / sampleCount", () => {
    const traces = [window(0), window(100_000), window(200_000)];
    const a = attributeCost(traces);
    expect(bucketTotal(a)).toBeCloseTo(a.totalScriptingMs / a.sampleCount, 6);
  });

  it("keeps the breakdown inside the mount it describes", () => {
    const traces = [window(0), window(100_000), window(200_000), window(300_000)];
    // Every window's top-level duration: 3 + 2 + 1 (no nesting here).
    const meanWindowDuration = 6;
    expect(bucketTotal(attributeCost(traces))).toBeLessThanOrEqual(meanWindowDuration);
  });

  it("leaves percentages untouched by normalization", () => {
    const one = attributeCost(window(0));
    const four = attributeCost([window(0), window(100_000), window(200_000), window(300_000)]);
    const pct = (a: typeof one, source: string) =>
      a.buckets.find((b) => b.source === source)!.percentage;
    expect(pct(four, "motion")).toBeCloseTo(pct(one, "motion"), 6);
    expect(pct(four, "motion")).toBeCloseTo(60, 5);
  });

  it("counts a window that produced no scripting", () => {
    const a = attributeCost([window(0), [], window(200_000)]);
    expect(a.sampleCount).toBe(3);
    expect(bucketTotal(a)).toBeCloseTo(10 / 3, 5);
  });

  it("survives empty input in either shape", () => {
    for (const empty of [[], [[], []]]) {
      const a = attributeCost(empty as TraceEvent[] | TraceEvent[][]);
      expect(a.buckets).toHaveLength(0);
      expect(a.totalScriptingMs).toBe(0);
      expect(a.sampleCount).toBeGreaterThanOrEqual(1);
    }
  });

  it("flattening N windows inflates the breakdown by exactly N", () => {
    const traces = [window(0), window(100_000), window(200_000), window(300_000)];
    const flat = attributeCost(traces.flat());
    expect(bucketTotal(flat)).toBeCloseTo(bucketTotal(attributeCost(traces)) * 4, 5);
  });
});
