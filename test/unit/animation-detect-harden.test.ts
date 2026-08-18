import { describe, it, expect } from "vitest";
import {
  classifyTier,
  DEFAULT_THRESHOLDS,
} from "../../src/report.js";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";

// --- helpers ---

const baseMachine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};

function makeInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    componentPath: "./Button.tsx",
    componentName: "Button",
    machine: baseMachine,
    calibration: { totalDuration: 10, scriptDuration: 5 },
    mounts: [{
      comboIndex: 0,
      props: {},
      mount: { samples: [1.5], median: 1.5, p95: 1.5 },
      unmount: { samples: [1], median: 1, p95: 1 },
      domNodeCount: 8,
    }],
    explores: [],
    heapDeltas: [0],
    thresholds: DEFAULT_THRESHOLDS,
    ...overrides,
  };
}

// --- H13: hasAnimation + hasPortal on a large DOM ---
describe("H13: animation + portal floor", () => {
  it("keeps the size tier when it is already above the T3 floor", () => {
    const graph = {
      nodes: new Map([["n1", { id: "n1", depth: 0, interactions: [], pathFromRoot: [] }]]),
      edges: [{
        id: "e1", fromId: "n1", toId: "n2",
        interaction: { type: "click" as const, selector: "button", tagName: "BUTTON", label: "Open", portal: true },
        samples: [5], median: 5, p95: 5, traces: [],
      }],
      initialNodeId: "n1",
      wallClockMs: 100,
    };
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 50, hasAnimation: true,
      }],
      explores: [{ graph, comboIndex: 0, props: {} }],
    }));
    expect(report.combos[0].tier).toBe("T4");
    expect(report.combos[0].hasAnimation).toBe(true);
  });
});

// --- H14: hasAnimation + hasScaling interaction ---
describe("H14: animation + scaling tier interaction", () => {
  it("animation=true + scaling=true, 30 DOM → T3 (floor lifts T2 to T3)", () => {
    expect(classifyTier({ domNodeCount: 30, hasPortal: false, hasScaling: true, hasAnimation: true })).toBe("T3");
  });

  it("animation=false + scaling=true, 30 DOM → T2 (scaling ignored, DOM determines tier)", () => {
    expect(classifyTier({ domNodeCount: 30, hasPortal: false, hasScaling: true, hasAnimation: false })).toBe("T2");
  });

  it("animation=true + scaling=false on large DOM → T4 (floor already cleared)", () => {
    expect(classifyTier({ domNodeCount: 50, hasPortal: false, hasScaling: false, hasAnimation: true })).toBe("T4");
  });
});

// --- H17: JSON roundtrip preserves hasAnimation ---
describe("H17: JSON roundtrip", () => {
  it("hasAnimation survives JSON.stringify/parse", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 8, hasAnimation: true,
      }],
    }));
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.combos[0].hasAnimation).toBe(true);
    expect(parsed.combos[0].tier).toBe("T3");
  });
});

// --- H20: hasAnimation on all combos when tieredBudgets active ---
describe("H20: hasAnimation field present on all combos", () => {
  it("every combo has hasAnimation set when tiered budgets active", () => {
    const report = buildReport(makeInput({
      mounts: [
        {
          comboIndex: 0, props: { a: 1 },
          mount: { samples: [1], median: 1, p95: 1 },
          unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
          domNodeCount: 8, hasAnimation: false,
        },
        {
          comboIndex: 1, props: { a: 2 },
          mount: { samples: [1], median: 1, p95: 1 },
          unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
          domNodeCount: 8, hasAnimation: true,
        },
        {
          comboIndex: 2, props: { a: 3 },
          mount: { samples: [1], median: 1, p95: 1 },
          unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
          domNodeCount: 8,
        },
      ],
      heapDeltas: [0, 0, 0],
    }));
    expect(report.combos).toHaveLength(3);
    expect(report.combos[0].hasAnimation).toBe(false);
    expect(report.combos[1].hasAnimation).toBe(true);
    expect(report.combos[2].hasAnimation).toBe(false);
    for (const combo of report.combos) {
      expect(combo.tier).toBeDefined();
      expect(typeof combo.hasAnimation).toBe("boolean");
    }
  });

  it("flatThresholds → hasAnimation undefined on all combos", () => {
    const report = buildReport(makeInput({
      flatThresholds: true,
      mounts: [
        {
          comboIndex: 0, props: {},
          mount: { samples: [1], median: 1, p95: 1 },
          unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
          domNodeCount: 8, hasAnimation: true,
        },
      ],
    }));
    expect(report.combos[0].hasAnimation).toBeUndefined();
    expect(report.combos[0].tier).toBeUndefined();
  });
});
