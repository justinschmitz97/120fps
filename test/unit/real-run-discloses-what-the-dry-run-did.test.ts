import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  alternativeExportNote,
  buildReport,
  ALTERNATIVE_EXPORT_WITHOUT_DEGENERATE_PROPS_NOTE,
  NO_PROPS_MEASURED_WARNING,
  type BuildReportInput,
} from "../../src/analyze.js";
import { extractProps } from "../../src/prop-gen.js";
import { formatTable, type CalibrationResult, type Report, type Thresholds } from "../../src/report.js";
import type { MountResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";

// chakra-ui-F4: --explain-props printed the one actionable sentence for a
// Select whose resolved export takes a class instance ("Target it with
// #SelectTrigger"), and the real run — the one a user pays wall-clock time for
// — dropped it. calcom-F4: a composed run measured `props: {}` and printed
// none of the 73-prop extraction diagnostics the dry run had printed, with no
// caveat that no props were applied at all.

const FIXTURE = path.resolve("fixtures/alt-export-degenerate/select.tsx");

describe("the retarget remedy is computed once and printed by both modes", () => {
  it("names the alternative export for a degenerate required prop", async () => {
    const schemas = await extractProps(FIXTURE, { onWarning: () => {} });
    const note = await alternativeExportNote(FIXTURE, "SelectRootProvider", schemas, undefined);
    expect(note).toBe(
      ALTERNATIVE_EXPORT_WITHOUT_DEGENERATE_PROPS_NOTE("SelectRootProvider", "SelectTrigger"),
    );
  });

  it("says nothing when the user already named a target", async () => {
    const schemas = await extractProps(FIXTURE, { onWarning: () => {} });
    expect(await alternativeExportNote(FIXTURE, "SelectRootProvider", schemas, "SelectRootProvider"))
      .toBeUndefined();
  });

  it("says nothing when no required prop is degenerate", async () => {
    const schemas = await extractProps(FIXTURE, { target: "SelectTrigger", onWarning: () => {} });
    expect(await alternativeExportNote(FIXTURE, "SelectTrigger", schemas, undefined)).toBeUndefined();
  });
});

const machine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};
const calibration: CalibrationResult = { totalDuration: 10, scriptDuration: 5 };
const thresholds: Thresholds = {
  mountMs: 50, interactionMs: 400, interactionStepMs: 67, relativeMount: 2.0, rerenderMs: 16,
};

function mountResult(): MountResult {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [2, 2, 2], median: 2, p95: 2 },
    unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
    domNodeCount: 6,
  };
}

function exploreResult(): ExploreResult {
  const nodes = new Map();
  nodes.set("a", { id: "a", depth: 0, interactions: [], pathFromRoot: [] });
  const graph: StateGraph = { nodes, edges: [], initialNodeId: "a", wallClockMs: 10 };
  return { graph, comboIndex: 0, props: {} };
}

function build(overrides: Partial<BuildReportInput> = {}): Report {
  return buildReport({
    componentPath: "./Select.tsx",
    componentName: "Select",
    machine,
    calibration,
    mounts: [mountResult()],
    explores: [exploreResult()],
    heapDeltas: [0],
    thresholds,
    ...overrides,
  });
}

describe("a run that applied no props at all says so on the row it measured", () => {
  it("marks the combo when the scene owned the props", () => {
    const report = build({ measuredWithoutProps: true });
    expect(report.combos[0].measuredWithoutProps).toBe(true);
    expect(formatTable(report)).toContain("[no props applied]");
  });

  it("leaves an ordinary empty-prop combo unmarked", () => {
    const report = build();
    expect(report.combos[0].measuredWithoutProps).toBeUndefined();
    expect(formatTable(report)).not.toContain("[no props applied]");
  });

  it("names which of the two reasons applied", () => {
    expect(NO_PROPS_MEASURED_WARNING(true)).toContain("fixture");
    expect(NO_PROPS_MEASURED_WARNING(false)).toContain("composed");
    for (const warning of [NO_PROPS_MEASURED_WARNING(true), NO_PROPS_MEASURED_WARNING(false)]) {
      expect(warning).toContain("props: {}");
    }
  });
});
