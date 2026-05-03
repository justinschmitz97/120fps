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
import { parseArgs } from "../../src/cli.js";

// --- helpers ---

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
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: {
      cpu: "Test CPU",
      cores: 4,
      ramMb: 16384,
      os: "Linux 6.0",
      nodeVersion: "v20.0.0",
      chromiumVersion: "120.0.0.0",
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

// --- classifyTier ---

describe("classifyTier", () => {
  it("returns T1 for small component with no portals, scaling, or animations", () => {
    expect(classifyTier({ domNodeCount: 8, hasPortal: false, hasScaling: false, hasAnimation: false })).toBe("T1");
  });

  it("returns T1 at boundary: domNodeCount=12", () => {
    expect(classifyTier({ domNodeCount: 12, hasPortal: false, hasScaling: false, hasAnimation: false })).toBe("T1");
  });

  it("returns T2 for domNodeCount=13, no portals/scaling", () => {
    expect(classifyTier({ domNodeCount: 13, hasPortal: false, hasScaling: false, hasAnimation: false })).toBe("T2");
  });

  it("returns T2 at boundary: domNodeCount=40", () => {
    expect(classifyTier({ domNodeCount: 40, hasPortal: false, hasScaling: false, hasAnimation: false })).toBe("T2");
  });

  it("returns T3 when hasPortal=true (even small DOM)", () => {
    expect(classifyTier({ domNodeCount: 5, hasPortal: true, hasScaling: false, hasAnimation: false })).toBe("T3");
  });

  it("returns T3 when hasAnimation=true and domNodeCount > 40", () => {
    expect(classifyTier({ domNodeCount: 50, hasPortal: false, hasScaling: false, hasAnimation: true })).toBe("T3");
  });

  it("returns T3 for small animated component (animation always T3)", () => {
    expect(classifyTier({ domNodeCount: 5, hasPortal: false, hasScaling: false, hasAnimation: true })).toBe("T3");
  });

  it("returns T4 for domNodeCount=41, no portals", () => {
    expect(classifyTier({ domNodeCount: 41, hasPortal: false, hasScaling: false, hasAnimation: false })).toBe("T4");
  });

  it("hasScaling does not affect tier — DOM count determines tier", () => {
    expect(classifyTier({ domNodeCount: 10, hasPortal: false, hasScaling: true, hasAnimation: false })).toBe("T1");
  });

  it("returns T4 for large DOM regardless of scaling", () => {
    expect(classifyTier({ domNodeCount: 200, hasPortal: false, hasScaling: true, hasAnimation: false })).toBe("T4");
  });

  it("T3 for portal even with scaling and large DOM", () => {
    expect(classifyTier({ domNodeCount: 200, hasPortal: true, hasScaling: true, hasAnimation: false })).toBe("T3");
  });

  it("is pure: same inputs produce same tier", () => {
    const info = { domNodeCount: 25, hasPortal: false, hasScaling: false, hasAnimation: false };
    const a = classifyTier(info);
    const b = classifyTier(info);
    expect(a).toBe(b);
  });
});

// --- TIER_BUDGETS ---

describe("TIER_BUDGETS", () => {
  it("T1 budget: mount 14ms, rerender 10ms, interaction 200ms", () => {
    expect(TIER_BUDGETS.T1).toEqual({ mountMs: 14, rerenderMs: 10, interactionMs: 200 });
  });

  it("T2 budget: mount 20ms, rerender 12ms, interaction 250ms", () => {
    expect(TIER_BUDGETS.T2).toEqual({ mountMs: 20, rerenderMs: 12, interactionMs: 250 });
  });

  it("T3 budget: mount 30ms, rerender 14ms, interaction 300ms", () => {
    expect(TIER_BUDGETS.T3).toEqual({ mountMs: 30, rerenderMs: 14, interactionMs: 300 });
  });

  it("T4 budget: mount 50ms, rerender 16ms, interaction 400ms", () => {
    expect(TIER_BUDGETS.T4).toEqual({ mountMs: 50, rerenderMs: 16, interactionMs: 400 });
  });
});

// --- computeVerdict with tierBudget ---

describe("computeVerdict with tierBudget", () => {
  const flatThresholds: Thresholds = { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 };

  it("uses tier budget mount threshold when tierBudget provided", () => {
    const combo = makeCombo({
      mount: { samples: [15], median: 15, p95: 15, cv: 0, unstable: false },
      rerender: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
    });
    const verdict = computeVerdict(combo, flatThresholds, { tierBudget: TIER_BUDGETS.T1 });
    expect(verdict).toBe("fail"); // 15ms > T1 mount budget 14ms
  });

  it("passes when within tier budget", () => {
    const combo = makeCombo({
      mount: { samples: [13], median: 13, p95: 13, cv: 0, unstable: false },
      rerender: { samples: [9], median: 9, p95: 9, cv: 0, unstable: false },
    });
    const verdict = computeVerdict(combo, flatThresholds, { tierBudget: TIER_BUDGETS.T1 });
    expect(verdict).toBe("pass");
  });

  it("uses tier rerender threshold", () => {
    const combo = makeCombo({
      mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
      rerender: { samples: [11], median: 11, p95: 11, cv: 0, unstable: false },
    });
    const verdict = computeVerdict(combo, flatThresholds, { tierBudget: TIER_BUDGETS.T1 });
    expect(verdict).toBe("fail"); // 11ms > T1 rerender budget 10ms
  });

  it("uses tier interaction threshold", () => {
    const combo = makeCombo({
      mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
      rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
      interactions: [{
        selector: "button",
        type: "click",
        label: "btn",
        timing: { samples: [210], median: 210, p95: 210, cv: 0, unstable: false },
        relativeTiming: 1.0,
      }],
    });
    const verdict = computeVerdict(combo, flatThresholds, { tierBudget: TIER_BUDGETS.T1 });
    expect(verdict).toBe("fail"); // 210ms > T1 interaction budget 200ms
  });

  it("relativeMount threshold unchanged by tier budget", () => {
    const combo = makeCombo({
      mount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
      rerender: { samples: [0.5], median: 0.5, p95: 0.5, cv: 0, unstable: false },
      relativeMount: 3.0,
    });
    const verdict = computeVerdict(combo, flatThresholds, { tierBudget: TIER_BUDGETS.T1 });
    expect(verdict).toBe("fail"); // relativeMount 3.0 > 2.0 threshold
  });

  it("without tierBudget, uses flat thresholds (backward compat)", () => {
    const combo = makeCombo({
      mount: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
      rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
    });
    const verdict = computeVerdict(combo, flatThresholds);
    expect(verdict).toBe("pass"); // 3ms < flat 16ms
  });
});

// --- formatTable with tier ---

describe("formatTable with tier", () => {
  it("shows tier in verdict column when tier is set", () => {
    const combo = makeCombo({ tier: "T1" as ComponentTier, verdict: "pass" });
    const r = makeReport({ combos: [combo], tieredBudgets: true });
    const output = formatTable(r);
    expect(output).toContain("PASS (T1)");
  });

  it("shows FAIL (T4) for failing heavy combo", () => {
    const combo = makeCombo({
      tier: "T4" as ComponentTier,
      verdict: "fail",
      mount: { samples: [20], median: 20, p95: 20, cv: 0, unstable: false },
    });
    const r = makeReport({ combos: [combo], pass: false, tieredBudgets: true });
    const output = formatTable(r);
    expect(output).toContain("FAIL (T4)");
  });

  it("shows WARN (T2) for unstable composite combo", () => {
    const combo = makeCombo({
      tier: "T2" as ComponentTier,
      verdict: "warn",
      mount: { samples: [2], median: 2, p95: 2, cv: 20, unstable: true },
      domNodeCount: 20,
    });
    const r = makeReport({ combos: [combo], tieredBudgets: true });
    const output = formatTable(r);
    expect(output).toContain("WARN (T2)");
  });

  it("does not show tier when tier is undefined (flat thresholds)", () => {
    const combo = makeCombo({ verdict: "pass" });
    const r = makeReport({ combos: [combo] });
    const output = formatTable(r);
    expect(output).toContain("PASS");
    expect(output).not.toMatch(/PASS\s*\(T\d\)/);
  });
});

// --- parseArgs --flat-thresholds ---

describe("parseArgs --flat-thresholds", () => {
  it("parses --flat-thresholds flag", () => {
    const result = parseArgs(["./Button.tsx", "--flat-thresholds"]);
    expect(result.flatThresholds).toBe(true);
  });

  it("defaults flatThresholds to undefined when not specified", () => {
    const result = parseArgs(["./Button.tsx"]);
    expect(result.flatThresholds).toBeUndefined();
  });

  it("--flat-thresholds coexists with --threshold-mount", () => {
    const result = parseArgs(["./Button.tsx", "--flat-thresholds", "--threshold-mount", "20"]);
    expect(result.flatThresholds).toBe(true);
    expect(result.thresholdMount).toBe(20);
  });
});

// --- buildReport with tiered budgets ---

describe("buildReport with tiered budgets", () => {
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

  it("sets tier on each combo when tiered budgets active (default)", () => {
    const report = buildReport(makeInput());
    expect(report.combos[0].tier).toBe("T1");
  });

  it("sets tieredBudgets=true on report by default", () => {
    const report = buildReport(makeInput());
    expect(report.tieredBudgets).toBe(true);
  });

  it("classifies T3 when interaction has portal flag", () => {
    const graph = {
      nodes: new Map([["abc", { id: "abc", depth: 0, interactions: [], pathFromRoot: [] }]]),
      edges: [{
        id: "e1",
        fromId: "abc",
        toId: "def",
        interaction: { type: "click" as const, selector: "button", tagName: "BUTTON", label: "Open", portal: true },
        samples: [5],
        median: 5,
        p95: 5,
        traces: [],
      }],
      initialNodeId: "abc",
      wallClockMs: 100,
    };
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [4], median: 4, p95: 4 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
      }],
      explores: [{ graph, comboIndex: 0, props: {} }],
    }));
    expect(report.combos[0].tier).toBe("T3");
  });

  it("classifies per-combo tier based on DOM count, not scaling", () => {
    const report = buildReport(makeInput({
      mounts: [
        { comboIndex: 0, props: {}, mount: { samples: [5], median: 5, p95: 5 }, unmount: { samples: [1], median: 1, p95: 1 }, domNodeCount: 10 },
        { comboIndex: 1, props: {}, mount: { samples: [25], median: 25, p95: 25 }, unmount: { samples: [1], median: 1, p95: 1 }, domNodeCount: 50 },
      ],
      explores: [],
      heapDeltas: [0, 0],
      thresholds: { ...DEFAULT_THRESHOLDS, mountMs: 100 },
    }));
    expect(report.combos[0].tier).toBe("T1");
    expect(report.combos[1].tier).toBe("T4");
  });

  it("omits tier when flatThresholds=true", () => {
    const report = buildReport(makeInput({ flatThresholds: true }));
    expect(report.combos[0].tier).toBeUndefined();
    expect(report.tieredBudgets).toBeUndefined();
  });

  it("applies tighter T1 budget: mount 14ms fails for 15ms", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [15], median: 15, p95: 15 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
      }],
    }));
    expect(report.combos[0].tier).toBe("T1");
    expect(report.combos[0].verdict).toBe("fail");
  });

  it("explicit threshold overrides tier budget for that metric only", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [2.5], median: 2.5, p95: 2.5 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
      }],
      explicitThresholds: { mountMs: true },
      thresholds: { ...DEFAULT_THRESHOLDS, mountMs: 5 },
    }));
    expect(report.combos[0].tier).toBe("T1");
    expect(report.combos[0].verdict).toBe("pass"); // 2.5ms < explicit 5ms
  });
});
