import { describe, it, expect } from "vitest";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";
import { formatTable, describeMode, type CalibrationResult, type Report, type Thresholds } from "../../src/report.js";
import type { MountResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";

// dub-F5: a Badge run's footer said "2 of 12 combos warned" two lines above
// its own "measured 8 of 64 prop combos". Twelve is eight prop combos plus
// four sibling-copies scale probes, which the mode line already excludes.
// M59 also exempts a scale probe from tier budgets ("exempt from budgets,
// never from rendering"); the test that found them read a props key M61 had
// already stripped, so the exemption had stopped applying.

const baseMachine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};
const baseCalibration: CalibrationResult = { totalDuration: 10, scriptDuration: 5 };
const baseThresholds: Thresholds = {
  mountMs: 50, interactionMs: 400, interactionStepMs: 67, relativeMount: 2.0, rerenderMs: 16,
};

function mountResult(comboIndex: number, props: Record<string, unknown>, mountMs: number, domNodeCount = 4): MountResult {
  return {
    comboIndex,
    props,
    mount: { samples: [mountMs, mountMs, mountMs], median: mountMs, p95: mountMs },
    unmount: { samples: [0.5, 0.5, 0.5], median: 0.5, p95: 0.5 },
    domNodeCount,
  };
}

function exploreResult(comboIndex: number): ExploreResult {
  const nodes = new Map();
  nodes.set("a", { id: "a", depth: 0, interactions: [], pathFromRoot: [] });
  const graph: StateGraph = { nodes, edges: [], initialNodeId: "a", wallClockMs: 10 };
  return { graph, comboIndex, props: {} };
}

function build(mounts: MountResult[], overrides: Partial<BuildReportInput> = {}): Report {
  return buildReport({
    componentPath: "./Badge.tsx",
    componentName: "Badge",
    machine: baseMachine,
    calibration: baseCalibration,
    mounts,
    explores: mounts.map((m) => exploreResult(m.comboIndex)),
    heapDeltas: mounts.map(() => 0),
    thresholds: baseThresholds,
    ...overrides,
  });
}

// One warning-worthy prop combo (unstable mount), one healthy one, and four
// scale probes: dub's exact shape at a smaller size.
function dubShapedMounts(): MountResult[] {
  const unstable = mountResult(0, { variant: "default" }, 4);
  unstable.mount.samples = [1, 9, 1];
  return [
    unstable,
    mountResult(1, { variant: "neutral" }, 4),
    mountResult(2, { __120fps_scaleN: 1 }, 4, 4),
    mountResult(3, { __120fps_scaleN: 5 }, 6, 20),
    mountResult(4, { __120fps_scaleN: 20 }, 9, 80),
    mountResult(5, { __120fps_scaleN: 50 }, 14, 200),
  ];
}

describe("a run's combo counts all describe the same set", () => {
  it("counts the warn rollup over prop combos, not scale probes", () => {
    const report = build(dubShapedMounts());
    const table = formatTable(report);
    expect(table).toContain("of 2 combos warned");
    expect(table).not.toContain("of 6 combos warned");
  });

  it("agrees with the mode line's own prop-combo count", () => {
    const report = build(dubShapedMounts());
    expect(describeMode(report)).toContain("2 measured");
    expect(formatTable(report)).toContain("of 2 combos warned");
  });

  it("keeps every scale probe in combos[] with its own identity", () => {
    const report = build(dubShapedMounts());
    expect(report.combos).toHaveLength(6);
    expect(report.combos.filter((c) => c.scaleProbe !== undefined).map((c) => c.scaleProbe))
      .toEqual([1, 5, 20, 50]);
    // M61: the trigger key is never a reported prop.
    expect(report.combos.every((c) => !("__120fps_scaleN" in c.props))).toBe(true);
  });
});

describe("a scale probe is exempt from budgets and never from rendering", () => {
  it("does not fail a scale probe for exceeding a prop-combo tier budget", () => {
    // 200 DOM nodes is still T1 by node count, and 40ms would fail T1's
    // mount budget — the probe mounts N whole extra trees, so that budget
    // never described it.
    const mounts = [
      mountResult(0, { variant: "default" }, 4),
      mountResult(1, { __120fps_scaleN: 50 }, 40, 30),
    ];
    const report = build(mounts);
    expect(report.combos[1].scaleProbe).toBe(50);
    expect(report.combos[1].verdict).toBe("pass");
    expect(report.pass).toBe(true);
  });

  it("still fails a scale probe whose render threw", () => {
    const broken = mountResult(1, { __120fps_scaleN: 50 }, 4, 0);
    broken.pageErrors = { messages: ["TypeError: boom"], fatal: true, dropped: 0 };
    const report = build([mountResult(0, { variant: "default" }, 4), broken]);
    expect(report.combos[1].verdict).toBe("fail");
    expect(report.pass).toBe(false);
  });
});
