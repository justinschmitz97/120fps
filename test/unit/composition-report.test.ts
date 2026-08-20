import { describe, it, expect } from "vitest";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";
import { DEFAULT_THRESHOLDS } from "../../src/report.js";

function makeInput(overrides?: Partial<BuildReportInput>): BuildReportInput {
  return {
    componentPath: "./Accordion.tsx",
    componentName: "Accordion",
    machine: {
      cpu: "test",
      cores: 4,
      ramMb: 8192,
      os: "test",
      nodeVersion: "20.0.0",
      chromiumVersion: "120.0.0",
    },
    calibration: { totalDuration: 10, scriptDuration: 5 },
    mounts: [
      {
        comboIndex: 0,
        props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 30,
      },
    ],
    explores: [],
    heapDeltas: [0],
    thresholds: DEFAULT_THRESHOLDS,
    ...overrides,
  };
}

describe("Report autoComposition fields", () => {
  it("report includes autoComposition when set in input", () => {
    const input = makeInput();
    const report = buildReport(input);
    // Default: no autoComposition
    expect(report.autoComposition).toBeUndefined();
  });

  it("report includes compositionTree when set in input", () => {
    const input = makeInput();
    const report = buildReport(input);
    expect(report.compositionTree).toBeUndefined();
  });

  it("report sets autoComposition = true when autoComposition flag is passed", () => {
    const input = makeInput({ autoComposition: true } as any);
    const report = buildReport(input);
    expect(report.autoComposition).toBe(true);
  });

  it("report preserves compositionTree in output", () => {
    const tree = {
      root: "Accordion",
      structure: [{ component: "Accordion", props: {}, children: [] }],
      repeatNode: "AccordionItem",
      repeatCount: 3,
    };
    const input = makeInput({ compositionTree: tree } as any);
    const report = buildReport(input);
    expect(report.compositionTree).toEqual(tree);
  });
});

// ─── M80: disclosureReason downgrades a confident PASS to WARN ───

describe("BuildReportInput.disclosureReason", () => {
  it("is absent by default: no disclosureReason and no verdict change", () => {
    const input = makeInput();
    const report = buildReport(input);
    expect(report.combos[0].disclosureReason).toBeUndefined();
    expect(report.combos[0].verdict).toBe("pass");
  });

  it("sets combo.disclosureReason and downgrades a pass verdict to warn", () => {
    const input = makeInput({ disclosureReason: "uncomposed" } as any);
    const report = buildReport(input);
    expect(report.combos[0].disclosureReason).toBe("uncomposed");
    expect(report.combos[0].verdict).toBe("warn");
  });

  it("keeps report.pass true: a WARN combo is still the green bucket", () => {
    const input = makeInput({ disclosureReason: "uncomposed" } as any);
    const report = buildReport(input);
    expect(report.pass).toBe(true);
  });

  it("supports propsExcluded the same way", () => {
    const input = makeInput({ disclosureReason: "propsExcluded" } as any);
    const report = buildReport(input);
    expect(report.combos[0].disclosureReason).toBe("propsExcluded");
    expect(report.combos[0].verdict).toBe("warn");
  });

  it("never touches an already-failing combo's verdict", () => {
    const input = makeInput({
      disclosureReason: "uncomposed",
      flatThresholds: true,
      thresholds: { ...DEFAULT_THRESHOLDS, mountMs: 0 },
    } as any);
    const report = buildReport(input);
    // mount.median (1) > mountMs (0): computeVerdict already failed it.
    expect(report.combos[0].verdict).toBe("fail");
  });
});
