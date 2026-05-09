import { describe, it, expect } from "vitest";
import {
  buildMatrixReport,
  type MatrixAxis,
  type PropDelta,
  type Thresholds,
} from "../../src/report.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";

function makeMountResult(comboIndex: number, mountMedian: number, dom: number): MountResult {
  return {
    comboIndex,
    props: {},
    mount: { samples: [mountMedian, mountMedian, mountMedian], median: mountMedian, p95: mountMedian },
    unmount: { samples: [0.1, 0.1, 0.1], median: 0.1, p95: 0.1 },
    domNodeCount: dom,
    heapDelta: 0,
    mountTraces: [],
  };
}

function makeRerenderResult(comboIndex: number, stableMedian: number): RerenderResult {
  return {
    comboIndex,
    props: {},
    stable: { samples: [stableMedian, stableMedian, stableMedian], median: stableMedian, p95: stableMedian },
  };
}

const THRESHOLDS: Thresholds = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

const TWO_AXES: MatrixAxis[] = [
  { propName: "variant", values: ["primary", "secondary"] },
  { propName: "disabled", values: [false, true] },
];

describe("buildMatrixReport", () => {
  it("produces correct cell count", () => {
    const mounts = [
      makeMountResult(0, 1.0, 8),
      makeMountResult(1, 2.0, 10),
      makeMountResult(2, 1.5, 9),
      makeMountResult(3, 3.0, 12),
    ];
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const result = buildMatrixReport({
      axes: TWO_AXES,
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
    });
    expect(result.cells).toHaveLength(4);
  });

  it("hotCells are top 5 by mount.median descending", () => {
    const mounts = Array.from({ length: 8 }, (_, i) => makeMountResult(i, (i + 1) * 1.0, 10));
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const result = buildMatrixReport({
      axes: [{ propName: "variant", values: Array.from({ length: 8 }, (_, i) => `v${i}`) }],
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
    });
    expect(result.hotCells).toHaveLength(5);
    expect(result.hotCells[0].mount.median).toBe(8.0);
    expect(result.hotCells[4].mount.median).toBe(4.0);
  });

  it("coldCells are bottom 3 by mount.median ascending", () => {
    const mounts = Array.from({ length: 8 }, (_, i) => makeMountResult(i, (i + 1) * 1.0, 10));
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const result = buildMatrixReport({
      axes: [{ propName: "variant", values: Array.from({ length: 8 }, (_, i) => `v${i}`) }],
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
    });
    expect(result.coldCells).toHaveLength(3);
    expect(result.coldCells[0].mount.median).toBe(1.0);
    expect(result.coldCells[2].mount.median).toBe(3.0);
  });

  it("hotCells capped at 5 even with more cells", () => {
    const mounts = Array.from({ length: 20 }, (_, i) => makeMountResult(i, (i + 1) * 1.0, 10));
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const result = buildMatrixReport({
      axes: [{ propName: "v", values: Array.from({ length: 20 }, (_, i) => `v${i}`) }],
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
    });
    expect(result.hotCells).toHaveLength(5);
  });

  it("coldCells capped at 3", () => {
    const mounts = Array.from({ length: 20 }, (_, i) => makeMountResult(i, (i + 1) * 1.0, 10));
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const result = buildMatrixReport({
      axes: [{ propName: "v", values: Array.from({ length: 20 }, (_, i) => `v${i}`) }],
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
    });
    expect(result.coldCells).toHaveLength(3);
  });

  it("computes verdict for each cell", () => {
    const mounts = [
      makeMountResult(0, 1.0, 8),
      makeMountResult(1, 60.0, 10), // exceeds T1 and default
    ];
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const result = buildMatrixReport({
      axes: TWO_AXES.slice(0, 1),
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
    });
    expect(result.cells[0].verdict).toBe("pass");
    expect(result.cells[1].verdict).toBe("fail");
  });

  it("produces compound effects from propDeltas", () => {
    const anchorMount = 1.0;
    const mounts = [
      makeMountResult(0, anchorMount, 8),            // anchor: variant=primary, disabled=false
      makeMountResult(1, 1.5, 8),                    // variant=primary, disabled=true
      makeMountResult(2, 1.3, 8),                    // variant=secondary, disabled=false
      makeMountResult(3, 5.0, 8),                    // variant=secondary, disabled=true -> compound!
    ];
    mounts[0].props = { variant: "primary", disabled: false };
    mounts[1].props = { variant: "primary", disabled: true };
    mounts[2].props = { variant: "secondary", disabled: false };
    mounts[3].props = { variant: "secondary", disabled: true };
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const deltas: PropDelta[] = [
      { propName: "disabled", baseValue: false, flipValue: true, mountDelta: 0.5, rerenderDelta: 0 },
      { propName: "variant", baseValue: "primary", flipValue: "secondary", mountDelta: 0.3, rerenderDelta: 0 },
    ];
    const result = buildMatrixReport({
      axes: TWO_AXES,
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
      propDeltas: deltas,
    });
    expect(result.compoundEffects.length).toBeGreaterThan(0);
    const effect = result.compoundEffects.find((e) => e.props.variant === "secondary" && e.props.disabled === true);
    expect(effect).toBeDefined();
    expect(effect!.significance).toBe("high"); // 5.0 / (1.0 + 0.5 + 0.3) = 2.78x
  });

  it("compound effects empty without propDeltas", () => {
    const mounts = [makeMountResult(0, 1.0, 8), makeMountResult(1, 5.0, 8)];
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const result = buildMatrixReport({
      axes: TWO_AXES.slice(0, 1),
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
    });
    expect(result.compoundEffects).toHaveLength(0);
  });

  it("compound effects empty with single axis", () => {
    const mounts = [makeMountResult(0, 1.0, 8), makeMountResult(1, 5.0, 8)];
    mounts[0].props = { variant: "primary" };
    mounts[1].props = { variant: "secondary" };
    const rerenders = mounts.map((_, i) => makeRerenderResult(i, 0.5));
    const deltas: PropDelta[] = [
      { propName: "variant", baseValue: "primary", flipValue: "secondary", mountDelta: 4.0, rerenderDelta: 0 },
    ];
    const result = buildMatrixReport({
      axes: [TWO_AXES[0]],
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
      propDeltas: deltas,
    });
    expect(result.compoundEffects).toHaveLength(0);
  });

  it("handles single cell", () => {
    const mounts = [makeMountResult(0, 1.0, 8)];
    const rerenders = [makeRerenderResult(0, 0.5)];
    const result = buildMatrixReport({
      axes: [],
      mounts,
      rerenders,
      thresholds: THRESHOLDS,
    });
    expect(result.cells).toHaveLength(1);
    expect(result.hotCells).toHaveLength(1);
    expect(result.coldCells).toHaveLength(1);
  });
});
