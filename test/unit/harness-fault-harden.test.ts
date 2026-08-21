import { describe, it, expect } from "vitest";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";
import { formatTable, type CalibrationResult, type Report, type Thresholds, type PropProvenance } from "../../src/report.js";
import { hintsForReport } from "../../src/hints.js";
import type { MountResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";
import type { PropSchema } from "../../src/prop-gen.js";

// M85 harden: 10 adversarial hypotheses against detectHarnessFault, see
// report table in the milestone's final write-up.

type Schema = PropSchema & { provenance?: PropProvenance };

function makeMountResult(overrides: Partial<MountResult> = {}): MountResult {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [1.5, 1.5, 1.5], median: 1.5, p95: 1.5 },
    unmount: { samples: [0.5, 0.5, 0.5], median: 0.5, p95: 0.5 },
    domNodeCount: 0,
    ...overrides,
  };
}

function makeExploreResult(comboIndex = 0): ExploreResult {
  const nodes = new Map();
  nodes.set("abc", { id: "abc", depth: 0, interactions: [], pathFromRoot: [] });
  const graph: StateGraph = { nodes, edges: [], initialNodeId: "abc", wallClockMs: 10 };
  return { graph, comboIndex, props: {} };
}

const baseMachine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};
const baseCalibration: CalibrationResult = { totalDuration: 10, scriptDuration: 5 };
const baseThresholds: Thresholds = {
  mountMs: 50, interactionMs: 400, interactionStepMs: 67, relativeMount: 2.0, rerenderMs: 16,
};

function build(overrides: Partial<BuildReportInput>): Report {
  const mounts = overrides.mounts ?? [makeMountResult()];
  const input: BuildReportInput = {
    componentPath: "./Component.tsx",
    componentName: "Component",
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

function crashedMount(comboIndex: number, props: Record<string, unknown>, message: string): MountResult {
  return makeMountResult({
    comboIndex,
    props,
    domNodeCount: 0,
    pageErrors: { messages: [message], fatal: true, dropped: 0 },
  });
}

describe("M85 harden", () => {
  // #1: short numeric placeholder must not match by pure substring collision.
  it("#1 a numeric placeholder '1' does not spuriously match 'at line 10'", () => {
    const schemas: Schema[] = [{ name: "index", kind: "number", required: false, values: [1], provenance: "placeholder" }];
    const report = build({
      mounts: [crashedMount(0, { index: 1 }, "TypeError: x is undefined at line 10")],
      schemas,
    });
    expect(report.combos[0].harnessFault).toBeUndefined();
    expect(report.combos[0].verdict).toBe("fail");
  });

  // #2: a genuine standalone numeric match (word-bounded) still fires.
  it("#2 a numeric placeholder still matches when it appears as a standalone token", () => {
    const schemas: Schema[] = [{ name: "count", kind: "number", required: false, values: [0], provenance: "placeholder" }];
    const report = build({
      mounts: [crashedMount(0, { count: 0 }, "RangeError: divisor must not be 0")],
      schemas,
    });
    expect(report.combos[0].harnessFault?.propName).toBe("count");
  });

  // #3: cyclic nested object does not hang or crash the detector.
  it("#3 a cyclic object value does not crash or hang", () => {
    const cyclic: Record<string, unknown> = { a: "text" };
    cyclic.self = cyclic;
    const schemas: Schema[] = [{ name: "data", kind: "object", required: false, values: [cyclic], provenance: "placeholder" }];
    const report = build({
      mounts: [crashedMount(0, { data: cyclic }, "Invalid currency code : text")],
      schemas,
    });
    expect(report.combos[0].harnessFault?.propName).toBe("data");
  });

  // #4: two contract props, only the truthy one is attributed.
  it("#4 attributes to the truthy contract prop, not a falsy sibling", () => {
    const schemas: Schema[] = [
      { name: "render", kind: "function", required: false, values: [undefined], provenance: "contract" },
      { name: "asChild", kind: "boolean", required: false, values: [true, false], provenance: "contract" },
    ];
    const report = build({
      mounts: [crashedMount(0, { render: undefined, asChild: true }, "Primitive.div failed to slot onto its children.")],
      schemas,
    });
    expect(report.combos[0].harnessFault?.propName).toBe("asChild");
  });

  // #5: a report with one genuine failure and one harness-fault combo keeps
  // both hints (they are not mutually exclusive at the report level).
  it("#5 a mixed report shows both renderError and harnessFault hints", () => {
    const schemas: Schema[] = [{ name: "asChild", kind: "boolean", required: false, values: [true], provenance: "contract" }];
    const report = build({
      mounts: [
        crashedMount(0, { asChild: true }, "Primitive.div failed to slot onto its children."),
        crashedMount(1, { asChild: false }, "TypeError: genuine bug, unrelated"),
      ],
      schemas,
    });
    const hints = hintsForReport(report);
    expect(hints).toContain("harnessFault");
    expect(hints).toContain("renderError");
    expect(report.pass).toBe(false); // combo 1's genuine failure still fails the run
  });

  // #6: a capped, deduped pageErrors array (the "(+N more dropped)" suffix)
  // still lets the detector match against what survived the cap.
  it("#6 matches against a deduped/capped pageErrors array", () => {
    const schemas: Schema[] = [{ name: "src", kind: "string", required: false, values: ["test"], provenance: "placeholder" }];
    const report = build({
      mounts: [
        makeMountResult({
          comboIndex: 0,
          props: { src: "test" },
          domNodeCount: 0,
          pageErrors: {
            messages: ["Failed to decode image: test (×5)", "(+3 more dropped)"],
            fatal: true,
            dropped: 3,
          },
        }),
      ],
      schemas,
    });
    expect(report.combos[0].harnessFault?.propName).toBe("src");
  });

  // #7: fault detection is scoped per combo, not leaked across the report.
  it("#7 a harnessFault on one combo does not exonerate a sibling combo's unrelated crash", () => {
    const schemas: Schema[] = [{ name: "asChild", kind: "boolean", required: false, values: [true, false], provenance: "contract" }];
    const report = build({
      mounts: [
        crashedMount(0, { asChild: true }, "Primitive.div failed to slot onto its children."),
        crashedMount(1, { asChild: false }, "TypeError: real bug"),
      ],
      schemas,
    });
    expect(report.combos[0].harnessFault).toBeDefined();
    expect(report.combos[1].harnessFault).toBeUndefined();
    expect(report.combos[1].verdict).toBe("fail");
  });

  // #8: "declared" or "preset" provenance never fires even with a textual match.
  it("#8 declared/preset provenance never fires even when the value matches the error text", () => {
    const schemas: Schema[] = [
      { name: "label", kind: "string", required: false, values: ["broken-value"], provenance: "declared" },
      { name: "mode", kind: "string", required: false, values: ["broken-value"], provenance: "preset" },
    ];
    const report = build({
      mounts: [crashedMount(0, { label: "broken-value", mode: "broken-value" }, "Error: broken-value is not supported")],
      schemas,
    });
    expect(report.combos[0].harnessFault).toBeUndefined();
    expect(report.combos[0].verdict).toBe("fail");
  });

  // #9: an empty string value is never treated as evidence (it would match everything).
  it("#9 an empty-string placeholder value is never used as evidence", () => {
    const schemas: Schema[] = [{ name: "label", kind: "string", required: false, values: [""], provenance: "placeholder" }];
    const report = build({
      mounts: [crashedMount(0, { label: "" }, "TypeError: cannot read properties of null")],
      schemas,
    });
    expect(report.combos[0].harnessFault).toBeUndefined();
  });

  // #10: schemas present but none reference any prop actually in this combo
  // (a schema list from a different component / stale schema) never fires.
  it("#10 a schema whose name is absent from the combo's own props never fires", () => {
    const schemas: Schema[] = [{ name: "notInThisCombo", kind: "boolean", required: false, values: [true], provenance: "contract" }];
    const report = build({
      mounts: [crashedMount(0, { asChild: true }, "Primitive.div failed to slot onto its children.")],
      schemas,
    });
    expect(report.combos[0].harnessFault).toBeUndefined();
    expect(report.combos[0].verdict).toBe("fail");
  });
});
