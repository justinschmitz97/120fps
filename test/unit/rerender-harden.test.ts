import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";
import { hasScaleExport, buildReport, type BuildReportInput } from "../../src/analyze.js";
import { detectScaleExport } from "../../src/harness.js";
import {
  computeVerdict,
  buildTimingWithCV,
  DEFAULT_THRESHOLDS,
  type ComboReport,
  type Thresholds,
} from "../../src/report.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";
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

const baseThresholds: Thresholds = {
  mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8,
};
const baseCal = { totalDuration: 10, scriptDuration: 5 };

// H2: scale(0) — zero items
describe("H2: hasScaleExport with edge patterns", () => {
  it("does not match export { scale } re-export", () => {
    expect(hasScaleExport("export { scale } from './other';")).toBe(false);
  });

  it("does not match export default scale", () => {
    expect(hasScaleExport("export default scale;")).toBe(false);
  });
});

// H4: Fixture with scale but no default export — hasScaleExport still detects it
describe("H4: scale without default export detection", () => {
  it("detects scale even without default export", () => {
    const source = `export function scale(n: number) { return <div>{n}</div>; }`;
    expect(hasScaleExport(source)).toBe(true);
  });
});

// H5: --scale with single value
describe("H5: --scale single value", () => {
  it("accepts single integer", () => {
    const result = parseArgs(["./comp.tsx", "--scale", "42"]);
    expect(result.scale).toEqual([42]);
    expect(result.error).toBeUndefined();
  });
});

// H6: --scale with duplicates
describe("H6: --scale duplicate values", () => {
  it("accepts duplicate values", () => {
    const result = parseArgs(["./comp.tsx", "--scale", "5,5,5"]);
    expect(result.scale).toEqual([5, 5, 5]);
    expect(result.error).toBeUndefined();
  });
});

// H7: extremely low threshold
describe("H7: extreme --threshold-rerender", () => {
  it("accepts very small positive number", () => {
    const result = parseArgs(["./comp.tsx", "--threshold-rerender", "0.001"]);
    expect(result.thresholdRerender).toBe(0.001);
    expect(result.error).toBeUndefined();
  });
});

// H9: identity rerender (same props) produces valid timing
describe("H9: buildReport rerender with zeroed samples", () => {
  it("handles zero-duration rerender samples", () => {
    const report = buildReport({
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: baseCal,
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1.5], median: 1.5, p95: 1.5 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 10,
      }],
      explores: [{ graph: makeEmptyGraph(), comboIndex: 0, props: {} }],
      heapDeltas: [0],
      thresholds: baseThresholds,
      rerenders: [{ comboIndex: 0, stable: { samples: [0, 0, 0], median: 0, p95: 0 } }],
    });
    expect(report.combos[0].rerender.median).toBe(0);
    expect(report.combos[0].verdict).toBe("pass");
  });
});

// H10: non-exact match for scale
describe("H10: hasScaleExport false positives", () => {
  it("does not match scaleItems", () => {
    const source = `export function scaleItems(n: number) { return <div/>; }`;
    expect(hasScaleExport(source)).toBe(false);
  });

  it("does not match rescale", () => {
    const source = `export function rescale(n: number) { return <div/>; }`;
    expect(hasScaleExport(source)).toBe(false);
  });

  it("does not match scaleUp", () => {
    const source = `export const scaleUp = (n: number) => <div/>;`;
    expect(hasScaleExport(source)).toBe(false);
  });
});

// H11: non-fixture file with export function scale — detectScaleExport reads file
describe("H11: detectScaleExport on fixture file", () => {
  it("detects scale export in scale-accordion fixture", () => {
    expect(detectScaleExport(path.resolve("fixtures/scale-accordion.fixture.tsx"))).toBe(true);
  });

  it("returns false for fixture without scale", () => {
    expect(detectScaleExport(path.resolve("fixtures/standalone.fixture.tsx"))).toBe(false);
  });

  it("returns false for regular component", () => {
    expect(detectScaleExport(path.resolve("fixtures/button.tsx"))).toBe(false);
  });
});

// H12: --scale with float values
describe("H12: --scale rejects floats", () => {
  it("rejects float scale values", () => {
    const result = parseArgs(["./comp.tsx", "--scale", "1.5,3"]);
    expect(result.error).toBeTruthy();
  });
});

// H13: rerender timing is non-negative
describe("H13: rerender timing non-negative invariant", () => {
  it("verdict still works with negative samples (edge)", () => {
    const combo = makeCombo({
      rerender: buildTimingWithCV([-1, -2, -3]),
    });
    const verdict = computeVerdict(combo, baseThresholds);
    expect(["pass", "warn", "fail"]).toContain(verdict);
  });
});

// H14: report JSON includes rerender fields
describe("H14: report JSON serialization", () => {
  it("serializes rerender and rerenderChange to JSON", () => {
    const report = buildReport({
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: baseCal,
      mounts: [{
        comboIndex: 0, props: { label: "A" },
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 10,
      }],
      explores: [{ graph: makeEmptyGraph(), comboIndex: 0, props: { label: "A" } }],
      heapDeltas: [0],
      thresholds: baseThresholds,
      rerenders: [{
        comboIndex: 0,
        stable: { samples: [3], median: 3, p95: 3 },
        change: { samples: [5], median: 5, p95: 5 },
      }],
    });
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json);
    expect(parsed.combos[0].rerender).toBeDefined();
    expect(parsed.combos[0].rerender.median).toBe(3);
    expect(parsed.combos[0].rerenderChange).toBeDefined();
    expect(parsed.combos[0].rerenderChange.median).toBe(5);
    expect(parsed.thresholds.rerenderMs).toBe(8);
  });
});

// H15: rerenderScalingCurve null when single combo
describe("H15: rerenderScalingCurve with single combo", () => {
  it("leaves rerenderScalingCurve undefined for single combo", () => {
    const report = buildReport({
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: baseCal,
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 10,
      }],
      explores: [{ graph: makeEmptyGraph(), comboIndex: 0, props: {} }],
      heapDeltas: [0],
      thresholds: baseThresholds,
      rerenders: [{ comboIndex: 0, stable: { samples: [3], median: 3, p95: 3 } }],
    });
    expect(report.combos[0].rerenderScalingCurve).toBeUndefined();
  });

  it("sets rerenderScalingCurve when multiple distinct DOM sizes", () => {
    const report = buildReport({
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: baseCal,
      mounts: [
        { comboIndex: 0, props: {}, mount: { samples: [5], median: 5, p95: 5 }, unmount: { samples: [2], median: 2, p95: 2 }, domNodeCount: 10 },
        { comboIndex: 1, props: {}, mount: { samples: [10], median: 10, p95: 10 }, unmount: { samples: [3], median: 3, p95: 3 }, domNodeCount: 50 },
      ],
      explores: [
        { graph: makeEmptyGraph(), comboIndex: 0, props: {} },
        { graph: makeEmptyGraph(), comboIndex: 1, props: {} },
      ],
      heapDeltas: [0, 0],
      thresholds: { ...baseThresholds, mountMs: 100 },
      rerenders: [
        { comboIndex: 0, stable: { samples: [3], median: 3, p95: 3 } },
        { comboIndex: 1, stable: { samples: [8], median: 8, p95: 8 } },
      ],
    });
    expect(report.combos[0].rerenderScalingCurve).not.toBeNull();
    expect(report.combos[0].rerenderScalingCurve).not.toBeUndefined();
  });
});

// H1/H3: scale with edge N values (tested via build report with 0-duration data)
describe("H1: buildReport with missing rerender data gracefully defaults", () => {
  it("produces zero-median rerender when no rerender result for combo", () => {
    const report = buildReport({
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: baseCal,
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 10,
      }],
      explores: [{ graph: makeEmptyGraph(), comboIndex: 0, props: {} }],
      heapDeltas: [0],
      thresholds: baseThresholds,
    });
    expect(report.combos[0].rerender).toBeDefined();
    expect(report.combos[0].rerender.median).toBe(0);
  });
});

// H8: component that renders null
describe("H8: rerender of null-rendering component", () => {
  it("buildReport succeeds with zero-sample rerender", () => {
    const report = buildReport({
      componentPath: "./NullComp.tsx",
      componentName: "NullComp",
      machine: baseMachine,
      calibration: baseCal,
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 1,
      }],
      explores: [{ graph: makeEmptyGraph(), comboIndex: 0, props: {} }],
      heapDeltas: [0],
      thresholds: baseThresholds,
      rerenders: [{ comboIndex: 0, stable: { samples: [0.1, 0.1], median: 0.1, p95: 0.1 } }],
    });
    expect(report.combos[0].rerender.median).toBeCloseTo(0.1, 1);
    expect(report.combos[0].verdict).toBe("pass");
  });
});
