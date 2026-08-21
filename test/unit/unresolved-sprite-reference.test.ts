import { describe, it, expect } from "vitest";
import { buildReport, UNRESOLVED_SPRITE_REFS_WARNING, type BuildReportInput } from "../../src/analyze.js";
import { hintsForReport, formatHints, HINTS } from "../../src/hints.js";
import { formatTable, type CalibrationResult, type Report, type Thresholds } from "../../src/report.js";
import type { MountResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";

// calcom-F5: `Icon.tsx` renders `<svg><use href="#calendar">`. The sprite that
// defines `#calendar` lives in `apps/web/app/layout.tsx`, never in the
// component, so the harness measured a real cost attribution for a graphic
// that rendered nothing visible. `<svg>` + `<use>` are two real nodes, and a
// same-document fragment reference issues no request, so neither the DOM count
// nor the M70 network capture could see it.

const machine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};
const calibration: CalibrationResult = { totalDuration: 10, scriptDuration: 5 };
const thresholds: Thresholds = {
  mountMs: 50, interactionMs: 400, interactionStepMs: 67, relativeMount: 2.0, rerenderMs: 16,
};

function mountResult(comboIndex: number, refs?: string[]): MountResult {
  return {
    comboIndex,
    props: {},
    mount: { samples: [2], median: 2, p95: 2 },
    unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
    domNodeCount: 2,
    ...(refs ? { unresolvedSpriteRefs: refs } : {}),
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
    componentPath: "./Icon.tsx",
    componentName: "Icon",
    machine,
    calibration,
    mounts,
    explores: mounts.map((m) => exploreResult(m.comboIndex)),
    heapDeltas: mounts.map(() => 0),
    thresholds,
    ...overrides,
  });
}

describe("an svg sprite reference the document never defines is disclosed", () => {
  it("carries the ids on the combo in JSON", () => {
    const report = build([mountResult(0, ["#calendar", "#clock"])]);
    expect(report.combos[0].unresolvedSpriteRefs).toEqual(["#calendar", "#clock"]);
  });

  it("names every id and the symptom in the run's warnings", () => {
    const report = build([mountResult(0, ["#calendar"])]);
    expect(report.warnings).toContain(UNRESOLVED_SPRITE_REFS_WARNING(["#calendar"]));
    expect(UNRESOLVED_SPRITE_REFS_WARNING(["#calendar"])).toContain("#calendar");
    expect(UNRESOLVED_SPRITE_REFS_WARNING(["#calendar"])).toContain("empty");
  });

  it("names each id once across combos that share it", () => {
    const report = build([mountResult(0, ["#calendar"]), mountResult(1, ["#calendar", "#clock"])]);
    const spriteWarnings = (report.warnings ?? []).filter((w) => w.includes("#calendar"));
    expect(spriteWarnings).toHaveLength(1);
    expect(spriteWarnings[0]).toContain("#clock");
  });

  it("reaches the hint pipeline with a remedy", () => {
    const report = build([mountResult(0, ["#calendar"])]);
    expect(hintsForReport(report)).toContain("unresolvedSprite");
    const block = formatHints(hintsForReport(report), report);
    expect(block).toContain(HINTS.unresolvedSprite.title);
    expect(block).toContain("--wrap");
  });

  it("marks the row that measured it", () => {
    expect(formatTable(build([mountResult(0, ["#calendar"])]))).toContain("[unresolved sprite]");
  });

  it("says nothing at all when every reference resolved", () => {
    const report = build([mountResult(0)]);
    expect(report.combos[0].unresolvedSpriteRefs).toBeUndefined();
    expect((report.warnings ?? []).some((w) => w.includes("sprite"))).toBe(false);
    expect(hintsForReport(report)).not.toContain("unresolvedSprite");
  });
});
