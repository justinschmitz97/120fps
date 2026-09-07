import { describe, it, expect } from "vitest";
import { buildReport, type BuildReportInput } from "../../src/pipeline/index.js";
import type { CalibrationResult, PropProvenance, Report, Thresholds } from "../../src/report/index.js";
import type { MountResult } from "../../src/browser/index.js";
import type { ExploreResult, StateGraph } from "../../src/analysis/index.js";
import type { PropSchema } from "../../src/props/index.js";

type Schema = PropSchema & { provenance?: PropProvenance };

const SIZE_SCHEMAS: Schema[] = [
  { name: "size", kind: "string", required: false, values: ["test"], provenance: "placeholder" },
];

function makeMountResult(overrides: Partial<MountResult> = {}): MountResult {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [1.5, 1.5, 1.5], median: 1.5, p95: 1.5 },
    unmount: { samples: [0.5, 0.5, 0.5], median: 0.5, p95: 0.5 },
    domNodeCount: 39,
    ...overrides,
  };
}

function makeExploreResult(comboIndex = 0): ExploreResult {
  const nodes = new Map();
  nodes.set("abc", { id: "abc", depth: 0, interactions: [], pathFromRoot: [] });
  const graph: StateGraph = { nodes, edges: [], initialNodeId: "abc", wallClockMs: 10 };
  return { graph, comboIndex, props: {} };
}

const machine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};
const calibration: CalibrationResult = { totalDuration: 10, scriptDuration: 5 };
const thresholds: Thresholds = {
  mountMs: 50, interactionMs: 400, interactionStepMs: 67, relativeMount: 2.0, rerenderMs: 16,
};

function build(overrides: Partial<BuildReportInput>): Report {
  const mounts = overrides.mounts ?? [makeMountResult()];
  return buildReport({
    componentPath: "./Loader.tsx",
    componentName: "Loader",
    machine,
    calibration,
    mounts,
    explores: mounts.map((m) => makeExploreResult(m.comboIndex)),
    heapDeltas: mounts.map(() => 0),
    thresholds,
    ...overrides,
  });
}

const SVG_ERROR = 'Error: <svg> attribute width: Expected length, "test".';

describe("a synthesized placeholder that reached the DOM of a rendered combo", () => {
  it("is disclosed, naming the prop and the value", () => {
    const report = build({
      mounts: [
        makeMountResult({
          props: { size: "test" },
          pageErrors: { messages: [SVG_ERROR], fatal: false, dropped: 0 },
        }),
      ],
      schemas: SIZE_SCHEMAS,
    });
    const disclosure = (report.warnings ?? []).find((w) => w.includes("[harness fault]"));
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain('"size"');
    expect(disclosure).toContain('"test"');
  });

  it("leaves the verdict and the run's result alone", () => {
    const report = build({
      mounts: [
        makeMountResult({
          props: { size: "test" },
          pageErrors: { messages: [SVG_ERROR], fatal: false, dropped: 0 },
        }),
      ],
      schemas: SIZE_SCHEMAS,
    });
    expect(report.combos[0].verdict).toBe("pass");
    expect(report.combos[0].renderHealth).not.toBe("error");
    expect(report.pass).toBe(true);
  });

  it("does not exempt a combo that failed its budget", () => {
    const slow = makeMountResult({
      props: { size: "test" },
      mount: { samples: [900, 900, 900], median: 900, p95: 900 },
      pageErrors: { messages: [SVG_ERROR], fatal: false, dropped: 0 },
    });
    const report = build({ mounts: [slow], schemas: SIZE_SCHEMAS });
    expect(report.combos[0].verdict).toBe("fail");
    expect(report.pass).toBe(false);
    expect((report.warnings ?? []).some((w) => w.includes("[harness fault]"))).toBe(true);
  });

  it("says nothing when no synthesized value appears in the errors", () => {
    const report = build({
      mounts: [
        makeMountResult({
          props: { size: "test" },
          pageErrors: { messages: ["TypeError: unrelated crash"], fatal: false, dropped: 0 },
        }),
      ],
      schemas: SIZE_SCHEMAS,
    });
    expect((report.warnings ?? []).some((w) => w.includes("[harness fault]"))).toBe(false);
  });

  it("says nothing when the combo raised no page error at all", () => {
    const report = build({ mounts: [makeMountResult({ props: { size: "test" } })], schemas: SIZE_SCHEMAS });
    expect((report.warnings ?? []).some((w) => w.includes("[harness fault]"))).toBe(false);
  });
});

describe("text that is 120fps's own, or the runtime's, and not the component's", () => {
  const DIMENSION_SCHEMAS: Schema[] = [
    { name: "size", kind: "string", required: false, values: ["16"], provenance: "heuristic" },
  ];

  function disclosedFor(message: string): boolean {
    const report = build({
      mounts: [
        makeMountResult({
          props: { size: "16" },
          pageErrors: { messages: [message], fatal: false, dropped: 0 },
        }),
      ],
      schemas: DIMENSION_SCHEMAS,
    });
    return (report.warnings ?? []).some((w) => w.includes("[harness fault]"));
  }

  it("does not read 120fps's own repeat suffix as evidence", () => {
    expect(disclosedFor("TypeError: cannot read properties of null (×16)")).toBe(false);
  });

  it("does not read a stack frame's line and column as evidence", () => {
    expect(
      disclosedFor("TypeError: boom\n    at Widget (webpack://src/Widget.tsx:16:5)"),
    ).toBe(false);
  });

  it("does not read a React error code as evidence", () => {
    expect(disclosedFor("Minified React error #16; visit https://react.dev/errors/16")).toBe(false);
  });

  it("still reads a distinctive placeholder as evidence", () => {
    const report = build({
      mounts: [
        makeMountResult({
          props: { size: "test" },
          pageErrors: { messages: [SVG_ERROR], fatal: false, dropped: 0 },
        }),
      ],
      schemas: SIZE_SCHEMAS,
    });
    expect((report.warnings ?? []).some((w) => w.includes("[harness fault]"))).toBe(true);
  });

  it("keeps the crashed combo's exemption on a short numeric value", () => {
    const report = build({
      mounts: [
        makeMountResult({
          props: { size: "16" },
          domNodeCount: 0,
          pageErrors: {
            messages: ['Error: <svg> attribute width: Expected length, "16".'],
            fatal: true,
            dropped: 0,
          },
        }),
      ],
      schemas: DIMENSION_SCHEMAS,
    });
    expect(report.combos[0].harnessFault?.propName).toBe("size");
    expect(report.combos[0].verdict).toBe("warn");
  });
});

describe("the combo that crashed on a synthesized value", () => {
  it("keeps the exemption the verdict already grants it", () => {
    const report = build({
      mounts: [
        makeMountResult({
          props: { size: "test" },
          domNodeCount: 0,
          pageErrors: { messages: [SVG_ERROR], fatal: true, dropped: 0 },
        }),
      ],
      schemas: SIZE_SCHEMAS,
    });
    expect(report.combos[0].harnessFault?.propName).toBe("size");
    expect(report.combos[0].verdict).toBe("warn");
    expect(report.pass).toBe(true);
    expect((report.warnings ?? []).some((w) => w.includes("[harness fault]"))).toBe(false);
  });
});
