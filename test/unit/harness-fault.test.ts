import { describe, it, expect } from "vitest";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";
import { formatTable, type CalibrationResult, type Report, type Thresholds, type PropProvenance } from "../../src/report.js";
import { hintsForReport } from "../../src/hints.js";
import type { MountResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";
import type { PropSchema } from "../../src/prop-gen.js";

// M85: a combo whose fatal crash traces to a harness-synthesized value with a
// risky provenance must not count as the component's own failure. Fixtures
// mirror the two live repros: radix-primitives' `asChild=true` (a "contract"
// prop synthesized truthy with no satisfying child) and commerce's nested
// `label.currencyCode: "text"` (a "placeholder" value whose text appears
// verbatim in the page's own thrown error).

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
    componentPath: "./Separator.tsx",
    componentName: "Separator",
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

const ASCHILD_SCHEMAS: Schema[] = [
  { name: "asChild", kind: "boolean", required: false, values: [true, false], provenance: "contract" },
];

function crashedCombo(props: Record<string, unknown>, message: string): Partial<BuildReportInput> {
  return {
    mounts: [
      makeMountResult({
        props,
        domNodeCount: 0,
        pageErrors: { messages: [message], fatal: true, dropped: 0 },
      }),
    ],
  };
}

describe("M85 contract-provenance fault (radix asChild)", () => {
  it("sets harnessFault and demotes the verdict for a truthy contract prop", () => {
    const report = build({
      ...crashedCombo(
        { asChild: true },
        "Primitive.div failed to slot onto its children. Expected a single React element child.",
      ),
      schemas: ASCHILD_SCHEMAS,
    });
    const combo = report.combos[0];
    expect(combo.renderHealth).toBe("error");
    expect(combo.harnessFault).toBeDefined();
    expect(combo.harnessFault?.propName).toBe("asChild");
    expect(combo.harnessFault?.value).toBe(true);
    expect(combo.harnessFault?.provenance).toBe("contract");
    expect(combo.verdict).not.toBe("fail");
    expect(report.pass).toBe(true);
  });

  it("does not fire when the contract prop is falsy", () => {
    const report = build({
      ...crashedCombo({ asChild: false }, "TypeError: unrelated crash"),
      schemas: ASCHILD_SCHEMAS,
    });
    expect(report.combos[0].harnessFault).toBeUndefined();
    expect(report.combos[0].verdict).toBe("fail");
    expect(report.pass).toBe(false);
  });
});

describe("M85 placeholder/heuristic-provenance fault (commerce nested currencyCode)", () => {
  const NESTED_SCHEMAS: Schema[] = [
    {
      name: "label",
      kind: "object",
      required: false,
      values: [{ title: "text", amount: "text", currencyCode: "text" }],
      provenance: "placeholder",
    },
  ];

  it("sets harnessFault for a nested value that appears in the captured error text", () => {
    const report = build({
      ...crashedCombo(
        { label: { title: "text", amount: "text", currencyCode: "text" } },
        "Invalid currency code : text",
      ),
      schemas: NESTED_SCHEMAS,
    });
    const combo = report.combos[0];
    expect(combo.harnessFault).toBeDefined();
    expect(combo.harnessFault?.propName).toBe("label");
    expect(combo.harnessFault?.provenance).toBe("placeholder");
    expect(combo.harnessFault?.evidence).toContain("Invalid currency code : text");
    expect(combo.verdict).not.toBe("fail");
    expect(report.pass).toBe(true);
  });

  it("does not fire when the placeholder value is absent from the error text (presence is not evidence)", () => {
    const report = build({
      ...crashedCombo(
        { label: { title: "text", amount: "text", currencyCode: "text" } },
        "TypeError: Cannot read properties of undefined (reading 'map')",
      ),
      schemas: NESTED_SCHEMAS,
    });
    expect(report.combos[0].harnessFault).toBeUndefined();
    expect(report.combos[0].verdict).toBe("fail");
    expect(report.pass).toBe(false);
  });

  it("a top-level placeholder value matching the error text also fires", () => {
    const report = build({
      ...crashedCombo({ src: "test" }, "Failed to decode image: test"),
      schemas: [{ name: "src", kind: "string", required: false, values: ["test"], provenance: "placeholder" }],
    });
    expect(report.combos[0].harnessFault?.propName).toBe("src");
    expect(report.combos[0].verdict).not.toBe("fail");
  });
});

describe("M85 fallback safety: absent or irrelevant provenance never exonerates a real failure", () => {
  it("leaves a genuine failure alone when no schemas are supplied at all", () => {
    const report = build(crashedCombo({ asChild: true }, "Primitive.div failed to slot onto its children."));
    expect(report.combos[0].harnessFault).toBeUndefined();
    expect(report.combos[0].verdict).toBe("fail");
    expect(report.pass).toBe(false);
  });

  it("leaves a genuine failure alone when every schema's provenance is declared", () => {
    const report = build({
      ...crashedCombo({ count: 5 }, "TypeError: this.items is not iterable"),
      schemas: [{ name: "count", kind: "number", required: false, values: [5], provenance: "declared" }],
    });
    expect(report.combos[0].harnessFault).toBeUndefined();
    expect(report.combos[0].verdict).toBe("fail");
    expect(report.pass).toBe(false);
  });

  it("MUST NOT: a component whose only failing combo is unrelated to any risky prop still reports FAIL", () => {
    const report = build({
      ...crashedCombo({ label: "USD" }, "TypeError: Cannot read properties of null (reading 'focus')"),
      schemas: [{ name: "label", kind: "string", required: false, values: ["USD"], provenance: "heuristic" }],
    });
    expect(report.combos[0].harnessFault).toBeUndefined();
    expect(report.pass).toBe(false);
  });

  it("does not fire on a combo that is not a fatal render error, even with a truthy contract prop", () => {
    const report = build({
      mounts: [makeMountResult({ props: { asChild: true }, domNodeCount: 5 })],
      schemas: ASCHILD_SCHEMAS,
    });
    expect(report.combos[0].renderHealth).toBeUndefined();
    expect(report.combos[0].harnessFault).toBeUndefined();
    expect(report.combos[0].verdict).toBe("pass");
  });
});

describe("M85 disclosure", () => {
  const faulted = () =>
    build({
      ...crashedCombo(
        { asChild: true },
        "Primitive.div failed to slot onto its children. Expected a single React element child.",
      ),
      schemas: ASCHILD_SCHEMAS,
    });

  it("marks the row [harness fault: asChild] in the console table", () => {
    const out = formatTable(faulted());
    expect(out).toContain("[harness fault: asChild]");
  });

  it("names the prop and states the combo was excluded, not counted, in the page-errors block", () => {
    const out = formatTable(faulted());
    expect(out).toContain("asChild");
    expect(out).not.toMatch(/counted as a failure, not a pass/);
  });

  it("still shows Result: PASS at the top when the only failing combo is a harness fault", () => {
    const out = formatTable(faulted());
    expect(out).toContain("Result: PASS");
  });

  it("excludes the generic renderError hint and includes a harnessFault hint", () => {
    const hints = hintsForReport(faulted());
    expect(hints).not.toContain("renderError");
    expect(hints).toContain("harnessFault");
  });

  it("JSON report carries harnessFault on the combo", () => {
    const report = faulted();
    const json = JSON.parse(JSON.stringify(report));
    expect(json.combos[0].harnessFault).toEqual({
      propName: "asChild",
      value: true,
      provenance: "contract",
      evidence: expect.stringContaining("Primitive.div"),
    });
  });
});

describe("M85 invariants", () => {
  it("harnessFault.propName always names a prop present on the combo", () => {
    const report = build({
      ...crashedCombo(
        { asChild: true, size: "md" },
        "Primitive.div failed to slot onto its children.",
      ),
      schemas: ASCHILD_SCHEMAS,
    });
    const fault = report.combos[0].harnessFault;
    expect(fault).toBeDefined();
    expect(Object.keys(report.combos[0].props)).toContain(fault!.propName);
  });

  it("a harnessFault combo always keeps renderHealth: error", () => {
    const report = build({
      ...crashedCombo({ asChild: true }, "Primitive.div failed to slot onto its children."),
      schemas: ASCHILD_SCHEMAS,
    });
    expect(report.combos[0].renderHealth).toBe("error");
  });
});
