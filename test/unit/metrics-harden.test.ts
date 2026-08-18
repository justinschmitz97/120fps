import { describe, it, expect } from "vitest";
import {
  parseMetrics,
  computeINP,
  computeScalingCurve,
  isDomFlat,
} from "../../src/metrics.js";
import { parseTraceDuration, type TraceEvent } from "../../src/measure.js";

describe("H1: zero-duration events", () => {
  it("does not count as long tasks", () => {
    const events: TraceEvent[] = [
      { name: "FunctionCall", dur: 0, ph: "X", ts: 100 },
      { name: "EvaluateScript", dur: 0, ph: "X", ts: 200 },
    ];
    const m = parseMetrics(events);
    expect(m.longTasks).toHaveLength(0);
    expect(m.scriptDuration).toBe(0);
    expect(m.totalDuration).toBe(0);
  });
});

describe("H2: only B/E phase events", () => {
  it("produces zero duration metrics", () => {
    const events: TraceEvent[] = [
      { name: "FunctionCall", ph: "B", ts: 100 },
      { name: "FunctionCall", ph: "E", ts: 200 },
      { name: "Paint", ph: "B", ts: 300 },
      { name: "Paint", ph: "E", ts: 400 },
    ];
    const m = parseMetrics(events);
    expect(m.paintCount).toBe(0);
    expect(m.paintDuration).toBe(0);
    expect(m.scriptDuration).toBe(0);
    expect(m.totalDuration).toBe(0);
  });
});

describe("H3: events with missing ts field", () => {
  it("handles gracefully in parseMetrics", () => {
    const events: TraceEvent[] = [
      { name: "FunctionCall", dur: 1000, ph: "X" },
      { name: "Paint", dur: 500, ph: "X" },
    ];
    const m = parseMetrics(events);
    // Events without ts are filtered out in the sorted array
    expect(m.totalDuration).toBe(0);
  });

  it("handles gracefully in parseTraceDuration fallback", () => {
    const events: TraceEvent[] = [
      { name: "FunctionCall", dur: 1000, ph: "X" },
      { name: "Paint", dur: 500, ph: "X" },
    ];
    const result = parseTraceDuration(events);
    // Fallback path sums all
    expect(result.totalDuration).toBeCloseTo(1.5, 1);
  });
});

describe("H4: LayoutShift with missing args", () => {
  it("does not crash with no args", () => {
    const events: TraceEvent[] = [
      { name: "LayoutShift", ph: "I", ts: 100 } as any,
    ];
    const m = parseMetrics(events);
    expect(m.layoutShiftScore).toBe(0);
  });

  it("does not crash with empty data", () => {
    const events: TraceEvent[] = [
      { name: "LayoutShift", ph: "I", ts: 100, args: { data: {} } } as any,
    ];
    const m = parseMetrics(events);
    expect(m.layoutShiftScore).toBe(0);
  });

  it("does not crash with null args", () => {
    const events: TraceEvent[] = [
      { name: "LayoutShift", ph: "I", ts: 100, args: null } as any,
    ];
    const m = parseMetrics(events);
    expect(m.layoutShiftScore).toBe(0);
  });
});

describe("H6: INP multiple inputs before single paint", () => {
  it("uses the last input event before paint", () => {
    const traces: TraceEvent[][] = [
      [
        { name: "EventDispatch", dur: 100, ph: "X", ts: 100_000, args: { data: { type: "click" } } } as any,
        { name: "EventDispatch", dur: 100, ph: "X", ts: 140_000, args: { data: { type: "keydown" } } } as any,
        { name: "Paint", dur: 1000, ph: "X", ts: 150_000 },
      ],
    ];
    const inp = computeINP(traces);
    // Gap from last input (140_000) to paint (150_000) = 10ms
    expect(inp).toBeCloseTo(10, 0);
  });
});

describe("H7: INP paint without preceding input", () => {
  it("returns 0", () => {
    const traces: TraceEvent[][] = [
      [
        { name: "Paint", dur: 1000, ph: "X", ts: 100_000 },
        { name: "Paint", dur: 1000, ph: "X", ts: 200_000 },
      ],
    ];
    expect(computeINP(traces)).toBe(0);
  });
});

describe("H8: scaling curve with all-zero metrics", () => {
  it("classifies as constant", () => {
    const points = [
      { n: 1, metric: 0 },
      { n: 5, metric: 0 },
      { n: 20, metric: 0 },
      { n: 50, metric: 0 },
    ];
    const curve = computeScalingCurve(points);
    expect(curve.growthClass).toBe("constant");
  });
});

describe("H9: scaling curve with negative slope", () => {
  it("classifies declining linear data as constant (cost not growing)", () => {
    const points = [
      { n: 1, metric: 100 },
      { n: 5, metric: 80 },
      { n: 20, metric: 30 },
      { n: 50, metric: -70 },
    ];
    const curve = computeScalingCurve(points);
    expect(curve.slope).toBeLessThan(0);
    // Non-positive slope means cost is not growing: never linear/quadratic/exponential
    expect(curve.growthClass).toBe("constant");
  });

  it("classifies curved (quadratic-shaped) declining data as constant, not quadratic", () => {
    // metric = 2500 - n^2: a textbook quadratic fit (r2≈1 against n^2), but declining.
    const points = [
      { n: 1, metric: 2499 },
      { n: 5, metric: 2475 },
      { n: 20, metric: 2100 },
      { n: 50, metric: 0 },
    ];
    const curve = computeScalingCurve(points);
    expect(curve.slope).toBeLessThan(0);
    expect(curve.growthClass).toBe("constant");
  });
});

describe("H10: mixed nested and sibling events in parseTraceDuration", () => {
  it("correctly handles interleaved nesting", () => {
    // A: ts=0, dur=10000 (parent)
    //   B: ts=1000, dur=3000 (nested in A)
    // C: ts=15000, dur=5000 (sibling of A)
    //   D: ts=16000, dur=2000 (nested in C)
    const events: TraceEvent[] = [
      { name: "FunctionCall", dur: 10_000, ph: "X", ts: 0 },
      { name: "v8.compile", dur: 3_000, ph: "X", ts: 1_000 },
      { name: "FunctionCall", dur: 5_000, ph: "X", ts: 15_000 },
      { name: "v8.run", dur: 2_000, ph: "X", ts: 16_000 },
    ];
    const result = parseTraceDuration(events);
    // Only top-level: A (10ms) + C (5ms) = 15ms
    expect(result.totalDuration).toBeCloseTo(15, 0);
    // Script duration must also dedup nesting: B is nested in A, D is nested
    // in C, so only the outer events' durations count: A (10ms) + C (5ms) = 15ms
    expect(result.scriptDuration).toBeCloseTo(15, 0);
  });

  it("counts nested script event wall time once (EvaluateScript containing nested FunctionCall)", () => {
    const events: TraceEvent[] = [
      { name: "EvaluateScript", dur: 10_000, ph: "X", ts: 0 },
      { name: "FunctionCall", dur: 4_000, ph: "X", ts: 1_000 },
    ];
    const result = parseTraceDuration(events);
    expect(result.totalDuration).toBeCloseTo(10, 0);
    expect(result.scriptDuration).toBeCloseTo(10, 0);
  });
});

describe("H11: events with same start time", () => {
  it("treats shorter event as nested in longer event", () => {
    const events: TraceEvent[] = [
      { name: "FunctionCall", dur: 10_000, ph: "X", ts: 100 },
      { name: "v8.compile", dur: 3_000, ph: "X", ts: 100 },
    ];
    const result = parseTraceDuration(events);
    // After sorting by ts, both have ts=100; first processed is top-level
    // Second has ts=100 which is within first's [100, 10100] range → nested
    expect(result.totalDuration).toBeCloseTo(10, 0);
  });
});

describe("H12: large trace performance", () => {
  it("handles 10000 events without timeout", () => {
    const events: TraceEvent[] = [];
    for (let i = 0; i < 10_000; i++) {
      events.push({
        name: "FunctionCall",
        dur: 100,
        ph: "X",
        ts: i * 200,
      });
    }
    const start = Date.now();
    const m = parseMetrics(events);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(m.scriptDuration).toBeGreaterThan(0);
    expect(m.totalDuration).toBeGreaterThan(0);
  });
});

describe("H13: filterToMarks with only start mark", () => {
  it("uses all events when end mark is missing", () => {
    const events: TraceEvent[] = [
      { name: "__120fps_start", ph: "R", ts: 100_000, cat: "blink.user_timing" } as any,
      { name: "Paint", dur: 1000, ph: "X", ts: 200_000 },
      { name: "Paint", dur: 2000, ph: "X", ts: 300_000 },
    ];
    const m = parseMetrics(events, { filterToMarks: true });
    expect(m.paintCount).toBe(2);
  });
});

describe("H14: DrawFrame events in frames array", () => {
  it("counts DrawFrame events", () => {
    const events: TraceEvent[] = [
      { name: "DrawFrame", dur: 8_000, ph: "X", ts: 100_000 },
      { name: "DrawFrame", dur: 20_000, ph: "X", ts: 200_000 },
    ];
    const m = parseMetrics(events);
    expect(m.frames).toHaveLength(2);
    expect(m.frames[0].duration).toBeCloseTo(8, 0);
    expect(m.jankFrameCount).toBe(1);
  });
});

describe("H18-H19: isDomFlat guards", () => {
  it("H18 a growing DOM is never flat", () => {
    expect(isDomFlat([{ n: 1, domNodeCount: 9 }, { n: 2, domNodeCount: 10 }])).toBe(false);
  });

  it("H19 all-unknown node counts are not flat", () => {
    expect(isDomFlat([{ n: 1 }, { n: 2 }])).toBe(false);
  });
});
