import { describe, it, expect } from "vitest";
import {
  classifyTier,
  formatTable,
  DEFAULT_THRESHOLDS,
  TIER_BUDGETS,
  type ComboReport,
  type Report,
} from "../../src/report.js";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";
import { detectAnimations } from "../../src/measure.js";

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

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: baseMachine,
    componentPath: "./Button.tsx",
    componentName: "Button",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [makeCombo()],
    thresholds: DEFAULT_THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

// --- detectAnimations export ---

describe("detectAnimations export", () => {
  it("is exported as a function", () => {
    expect(typeof detectAnimations).toBe("function");
  });
});

// --- buildReport with hasAnimation on MountResult ---

describe("buildReport animation detection integration", () => {
  it("small DOM (<=12) with hasAnimation=true produces T3", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1.5], median: 1.5, p95: 1.5 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
        hasAnimation: true,
      }],
    }));
    expect(report.combos[0].tier).toBe("T3");
  });

  it("large DOM (>40) with hasAnimation=true, no portal/scaling produces T3", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 50,
        hasAnimation: true,
      }],
    }));
    expect(report.combos[0].tier).toBe("T3");
  });

  it("medium DOM (13-40) with hasAnimation=true produces T3 (animation triggers T3)", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [2], median: 2, p95: 2 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 25,
        hasAnimation: true,
      }],
    }));
    expect(report.combos[0].tier).toBe("T3");
  });

  it("hasAnimation=false on small DOM still produces T1", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1.5], median: 1.5, p95: 1.5 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
        hasAnimation: false,
      }],
    }));
    expect(report.combos[0].tier).toBe("T1");
  });

  it("undefined hasAnimation on MountResult defaults to false (T1 for small)", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1.5], median: 1.5, p95: 1.5 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
      }],
    }));
    expect(report.combos[0].tier).toBe("T1");
  });

  it("flatThresholds=true produces no tier regardless of hasAnimation", () => {
    const report = buildReport(makeInput({
      flatThresholds: true,
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1.5], median: 1.5, p95: 1.5 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
        hasAnimation: true,
      }],
    }));
    expect(report.combos[0].tier).toBeUndefined();
  });

  it("sets ComboReport.hasAnimation when tiered budgets active", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1.5], median: 1.5, p95: 1.5 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
        hasAnimation: true,
      }],
    }));
    expect(report.combos[0].hasAnimation).toBe(true);
  });

  it("does not set ComboReport.hasAnimation when flatThresholds=true", () => {
    const report = buildReport(makeInput({
      flatThresholds: true,
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1.5], median: 1.5, p95: 1.5 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
        hasAnimation: true,
      }],
    }));
    expect(report.combos[0].hasAnimation).toBeUndefined();
  });

  it("multiple combos: each gets correct hasAnimation from its MountResult", () => {
    const report = buildReport(makeInput({
      mounts: [
        {
          comboIndex: 0, props: { animated: true },
          mount: { samples: [1.5], median: 1.5, p95: 1.5 },
          unmount: { samples: [1], median: 1, p95: 1 },
          domNodeCount: 8,
          hasAnimation: true,
        },
        {
          comboIndex: 1, props: { animated: false },
          mount: { samples: [1.5], median: 1.5, p95: 1.5 },
          unmount: { samples: [1], median: 1, p95: 1 },
          domNodeCount: 8,
          hasAnimation: false,
        },
      ],
      heapDeltas: [0, 0],
    }));
    expect(report.combos[0].tier).toBe("T3");
    expect(report.combos[0].hasAnimation).toBe(true);
    expect(report.combos[1].tier).toBe("T1");
    expect(report.combos[1].hasAnimation).toBe(false);
  });

  it("animated small component with mount 15ms passes under T3 budget (mountMs=20)", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [15], median: 15, p95: 15 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
        hasAnimation: true,
      }],
    }));
    expect(report.combos[0].tier).toBe("T3");
    expect(report.combos[0].verdict).toBe("pass");
  });

  it("non-animated small component with mount 15ms fails under T1 budget (mountMs=14)", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [15], median: 15, p95: 15 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
        hasAnimation: false,
      }],
    }));
    expect(report.combos[0].tier).toBe("T1");
    expect(report.combos[0].verdict).toBe("fail");
  });
});

// --- formatTable with animation ---

describe("formatTable animation display", () => {
  it("shows [anim] suffix when hasAnimation=true and tier is set", () => {
    const report = makeReport({
      combos: [makeCombo({ tier: "T2", hasAnimation: true })],
      tieredBudgets: true,
    });
    const table = formatTable(report);
    expect(table).toContain("[anim]");
    expect(table).toContain("(T2)");
  });

  it("does not show [anim] when hasAnimation=false", () => {
    const report = makeReport({
      combos: [makeCombo({ tier: "T1", hasAnimation: false })],
      tieredBudgets: true,
    });
    const table = formatTable(report);
    expect(table).not.toContain("[anim]");
  });

  it("does not show [anim] when tier is undefined (flat thresholds)", () => {
    const report = makeReport({
      combos: [makeCombo({ hasAnimation: true })],
    });
    const table = formatTable(report);
    expect(table).not.toContain("[anim]");
  });

  it("shows [anim] with FAIL verdict", () => {
    const report = makeReport({
      combos: [makeCombo({ tier: "T3", hasAnimation: true, verdict: "fail" })],
      tieredBudgets: true,
    });
    const table = formatTable(report);
    expect(table).toContain("FAIL");
    expect(table).toContain("(T3)");
    expect(table).toContain("[anim]");
  });
});
