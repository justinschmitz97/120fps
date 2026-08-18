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

const PKG = "http://localhost:5173/node_modules/.vite/deps/motion.js";
const USER = "http://localhost:5173/src/App.tsx";

function total(a: { buckets: { durationMs: number }[] }): number {
  return a.buckets.reduce((sum, b) => sum + b.durationMs, 0);
}

describe("attribution window edge cases", () => {
  // H1: one sample behaves exactly like the single-window call it replaces.
  it("a one-window array equals the flat call", () => {
    const events = [ev("FunctionCall", 3000, 1000, PKG), ev("FunctionCall", 2000, 5000, USER)];
    const nested = attributeCost([events]);
    const flat = attributeCost(events);
    expect(nested.sampleCount).toBe(1);
    expect(total(nested)).toBeCloseTo(total(flat), 6);
    expect(nested.buckets.map((b) => b.source)).toEqual(flat.buckets.map((b) => b.source));
  });

  // H5: a later window's events must not be treated as nested inside an
  // earlier window's span, which would delete them from the breakdown.
  it("does not deduct across window boundaries", () => {
    // Window A holds one long span; window B's timestamps sit inside A's range,
    // as they would if the trace clock restarted or windows were reordered.
    const a = [ev("FunctionCall", 10_000, 1000, PKG)];
    const b = [ev("FunctionCall", 4000, 2000, USER)];
    const perWindow = attributeCost([a, b]);
    expect(perWindow.totalScriptingMs).toBeCloseTo(14, 5);
    expect(perWindow.buckets.find((x) => x.source === "motion")!.durationMs).toBeCloseTo(5, 5);
    // Flattened, B reads as a child of A and is deducted from it.
    expect(attributeCost([...a, ...b]).totalScriptingMs).toBeCloseTo(10, 5);
  });

  // H6: normalization is a scale, so ranking and shares are untouched.
  it("keeps bucket order and percentages across sample counts", () => {
    const w = () => [ev("FunctionCall", 3000, 1000, PKG), ev("FunctionCall", 2000, 5000, USER)];
    const one = attributeCost([w()]);
    const five = attributeCost([w(), w(), w(), w(), w()]);
    expect(five.buckets.map((b) => b.source)).toEqual(one.buckets.map((b) => b.source));
    expect(five.buckets.map((b) => Math.round(b.percentage)))
      .toEqual(one.buckets.map((b) => Math.round(b.percentage)));
    expect(five.sampleCount).toBe(5);
    expect(total(five)).toBeCloseTo(total(one), 6);
  });

  // H3: nesting deduction still applies inside a window after normalization.
  it("subtracts a child span from its parent inside each window", () => {
    const w = () => [
      ev("FunctionCall", 10_000, 1000, PKG),
      ev("FunctionCall", 4000, 2000, USER),
    ];
    const a = attributeCost([w(), w()]);
    expect(a.buckets.find((b) => b.source === "motion")!.durationMs).toBeCloseTo(6, 5);
    expect(a.buckets.find((b) => b.source!.includes("App.tsx"))!.durationMs).toBeCloseTo(4, 5);
  });

  it("survives a window of non-script events only", () => {
    const a = attributeCost([[ev("Layout", 5000, 1000)], [ev("FunctionCall", 2000, 20_000, PKG)]]);
    expect(a.sampleCount).toBe(2);
    expect(total(a)).toBeCloseTo(1, 5);
  });
});
