import { describe, it, expect } from "vitest";
import {
  measureGatedScaleMounts,
  SCALE_PROBE_GATE_MS,
  SCALE_PROBE_COST_WARNING,
} from "../../src/pipeline/index.js";
import type { MountResult } from "../../src/browser/index.js";
import type { PropCombination } from "../../src/props/index.js";

const scale = (n: number): PropCombination => ({ __120fps_scaleN: n });

function batchOf(combos: PropCombination[], medianFor: (props: PropCombination) => number): MountResult[] {
  return combos.map((props, comboIndex) => ({
    comboIndex,
    props,
    mount: { samples: [medianFor(props)], median: medianFor(props), p95: medianFor(props) },
    unmount: { samples: [1], median: 1, p95: 1 },
    domNodeCount: 10,
    heapDelta: 0,
  }));
}

function recordingMeasure(medianFor: (props: PropCombination) => number) {
  const batches: PropCombination[][] = [];
  return {
    batches,
    measure: async (combos: PropCombination[]) => {
      batches.push(combos);
      return batchOf(combos, medianFor);
    },
  };
}

const CHEAP = () => 5;
const OVER_GATE = (props: PropCombination) =>
  props.__120fps_scaleN === undefined ? 5 : SCALE_PROBE_GATE_MS + 1;

describe("the scale-point gate", () => {
  it("measures the smallest scale point once, in the main batch", async () => {
    const { batches, measure } = recordingMeasure(CHEAP);

    await measureGatedScaleMounts({ propCombos: [{ variant: "a" }], scalePoints: [1, 5, 20, 50], measure });

    expect(batches[0]).toEqual([{ variant: "a" }, scale(1)]);
    expect(batches.flat().filter((props) => props.__120fps_scaleN === 1)).toHaveLength(1);
  });

  it("measures the larger scale points only after the gate lets them through", async () => {
    const { batches, measure } = recordingMeasure(CHEAP);

    const result = await measureGatedScaleMounts({
      propCombos: [{ variant: "a" }],
      scalePoints: [1, 5, 20, 50],
      measure,
    });

    expect(batches[1]).toEqual([scale(5), scale(20), scale(50)]);
    expect(result.combos).toEqual([{ variant: "a" }, scale(1), scale(5), scale(20), scale(50)]);
    expect(result.mounts.map((m) => m.comboIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(result.mounts.map((m) => m.props)).toEqual(result.combos);
    expect(result.warning).toBeUndefined();
  });

  it("never measures a scale point the gate refused", async () => {
    const { batches, measure } = recordingMeasure(OVER_GATE);

    const result = await measureGatedScaleMounts({
      propCombos: [{ variant: "a" }],
      scalePoints: [1, 5, 20, 50],
      measure,
    });

    expect(batches).toHaveLength(1);
    expect(result.combos).toEqual([{ variant: "a" }, scale(1)]);
    expect(result.warning).toBe(SCALE_PROBE_COST_WARNING(1, SCALE_PROBE_GATE_MS + 1, [5, 20, 50]));
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

  it("opens one batch for a run whose scale points are a single point", async () => {
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

    expect(batches[0]).toEqual([scale(1)]);
    expect(result.combos).toEqual([scale(1), scale(5)]);
    expect(result.mounts.map((m) => m.comboIndex)).toEqual([0, 1]);
  });

  it("keeps the larger points when the smallest point's measurement is missing", async () => {
    const result = await measureGatedScaleMounts({
      propCombos: [],
      scalePoints: [1, 5],
      measure: async (combos) => (combos.length === 1 ? [] : batchOf(combos, CHEAP)),
    });

    expect(result.combos).toEqual([scale(1), scale(5)]);
    expect(result.warning).toBeUndefined();
  });
});
