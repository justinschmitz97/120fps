import { describe, it, expect } from "vitest";
import {
  buildMatrixReport,
  buildTimingWithCV,
  type ComboReport,
  type InteractionReport,
  type MatrixAxis,
  type PropDelta,
} from "../../src/report.js";

function makeCombo(
  comboIndex: number,
  mountMedian: number,
  dom: number,
  overrides: Partial<ComboReport> = {},
): ComboReport {
  return {
    comboIndex,
    props: {},
    mount: buildTimingWithCV([mountMedian, mountMedian, mountMedian]),
    rerender: buildTimingWithCV([0.5, 0.5, 0.5]),
    unmount: buildTimingWithCV([0.1, 0.1, 0.1]),
    domNodeCount: dom,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 1,
    verdict: "pass",
    tier: "T1",
    ...overrides,
  };
}

function makeInteraction(median: number): InteractionReport {
  return {
    selector: "button",
    type: "click",
    label: "Toggle",
    timing: buildTimingWithCV([median, median, median]),
    relativeTiming: 1,
  };
}

const TWO_AXES: MatrixAxis[] = [
  { propName: "variant", values: ["primary", "secondary"] },
  { propName: "disabled", values: [false, true] },
];

describe("buildMatrixReport", () => {
  it("produces correct cell count", () => {
    const combos = [
      makeCombo(0, 1.0, 8),
      makeCombo(1, 2.0, 10),
      makeCombo(2, 1.5, 9),
      makeCombo(3, 3.0, 12),
    ];
    const result = buildMatrixReport({ axes: TWO_AXES, combos });
    expect(result.cells).toHaveLength(4);
  });

  it("hotCells are top 5 by mount.median descending", () => {
    const combos = Array.from({ length: 8 }, (_, i) => makeCombo(i, (i + 1) * 1.0, 10));
    const result = buildMatrixReport({
      axes: [{ propName: "variant", values: Array.from({ length: 8 }, (_, i) => `v${i}`) }],
      combos,
    });
    expect(result.hotCells).toHaveLength(5);
    expect(result.hotCells[0].mount.median).toBe(8.0);
    expect(result.hotCells[4].mount.median).toBe(4.0);
  });

  it("coldCells are bottom 3 by mount.median ascending", () => {
    const combos = Array.from({ length: 8 }, (_, i) => makeCombo(i, (i + 1) * 1.0, 10));
    const result = buildMatrixReport({
      axes: [{ propName: "variant", values: Array.from({ length: 8 }, (_, i) => `v${i}`) }],
      combos,
    });
    expect(result.coldCells).toHaveLength(3);
    expect(result.coldCells[0].mount.median).toBe(1.0);
    expect(result.coldCells[2].mount.median).toBe(3.0);
  });

  it("hotCells capped at 5 even with more cells", () => {
    const combos = Array.from({ length: 20 }, (_, i) => makeCombo(i, (i + 1) * 1.0, 10));
    const result = buildMatrixReport({
      axes: [{ propName: "v", values: Array.from({ length: 20 }, (_, i) => `v${i}`) }],
      combos,
    });
    expect(result.hotCells).toHaveLength(5);
  });

  it("coldCells capped at 3", () => {
    const combos = Array.from({ length: 20 }, (_, i) => makeCombo(i, (i + 1) * 1.0, 10));
    const result = buildMatrixReport({
      axes: [{ propName: "v", values: Array.from({ length: 20 }, (_, i) => `v${i}`) }],
      combos,
    });
    expect(result.coldCells).toHaveLength(3);
  });

  it("carries the combo verdict onto the cell", () => {
    const combos = [
      makeCombo(0, 1.0, 8),
      makeCombo(1, 60.0, 10, { verdict: "fail" }),
    ];
    const result = buildMatrixReport({ axes: TWO_AXES.slice(0, 1), combos });
    expect(result.cells[0].verdict).toBe("pass");
    expect(result.cells[1].verdict).toBe("fail");
  });

  // The run-level pass/fail is derived from the combos. Recomputing a verdict
  // here from mount/rerender alone is what let an all-PASS table sit above a
  // FAIL result when the real cost was in an interaction.
  it("marks a cell failed when the combo failed on an interaction alone", () => {
    const combos = [
      makeCombo(0, 1.0, 8),
      makeCombo(1, 1.2, 8, { verdict: "fail", interactions: [makeInteraction(717.3)] }),
    ];
    const result = buildMatrixReport({ axes: TWO_AXES.slice(0, 1), combos });
    expect(result.cells[1].verdict).toBe("fail");
    expect(result.failingCells).toHaveLength(1);
    expect(result.failingCells[0].comboIndex).toBe(1);
  });

  it("reports the slowest interaction per cell", () => {
    const combos = [
      makeCombo(0, 1.0, 8, { interactions: [makeInteraction(12), makeInteraction(717.3), makeInteraction(4)] }),
    ];
    const result = buildMatrixReport({ axes: [], combos });
    expect(result.cells[0].worstInteractionMs).toBeCloseTo(717.3);
  });

  it("reports null interaction time when the cell was not explored", () => {
    const result = buildMatrixReport({ axes: [], combos: [makeCombo(0, 1.0, 8)] });
    expect(result.cells[0].worstInteractionMs).toBeNull();
  });

  it("preserves comboIndex on each cell", () => {
    const combos = [makeCombo(7, 1.0, 8), makeCombo(2, 2.0, 8)];
    const result = buildMatrixReport({ axes: [], combos });
    expect(result.cells.map((c) => c.comboIndex)).toEqual([7, 2]);
  });

  it("falls back to T1 when the combo has no tier", () => {
    const combos = [makeCombo(0, 1.0, 8, { tier: undefined })];
    const result = buildMatrixReport({ axes: [], combos });
    expect(result.cells[0].tier).toBe("T1");
  });

  it("failingCells is empty when every combo passed", () => {
    const combos = [makeCombo(0, 1.0, 8), makeCombo(1, 2.0, 8, { verdict: "warn" })];
    const result = buildMatrixReport({ axes: [], combos });
    expect(result.failingCells).toEqual([]);
  });

  it("produces compound effects from propDeltas", () => {
    const combos = [
      makeCombo(0, 1.0, 8, { props: { variant: "primary", disabled: false } }),
      makeCombo(1, 1.5, 8, { props: { variant: "primary", disabled: true } }),
      makeCombo(2, 1.3, 8, { props: { variant: "secondary", disabled: false } }),
      makeCombo(3, 5.0, 8, { props: { variant: "secondary", disabled: true } }),
    ];
    const deltas: PropDelta[] = [
      { propName: "disabled", baseValue: false, flipValue: true, mountDelta: 0.5, rerenderDelta: 0 },
      { propName: "variant", baseValue: "primary", flipValue: "secondary", mountDelta: 0.3, rerenderDelta: 0 },
    ];
    const result = buildMatrixReport({ axes: TWO_AXES, combos, propDeltas: deltas });
    expect(result.compoundEffects.length).toBeGreaterThan(0);
    const effect = result.compoundEffects.find((e) => e.props.variant === "secondary" && e.props.disabled === true);
    expect(effect).toBeDefined();
    expect(effect!.significance).toBe("high"); // 5.0 / (1.0 + 0.5 + 0.3) = 2.78x
  });

  it("compound effects empty without propDeltas", () => {
    const combos = [makeCombo(0, 1.0, 8), makeCombo(1, 5.0, 8)];
    const result = buildMatrixReport({ axes: TWO_AXES.slice(0, 1), combos });
    expect(result.compoundEffects).toHaveLength(0);
  });

  it("compound effects empty with single axis", () => {
    const combos = [
      makeCombo(0, 1.0, 8, { props: { variant: "primary" } }),
      makeCombo(1, 5.0, 8, { props: { variant: "secondary" } }),
    ];
    const deltas: PropDelta[] = [
      { propName: "variant", baseValue: "primary", flipValue: "secondary", mountDelta: 4.0, rerenderDelta: 0 },
    ];
    const result = buildMatrixReport({ axes: [TWO_AXES[0]], combos, propDeltas: deltas });
    expect(result.compoundEffects).toHaveLength(0);
  });

  it("handles single cell", () => {
    const result = buildMatrixReport({ axes: [], combos: [makeCombo(0, 1.0, 8)] });
    expect(result.cells).toHaveLength(1);
    expect(result.hotCells).toHaveLength(1);
    expect(result.coldCells).toHaveLength(1);
  });

  it("handles zero cells", () => {
    const result = buildMatrixReport({ axes: [], combos: [] });
    expect(result.cells).toEqual([]);
    expect(result.hotCells).toEqual([]);
    expect(result.failingCells).toEqual([]);
  });
});
