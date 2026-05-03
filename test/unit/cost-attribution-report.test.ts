import { describe, it, expect } from "vitest";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";
import { formatTable, type ComboReport, type Report } from "../../src/report.js";
import type { TraceEvent } from "../../src/measure.js";

function makeEvent(
  name: string,
  durUs: number,
  tsUs: number,
  url?: string,
): TraceEvent {
  return {
    cat: "devtools.timeline",
    name,
    dur: durUs,
    ph: "X",
    ts: tsUs,
    args: url ? { data: { url } } : {},
  };
}

function makeBaseInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    componentPath: "test.tsx",
    componentName: "Test",
    machine: {
      cpu: "test",
      cores: 4,
      ramMb: 8192,
      os: "test",
      nodeVersion: "20.0.0",
      chromiumVersion: "120.0",
    },
    calibration: { totalDuration: 10, scriptDuration: 5 },
    mounts: [
      {
        comboIndex: 0,
        props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 10,
        heapDelta: 0,
        mountTraces: [
          [
            makeEvent("FunctionCall", 3000, 1000,
              "http://localhost:5173/node_modules/.vite/deps/motion.js"),
            makeEvent("FunctionCall", 2000, 5000,
              "http://localhost:5173/src/App.tsx"),
          ],
        ],
      },
    ],
    explores: [],
    heapDeltas: [0],
    thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
    flatThresholds: true,
    ...overrides,
  };
}

describe("buildReport with cost attribution", () => {
  it("adds costAttribution to ComboReport when mountTraces present", () => {
    const report = buildReport(makeBaseInput());
    expect(report.combos[0].costAttribution).toBeDefined();
    expect(report.combos[0].costAttribution!.buckets.length).toBeGreaterThan(0);
  });

  it("omits costAttribution when no mountTraces", () => {
    const input = makeBaseInput();
    input.mounts[0].mountTraces = undefined;
    const report = buildReport(input);
    expect(report.combos[0].costAttribution).toBeUndefined();
  });

  it("omits costAttribution when skipAttribution is true", () => {
    const input = makeBaseInput({ skipAttribution: true } as any);
    const report = buildReport(input);
    expect(report.combos[0].costAttribution).toBeUndefined();
  });
});

describe("formatTable with cost attribution", () => {
  function makeReport(): Report {
    const report = buildReport(makeBaseInput());
    return report;
  }

  it("includes cost breakdown section when attribution present", () => {
    const report = makeReport();
    const table = formatTable(report);
    expect(table).toContain("Cost breakdown");
  });

  it("shows source name and percentage", () => {
    const report = makeReport();
    const table = formatTable(report);
    expect(table).toContain("motion");
    expect(table).toContain("%");
  });

  it("omits cost breakdown section when no attribution", () => {
    const input = makeBaseInput();
    input.mounts[0].mountTraces = undefined;
    const report = buildReport(input);
    const table = formatTable(report);
    expect(table).not.toContain("Cost breakdown");
  });
});
