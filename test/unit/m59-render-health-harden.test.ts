import { describe, it, expect } from "vitest";
import type { Page } from "playwright";
import {
  attachPageErrorCapture,
  enrichPhaseError,
  mergeDrains,
  renderDrain,
} from "../../src/page-errors.js";
import { isContextLostError } from "../../src/measure.js";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";
import {
  formatTable,
  computeVerdict,
  type CalibrationResult,
  type ComboReport,
  type MatrixReport,
  type Report,
  type Thresholds,
} from "../../src/report.js";
import { formatJUnit } from "../../src/ci-report.js";

type Handler = (payload: any) => void;

function fakePage() {
  const handlers = new Map<string, Handler[]>();
  const page = {
    on(event: string, handler: Handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  } as unknown as Page;
  const emit = (event: string, payload: unknown) => {
    for (const handler of handlers.get(event) ?? []) handler(payload);
  };
  return {
    page,
    throwError: (message: string) => emit("pageerror", { message }),
    consoleError: (text: string) => emit("console", { type: () => "error", text: () => text }),
  };
}

function makeMountResult(overrides: Partial<MountResult> = {}): MountResult {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [1.5, 1.5, 1.5], median: 1.5, p95: 1.5 },
    unmount: { samples: [0.5, 0.5, 0.5], median: 0.5, p95: 0.5 },
    domNodeCount: 10,
    ...overrides,
  };
}

function makeRerenderResult(overrides: Partial<RerenderResult> = {}): RerenderResult {
  return {
    comboIndex: 0,
    props: {},
    stable: { samples: [1, 1, 1], median: 1, p95: 1 },
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
  return buildReport({
    componentPath: "./Button.tsx",
    componentName: "Button",
    machine: baseMachine,
    calibration: baseCalibration,
    mounts,
    explores: mounts.map((m) => makeExploreResult(m.comboIndex)),
    heapDeltas: mounts.map(() => 0),
    thresholds: baseThresholds,
    ...overrides,
  });
}

// ====================================================================
// H1 — an error after paint must not gate a component that rendered
// ====================================================================

describe("H1: error after paint on a component that rendered", () => {
  it("reports the error and leaves the verdict to the budgets", () => {
    const report = build({
      mounts: [
        makeMountResult({
          domNodeCount: 4,
          pageErrors: { messages: ["effect blew up after paint"], fatal: true, dropped: 0 },
        }),
      ],
    });
    expect(report.combos[0].renderHealth).toBeUndefined();
    expect(report.combos[0].verdict).toBe("pass");
    expect(report.pass).toBe(true);
    expect(formatTable(report)).toContain("effect blew up after paint");
  });
});

// ====================================================================
// H2 — an error only the rerender pass saw
// ====================================================================

describe("H2: rerender-only error", () => {
  it("reaches the combo even though the mount pass stayed quiet", () => {
    const report = build({
      mounts: [makeMountResult({ domNodeCount: 4 })],
      rerenders: [
        makeRerenderResult({
          pageErrors: { messages: ["update render blew up"], fatal: true, dropped: 0 },
        }),
      ],
    });
    expect(report.combos[0].pageErrors).toEqual(["update render blew up"]);
  });

  it("does not gate on it when the mount rendered DOM", () => {
    const report = build({
      mounts: [makeMountResult({ domNodeCount: 4 })],
      rerenders: [
        makeRerenderResult({ pageErrors: { messages: ["boom"], fatal: true, dropped: 0 } }),
      ],
    });
    expect(report.combos[0].renderHealth).toBeUndefined();
  });

  it("gates when the mount rendered nothing and only the rerender threw", () => {
    const report = build({
      mounts: [makeMountResult({ domNodeCount: 0 })],
      rerenders: [
        makeRerenderResult({ pageErrors: { messages: ["boom"], fatal: true, dropped: 0 } }),
      ],
    });
    expect(report.combos[0].renderHealth).toBe("error");
  });
});

// ====================================================================
// H3 — StrictMode / repeated-sample duplicates
// ====================================================================

describe("H3: repeated identical errors", () => {
  it("collapses a double-invoked throw into one entry with a count", () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);
    fake.throwError("StrictCard: data is undefined");
    fake.throwError("StrictCard: data is undefined");
    const drained = capture.drain();
    expect(drained.messages).toEqual(["StrictCard: data is undefined (×2)"]);
    expect(drained.fatal).toBe(true);
  });

  it("keeps the row marker at one error, not one per sample", () => {
    const report = build({
      mounts: [
        makeMountResult({
          domNodeCount: 3,
          pageErrors: { messages: ["boom (×10)"], fatal: true, dropped: 0 },
        }),
      ],
    });
    expect(formatTable(report)).toContain("[1 page error]");
  });
});

// ====================================================================
// H4 — cap overflow
// ====================================================================

describe("H4: more distinct errors than the cap", () => {
  it("keeps 20, counts the rest, and still gates", () => {
    const drain = {
      messages: Array.from({ length: 20 }, (_, i) => `msg ${i}`),
      fatal: true,
      dropped: 6,
    };
    const report = build({
      mounts: [makeMountResult({ domNodeCount: 0, pageErrors: drain })],
    });
    expect(report.combos[0].pageErrors).toHaveLength(21);
    expect(report.combos[0].pageErrors!.at(-1)).toBe("(+6 more dropped)");
    expect(report.combos[0].renderHealth).toBe("error");
  });

  it("attaches a drain that dropped everything, so an all-overflow window is not silent", () => {
    const report = build({
      mounts: [
        makeMountResult({ domNodeCount: 3, pageErrors: { messages: [], fatal: false, dropped: 3 } }),
      ],
    });
    expect(report.combos[0].pageErrors).toEqual(["(+3 more dropped)"]);
  });
});

// ====================================================================
// H5 — non-Error throws and hostile message content
// ====================================================================

describe("H5: hostile error payloads", () => {
  it("records a thrown non-Error via the message Playwright reports", () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);
    fake.throwError("Uncaught plain string");
    expect(capture.drain()).toMatchObject({ messages: ["Uncaught plain string"], fatal: true });
  });

  it("escapes XML metacharacters in the JUnit failure body", () => {
    const report = build({
      mounts: [
        makeMountResult({
          domNodeCount: 0,
          pageErrors: {
            messages: ['TypeError: <Foo & "Bar"> is not a function'],
            fatal: true,
            dropped: 0,
          },
        }),
      ],
    });
    const xml = formatJUnit([report]);
    expect(xml).toContain("&lt;Foo &amp; &quot;Bar&quot;&gt;");
    expect(xml).not.toContain('<Foo & "Bar">');
  });
});

// ====================================================================
// H6 — the gate survives every verdict path
// ====================================================================

describe("H6: gate precedence", () => {
  it("overrides a would-be warn from unstable timings", () => {
    const combo: ComboReport = {
      comboIndex: 0,
      props: {},
      mount: { samples: [1, 9], median: 5, p95: 9, cv: 80, unstable: true },
      unmount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
      rerender: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
      domNodeCount: 0,
      heapDelta: 0,
      interactions: [],
      scalingCurve: null,
      relativeMount: 0.5,
      verdict: "pass",
      renderHealth: "error",
    };
    expect(computeVerdict(combo, baseThresholds)).toBe("fail");
  });

  it("leaves an empty render's verdict to the budgets", () => {
    const combo: ComboReport = {
      comboIndex: 0,
      props: {},
      mount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
      unmount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
      rerender: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
      domNodeCount: 0,
      heapDelta: 0,
      interactions: [],
      scalingCurve: null,
      relativeMount: 0.5,
      verdict: "pass",
      renderHealth: "empty",
    };
    expect(computeVerdict(combo, baseThresholds)).toBe("pass");
  });
});

// ====================================================================
// H7 — matrix mode
// ====================================================================

describe("H7: matrix mode", () => {
  it("fails the run and prints the errors on the matrix screen", () => {
    const report = build({
      mounts: [
        makeMountResult({
          domNodeCount: 0,
          pageErrors: { messages: ["cell boom"], fatal: true, dropped: 0 },
        }),
      ],
    });
    const cell = {
      comboIndex: 0,
      props: {},
      mount: report.combos[0].mount,
      rerender: report.combos[0].rerender,
      unmount: report.combos[0].unmount,
      domNodeCount: 0,
      tier: "T1" as const,
      verdict: report.combos[0].verdict,
      worstInteractionMs: null,
    };
    const matrixReport: MatrixReport = {
      axes: [{ propName: "variant", values: ["a"] }],
      cells: [cell],
      hotCells: [cell],
      coldCells: [cell],
      failingCells: [cell],
      compoundEffects: [],
    };
    report.matrixReport = matrixReport;
    expect(report.pass).toBe(false);
    const out = formatTable(report);
    expect(out).toContain("Page errors");
    expect(out).toContain("cell boom");
  });
});

// ====================================================================
// H8 — phase enrichment must not break retry detection
// ====================================================================

describe("H8: enriched errors stay matchable", () => {
  it("keeps isContextLostError true for a wrapped tracing timeout", () => {
    const err = enrichPhaseError(new Error("Tracing.tracingComplete timed out"), {
      phase: "mount",
      comboIndex: 2,
      component: "App.tsx",
    });
    expect(isContextLostError(err)).toBe(true);
  });

  it("keeps isContextLostError true for a wrapped destroyed context", () => {
    const err = enrichPhaseError(new Error("Execution context was destroyed"), {
      phase: "rerender",
      comboIndex: 0,
    });
    expect(isContextLostError(err)).toBe(true);
  });

  it("does not turn an unrelated error into a context-lost one", () => {
    const err = enrichPhaseError(new Error("Calibration produced zero duration"), {
      phase: "mount",
    });
    expect(isContextLostError(err)).toBe(false);
  });
});

// ====================================================================
// H9 — merge and render helpers
// ====================================================================

describe("H9: drain merging", () => {
  it("returns the other side when one is missing", () => {
    const drain = { messages: ["a"], fatal: true, dropped: 0 };
    expect(mergeDrains(undefined, drain)).toBe(drain);
    expect(mergeDrains(drain, undefined)).toBe(drain);
    expect(mergeDrains(undefined, undefined)).toBeUndefined();
  });

  it("keeps fatality from either side and sums the dropped counts", () => {
    const merged = mergeDrains(
      { messages: ["a"], fatal: false, dropped: 1 },
      { messages: ["b"], fatal: true, dropped: 2 },
    );
    expect(merged).toEqual({ messages: ["a", "b"], fatal: true, dropped: 3 });
  });

  it("renders a drain without a dropped entry when nothing was dropped", () => {
    expect(renderDrain({ messages: ["a"], fatal: true, dropped: 0 })).toEqual(["a"]);
  });
});

// ====================================================================
// H10 — quiet runs are untouched
// ====================================================================

describe("H10: no page errors anywhere", () => {
  it("serializes a healthy report without either new field", () => {
    const report = build({ mounts: [makeMountResult()] });
    const json = JSON.stringify(report);
    expect(json).not.toContain("pageErrors");
    expect(json).not.toContain("renderHealth");
  });

  it("keeps a plain empty drain off the report entirely", () => {
    const report = build({
      mounts: [
        makeMountResult({ domNodeCount: 7, pageErrors: { messages: [], fatal: false, dropped: 0 } }),
      ],
    });
    expect(report.combos[0].pageErrors).toBeUndefined();
  });
});

// ====================================================================
// H11 — console-only noise on a rendering component
// ====================================================================

describe("H11: dev warnings on a healthy component", () => {
  it("never produces a fatal drain from console.error alone", () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);
    fake.consoleError("Warning: validateDOMNesting(...)");
    fake.consoleError("Warning: Each child in a list should have a unique key");
    const drained = capture.drain();
    expect(drained.fatal).toBe(false);
    expect(drained.messages).toHaveLength(2);
  });

  it("clears fatality on the next window once the throw stops repeating", () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);
    fake.throwError("boom");
    expect(capture.drain().fatal).toBe(true);
    fake.consoleError("Warning: still noisy");
    expect(capture.drain().fatal).toBe(false);
  });
});
