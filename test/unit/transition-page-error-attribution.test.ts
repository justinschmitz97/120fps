import { describe, it, expect } from "vitest";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";
import { formatTable, type CalibrationResult, type Report, type Thresholds, type PropProvenance } from "../../src/report.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";
import type { PropSchema } from "../../src/prop-gen.js";

// The rerender pass measures combo `ci` and then, in the same loop body,
// rerenders into `combos[ci+1]`'s props to price the prop delta. Errors from
// that second render belong to the transition, not to combo `ci`: radix
// `label.tsx` combos #1 and #6 carry no `asChild` at all and were printed with
// a Slot error only `asChild: true` can raise, and base UI `SelectRoot`
// combo #0 (controlled) was printed with a controlled-to-uncontrolled warning
// that combo #0 alone never triggers.

type Schema = PropSchema & { provenance?: PropProvenance };

const baseMachine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};
const baseCalibration: CalibrationResult = { totalDuration: 10, scriptDuration: 5 };
const baseThresholds: Thresholds = {
  mountMs: 50, interactionMs: 400, interactionStepMs: 67, relativeMount: 2.0, rerenderMs: 16,
};

function makeMountResult(overrides: Partial<MountResult> = {}): MountResult {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [1.5, 1.5, 1.5], median: 1.5, p95: 1.5 },
    unmount: { samples: [0.5, 0.5, 0.5], median: 0.5, p95: 0.5 },
    domNodeCount: 1,
    ...overrides,
  };
}

function makeExploreResult(comboIndex = 0): ExploreResult {
  const nodes = new Map();
  nodes.set("abc", { id: "abc", depth: 0, interactions: [], pathFromRoot: [] });
  const graph: StateGraph = { nodes, edges: [], initialNodeId: "abc", wallClockMs: 10 };
  return { graph, comboIndex, props: {} };
}

function makeRerenderResult(overrides: Partial<RerenderResult> = {}): RerenderResult {
  return {
    comboIndex: 0,
    props: {},
    stable: { samples: [1, 1, 1], median: 1, p95: 1 },
    ...overrides,
  };
}

function build(overrides: Partial<BuildReportInput>): Report {
  const mounts = overrides.mounts ?? [makeMountResult()];
  const input: BuildReportInput = {
    componentPath: "./Label.tsx",
    componentName: "Label",
    machine: baseMachine,
    calibration: baseCalibration,
    mounts,
    explores: mounts.map((m) => makeExploreResult(m.comboIndex)),
    heapDeltas: mounts.map(() => 0),
    thresholds: baseThresholds,
    ...overrides,
  };
  return buildReport(input);
}

const SLOT_ERROR =
  "Primitive.label failed to slot onto its children. Expected a single React element child or `Slottable`. (×10)";

// The radix shape: combo #0 has no `asChild`, its successor #1 does, and the
// Slot error was raised while rerendering into #1's props.
function radixShapedReport(): Report {
  return build({
    mounts: [
      makeMountResult({ comboIndex: 0, props: { children: "120fps-placeholder" }, domNodeCount: 1 }),
      makeMountResult({ comboIndex: 1, props: { asChild: true }, domNodeCount: 0 }),
    ],
    rerenders: [
      makeRerenderResult({
        comboIndex: 0,
        props: { children: "120fps-placeholder" },
        changeToProps: { asChild: true },
        transitionPageErrors: {
          toComboIndex: 1,
          errors: { messages: [SLOT_ERROR], fatal: true, dropped: 0 },
        },
      }),
    ],
  });
}

describe("a page error from the prop-change rerender is attributed to the transition", () => {
  it("lands on transitionPageErrors, never on the combo's own pageErrors", () => {
    const combo = radixShapedReport().combos[0];
    expect(combo.pageErrors).toBeUndefined();
    expect(combo.transitionPageErrors).toEqual({ toComboIndex: 1, errors: [SLOT_ERROR] });
  });

  it("does not turn the combo's render health into an error", () => {
    const report = build({
      mounts: [
        makeMountResult({ comboIndex: 0, props: {}, domNodeCount: 0 }),
        makeMountResult({ comboIndex: 1, props: { asChild: true }, domNodeCount: 0 }),
      ],
      rerenders: [
        makeRerenderResult({
          comboIndex: 0,
          transitionPageErrors: {
            toComboIndex: 1,
            errors: { messages: [SLOT_ERROR], fatal: true, dropped: 0 },
          },
        }),
      ],
    });
    // Nothing rendered and nothing that this combo itself threw: "empty" is
    // legal, "error" is a fail.
    expect(report.combos[0].renderHealth).toBe("empty");
    expect(report.combos[0].verdict).not.toBe("fail");
  });

  it("is never used as evidence for a harness fault on the combo it is shown on", () => {
    const schemas: Schema[] = [
      { name: "asChild", kind: "boolean", required: false, values: [true, false], provenance: "contract" },
    ];
    const report = build({
      mounts: [makeMountResult({ comboIndex: 0, props: { asChild: true }, domNodeCount: 0 })],
      rerenders: [
        makeRerenderResult({
          comboIndex: 0,
          props: { asChild: true },
          transitionPageErrors: {
            toComboIndex: 1,
            errors: { messages: [SLOT_ERROR], fatal: true, dropped: 0 },
          },
        }),
      ],
      schemas,
    });
    expect(report.combos[0].harnessFault).toBeUndefined();
  });

  it("keeps the combo's own errors on the combo and the transition's on the transition", () => {
    const report = build({
      mounts: [
        makeMountResult({
          comboIndex: 0,
          props: { asChild: true },
          domNodeCount: 0,
          pageErrors: { messages: ["own: mount threw"], fatal: true, dropped: 0 },
        }),
      ],
      rerenders: [
        makeRerenderResult({
          comboIndex: 0,
          props: { asChild: true },
          transitionPageErrors: {
            toComboIndex: 1,
            errors: { messages: [SLOT_ERROR], fatal: true, dropped: 0 },
          },
        }),
      ],
    });
    const combo = report.combos[0];
    expect(combo.pageErrors).toEqual(["own: mount threw"]);
    expect(combo.transitionPageErrors?.errors).toEqual([SLOT_ERROR]);
    expect(combo.renderHealth).toBe("error");
  });

  it("promotes a capped window's dropped count the same way an own-error list does", () => {
    const report = build({
      rerenders: [
        makeRerenderResult({
          transitionPageErrors: {
            toComboIndex: 1,
            errors: { messages: [SLOT_ERROR], fatal: false, dropped: 3 },
          },
        }),
      ],
    });
    expect(report.combos[0].transitionPageErrors?.errors).toEqual([SLOT_ERROR, "(+3 more dropped)"]);
  });

  it("marks the row with the transition it observed", () => {
    const table = formatTable(radixShapedReport());
    expect(table).toContain("[→ #1: 1 page error]");
  });

  it("states the window it observed and never claims the next combo caused it", () => {
    const table = formatTable(radixShapedReport());
    expect(table).toContain("transitioning to combo #1");
    expect(table).toContain(SLOT_ERROR);
    expect(table).not.toContain("caused by combo #1");
  });

  it("a combo with no transition errors is unchanged", () => {
    const report = build({ rerenders: [makeRerenderResult({ comboIndex: 0 })] });
    expect(report.combos[0].transitionPageErrors).toBeUndefined();
    expect(formatTable(report)).not.toContain("transitioning to combo");
  });
});

describe("a harness fault on a contract prop requires the error text to evidence it", () => {
  const CONTRACT_SCHEMAS: Schema[] = [
    { name: "asChild", kind: "boolean", required: false, values: [true, false], provenance: "contract" },
  ];

  function crashed(props: Record<string, unknown>, message: string, schemas: Schema[]): Report {
    return build({
      mounts: [
        makeMountResult({
          props,
          domNodeCount: 0,
          pageErrors: { messages: [message], fatal: true, dropped: 0 },
        }),
      ],
      schemas,
    });
  }

  it("does not fire on a missing-provider crash that never mentions the prop or its mechanism", () => {
    const report = crashed(
      { asChild: true },
      "useContext returned `undefined`. Seems you forgot to wrap component within <ChakraProvider /> (×5)",
      CONTRACT_SCHEMAS,
    );
    expect(report.combos[0].harnessFault).toBeUndefined();
    expect(report.combos[0].verdict).toBe("fail");
    expect(report.pass).toBe(false);
  });

  it("fires when the error text names the slot mechanism", () => {
    const report = crashed({ asChild: true }, SLOT_ERROR, CONTRACT_SCHEMAS);
    expect(report.combos[0].harnessFault?.propName).toBe("asChild");
    expect(report.combos[0].verdict).toBe("warn");
  });

  it("fires when the error text names the prop itself", () => {
    const report = crashed(
      { asChild: true },
      "Invalid prop `asChild` supplied to `Tabs`.",
      CONTRACT_SCHEMAS,
    );
    expect(report.combos[0].harnessFault?.propName).toBe("asChild");
  });

  it("does not fire on the English word behind a one-word contract prop name", () => {
    const schemas: Schema[] = [
      { name: "as", kind: "union", required: false, values: ["div", "span"], provenance: "contract" },
    ];
    const report = crashed(
      { as: "div" },
      "TypeError: Cannot read properties of undefined as the store was never created",
      schemas,
    );
    expect(report.combos[0].harnessFault).toBeUndefined();
  });

  it("fires for the same prop when the error text quotes it as a prop", () => {
    const schemas: Schema[] = [
      { name: "as", kind: "union", required: false, values: ["div", "span"], provenance: "contract" },
    ];
    const report = crashed({ as: "div" }, 'The "as" prop must be a valid element type.', schemas);
    expect(report.combos[0].harnessFault?.propName).toBe("as");
  });

  it("never fires with no captured error text at all", () => {
    const report = build({
      mounts: [makeMountResult({ props: { asChild: true }, domNodeCount: 0, pageErrors: { messages: [], fatal: true, dropped: 0 } })],
      schemas: CONTRACT_SCHEMAS,
    });
    expect(report.combos[0].harnessFault).toBeUndefined();
  });

  it("keeps every failing combo of one crash on the same verdict regardless of asChild", () => {
    const chakra = "useContext returned `undefined`. Seems you forgot to wrap component within <ChakraProvider />";
    const report = build({
      mounts: [
        makeMountResult({ comboIndex: 0, props: { asChild: true }, domNodeCount: 0, pageErrors: { messages: [chakra], fatal: true, dropped: 0 } }),
        makeMountResult({ comboIndex: 1, props: {}, domNodeCount: 0, pageErrors: { messages: [chakra], fatal: true, dropped: 0 } }),
      ],
      schemas: CONTRACT_SCHEMAS,
    });
    expect(report.combos.map((c) => c.verdict)).toEqual(["fail", "fail"]);
  });
});
