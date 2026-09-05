import { describe, it, expect } from "vitest";
import {
  measureCallbackIdentityDeltas,
  probedFunctionProps,
  propCombinationKey,
  type CallbackProbePort,
} from "../../src/analysis/index.js";
import type { PropCombination } from "../../src/props/index.js";

interface Recorded {
  port: CallbackProbePort;
  collections: string[];
  mounts: string[];
  arms: Array<{ fnProp: string; fresh: boolean }>;
}

// Returns a fixed duration per arm so the recorded call order is what the assertions read.
function recordingPort(durations: (fnProp: string, fresh: boolean) => number): Recorded {
  const collections: string[] = [];
  const mounts: string[] = [];
  const arms: Array<{ fnProp: string; fresh: boolean }> = [];
  return {
    collections,
    mounts,
    arms,
    port: {
      async collectGarbage() {
        collections.push("gc");
      },
      async mountWithStableCallbacks(fnProp: string) {
        mounts.push(fnProp);
      },
      async measureRerender(fnProp: string, fresh: boolean) {
        arms.push({ fnProp, fresh });
        return durations(fnProp, fresh);
      },
    },
  };
}

describe("the props the callback-identity pass probes", () => {
  it("skips a capture-phase prop whose bubble twin is probed", () => {
    expect(probedFunctionProps(["onCopy", "onCopyCapture", "onFocus", "onFocusCapture"])).toEqual([
      "onCopy",
      "onFocus",
    ]);
  });

  it("probes a capture-phase prop that has no bubble twin", () => {
    expect(probedFunctionProps(["onCopyCapture", "onFocus"])).toEqual(["onCopyCapture", "onFocus"]);
  });

  it("keeps a prop whose name merely ends in the word", () => {
    expect(probedFunctionProps(["onCapture"])).toEqual(["onCapture"]);
  });

  it("reduces the run-6 label prop list to nine props", () => {
    const extracted = [
      "onCopy", "onCopyCapture", "onCut", "onCutCapture", "onPaste", "onPasteCapture",
      "onCompositionEnd", "onCompositionEndCapture", "onCompositionStart",
      "onCompositionStartCapture", "onCompositionUpdate", "onCompositionUpdateCapture",
      "onFocus", "onFocusCapture", "onBlur", "onBlurCapture", "onChange",
    ];
    expect(probedFunctionProps(extracted)).toHaveLength(9);
  });
});

describe("the prop sets the callback-identity pass distinguishes", () => {
  it("gives combos with equal props one key whatever order they declare them in", () => {
    expect(propCombinationKey({ a: 1, b: "x" })).toBe(propCombinationKey({ b: "x", a: 1 }));
  });

  it("gives combos with different props different keys", () => {
    expect(propCombinationKey({ a: 1 })).not.toBe(propCombinationKey({ a: 2 }));
    expect(propCombinationKey({ a: 1 })).not.toBe(propCombinationKey({}));
  });

  it("gives combos that differ only in the scale trigger one key", () => {
    expect(propCombinationKey({ __120fps_scaleN: 1 })).toBe(
      propCombinationKey({ __120fps_scaleN: 50 }),
    );
    expect(propCombinationKey({ a: 1, __120fps_scaleN: 5 })).toBe(propCombinationKey({ a: 1 }));
  });

  it("reduces the run-6 combo list to three prop sets", () => {
    // Two prop-space combos plus four scale probes, which carry only the harness trigger key.
    const combos: PropCombination[] = [
      { className: "test", asChild: true },
      { className: "test" },
      { __120fps_scaleN: 1 },
      { __120fps_scaleN: 5 },
      { __120fps_scaleN: 20 },
      { __120fps_scaleN: 50 },
    ];
    expect(new Set(combos.map(propCombinationKey)).size).toBe(3);
  });
});

describe("the work the callback-identity pass performs", () => {
  it("collects garbage once per probed prop and measures two arms per sample", async () => {
    const recorded = recordingPort(() => 1);
    await measureCallbackIdentityDeltas(
      recorded.port,
      ["onCopy", "onCopyCapture", "onFocus"],
      3,
    );

    expect(recorded.collections).toHaveLength(2);
    expect(recorded.arms).toHaveLength(2 * 3 * 2);
    expect(recorded.mounts).toHaveLength(2 * 3 * 2);
  });

  it("collects garbage before the first arm of each probed prop", async () => {
    const order: string[] = [];
    const port: CallbackProbePort = {
      collectGarbage: async () => { order.push("gc"); },
      mountWithStableCallbacks: async (p) => { order.push("mount:" + p); },
      measureRerender: async (p, fresh) => { order.push("arm:" + p + ":" + fresh); return 1; },
    };
    await measureCallbackIdentityDeltas(port, ["onCopy", "onFocus"], 1);

    expect(order).toEqual([
      "gc",
      "mount:onCopy", "arm:onCopy:false",
      "mount:onCopy", "arm:onCopy:true",
      "gc",
      "mount:onFocus", "arm:onFocus:false",
      "mount:onFocus", "arm:onFocus:true",
    ]);
  });

  it("alternates which arm runs first across samples", async () => {
    const recorded = recordingPort(() => 1);
    await measureCallbackIdentityDeltas(recorded.port, ["onCopy"], 3);

    expect(recorded.arms.map((a) => a.fresh)).toEqual([false, true, true, false, false, true]);
  });

  it("reports one delta per probed prop whose fresh arm costs more", async () => {
    const recorded = recordingPort((fnProp, fresh) =>
      fnProp === "onCopy" && fresh ? 12 : 4,
    );
    const deltas = await measureCallbackIdentityDeltas(
      recorded.port,
      ["onCopy", "onCopyCapture", "onFocus"],
      3,
    );

    expect(deltas.map((d) => d.propName)).toEqual(["onCopy"]);
    expect(deltas[0].stableMs).toBe(4);
    expect(deltas[0].freshMs).toBe(12);
    expect(deltas[0].deltaMs).toBe(8);
  });

  it("reports nothing when no prop is probed", async () => {
    const recorded = recordingPort(() => 1);
    expect(await measureCallbackIdentityDeltas(recorded.port, [], 3)).toEqual([]);
    expect(recorded.arms).toHaveLength(0);
    expect(recorded.collections).toHaveLength(0);
  });
});
