import { describe, it, expect } from "vitest";
import type { Page } from "playwright";
import {
  attachPageErrorCapture,
  enrichPhaseError,
  enrichTimeoutError,
  gotoWithErrorContext,
  HARNESS_STALL_HINT,
} from "../../src/page-errors.js";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";
import { formatTable, type CalibrationResult, type Report, type Thresholds } from "../../src/report.js";
import { hintsForReport } from "../../src/hints.js";
import { formatJUnit } from "../../src/ci-report.js";

// ====================================================================
// Fakes
// ====================================================================

type Handler = (payload: any) => void;

interface FakePage {
  page: Page;
  throwError(message: string): void;
  consoleError(text: string): void;
  consoleLog(text: string): void;
}

function fakePage(): FakePage {
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
    throwError: (message) => emit("pageerror", { message }),
    consoleError: (text) => emit("console", { type: () => "error", text: () => text }),
    consoleLog: (text) => emit("console", { type: () => "log", text: () => text }),
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
  const input: BuildReportInput = {
    componentPath: "./Button.tsx",
    componentName: "Button",
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

// ====================================================================
// C1: page errors reach the combo that produced them
// ====================================================================

describe("C1 drain()", () => {
  it("returns only the events recorded since the previous drain", () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);

    fake.throwError("first boom");
    const a = capture.drain();
    expect(a.messages).toEqual(["first boom"]);

    fake.throwError("second boom");
    const b = capture.drain();
    expect(b.messages).toEqual(["second boom"]);

    expect(capture.drain().messages).toEqual([]);
  });

  it("keeps errors/summary session-wide, so timeout enrichment is unchanged", () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);

    fake.throwError("first boom");
    capture.drain();
    fake.throwError("second boom");
    capture.drain();

    expect(capture.errors).toEqual(["first boom", "second boom"]);
    const enriched = enrichTimeoutError(
      new Error("Timeout 30000ms exceeded"),
      capture,
      "mount harness",
    );
    expect(enriched.message).toContain("first boom");
    expect(enriched.message).toContain("second boom");
  });

  it("marks the drain fatal only when an uncaught exception was recorded", () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);

    fake.consoleError("Warning: Each child in a list should have a unique key");
    const advisory = capture.drain();
    expect(advisory.messages).toHaveLength(1);
    expect(advisory.fatal).toBe(false);

    fake.throwError("TypeError: Cannot read properties of undefined");
    expect(capture.drain().fatal).toBe(true);
  });

  it("ignores non-error console output", () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);
    fake.consoleLog("just a log");
    expect(capture.drain().messages).toEqual([]);
  });

  it("dedupes repeats within one drain and annotates the count", () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);
    fake.throwError("same boom");
    fake.throwError("same boom");
    fake.throwError("same boom");
    expect(capture.drain().messages).toEqual(["same boom (×3)"]);
  });

  it("caps distinct entries at 20 per drain and counts the rest", () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);
    for (let i = 0; i < 25; i++) fake.throwError(`boom ${i}`);
    const drained = capture.drain();
    expect(drained.messages).toHaveLength(20);
    expect(drained.dropped).toBe(5);
  });

  it("caps the segment independently of the session buffer", () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);
    // Fill the session buffer past its cap, then drain and record one more.
    for (let i = 0; i < 25; i++) fake.throwError(`early ${i}`);
    capture.drain();
    fake.throwError("late but real");
    const drained = capture.drain();
    expect(drained.messages).toEqual(["late but real"]);
    expect(drained.fatal).toBe(true);
  });
});

describe("C1 combo attachment", () => {
  it("attaches mount-phase page errors to the combo that produced them", () => {
    const report = build({
      mounts: [
        makeMountResult({
          pageErrors: { messages: ["boom in mount"], fatal: true, dropped: 0 },
        }),
      ],
    });
    expect(report.combos[0].pageErrors).toEqual(["boom in mount"]);
  });

  it("merges rerender-phase errors into the same combo without duplicating", () => {
    const report = build({
      mounts: [
        makeMountResult({
          pageErrors: { messages: ["shared boom"], fatal: true, dropped: 0 },
        }),
      ],
      rerenders: [
        makeRerenderResult({
          pageErrors: { messages: ["shared boom", "rerender-only boom"], fatal: true, dropped: 0 },
        }),
      ],
    });
    expect(report.combos[0].pageErrors).toEqual(["shared boom", "rerender-only boom"]);
  });

  it("appends the dropped count so the cap is never silent", () => {
    const report = build({
      mounts: [
        makeMountResult({ pageErrors: { messages: ["boom"], fatal: true, dropped: 4 } }),
      ],
    });
    expect(report.combos[0].pageErrors).toEqual(["boom", "(+4 more dropped)"]);
  });

  it("leaves a healthy combo without pageErrors or renderHealth", () => {
    const report = build({ mounts: [makeMountResult()] });
    expect(report.combos[0].pageErrors).toBeUndefined();
    expect(report.combos[0].renderHealth).toBeUndefined();
  });
});

// ====================================================================
// C2: render-health gate
// ====================================================================

describe("C2 render-health gate", () => {
  it("fails a combo that rendered no DOM nodes while the page threw", () => {
    const report = build({
      mounts: [
        makeMountResult({
          domNodeCount: 0,
          pageErrors: { messages: ["TypeError: x is undefined"], fatal: true, dropped: 0 },
        }),
      ],
    });
    expect(report.combos[0].renderHealth).toBe("error");
    expect(report.combos[0].verdict).toBe("fail");
    expect(report.pass).toBe(false);
  });

  it("does not gate on console.error output alone", () => {
    const report = build({
      mounts: [
        makeMountResult({
          domNodeCount: 0,
          pageErrors: {
            messages: ["Warning: validateDOMNesting(...)"],
            fatal: false,
            dropped: 0,
          },
        }),
      ],
    });
    expect(report.combos[0].renderHealth).toBe("empty");
    expect(report.combos[0].verdict).not.toBe("fail");
    expect(report.combos[0].pageErrors).toEqual(["Warning: validateDOMNesting(...)"]);
    expect(report.pass).toBe(true);
  });

  it("marks a legitimately empty render without failing it", () => {
    const report = build({ mounts: [makeMountResult({ domNodeCount: 0 })] });
    expect(report.combos[0].renderHealth).toBe("empty");
    expect(report.combos[0].verdict).toBe("pass");
    expect(report.pass).toBe(true);
  });

  it("does not gate a combo that rendered DOM nodes despite an error", () => {
    const report = build({
      mounts: [
        makeMountResult({
          domNodeCount: 12,
          pageErrors: { messages: ["late async boom"], fatal: true, dropped: 0 },
        }),
      ],
    });
    expect(report.combos[0].renderHealth).toBeUndefined();
    expect(report.combos[0].verdict).toBe("pass");
    expect(report.combos[0].pageErrors).toEqual(["late async boom"]);
  });

  it("overrides the scale-combo pass exemption", () => {
    const report = build({
      mounts: [
        makeMountResult({
          comboIndex: 0,
          props: { __120fps_scaleN: 50 },
          domNodeCount: 0,
          pageErrors: { messages: ["boom at N=50"], fatal: true, dropped: 0 },
        }),
      ],
    });
    expect(report.combos[0].verdict).toBe("fail");
    expect(report.pass).toBe(false);
  });

  it("gates under --flat-thresholds too", () => {
    const report = build({
      flatThresholds: true,
      mounts: [
        makeMountResult({
          domNodeCount: 0,
          pageErrors: { messages: ["boom"], fatal: true, dropped: 0 },
        }),
      ],
    });
    expect(report.combos[0].verdict).toBe("fail");
    expect(report.pass).toBe(false);
  });
});

// ====================================================================
// C2: terminal surfacing
// ====================================================================

describe("C2 terminal output", () => {
  const errored = () =>
    build({
      mounts: [
        makeMountResult({
          domNodeCount: 0,
          pageErrors: { messages: ["TypeError: useWorkbench is not a function"], fatal: true, dropped: 0 },
        }),
      ],
    });

  it("marks the affected row and lists the errors", () => {
    const out = formatTable(errored());
    expect(out).toContain("[render error]");
    expect(out).toContain("Page errors");
    expect(out).toContain("TypeError: useWorkbench is not a function");
  });

  it("states why the combo could not pass", () => {
    const out = formatTable(errored());
    expect(out).toMatch(/combo 0 rendered 0 DOM nodes/i);
  });

  it("suppresses the fixture suggestion when a render error explains the silence", () => {
    const out = formatTable(errored());
    expect(out).not.toContain("Consider creating");
  });

  it("notes a legitimately empty render and keeps the fixture suggestion", () => {
    const out = formatTable(build({ mounts: [makeMountResult({ domNodeCount: 0 })] }));
    expect(out).toMatch(/rendered no DOM nodes/i);
    expect(out).toContain("Consider creating");
    expect(out).not.toContain("[render error]");
  });

  it("marks a row whose errors did not gate it", () => {
    const out = formatTable(
      build({
        mounts: [
          makeMountResult({
            domNodeCount: 5,
            pageErrors: { messages: ["a", "b"], fatal: true, dropped: 0 },
          }),
        ],
      }),
    );
    expect(out).toContain("[2 page errors]");
    expect(out).not.toContain("[render error]");
  });

  it("leaves a healthy report's output untouched", () => {
    const out = formatTable(build({ mounts: [makeMountResult()] }));
    expect(out).not.toContain("Page errors");
    expect(out).not.toContain("[render error]");
    expect(out).not.toContain("[no DOM]");
  });
});

describe("C2 hints and CI serializers", () => {
  const errored = build({
    mounts: [
      makeMountResult({
        domNodeCount: 0,
        pageErrors: { messages: ["TypeError: boom"], fatal: true, dropped: 0 },
      }),
    ],
  });

  it("derives a renderError hint", () => {
    expect(hintsForReport(errored)).toContain("renderError");
  });

  it("names the render error in the JUnit failure body instead of a budget breach", () => {
    const xml = formatJUnit([errored]);
    expect(xml).toMatch(/rendered 0 DOM nodes/i);
    expect(xml).toContain("TypeError: boom");
    expect(xml).not.toContain("over budget for tier");
  });
});

// ====================================================================
// C3: page.goto enrichment
// ====================================================================

describe("C3 gotoWithErrorContext", () => {
  function stubPage(err?: unknown) {
    return {
      async goto() {
        if (err) throw err;
      },
    };
  }

  it("attaches captured page errors to a navigation timeout", async () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);
    fake.throwError('Module "node:path" has been externalized');

    await expect(
      gotoWithErrorContext(
        stubPage(new Error("page.goto: Timeout 30000ms exceeded")) as any,
        "http://localhost:1/",
        capture,
        "component harness",
      ),
    ).rejects.toThrow(/component harness did not become ready within timeout/);

    await gotoWithErrorContext(
      stubPage(new Error("page.goto: Timeout 30000ms exceeded")) as any,
      "http://localhost:1/",
      capture,
      "component harness",
    ).catch((err: Error) => {
      expect(err.message).toContain('Module "node:path" has been externalized');
    });
  });

  it("passes a non-timeout navigation failure through unchanged", async () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);
    await expect(
      gotoWithErrorContext(
        stubPage(new Error("net::ERR_CONNECTION_REFUSED")) as any,
        "http://localhost:1/",
        capture,
        "component harness",
      ),
    ).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
  });

  it("resolves when navigation succeeds", async () => {
    const fake = fakePage();
    const capture = attachPageErrorCapture(fake.page);
    await expect(
      gotoWithErrorContext(stubPage() as any, "http://localhost:1/", capture, "x"),
    ).resolves.toBeUndefined();
  });
});

// ====================================================================
// C4: phase context on harness crashes
// ====================================================================

describe("C4 enrichPhaseError", () => {
  it("names phase, combo and component on a tracing timeout", () => {
    const err = enrichPhaseError(new Error("Tracing.tracingComplete timed out"), {
      phase: "mount",
      comboIndex: 3,
      component: "App.tsx",
    });
    expect(err.message).toContain("mount");
    expect(err.message).toContain("combo 3");
    expect(err.message).toContain("App.tsx");
    expect(err.message).toContain("Tracing.tracingComplete timed out");
  });

  it("adds one remediation hint for a stall-class failure", () => {
    const err = enrichPhaseError(new Error("Tracing.tracingComplete timed out"), {
      phase: "attribution",
      comboIndex: 0,
      component: "App.tsx",
    });
    expect(err.message).toContain(HARNESS_STALL_HINT);
    expect(err.message).toContain("--no-attribution");
  });

  it("adds the hint for frame starvation and a crashed target", () => {
    for (const message of ["frame starvation: rAF fence exceeded 10000ms", "Target crashed"]) {
      const err = enrichPhaseError(new Error(message), { phase: "rerender", comboIndex: 1 });
      expect(err.message).toContain(HARNESS_STALL_HINT);
    }
  });

  it("does not add the hint to an unrelated failure", () => {
    const err = enrichPhaseError(new Error("Calibration produced zero duration"), {
      phase: "mount",
      comboIndex: 0,
    });
    expect(err.message).not.toContain(HARNESS_STALL_HINT);
    expect(err.message).toContain("Calibration produced zero duration");
  });

  it("is idempotent, so a nested phase cannot stack prefixes", () => {
    const once = enrichPhaseError(new Error("Tracing.tracingComplete timed out"), {
      phase: "explore",
      comboIndex: 2,
    });
    const twice = enrichPhaseError(once, { phase: "mount", comboIndex: 9 });
    expect(twice).toBe(once);
    expect(twice.message).not.toContain("combo 9");
  });

  it("keeps the original error reachable as the cause", () => {
    const original = new Error("Tracing.tracingComplete timed out");
    const err = enrichPhaseError(original, { phase: "mount", comboIndex: 0 });
    expect(err.cause).toBe(original);
  });

  it("works without a combo index", () => {
    const err = enrichPhaseError(new Error("boom"), { phase: "explore" });
    expect(err.message).toContain("explore");
    expect(err.message).toContain("boom");
  });

  it("stringifies a non-Error throw", () => {
    const err = enrichPhaseError("plain string failure", { phase: "mount", comboIndex: 1 });
    expect(err.message).toContain("plain string failure");
  });
});
