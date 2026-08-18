import { describe, it, expect } from "vitest";
import { attributeCost } from "../../src/metrics.js";
import { CALLBACK_PROPS_SOURCE, computeCallbackIdentityDelta } from "../../src/react-profiler.js";
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

const MARKER = "__120fps_fn__";
function loadBuilder() {
  return new Function(`${CALLBACK_PROPS_SOURCE}; return __120fpsCallbackProps;`)() as (
    props: Record<string, unknown>,
    cache: Map<string, unknown>,
    marker: string,
    measured: string | null,
    fresh: boolean,
  ) => Record<string, unknown>;
}

describe("M66 harden: attribution window", () => {
  // H1 — one sample behaves exactly like the single-window call it replaces.
  it("a one-window array equals the flat call", () => {
    const events = [ev("FunctionCall", 3000, 1000, PKG), ev("FunctionCall", 2000, 5000, USER)];
    const nested = attributeCost([events]);
    const flat = attributeCost(events);
    expect(nested.sampleCount).toBe(1);
    expect(total(nested)).toBeCloseTo(total(flat), 6);
    expect(nested.buckets.map((b) => b.source)).toEqual(flat.buckets.map((b) => b.source));
  });

  // H5 — a later window's events must not be treated as nested inside an
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

  // H6 — normalization is a scale, so ranking and shares are untouched.
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

  // H3 — nesting deduction still applies inside a window after normalization.
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

describe("M66 harden: callback identity gate", () => {
  // H11 — the gate is an inequality, so the boundary must not report.
  it("rejects a delta exactly at the noise floor and accepts just above it", () => {
    // spreads: stable 2, fresh 2 -> floor 4.
    expect(computeCallbackIdentityDelta([10, 11, 12], [14, 15, 16])).toBeNull();
    const justAbove = computeCallbackIdentityDelta([10, 11, 12], [14.1, 15.1, 16.1]);
    expect(justAbove).not.toBeNull();
    expect(justAbove!.deltaMs).toBeCloseTo(4.1, 5);
  });

  it("rejects a delta at the absolute floor even with zero scatter", () => {
    expect(computeCallbackIdentityDelta([10, 10], [10.5, 10.5])).toBeNull();
    expect(computeCallbackIdentityDelta([10, 10], [10.6, 10.6])).not.toBeNull();
  });

  it("reports the medians it compared, not the extremes", () => {
    const r = computeCallbackIdentityDelta([10, 11, 12], [50, 51, 52])!;
    expect(r.stableMs).toBe(11);
    expect(r.freshMs).toBe(51);
    expect(r.deltaMs).toBeCloseTo(40, 5);
  });
});

describe("M66 harden: callback props builder", () => {
  // H13 — a string prop that collides with the marker becomes a callback. Known
  // and pre-existing: the marker is the only channel functions have across CDP.
  it("converts a prop whose string value collides with the marker", () => {
    const out = loadBuilder()({ label: MARKER }, new Map(), MARKER, null, false);
    expect(typeof out.label).toBe("function");
  });

  it("gives the measured prop the same identity whether it arrived as a marker or not", () => {
    const build = loadBuilder();
    const cache = new Map<string, unknown>();
    const fromMarker = build({ onAction: MARKER }, cache, MARKER, "onAction", false);
    const fromAbsent = build({}, cache, MARKER, "onAction", false);
    expect(fromAbsent.onAction).toBe(fromMarker.onAction);
  });

  it("does not mutate the props object it was given", () => {
    const props = { onAction: MARKER, count: 1 };
    loadBuilder()(props, new Map(), MARKER, "onAction", true);
    expect(props.onAction).toBe(MARKER);
  });

  it("keeps caches independent so one component cannot leak into another", () => {
    const build = loadBuilder();
    const a = build({}, new Map(), MARKER, "onAction", false);
    const b = build({}, new Map(), MARKER, "onAction", false);
    expect(a.onAction).not.toBe(b.onAction);
  });
});
