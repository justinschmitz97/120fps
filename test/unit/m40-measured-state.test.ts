import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyMeasuredState, MEASURED_STATE_HOLD_MS } from "../../src/measure.js";
import { buildReport, MEASURED_STATE_WARNING, type BuildReportInput } from "../../src/analyze.js";
import {
  compareBaseline,
  saveBaseline,
  loadBaseline,
  type BaselineEntry,
  type ResolvedTolerance,
  selectBaselineEntry,
} from "../../src/budget.js";
import { DEFAULT_THRESHOLDS } from "../../src/report.js";

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

const TOLERANCE: ResolvedTolerance = { mount: 10, rerender: 15, interaction: 15, unmount: 20 };

function makeEntry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    mount: 10,
    rerender: 5,
    unmount: 2,
    domNodeCount: 8,
    interactions: {},
    tier: "T1",
    ...overrides,
  };
}

// C1 — every combo carries a settledness classification.
describe("m40 C1 — measured-state classification", () => {
  it("is settled when neither signal fires", () => {
    expect(classifyMeasuredState({ pendingNetwork: false, mutated: false, hasAnimation: false }))
      .toBe("settled");
  });

  it("reports late-mutation when the DOM moved after the fence", () => {
    expect(classifyMeasuredState({ pendingNetwork: false, mutated: true, hasAnimation: false }))
      .toBe("late-mutation");
  });

  it("reports pending-network when a request was still in flight", () => {
    expect(classifyMeasuredState({ pendingNetwork: true, mutated: false, hasAnimation: false }))
      .toBe("pending-network");
  });

  it("prefers the network signal when both fire: it names the cause", () => {
    expect(classifyMeasuredState({ pendingNetwork: true, mutated: true, hasAnimation: false }))
      .toBe("pending-network");
  });

  it("never blames an animated combo for animation-driven mutation", () => {
    expect(classifyMeasuredState({ pendingNetwork: false, mutated: true, hasAnimation: true }))
      .toBe("settled");
  });

  it("still reports pending-network on an animated combo", () => {
    expect(classifyMeasuredState({ pendingNetwork: true, mutated: true, hasAnimation: true }))
      .toBe("pending-network");
  });

  it("holds long enough for a promise-resolution re-render to land", () => {
    expect(MEASURED_STATE_HOLD_MS).toBeGreaterThanOrEqual(100);
  });
});

// C2 — the classification reaches the report, and a non-settled combo discloses.
describe("m40 C2 — report carries and discloses measured state", () => {
  it("carries the mount classification onto the combo", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0,
        props: {},
        mount: { samples: [1.5], median: 1.5, p95: 1.5 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
        measuredState: "pending-network",
      }],
    }));
    expect(report.combos[0].measuredState).toBe("pending-network");
  });

  it("defaults to settled when the mount pass recorded nothing", () => {
    expect(buildReport(makeInput()).combos[0].measuredState).toBe("settled");
  });

  it("warns once per non-settled combo, naming the combo and the signal", () => {
    const report = buildReport(makeInput({
      mounts: [
        {
          comboIndex: 0, props: {},
          mount: { samples: [1.5], median: 1.5, p95: 1.5 },
          unmount: { samples: [1], median: 1, p95: 1 },
          domNodeCount: 8,
          measuredState: "late-mutation",
        },
        {
          comboIndex: 1, props: {},
          mount: { samples: [1.5], median: 1.5, p95: 1.5 },
          unmount: { samples: [1], median: 1, p95: 1 },
          domNodeCount: 8,
          measuredState: "settled",
        },
      ],
      heapDeltas: [0, 0],
    }));
    const warnings = report.warnings ?? [];
    expect(warnings.filter((w) => w.includes("late-mutation")).length).toBe(1);
    expect(warnings.some((w) => w.includes("combo 0"))).toBe(true);
    expect(warnings.some((w) => w.includes("combo 1"))).toBe(false);
  });

  it("stays silent when every combo settled", () => {
    const report = buildReport(makeInput());
    expect((report.warnings ?? []).some((w) => w.includes("measured"))).toBe(false);
  });

  it("warns without a combo label when a cached verdict is reused", () => {
    const warning = MEASURED_STATE_WARNING("pending-network");
    expect(warning).toContain("pending-network");
    expect(warning).not.toContain("combo ");
  });

  it("never fails the run on a non-settled combo", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1.5], median: 1.5, p95: 1.5 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
        measuredState: "late-mutation",
      }],
    }));
    expect(report.pass).toBe(true);
  });
});

// C3 — comparing a skeleton to settled content is not a regression signal.
describe("m40 C3 — baseline comparison across a measured-state change", () => {
  it("skips comparison when the state changed", () => {
    const comparison = compareBaseline(
      makeEntry({ measuredState: "pending-network" }),
      { mount: 40, rerender: 5, unmount: 2, interactions: {}, measuredState: "settled" },
      TOLERANCE,
    );
    expect(comparison.regressions).toEqual([]);
    expect(comparison.improvements).toEqual([]);
    expect(comparison.measuredStateMismatch).toEqual({
      baseline: "pending-network",
      current: "settled",
    });
  });

  it("compares normally when the state matches", () => {
    const comparison = compareBaseline(
      makeEntry({ measuredState: "pending-network" }),
      { mount: 40, rerender: 5, unmount: 2, interactions: {}, measuredState: "pending-network" },
      TOLERANCE,
    );
    expect(comparison.measuredStateMismatch).toBeUndefined();
    expect(comparison.regressions.map((r) => r.metric)).toContain("mount");
  });

  it("compares a pre-M40 baseline that recorded no state", () => {
    const comparison = compareBaseline(
      makeEntry(),
      { mount: 40, rerender: 5, unmount: 2, interactions: {}, measuredState: "late-mutation" },
      TOLERANCE,
    );
    expect(comparison.measuredStateMismatch).toBeUndefined();
    expect(comparison.regressions.map((r) => r.metric)).toContain("mount");
  });

  it("round-trips the state through the baseline file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m40-baseline-"));
    const file = path.join(dir, "120fps-baseline.json");
    try {
      saveBaseline(file, makeEntry({ measuredState: "late-mutation" }), "./Button.tsx");
      expect(selectBaselineEntry(loadBaseline(file), "./Button.tsx", "unused")!.entry.measuredState).toBe("late-mutation");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
