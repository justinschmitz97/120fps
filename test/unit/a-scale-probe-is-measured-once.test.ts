import { describe, it, expect } from "vitest";
import {
  measureGatedScaleMounts,
  SCALE_PROBE_GATE_MS,
  SCALE_PROBE_COST_WARNING,
} from "../../src/pipeline/index.js";
import type { MountPassGate, MountResult } from "../../src/browser/index.js";
import type { PropCombination } from "../../src/props/index.js";

// A scale combo carries the first prop combo's props beside the copy count (M134 C7's shape).
const scale = (n: number, base: PropCombination = {}): PropCombination => ({
  ...base,
  __120fps_scaleN: n,
});
const A: PropCombination = { variant: "a" };

function mountResult(comboIndex: number, props: PropCombination, median: number): MountResult {
  return {
    comboIndex,
    props,
    mount: { samples: [median], median, p95: median },
    unmount: { samples: [1], median: 1, p95: 1 },
    domNodeCount: 10,
    heapDelta: 0,
  };
}

// Mirrors measureMount: one batch per call, results indexed by position, a gate consulted after
// each combo, and a combo nothing measured left as a hole.
function recordingMeasure(
  medianFor: (props: PropCombination) => number,
  unmeasured: (props: PropCombination) => boolean = () => false,
) {
  const batches: PropCombination[][] = [];
  return {
    batches,
    measure: async (combos: PropCombination[], gate?: MountPassGate) => {
      batches.push(combos);
      const results: MountResult[] = new Array(combos.length);
      for (let ci = 0; ci < combos.length; ci++) {
        if (ci > 0 && gate && !gate.shouldContinue(ci - 1, results)) break;
        if (unmeasured(combos[ci])) continue;
        results[ci] = mountResult(ci, combos[ci], medianFor(combos[ci]));
      }
      return results;
    },
  };
}

const CHEAP = () => 5;
const OVER_GATE = (props: PropCombination) =>
  props.__120fps_scaleN === undefined ? 5 : SCALE_PROBE_GATE_MS + 1;

describe("the scale-point gate", () => {
  it("measures the smallest scale point once, in the batch that measures the prop combos", async () => {
    const { batches, measure } = recordingMeasure(CHEAP);

    await measureGatedScaleMounts({ propCombos: [{ variant: "a" }], scalePoints: [1, 5, 20, 50], measure });

    expect(batches[0][0]).toEqual(A);
    expect(batches[0][1]).toEqual(scale(1, A));
    expect(batches.flat().filter((props) => props.__120fps_scaleN === 1)).toHaveLength(1);
  });

  it("measures the whole sweep in the one batch the prop combos ran in", async () => {
    const { batches, measure } = recordingMeasure(CHEAP);

    const result = await measureGatedScaleMounts({
      propCombos: [{ variant: "a" }],
      scalePoints: [1, 5, 20, 50],
      measure,
    });

    expect(batches).toHaveLength(1);
    expect(result.combos).toEqual([A, scale(1, A), scale(5, A), scale(20, A), scale(50, A)]);
    expect(result.mounts.map((m) => m.comboIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(result.mounts.map((m) => m.props)).toEqual(result.combos);
    expect(result.warning).toBeUndefined();
  });

  it("puts the scale points in ascending order however the run listed them", async () => {
    const { batches, measure } = recordingMeasure(CHEAP);

    await measureGatedScaleMounts({ propCombos: [], scalePoints: [50, 1, 20, 5], measure });

    expect(batches[0]).toEqual([scale(1), scale(5), scale(20), scale(50)]);
  });

  it("never measures a scale point the gate refused", async () => {
    const { batches, measure } = recordingMeasure(OVER_GATE);

    const result = await measureGatedScaleMounts({
      propCombos: [{ variant: "a" }],
      scalePoints: [1, 5, 20, 50],
      measure,
    });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(5);
    expect(result.combos).toEqual([A, scale(1, A)]);
    expect(result.mounts).toHaveLength(2);
    expect(result.warning).toBe(SCALE_PROBE_COST_WARNING(1, SCALE_PROBE_GATE_MS + 1, [5, 20, 50]));
  });

  it("keeps the hole the pass left for a combo it could not measure", async () => {
    const { measure } = recordingMeasure(CHEAP, (props) => props.variant === "b");

    const result = await measureGatedScaleMounts({
      propCombos: [{ variant: "a" }, { variant: "b" }],
      scalePoints: [1, 5, 20, 50],
      measure,
    });

    expect(result.mounts).toHaveLength(6);
    expect(Object.prototype.hasOwnProperty.call(result.mounts, 1)).toBe(false);
    expect([...result.mounts].filter(Boolean).map((m) => m!.comboIndex)).toEqual([0, 2, 3, 4, 5]);
    // What runComboMode does with the result: a hole must not become an all-zero row or a throw.
    expect(() => result.mounts.map((m) => m?.heapDelta ?? 0)).not.toThrow();
  });

  it("gates on the median the report prints, not on a separate probe", async () => {
    const { measure } = recordingMeasure((props) =>
      props.__120fps_scaleN === undefined ? 5 : SCALE_PROBE_GATE_MS + 12.5,
    );

    const result = await measureGatedScaleMounts({
      propCombos: [],
      scalePoints: [1, 5],
      measure,
    });

    expect(result.mounts[0].mount.median).toBe(SCALE_PROBE_GATE_MS + 12.5);
    expect(result.warning).toContain((SCALE_PROBE_GATE_MS + 12.5).toFixed(1));
  });

  it("asks no gate of a run whose scale points are a single point", async () => {
    const { batches, measure } = recordingMeasure(CHEAP);

    const result = await measureGatedScaleMounts({ propCombos: [{}], scalePoints: [1], measure });

    expect(batches).toEqual([[{}, scale(1)]]);
    expect(result.combos).toEqual([{}, scale(1)]);
    expect(result.warning).toBeUndefined();
  });

  it("opens one batch for a run with no scale points at all", async () => {
    const { batches, measure } = recordingMeasure(CHEAP);

    const result = await measureGatedScaleMounts({ propCombos: [{}], scalePoints: [], measure });

    expect(batches).toEqual([[{}]]);
    expect(result.combos).toEqual([{}]);
  });

  it("measures the scale points alone when the run has no prop combos", async () => {
    const { batches, measure } = recordingMeasure(CHEAP);

    const result = await measureGatedScaleMounts({ propCombos: [], scalePoints: [1, 5], measure });

    expect(batches[0]).toEqual([scale(1), scale(5)]);
    expect(result.combos).toEqual([scale(1), scale(5)]);
    expect(result.mounts.map((m) => m.comboIndex)).toEqual([0, 1]);
  });

  it("keeps the larger points when the smallest point's measurement is missing", async () => {
    const { measure } = recordingMeasure(CHEAP, (props) => props.__120fps_scaleN === 1);

    const result = await measureGatedScaleMounts({ propCombos: [], scalePoints: [1, 5], measure });

    expect(result.combos).toEqual([scale(1), scale(5)]);
    expect(result.warning).toBeUndefined();
  });
});
