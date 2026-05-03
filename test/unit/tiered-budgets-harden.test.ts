import { describe, it, expect } from "vitest";
import {
  classifyTier,
  TIER_BUDGETS,
  computeVerdict,
  formatTable,
  DEFAULT_THRESHOLDS,
  type ComponentTier,
  type TierBudget,
  type ComboReport,
  type Report,
  type Thresholds,
} from "../../src/report.js";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";

function makeCombo(overrides: Partial<ComboReport> = {}): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
    unmount: { samples: [0.5], median: 0.5, p95: 0.5, cv: 0, unstable: false },
    rerender: { samples: [0.5], median: 0.5, p95: 0.5, cv: 0, unstable: false },
    domNodeCount: 8,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 0.1,
    verdict: "pass",
    ...overrides,
  };
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: {
      cpu: "Test CPU", cores: 4, ramMb: 16384,
      os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
    },
    componentPath: "./Button.tsx",
    componentName: "Button",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [makeCombo()],
    thresholds: DEFAULT_THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

const baseMachine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};

// H1: domNodeCount=0
describe("H1: classifyTier with domNodeCount=0", () => {
  it("classifies as T1", () => {
    expect(classifyTier({ domNodeCount: 0, hasPortal: false, hasScaling: false, hasAnimation: false })).toBe("T1");
  });
});

// H2: domNodeCount=1
describe("H2: classifyTier with domNodeCount=1", () => {
  it("classifies as T1", () => {
    expect(classifyTier({ domNodeCount: 1, hasPortal: false, hasScaling: false, hasAnimation: false })).toBe("T1");
  });
});

// H3: exact boundaries
describe("H3: exact tier boundaries", () => {
  it("domNodeCount=12 is T1", () => {
    expect(classifyTier({ domNodeCount: 12, hasPortal: false, hasScaling: false, hasAnimation: false })).toBe("T1");
  });
  it("domNodeCount=13 is T2", () => {
    expect(classifyTier({ domNodeCount: 13, hasPortal: false, hasScaling: false, hasAnimation: false })).toBe("T2");
  });
  it("domNodeCount=40 is T2", () => {
    expect(classifyTier({ domNodeCount: 40, hasPortal: false, hasScaling: false, hasAnimation: false })).toBe("T2");
  });
  it("domNodeCount=41 is T4", () => {
    expect(classifyTier({ domNodeCount: 41, hasPortal: false, hasScaling: false, hasAnimation: false })).toBe("T4");
  });
});

// H4: all flags true
describe("H4: portal + animation + scaling all true", () => {
  it("portal takes T3 priority over scaling T4", () => {
    expect(classifyTier({ domNodeCount: 200, hasPortal: true, hasScaling: true, hasAnimation: true })).toBe("T3");
  });
});

// H5: rerenderChange exceeds tier budget
describe("H5: computeVerdict with rerenderChange exceeding tier budget", () => {
  it("fails when rerenderChange exceeds tier rerender budget", () => {
    const combo = makeCombo({
      rerenderChange: { samples: [11], median: 11, p95: 11, cv: 0, unstable: false },
    });
    const verdict = computeVerdict(combo, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 });
    expect(verdict).toBe("fail"); // 11ms > T1 rerender 10ms
  });
});

// H6: timing equals budget exactly
describe("H6: timing at exact budget boundary", () => {
  it("mount exactly at T1 budget (14ms) passes", () => {
    const combo = makeCombo({
      mount: { samples: [14], median: 14, p95: 14, cv: 0, unstable: false },
      rerender: { samples: [9], median: 9, p95: 9, cv: 0, unstable: false },
    });
    const verdict = computeVerdict(combo, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 });
    expect(verdict).toBe("pass"); // 14 is not > 14
  });

  it("mount 14.001ms exceeds T1 budget", () => {
    const combo = makeCombo({
      mount: { samples: [14.001], median: 14.001, p95: 14.001, cv: 0, unstable: false },
      rerender: { samples: [9], median: 9, p95: 9, cv: 0, unstable: false },
    });
    const verdict = computeVerdict(combo, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 });
    expect(verdict).toBe("fail");
  });
});

// H7: --flat-thresholds with other flags
describe("H7: --flat-thresholds with --no-deltas and --no-auto-scale", () => {
  it("all flags parsed together", () => {
    const result = parseArgs(["./Button.tsx", "--flat-thresholds", "--no-deltas", "--no-auto-scale"]);
    expect(result.flatThresholds).toBe(true);
    expect(result.noDeltas).toBe(true);
    expect(result.noAutoScale).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// H8: multiple combos with different tiers in formatTable
describe("H8: formatTable with multiple tiers", () => {
  it("shows different tiers for different combos", () => {
    const r = makeReport({
      combos: [
        makeCombo({ comboIndex: 0, tier: "T1" as ComponentTier, verdict: "pass", domNodeCount: 5 }),
        makeCombo({ comboIndex: 1, tier: "T4" as ComponentTier, verdict: "warn", domNodeCount: 80 }),
      ],
      tieredBudgets: true,
    });
    const output = formatTable(r);
    expect(output).toContain("PASS (T1)");
    expect(output).toContain("WARN (T4)");
  });
});

// H9: buildReport with empty mounts and tiered budgets
describe("H9: buildReport with 0 combos", () => {
  it("produces pass=true, tieredBudgets=true", () => {
    const report = buildReport({
      componentPath: "./Empty.tsx",
      componentName: "Empty",
      machine: baseMachine,
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [],
      explores: [],
      heapDeltas: [],
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(report.combos).toHaveLength(0);
    expect(report.pass).toBe(true);
    expect(report.tieredBudgets).toBe(true);
  });
});

// H10: scaling curve + explicit mount override
describe("H10: scaling T4 with explicit mount override", () => {
  it("uses explicit mount but tier rerender budget", () => {
    const report = buildReport({
      componentPath: "./List.tsx",
      componentName: "List",
      machine: baseMachine,
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [
        { comboIndex: 0, props: {}, mount: { samples: [1.5], median: 1.5, p95: 1.5 }, unmount: { samples: [0.5], median: 0.5, p95: 0.5 }, domNodeCount: 10 },
        { comboIndex: 1, props: {}, mount: { samples: [10], median: 10, p95: 10 }, unmount: { samples: [0.5], median: 0.5, p95: 0.5 }, domNodeCount: 50 },
      ],
      explores: [],
      heapDeltas: [0, 0],
      thresholds: { ...DEFAULT_THRESHOLDS, mountMs: 20 },
      explicitThresholds: { mountMs: true },
    });
    // Tier per-combo based on DOM count
    expect(report.combos[0].tier).toBe("T1");
    expect(report.combos[1].tier).toBe("T4");
    // mount 10ms < explicit 20ms → passes mount check
    // Rerender uses T4 budget (16ms), default rerender [0] median 0 → passes
    expect(report.combos[1].verdict).toBe("pass");
  });
});

// H11: JSON serialization includes tier fields
describe("H11: JSON serialization of tier fields", () => {
  it("tier and tieredBudgets appear in serialized report", () => {
    const report = buildReport({
      componentPath: "./Badge.tsx",
      componentName: "Badge",
      machine: baseMachine,
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 5,
      }],
      explores: [],
      heapDeltas: [0],
      thresholds: DEFAULT_THRESHOLDS,
    });
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json);
    expect(parsed.tieredBudgets).toBe(true);
    expect(parsed.combos[0].tier).toBe("T1");
  });
});

// H12: negative domNodeCount
describe("H12: classifyTier with negative domNodeCount", () => {
  it("returns T1 (≤12 check passes)", () => {
    expect(classifyTier({ domNodeCount: -1, hasPortal: false, hasScaling: false, hasAnimation: false })).toBe("T1");
  });
});

// H13: explicit rerender override + tier mount budget
describe("H13: partial override — explicit rerender, tier mount", () => {
  it("uses tier mount but explicit rerender", () => {
    const report = buildReport({
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [9], median: 9, p95: 9 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 8,
      }],
      explores: [],
      heapDeltas: [0],
      thresholds: { ...DEFAULT_THRESHOLDS, rerenderMs: 10 },
      explicitThresholds: { rerenderMs: true },
    });
    // T1 mount budget = 14ms, mount = 9ms → pass (within tier mount)
    expect(report.combos[0].tier).toBe("T1");
    expect(report.combos[0].verdict).toBe("pass");
  });
});

// H14: TIER_BUDGETS values not accidentally mutated
describe("H14: TIER_BUDGETS immutability", () => {
  it("T1 budget values remain unchanged after verdict computation", () => {
    const combo = makeCombo({
      mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
    });
    computeVerdict(combo, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T1 });
    expect(TIER_BUDGETS.T1.mountMs).toBe(14);
    expect(TIER_BUDGETS.T1.rerenderMs).toBe(10);
    expect(TIER_BUDGETS.T1.interactionMs).toBe(200);
  });
});

// H15: interaction at exact T2 boundary
describe("H15: interaction at exact T2 budget (250ms) passes", () => {
  it("250ms interaction passes T2", () => {
    const combo = makeCombo({
      mount: { samples: [10], median: 10, p95: 10, cv: 0, unstable: false },
      rerender: { samples: [4], median: 4, p95: 4, cv: 0, unstable: false },
      domNodeCount: 20,
      interactions: [{
        selector: "button",
        type: "click",
        label: "btn",
        timing: { samples: [250], median: 250, p95: 250, cv: 0, unstable: false },
        relativeTiming: 1.0,
      }],
    });
    const verdict = computeVerdict(combo, DEFAULT_THRESHOLDS, { tierBudget: TIER_BUDGETS.T2 });
    expect(verdict).toBe("pass"); // 250 is not > 250
  });
});

import { parseArgs } from "../../src/cli.js";
