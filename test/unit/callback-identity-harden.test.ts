import { describe, it, expect } from "vitest";
import { CALLBACK_PROPS_SOURCE, computeCallbackIdentityDelta } from "../../src/react-profiler.js";

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

describe("callback identity gate edge cases", () => {
  // H11: the gate is an inequality, so the boundary must not report.
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
    // Skewed arrays so the median differs from both the mean and the extremes:
    // stable [10,11,30] has median 11 (mean 17, extremes 10/30); fresh
    // [70,90,91] has median 90 (mean ~83.67, extremes 70/91).
    const r = computeCallbackIdentityDelta([10, 11, 30], [70, 90, 91])!;
    expect(r.stableMs).toBe(11);
    expect(r.freshMs).toBe(90);
    expect(r.deltaMs).toBeCloseTo(79, 5);
  });
});

describe("callback props builder edge cases", () => {
  // H13: a string prop that collides with the marker becomes a callback. Known
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
