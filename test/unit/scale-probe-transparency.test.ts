import { describe, it, expect } from "vitest";
import {
  buildReport,
  COMBO_CAP_WARNING,
  MATRIX_CELL_CAP_WARNING,
  SCALE_PROBE_COST_WARNING,
  SCALE_PROBE_GATE_MS,
  boundScalePointsByProbeCost,
  type BuildReportInput,
} from "../../src/analyze.js";
import { formatTable, describeMode, type Report, type ComboReport } from "../../src/report.js";
import { selectMatrixCombos, type PropCombination } from "../../src/prop-gen-values.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";

// --- Helpers ---

function makeEmptyGraph(): StateGraph {
  const nodes = new Map();
  nodes.set("abc", { id: "abc", depth: 0, interactions: [], pathFromRoot: [] });
  return { nodes, edges: [], initialNodeId: "abc", wallClockMs: 100 };
}

const baseMachine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};
const baseCal = { totalDuration: 10, scriptDuration: 5 };
const baseThresholds = { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 };

function mount(comboIndex: number, props: PropCombination, mountMedian: number, domNodeCount: number): MountResult {
  return {
    comboIndex,
    props,
    mount: { samples: [mountMedian], median: mountMedian, p95: mountMedian },
    unmount: { samples: [1], median: 1, p95: 1 },
    domNodeCount,
    heapDelta: 0,
  };
}

function rerender(comboIndex: number, props: PropCombination, median: number): RerenderResult {
  return { comboIndex, props, stable: { samples: [median], median, p95: median } };
}

function explore(comboIndex: number, props: PropCombination): ExploreResult {
  return { comboIndex, props, graph: makeEmptyGraph() };
}

function baseInput(mounts: MountResult[], rerenders: RerenderResult[]): BuildReportInput {
  return {
    componentPath: "./Widget.tsx",
    componentName: "Widget",
    machine: baseMachine,
    calibration: baseCal,
    mounts,
    explores: mounts.map((m) => explore(m.comboIndex, m.props)),
    heapDeltas: mounts.map(() => 0),
    thresholds: baseThresholds,
    rerenders,
  };
}

function makeCombo(overrides: Partial<ComboReport> = {}): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
    unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
    rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
    domNodeCount: 10,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 0.5,
    verdict: "pass",
    ...overrides,
  };
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-08-18T00:00:00Z",
    machine: baseMachine,
    componentPath: "./Widget.tsx",
    componentName: "Widget",
    calibration: baseCal,
    combos: [makeCombo()],
    thresholds: baseThresholds,
    pass: true,
    ...overrides,
  };
}

// --- Contract 1: scale-probe identity ---

describe("scale-probe identity", () => {
  it("strips __120fps_scaleN from combo.props and records scaleProbe", () => {
    const report = buildReport(baseInput(
      [mount(0, { __120fps_scaleN: 20 }, 5, 100)],
      [rerender(0, { __120fps_scaleN: 20 }, 3)],
    ));
    expect(report.combos[0].scaleProbe).toBe(20);
    expect(report.combos[0].props).not.toHaveProperty("__120fps_scaleN");
  });

  it("leaves scaleProbe undefined and props untouched for a real prop combo", () => {
    const report = buildReport(baseInput(
      [mount(0, { label: "x" }, 5, 10)],
      [rerender(0, { label: "x" }, 3)],
    ));
    expect(report.combos[0].scaleProbe).toBeUndefined();
    expect(report.combos[0].props).toEqual({ label: "x" });
  });

  it("keeps other props alongside a stripped __120fps_scaleN key", () => {
    const report = buildReport(baseInput(
      [mount(0, { __120fps_scaleN: 5, label: "kept" }, 5, 40)],
      [rerender(0, { __120fps_scaleN: 5, label: "kept" }, 3)],
    ));
    expect(report.combos[0].props).toEqual({ label: "kept" });
  });

  it("formatTable labels a scale-probe row with its N, not a bare index", () => {
    const combo = makeCombo({ comboIndex: 3, scaleProbe: 20, props: {} });
    const table = formatTable(makeReport({ combos: [combo] }));
    expect(table).toContain("×20 copies");
  });

  it("formatTable keeps a bare index for a non-probe row", () => {
    const table = formatTable(makeReport({ combos: [makeCombo({ comboIndex: 3 })] }));
    expect(table).toMatch(/^3\s/m);
    expect(table).not.toContain("copies");
  });
});

// --- Contract 2: one curve per mechanism ---

describe("scale-probe curve isolation", () => {
  it("does not fit a curve across real combos with merely differing DOM counts", () => {
    const report = buildReport(baseInput(
      [mount(0, {}, 5, 10), mount(1, {}, 10, 50)],
      [rerender(0, {}, 3), rerender(1, {}, 8)],
    ));
    expect(report.combos[0].scalingCurve).toBeNull();
    expect(report.combos[1].scalingCurve).toBeNull();
    expect(report.combos[0].rerenderScalingCurve).toBeUndefined();
    expect(report.combos[1].rerenderScalingCurve).toBeUndefined();
  });

  it("fits a curve across scale-probe combos using their N, and attaches it only to them", () => {
    const report = buildReport(baseInput(
      [
        mount(0, { label: "x" }, 4, 8),
        mount(1, { __120fps_scaleN: 1 }, 5, 10),
        mount(2, { __120fps_scaleN: 5 }, 20, 50),
        mount(3, { __120fps_scaleN: 20 }, 80, 200),
      ],
      [
        rerender(0, { label: "x" }, 2),
        rerender(1, { __120fps_scaleN: 1 }, 3),
        rerender(2, { __120fps_scaleN: 5 }, 12),
        rerender(3, { __120fps_scaleN: 20 }, 48),
      ],
    ));
    expect(report.combos[0].scalingCurve).toBeNull();
    expect(report.combos[1].scalingCurve).not.toBeNull();
    expect(report.combos[2].scalingCurve).not.toBeNull();
    expect(report.combos[3].scalingCurve).not.toBeNull();
    expect(report.combos[1].scalingCurve).toEqual(report.combos[2].scalingCurve);
  });

  it("formatTable labels a scale-probe combo's curve as synthetic, distinct from an auto-prop curve", () => {
    const probeCombo = makeCombo({
      comboIndex: 1,
      scaleProbe: 5,
      scalingCurve: { slope: 1, intercept: 0, r2: 0.99, growthClass: "linear" },
    });
    const table = formatTable(makeReport({ combos: [probeCombo] }));
    expect(table).toContain("synthetic");
    expect(table).not.toContain("auto:");
  });

  it("formatTable keeps the auto-prop label for a real combo's curve", () => {
    const realCombo = makeCombo({
      comboIndex: 0,
      scalingCurve: { slope: 1, intercept: 0, r2: 0.99, growthClass: "linear" },
    });
    const table = formatTable(makeReport({
      combos: [realCombo],
      autoScalingProp: "saves",
      autoScalingReason: "array prop",
    }));
    expect(table).toContain("auto: saves");
    expect(table).not.toContain("synthetic");
  });
});

// --- Contract 3: header reconciliation ---

describe("combo-count header excludes scale probes", () => {
  it("counts only prop combos in 'measured', and names scale probes separately", () => {
    const line = describeMode(makeReport({
      combos: [
        makeCombo({ comboIndex: 0 }),
        makeCombo({ comboIndex: 1 }),
        makeCombo({ comboIndex: 2, scaleProbe: 1 }),
        makeCombo({ comboIndex: 3, scaleProbe: 5 }),
        makeCombo({ comboIndex: 4, scaleProbe: 20 }),
        makeCombo({ comboIndex: 5, scaleProbe: 50 }),
      ],
    }));
    expect(line).toContain("2 measured");
    expect(line).toContain("+4 scale probe");
    expect(line).not.toContain("6 measured");
  });

  it("reconciles with the cap-warning's generated count", () => {
    const line = describeMode(makeReport({
      combos: [
        makeCombo({ comboIndex: 0 }),
        makeCombo({ comboIndex: 1, scaleProbe: 1 }),
      ],
      warnings: [COMBO_CAP_WARNING(8, 27)],
    }));
    expect(line).toContain("1 measured of 27 generated");
    expect(line).toContain("+1 scale probe");
  });

  it("names a scale-probe-only run distinctly instead of '0 measured'", () => {
    const line = describeMode(makeReport({
      combos: [
        makeCombo({ comboIndex: 0, scaleProbe: 1 }),
        makeCombo({ comboIndex: 1, scaleProbe: 5 }),
      ],
    }));
    expect(line.toLowerCase()).toContain("scale probe");
    expect(line).not.toContain("0 measured");
  });
});

// --- Contract 4: matrix combo cap ---

describe("selectMatrixCombos", () => {
  const axes = [
    { propName: "a", values: [false, true] },
    { propName: "b", values: [false, true] },
  ];

  it("keeps everything when already within the cap", () => {
    const combos: PropCombination[] = [{ a: false, b: false }, { a: false, b: true }];
    expect(selectMatrixCombos(combos, axes, 8)).toEqual([0, 1]);
  });

  it("always keeps the all-anchor base cell", () => {
    const combos: PropCombination[] = [
      { a: true, b: true },
      { a: false, b: false }, // base
      { a: true, b: false },
    ];
    const kept = selectMatrixCombos(combos, axes, 1);
    expect(kept).toEqual([1]);
  });

  it("prioritizes single-axis deviations over multi-axis ones", () => {
    const combos: PropCombination[] = [
      { a: false, b: false }, // base, distance 0
      { a: true, b: true }, // distance 2
      { a: true, b: false }, // distance 1
    ];
    const kept = selectMatrixCombos(combos, axes, 2);
    expect(kept).toEqual([0, 2]);
  });

  it("breaks ties by original index", () => {
    const threeAxes = [
      { propName: "a", values: [false, true] },
      { propName: "b", values: [false, true] },
      { propName: "c", values: [false, true] },
    ];
    const combos: PropCombination[] = [
      { a: false, b: false, c: false }, // base
      { a: true, b: false, c: false }, // dist 1
      { a: false, b: true, c: false }, // dist 1
      { a: false, b: false, c: true }, // dist 1
    ];
    expect(selectMatrixCombos(combos, threeAxes, 3)).toEqual([0, 1, 2]);
  });

  it("handles degenerate inputs", () => {
    expect(selectMatrixCombos([], axes, 8)).toEqual([]);
    expect(selectMatrixCombos([{ a: false, b: false }], axes, 0)).toEqual([]);
  });
});

describe("MATRIX_CELL_CAP_WARNING", () => {
  it("names both counts and points at --max-combos", () => {
    const warning = MATRIX_CELL_CAP_WARNING(8, 64);
    expect(warning).toContain("8");
    expect(warning).toContain("64");
    expect(warning).toContain("--max-combos");
  });
});

// --- Contract 5: probe cost gating ---

describe("boundScalePointsByProbeCost", () => {
  it("keeps every point when the cheapest probe is under the gate", () => {
    const result = boundScalePointsByProbeCost([1, 5, 20, 50], 4.2);
    expect(result.points).toEqual([1, 5, 20, 50]);
    expect(result.skipped).toEqual([]);
  });

  it("keeps only the probed point when the gate is exceeded", () => {
    const result = boundScalePointsByProbeCost([1, 5, 20, 50], SCALE_PROBE_GATE_MS + 1);
    expect(result.points).toEqual([1]);
    expect(result.skipped).toEqual([5, 20, 50]);
  });

  it("probes the smallest requested point, not literally 1", () => {
    const result = boundScalePointsByProbeCost([5, 10, 50], SCALE_PROBE_GATE_MS + 1);
    expect(result.points).toEqual([5]);
    expect(result.skipped).toEqual([10, 50]);
  });

  it("is a no-op right at the gate boundary", () => {
    const result = boundScalePointsByProbeCost([1, 5, 20, 50], SCALE_PROBE_GATE_MS);
    expect(result.points).toEqual([1, 5, 20, 50]);
  });

  it("is a no-op for a single-point request regardless of cost", () => {
    const result = boundScalePointsByProbeCost([20], SCALE_PROBE_GATE_MS + 100);
    expect(result.points).toEqual([20]);
    expect(result.skipped).toEqual([]);
  });
});

describe("SCALE_PROBE_COST_WARNING", () => {
  it("names the probed N, its cost, and the skipped points", () => {
    const warning = SCALE_PROBE_COST_WARNING(1, 123.4, [5, 20, 50]);
    expect(warning).toContain("1");
    expect(warning).toContain("123.4");
    expect(warning).toContain("5, 20, 50");
  });
});
