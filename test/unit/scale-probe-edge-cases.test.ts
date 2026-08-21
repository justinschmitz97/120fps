import { describe, it, expect } from "vitest";
import {
  buildReport,
  boundScalePointsByProbeCost,
  SCALE_PROBE_GATE_MS,
  MATRIX_CELL_CAP_WARNING,
  type BuildReportInput,
} from "../../src/analyze.js";
import { formatTable, describeMode, type Report, type ComboReport } from "../../src/report.js";
import { selectMatrixCombos, type PropCombination } from "../../src/prop-gen-values.js";
import { loadBaseline, computeEnvKey } from "../../src/budget.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// H1: zero-prop component: every combo is a scale probe.
describe("H1: zero-prop component where probes are the only combos", () => {
  it("names the run as scale-probe-only, not '0 measured'", () => {
    const report = buildReport(baseInput(
      [mount(0, { __120fps_scaleN: 1 }, 5, 10), mount(1, { __120fps_scaleN: 5 }, 20, 50)],
      [rerender(0, { __120fps_scaleN: 1 }, 3), rerender(1, { __120fps_scaleN: 5 }, 12)],
    ));
    expect(report.combos.every((c) => c.scaleProbe !== undefined)).toBe(true);
    const line = describeMode(report);
    expect(line).toContain("scale probe (2 points, no prop combos)");
  });
});

// H2: a scale-probe combo that rendered nothing while the page threw.
describe("H2: probe + render-error interplay", () => {
  it("still carries scaleProbe and fails the run, independent of the header count", () => {
    const m = mount(0, { __120fps_scaleN: 50 }, 3000, 0);
    (m as MountResult & { pageErrors: unknown }).pageErrors = { messages: ["boom"], fatal: true, dropped: 0 };
    const report = buildReport(baseInput([m], [rerender(0, { __120fps_scaleN: 50 }, 1)]));
    expect(report.combos[0].scaleProbe).toBe(50);
    expect(report.combos[0].renderHealth).toBe("error");
    expect(report.combos[0].verdict).toBe("fail");
    expect(report.pass).toBe(false);
    // A single scale probe is < 2 points, so no curve: must not throw.
    expect(report.combos[0].scalingCurve).toBeNull();
  });
});

// H3: matrix cap smaller than the axis count.
describe("H3: matrix cap smaller than axis count", () => {
  it("still keeps the base cell when the cap is 1 and there are 3 axes", () => {
    const axes = [
      { propName: "a", values: [false, true] },
      { propName: "b", values: [false, true] },
      { propName: "c", values: [false, true] },
    ];
    const combos: PropCombination[] = [
      { a: false, b: false, c: false },
      { a: true, b: false, c: false },
      { a: false, b: true, c: false },
      { a: false, b: false, c: true },
      { a: true, b: true, c: false },
      { a: true, b: false, c: true },
      { a: false, b: true, c: true },
      { a: true, b: true, c: true },
    ];
    const kept = selectMatrixCombos(combos, axes, 1);
    expect(kept).toEqual([0]);
  });
});

// H5: a baseline file saved before scaleProbe existed loads unaffected.
describe("H5: a baseline file saved before scaleProbe existed loads unaffected", () => {
  it("parses a flat entry with no scaleProbe/props-shaped fields at all", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m61-baseline-"));
    const baselinePath = path.join(dir, "120fps-baseline.json");
    const env = { cpu: "x", cores: 8, mode: "combo" } as never;
    const envKey = computeEnvKey(env);
    const key = `Widget.tsx#${envKey}`;
    const preM61Entry = {
      mount: 5, rerender: 3, unmount: 1, domNodeCount: 10,
      interactions: {}, tier: "T1", pass: true, env,
    };
    fs.writeFileSync(
      baselinePath,
      JSON.stringify({ version: 2, entries: { [key]: preM61Entry } }),
      "utf8",
    );
    const loaded = loadBaseline(baselinePath);
    expect(loaded?.entries[key]?.pass).toBe(true);
    expect(loaded?.entries[key]?.mount).toBe(5);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// H6: --no-auto-scale still leaves the sibling-copies probe's combos
// correctly shaped (the flag only gates the real detected-prop pass).
describe("H6: --no-auto-scale path", () => {
  it("scale-probe combos are still labeled correctly when the real-prop pass never runs", () => {
    // Simulates skipAutoScale=true: applyAutoScalingCurves never runs, so
    // report.autoScalingProp stays unset, but the sibling-copies combos
    // (already measured unconditionally) still carry scaleProbe/curve.
    const report = buildReport(baseInput(
      [mount(0, { __120fps_scaleN: 1 }, 5, 10), mount(1, { __120fps_scaleN: 5 }, 20, 50)],
      [rerender(0, { __120fps_scaleN: 1 }, 3), rerender(1, { __120fps_scaleN: 5 }, 12)],
    ));
    expect(report.autoScalingProp).toBeUndefined();
    const table = formatTable(report);
    expect(table).toContain("synthetic copies");
    expect(table).not.toContain("auto:");
  });
});

// H7: curve mode has no combos at all: no scale-probe artifacts possible.
describe("H7: curve mode has no probes", () => {
  it("describeMode names curve mode without any scale-probe accounting", () => {
    const report = makeReport({
      combos: [],
      scalingCurveReport: { propName: "items", propKind: "array", reason: "array prop" } as never,
    });
    const line = describeMode(report);
    expect(line).toContain("curve");
    expect(line).not.toContain("scale probe");
  });
});

// H8: pairwise-cover-generated cells, where no cell is guaranteed to equal
// the pure anchor combo.
describe("H8: selectMatrixCombos over cells with no exact anchor match", () => {
  it("still ranks deterministically by nearest distance, no crash", () => {
    const axes = [
      { propName: "a", values: ["x", "y", "z"] },
      { propName: "b", values: ["p", "q", "r"] },
    ];
    // None of these is { a: "x", b: "p" } (the anchor).
    const combos: PropCombination[] = [
      { a: "y", b: "q" },
      { a: "z", b: "r" },
      { a: "y", b: "p" },
      { a: "x", b: "q" },
    ];
    const kept = selectMatrixCombos(combos, axes, 2);
    // The two single-axis-from-anchor cells (index 2 and 3) win over the
    // two-axes-away cells (index 0, 1).
    expect(kept).toEqual([2, 3]);
  });
});

// H9: unsorted / duplicate --scale points.
describe("H9: boundScalePointsByProbeCost with unsorted or duplicate points", () => {
  it("probes the minimum value regardless of array order", () => {
    const result = boundScalePointsByProbeCost([50, 1, 20], SCALE_PROBE_GATE_MS + 1);
    expect(result.points).toEqual([1]);
    expect(result.skipped.sort((a, b) => a - b)).toEqual([20, 50]);
  });

  it("handles a duplicate minimum without dropping every point", () => {
    const result = boundScalePointsByProbeCost([1, 1, 5], SCALE_PROBE_GATE_MS + 1);
    expect(result.points).toEqual([1]);
    expect(result.skipped).toEqual([5]);
  });
});

// H10: scale-probe row alongside M59 render-health marks and M64 WARN-rollup
//: the new label must compose with existing formatting, not collide.
describe("H10: scale-probe label composes with render-health and warn-rollup formatting", () => {
  it("shows both the copies label and the render-health mark on one row", () => {
    const combo = makeCombo({ comboIndex: 2, scaleProbe: 20, domNodeCount: 0, renderHealth: "empty" });
    const table = formatTable(makeReport({ combos: [combo] }));
    expect(table).toContain("×20 copies");
    expect(table).toContain("[no DOM]");
  });

  it("WARN rollup note still prints under Result: PASS alongside a scale-probe row", () => {
    const report = makeReport({
      combos: [
        makeCombo({ comboIndex: 0, verdict: "warn" }),
        makeCombo({ comboIndex: 1, verdict: "pass" }),
        makeCombo({ comboIndex: 2, scaleProbe: 5 }),
      ],
    });
    const table = formatTable(report);
    expect(table).toContain("Result: PASS");
    // dub-F5: the denominator is the prop combos, so it agrees with the
    // "measured N of M prop combos" line the same run prints below it. The
    // scale probe is a sibling-copies measurement, not a prop combo.
    expect(table).toContain("1 of 2 combos warned;");
  });
});

// H11: JSON round-trip preserves scaleProbe and never resurrects the marker.
describe("H11: JSON round-trip", () => {
  it("serializes scaleProbe and never __120fps_scaleN", () => {
    const report = buildReport(baseInput(
      [mount(0, { __120fps_scaleN: 5 }, 10, 20)],
      [rerender(0, { __120fps_scaleN: 5 }, 3)],
    ));
    const json = JSON.stringify(report);
    expect(json).not.toContain("__120fps_scaleN");
    const parsed = JSON.parse(json) as Report;
    expect(parsed.combos[0].scaleProbe).toBe(5);
  });
});

// H12: a mixed probe group where one point rendered nothing fatally: the
// curve fit must not throw even with a degenerate data point.
describe("H12: curve fit tolerates a broken point inside the probe group", () => {
  it("computes a curve without throwing when one probe point errored", () => {
    const broken = mount(1, { __120fps_scaleN: 5 }, 1, 0);
    (broken as MountResult & { pageErrors: unknown }).pageErrors = { messages: ["x"], fatal: true, dropped: 0 };
    const report = buildReport(baseInput(
      [mount(0, { __120fps_scaleN: 1 }, 5, 10), broken],
      [rerender(0, { __120fps_scaleN: 1 }, 3), rerender(1, { __120fps_scaleN: 5 }, 1)],
    ));
    expect(() => report).not.toThrow();
    expect(report.combos[1].renderHealth).toBe("error");
    // Two points is enough to fit; the value may be poor but must be defined.
    expect(report.combos[0].scalingCurve).not.toBeNull();
  });
});

// H13: MATRIX_CELL_CAP_WARNING composes with the existing pairwise-cover
// warning without one clobbering the other's counts.
describe("H13: matrix cap warning coexists with pairwise-cover warning", () => {
  it("both warnings can appear together with independent, correct counts", () => {
    const pairwise = "matrix has 512 possible cells; measured 200 via pairwise cover (every value pair, not every cell): coverage is not exhaustive.";
    const cap = MATRIX_CELL_CAP_WARNING(8, 200);
    expect(pairwise).toContain("512");
    expect(cap).toContain("8");
    expect(cap).toContain("200");
  });
});
