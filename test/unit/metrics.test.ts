import { describe, it, expect } from "vitest";
import {
  parseMetrics,
  computeINP,
  computeScalingCurve,
  linearRegression,
  type CdpMetrics,
} from "../../src/metrics.js";
import { parseTraceDuration, type TraceEvent } from "../../src/measure.js";

describe("parseMetrics", () => {
  it("returns all-zero metrics for empty event array", () => {
    const m = parseMetrics([]);
    expect(m.paintCount).toBe(0);
    expect(m.paintDuration).toBe(0);
    expect(m.layoutCount).toBe(0);
    expect(m.layoutDuration).toBe(0);
    expect(m.styleRecalcCount).toBe(0);
    expect(m.styleRecalcDuration).toBe(0);
    expect(m.scriptDuration).toBe(0);
    expect(m.totalDuration).toBe(0);
    expect(m.longTasks).toEqual([]);
    expect(m.frames).toEqual([]);
    expect(m.jankFrameCount).toBe(0);
    expect(m.droppedFrameCount).toBe(0);
    expect(m.layoutShiftScore).toBe(0);
    expect(m.domNodeCount).toBe(0);
    expect(m.heapDelta).toBe(0);
  });

  it("counts Paint events and sums their duration", () => {
    const events: TraceEvent[] = [
      { name: "Paint", dur: 2000, ph: "X", ts: 100 },
      { name: "Paint", dur: 3000, ph: "X", ts: 200 },
    ];
    const m = parseMetrics(events);
    expect(m.paintCount).toBe(2);
    expect(m.paintDuration).toBeCloseTo(5, 0);
  });

  it("counts Layout events and sums their duration", () => {
    const events: TraceEvent[] = [
      { name: "Layout", dur: 1500, ph: "X", ts: 100 },
      { name: "Layout", dur: 2500, ph: "X", ts: 300 },
    ];
    const m = parseMetrics(events);
    expect(m.layoutCount).toBe(2);
    expect(m.layoutDuration).toBeCloseTo(4, 0);
  });

  it("counts style recalc events (UpdateLayoutTree)", () => {
    const events: TraceEvent[] = [
      { name: "UpdateLayoutTree", dur: 1000, ph: "X", ts: 100 },
      { name: "UpdateLayoutTree", dur: 2000, ph: "X", ts: 300 },
    ];
    const m = parseMetrics(events);
    expect(m.styleRecalcCount).toBe(2);
    expect(m.styleRecalcDuration).toBeCloseTo(3, 0);
  });

  it("counts style recalc events (RecalcStyles)", () => {
    const events: TraceEvent[] = [
      { name: "RecalcStyles", dur: 500, ph: "X", ts: 100 },
    ];
    const m = parseMetrics(events);
    expect(m.styleRecalcCount).toBe(1);
    expect(m.styleRecalcDuration).toBeCloseTo(0.5, 1);
  });

  it("sums scripting duration from FunctionCall, EvaluateScript, v8.compile, v8.run", () => {
    const events: TraceEvent[] = [
      { name: "FunctionCall", dur: 1000, ph: "X", ts: 100 },
      { name: "EvaluateScript", dur: 2000, ph: "X", ts: 200 },
      { name: "v8.compile", dur: 500, ph: "X", ts: 300 },
      { name: "v8.run", dur: 500, ph: "X", ts: 400 },
    ];
    const m = parseMetrics(events);
    expect(m.scriptDuration).toBeCloseTo(4, 0);
  });

  it("detects long tasks (scripting spans > 50ms)", () => {
    const events: TraceEvent[] = [
      { name: "FunctionCall", dur: 60_000, ph: "X", ts: 1000 },
      { name: "FunctionCall", dur: 30_000, ph: "X", ts: 100_000 },
      { name: "FunctionCall", dur: 80_000, ph: "X", ts: 200_000 },
    ];
    const m = parseMetrics(events);
    expect(m.longTasks).toHaveLength(2);
    expect(m.longTasks[0].duration).toBeCloseTo(60, 0);
    expect(m.longTasks[1].duration).toBeCloseTo(80, 0);
  });

  it("builds frame timing from BeginFrame events", () => {
    const events: TraceEvent[] = [
      { name: "BeginFrame", dur: 10_000, ph: "X", ts: 100_000 },
      { name: "BeginFrame", dur: 20_000, ph: "X", ts: 200_000 },
    ];
    const m = parseMetrics(events);
    expect(m.frames).toHaveLength(2);
    expect(m.frames[0].duration).toBeCloseTo(10, 0);
    expect(m.frames[1].duration).toBeCloseTo(20, 0);
  });

  it("counts jank frames (duration > 16.67ms)", () => {
    const events: TraceEvent[] = [
      { name: "BeginFrame", dur: 10_000, ph: "X", ts: 100_000 },
      { name: "BeginFrame", dur: 20_000, ph: "X", ts: 200_000 },
      { name: "BeginFrame", dur: 50_000, ph: "X", ts: 300_000 },
    ];
    const m = parseMetrics(events);
    expect(m.jankFrameCount).toBe(2);
  });

  it("estimates dropped frames from jank frame durations", () => {
    const events: TraceEvent[] = [
      { name: "BeginFrame", dur: 50_000, ph: "X", ts: 100_000 },
    ];
    const m = parseMetrics(events);
    // 50ms / 16.67ms ≈ 2.99 → floor = 2, dropped = 2 - 1 = 1
    expect(m.droppedFrameCount).toBe(1);
  });

  it("accumulates layout shift scores", () => {
    const events: TraceEvent[] = [
      { name: "LayoutShift", ph: "I", ts: 100, args: { data: { score: 0.1 } } } as any,
      { name: "LayoutShift", ph: "I", ts: 200, args: { data: { score: 0.05 } } } as any,
    ];
    const m = parseMetrics(events);
    expect(m.layoutShiftScore).toBeCloseTo(0.15, 2);
  });

  it("handles LayoutShift with cumulative_score field", () => {
    const events: TraceEvent[] = [
      { name: "LayoutShift", ph: "I", ts: 100, args: { data: { cumulative_score: 0.3 } } } as any,
    ];
    const m = parseMetrics(events);
    expect(m.layoutShiftScore).toBeCloseTo(0.3, 2);
  });

  it("ignores non-X phase events for duration metrics", () => {
    const events: TraceEvent[] = [
      { name: "Paint", dur: 1000, ph: "B", ts: 100 },
      { name: "Paint", ph: "E", ts: 200 },
      { name: "Paint", dur: 2000, ph: "X", ts: 300 },
    ];
    const m = parseMetrics(events);
    expect(m.paintCount).toBe(1);
    expect(m.paintDuration).toBeCloseTo(2, 0);
  });

  it("filters events to performance.mark window when filterToMarks is true", () => {
    const events: TraceEvent[] = [
      { name: "Paint", dur: 1000, ph: "X", ts: 100_000 },
      { name: "__120fps_start", ph: "R", ts: 200_000, cat: "blink.user_timing" } as any,
      { name: "Paint", dur: 2000, ph: "X", ts: 250_000 },
      { name: "__120fps_end", ph: "R", ts: 300_000, cat: "blink.user_timing" } as any,
      { name: "Paint", dur: 3000, ph: "X", ts: 400_000 },
    ];
    const m = parseMetrics(events, { filterToMarks: true });
    expect(m.paintCount).toBe(1);
    expect(m.paintDuration).toBeCloseTo(2, 0);
  });

  it("uses all events when marks are not present even with filterToMarks", () => {
    const events: TraceEvent[] = [
      { name: "Paint", dur: 1000, ph: "X", ts: 100_000 },
      { name: "Paint", dur: 2000, ph: "X", ts: 200_000 },
    ];
    const m = parseMetrics(events, { filterToMarks: true });
    expect(m.paintCount).toBe(2);
  });
});

describe("parseTraceDuration nested event fix", () => {
  it("excludes nested event durations from totalDuration", () => {
    // Parent: ts=100, dur=10000 (10ms)
    // Child: ts=200, dur=3000 (3ms) — nested inside parent
    const events: TraceEvent[] = [
      { name: "FunctionCall", dur: 10_000, ph: "X", ts: 100 },
      { name: "v8.compile", dur: 3_000, ph: "X", ts: 200 },
    ];
    const result = parseTraceDuration(events);
    // Only parent's 10ms counted, not parent + child = 13ms
    expect(result.totalDuration).toBeCloseTo(10, 0);
  });

  it("counts sibling events independently", () => {
    const events: TraceEvent[] = [
      { name: "FunctionCall", dur: 5000, ph: "X", ts: 100 },
      { name: "FunctionCall", dur: 3000, ph: "X", ts: 10_000 },
    ];
    const result = parseTraceDuration(events);
    expect(result.totalDuration).toBeCloseTo(8, 0);
  });

  it("handles deeply nested events", () => {
    // Grandparent: ts=0, dur=20000
    //   Parent: ts=100, dur=10000
    //     Child: ts=200, dur=5000
    const events: TraceEvent[] = [
      { name: "FunctionCall", dur: 20_000, ph: "X", ts: 0 },
      { name: "FunctionCall", dur: 10_000, ph: "X", ts: 100 },
      { name: "FunctionCall", dur: 5_000, ph: "X", ts: 200 },
    ];
    const result = parseTraceDuration(events);
    expect(result.totalDuration).toBeCloseTo(20, 0);
  });
});

describe("computeINP", () => {
  it("returns 0 for empty traces", () => {
    expect(computeINP([])).toBe(0);
  });

  it("returns 0 when no input events exist", () => {
    const traces: TraceEvent[][] = [
      [{ name: "Paint", dur: 1000, ph: "X", ts: 500_000 }],
    ];
    expect(computeINP(traces)).toBe(0);
  });

  it("computes gap between input event and next paint", () => {
    const traces: TraceEvent[][] = [
      [
        { name: "EventDispatch", dur: 100, ph: "X", ts: 100_000, args: { data: { type: "click" } } } as any,
        { name: "Paint", dur: 1000, ph: "X", ts: 150_000 },
      ],
    ];
    const inp = computeINP(traces);
    // Gap: (150_000 - 100_000) / 1000 = 50ms
    expect(inp).toBeCloseTo(50, 0);
  });

  it("returns max INP across multiple traces", () => {
    const traces: TraceEvent[][] = [
      [
        { name: "EventDispatch", dur: 100, ph: "X", ts: 100_000, args: { data: { type: "click" } } } as any,
        { name: "Paint", dur: 1000, ph: "X", ts: 120_000 },
      ],
      [
        { name: "EventDispatch", dur: 100, ph: "X", ts: 100_000, args: { data: { type: "keydown" } } } as any,
        { name: "Paint", dur: 1000, ph: "X", ts: 200_000 },
      ],
    ];
    const inp = computeINP(traces);
    expect(inp).toBeCloseTo(100, 0);
  });
});

describe("linearRegression", () => {
  it("fits a perfect line", () => {
    const points = [
      { x: 1, y: 2 },
      { x: 2, y: 4 },
      { x: 3, y: 6 },
    ];
    const result = linearRegression(points);
    expect(result.slope).toBeCloseTo(2, 5);
    expect(result.intercept).toBeCloseTo(0, 5);
    expect(result.r2).toBeCloseTo(1, 5);
  });

  it("returns zeros for single point", () => {
    const result = linearRegression([{ x: 1, y: 5 }]);
    expect(result.slope).toBe(0);
    expect(result.r2).toBe(0);
  });

  it("returns zeros for empty array", () => {
    const result = linearRegression([]);
    expect(result.slope).toBe(0);
    expect(result.r2).toBe(0);
  });
});

describe("computeScalingCurve", () => {
  it("classifies constant growth (flat line)", () => {
    const points = [
      { n: 1, metric: 10 },
      { n: 5, metric: 10.1 },
      { n: 20, metric: 9.9 },
      { n: 50, metric: 10 },
    ];
    const curve = computeScalingCurve(points);
    expect(curve.growthClass).toBe("constant");
  });

  it("classifies linear growth", () => {
    const points = [
      { n: 1, metric: 10 },
      { n: 5, metric: 50 },
      { n: 20, metric: 200 },
      { n: 50, metric: 500 },
    ];
    const curve = computeScalingCurve(points);
    expect(curve.growthClass).toBe("linear");
    expect(curve.r2).toBeGreaterThan(0.95);
  });

  it("classifies quadratic growth", () => {
    const points = [
      { n: 1, metric: 1 },
      { n: 5, metric: 25 },
      { n: 20, metric: 400 },
      { n: 50, metric: 2500 },
    ];
    const curve = computeScalingCurve(points);
    expect(curve.growthClass).toBe("quadratic");
  });

  it("classifies exponential growth", () => {
    const points = [
      { n: 1, metric: 2 },
      { n: 2, metric: 4 },
      { n: 3, metric: 8 },
      { n: 4, metric: 16 },
    ];
    const curve = computeScalingCurve(points);
    expect(curve.growthClass).toBe("exponential");
  });

  it("returns constant for single point", () => {
    const curve = computeScalingCurve([{ n: 1, metric: 10 }]);
    expect(curve.growthClass).toBe("constant");
  });
});
