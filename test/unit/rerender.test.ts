import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";
import {
  computeVerdict,
  buildTimingWithCV,
  formatTable,
  DEFAULT_THRESHOLDS,
  type ComboReport,
  type Report,
  type Thresholds,
} from "../../src/report.js";
import { buildReport, hasScaleExport, type BuildReportInput } from "../../src/analyze.js";
import type { MountResult } from "../../src/measure.js";
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

// --- CLI: --scale ---

describe("parseArgs --scale", () => {
  it("parses --scale with comma-separated integers", () => {
    const result = parseArgs(["./comp.tsx", "--scale", "1,10,100"]);
    expect(result.scale).toEqual([1, 10, 100]);
  });

  it("parses single scale value", () => {
    const result = parseArgs(["./comp.tsx", "--scale", "5"]);
    expect(result.scale).toEqual([5]);
  });

  it("returns error when --scale has no value", () => {
    const result = parseArgs(["./comp.tsx", "--scale"]);
    expect(result.error).toBeTruthy();
  });

  it("returns error for non-numeric --scale values", () => {
    const result = parseArgs(["./comp.tsx", "--scale", "a,b,c"]);
    expect(result.error).toBeTruthy();
  });

  it("returns error for zero or negative scale values", () => {
    const result = parseArgs(["./comp.tsx", "--scale", "0,5,10"]);
    expect(result.error).toBeTruthy();
  });

  it("combines with other flags", () => {
    const result = parseArgs([
      "./comp.tsx",
      "--scale", "1,10,100",
      "--samples", "5",
      "--ci",
    ]);
    expect(result.scale).toEqual([1, 10, 100]);
    expect(result.samples).toBe(5);
    expect(result.ci).toBe(true);
  });
});

// --- CLI: --threshold-rerender ---

describe("parseArgs --threshold-rerender", () => {
  it("parses --threshold-rerender with number", () => {
    const result = parseArgs(["./comp.tsx", "--threshold-rerender", "4"]);
    expect(result.thresholdRerender).toBe(4);
  });

  it("returns error when --threshold-rerender has no value", () => {
    const result = parseArgs(["./comp.tsx", "--threshold-rerender"]);
    expect(result.error).toBeTruthy();
  });

  it("returns error for non-positive --threshold-rerender", () => {
    const result = parseArgs(["./comp.tsx", "--threshold-rerender", "0"]);
    expect(result.error).toBeTruthy();
  });

  it("returns error for non-numeric --threshold-rerender", () => {
    const result = parseArgs(["./comp.tsx", "--threshold-rerender", "abc"]);
    expect(result.error).toBeTruthy();
  });
});

// --- Thresholds ---

describe("DEFAULT_THRESHOLDS includes rerenderMs", () => {
  it("has rerenderMs of 16", () => {
    expect(DEFAULT_THRESHOLDS.rerenderMs).toBe(16);
  });
});

// --- Verdict with rerender ---

describe("computeVerdict with rerender", () => {
  const thresholds: Thresholds = {
    mountMs: 16,
    interactionMs: 100,
    relativeMount: 2.0,
    rerenderMs: 8,
  };

  it("returns fail when stable rerender exceeds threshold", () => {
    const combo = makeCombo({
      rerender: { samples: [10], median: 10, p95: 10, cv: 0, unstable: false },
    });
    expect(computeVerdict(combo, thresholds)).toBe("fail");
  });

  it("returns fail when rerenderChange exceeds 1.5x threshold", () => {
    const combo = makeCombo({
      rerenderChange: { samples: [13], median: 13, p95: 13, cv: 0, unstable: false },
    });
    expect(computeVerdict(combo, thresholds)).toBe("fail");
  });

  it("returns warn when rerender is unstable but within threshold", () => {
    const combo = makeCombo({
      rerender: { samples: [3], median: 3, p95: 3, cv: 20, unstable: true },
    });
    expect(computeVerdict(combo, thresholds)).toBe("warn");
  });

  it("returns pass when rerender is within threshold and stable", () => {
    const combo = makeCombo({
      rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
    });
    expect(computeVerdict(combo, thresholds)).toBe("pass");
  });
});

// --- Report types ---

describe("buildReport with rerender", () => {
  const baseThresholds: Thresholds = {
    mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8,
  };
  const baseCal = { totalDuration: 10, scriptDuration: 5 };

  it("includes rerender timing in combo report", () => {
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
      rerenders: [{ comboIndex: 0, stable: { samples: [3, 3, 3], median: 3, p95: 3 } }],
    });

    expect(report.combos[0].rerender).toBeDefined();
    expect(report.combos[0].rerender.median).toBe(3);
  });

  it("includes rerenderChange when provided", () => {
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
        stable: { samples: [3, 3, 3], median: 3, p95: 3 },
        change: { samples: [5, 5, 5], median: 5, p95: 5 },
      }],
    });

    expect(report.combos[0].rerenderChange).toBeDefined();
    expect(report.combos[0].rerenderChange!.median).toBe(5);
  });

  it("includes rerenderMs in thresholds", () => {
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

    expect(report.thresholds.rerenderMs).toBe(8);
  });

  it("computes rerender scaling curve across scale combos", () => {
    const report = buildReport({
      componentPath: "./accordion.fixture.tsx",
      componentName: "AccordionScene",
      machine: baseMachine,
      calibration: baseCal,
      mounts: [
        { comboIndex: 0, props: {}, mount: { samples: [5], median: 5, p95: 5 }, unmount: { samples: [2], median: 2, p95: 2 }, domNodeCount: 10 },
        { comboIndex: 1, props: {}, mount: { samples: [10], median: 10, p95: 10 }, unmount: { samples: [3], median: 3, p95: 3 }, domNodeCount: 50 },
        { comboIndex: 2, props: {}, mount: { samples: [15], median: 15, p95: 15 }, unmount: { samples: [4], median: 4, p95: 4 }, domNodeCount: 100 },
      ],
      explores: [
        { graph: makeEmptyGraph(), comboIndex: 0, props: {} },
        { graph: makeEmptyGraph(), comboIndex: 1, props: {} },
        { graph: makeEmptyGraph(), comboIndex: 2, props: {} },
      ],
      heapDeltas: [0, 0, 0],
      thresholds: { mountMs: 100, interactionMs: 100, relativeMount: 20.0, rerenderMs: 100 },
      rerenders: [
        { comboIndex: 0, stable: { samples: [3], median: 3, p95: 3 } },
        { comboIndex: 1, stable: { samples: [8], median: 8, p95: 8 } },
        { comboIndex: 2, stable: { samples: [15], median: 15, p95: 15 } },
      ],
    });

    expect(report.combos[0].rerenderScalingCurve).not.toBeNull();
  });
});

// --- formatTable with rerender ---

describe("formatTable with rerender", () => {
  it("includes Rerender column in table header", () => {
    const report: Report = {
      version: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      machine: baseMachine,
      componentPath: "./Button.tsx",
      componentName: "Button",
      calibration: { totalDuration: 10, scriptDuration: 5 },
      combos: [makeCombo()],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
      pass: true,
    };
    const table = formatTable(report);
    expect(table).toContain("Rerender");
  });
});

// --- hasScaleExport ---

describe("hasScaleExport", () => {
  it("detects export function scale", () => {
    const source = `
export default function Scene() { return <div />; }
export function scale(n: number) { return <div>{n}</div>; }
`;
    expect(hasScaleExport(source)).toBe(true);
  });

  it("detects export const scale", () => {
    const source = `
export default function Scene() { return <div />; }
export const scale = (n: number) => <div>{n}</div>;
`;
    expect(hasScaleExport(source)).toBe(true);
  });

  it("returns false when no scale export", () => {
    const source = `
export default function Scene() { return <div />; }
`;
    expect(hasScaleExport(source)).toBe(false);
  });

  it("returns false for non-exported scale function", () => {
    const source = `
function scale(n: number) { return <div>{n}</div>; }
export default function Scene() { return scale(3); }
`;
    expect(hasScaleExport(source)).toBe(false);
  });
});
