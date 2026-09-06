import { describe, it, expect } from "vitest";
import { explore, type StateGraph } from "../../src/analysis/index.js";
import type { HarnessResult } from "../../src/harness/index.js";
import type { BrowserPool } from "../../src/browser/index.js";

// specs/milestones/m116-explore-replays-and-graph-walks-are-paid-for-once.md: replay once per edge.

interface Recorder {
  mounts: number;
  clicks: string[];
  wheels: number;
  cdpSends: string[];
  observedReads: number;
}

interface RawElementSeed {
  tagName: string;
  selector: string;
  scrollAxis?: string;
}

function rawElement(seed: RawElementSeed): Record<string, unknown> {
  return {
    tagName: seed.tagName,
    id: "",
    role: "",
    ariaLabel: "",
    ariaControls: "",
    ariaHaspopup: "",
    ariaExpanded: "",
    ariaValueNow: "",
    ariaOrientation: "",
    cursor: "",
    tabindex: null,
    inputType: "",
    textContent: seed.tagName === "BUTTON" ? "Save" : "",
    dataTestid: "",
    hasOnclick: false,
    hasOnkeydown: false,
    hasOnkeyup: false,
    hasOnkeypress: false,
    hasOnmousedown: false,
    hasOnmouseup: false,
    scrollAxis: seed.scrollAxis ?? "",
    isContentEditable: false,
    isHidden: false,
    selector: seed.selector,
    inShadow: false,
  };
}

const OBSERVED_WINDOW = {
  events: [
    { name: "click", interactionId: 1, durationMs: 20, delayMs: 0, processingMs: 4 },
  ],
  longFrames: [],
  layoutShiftScore: 0,
  windowMs: 20,
  eventTimingUnavailable: false,
};

interface FakeOptions {
  elements: RawElementSeed[];
  // Which readObservedWindow call loses the target once, like a crashed renderer.
  loseTargetOnRead?: number;
  // Which mouse.wheel call throws once (element left DOM); stepsFailed marks the miss.
  failWheelOnCall?: number;
  // True times the run like the shipped default: a real trace lifecycle, not PerformanceObserver.
  traceTiming?: boolean;
}

const HARNESS_ORIGIN = "http://localhost:5173";

function fakeHarnessRun(options: FakeOptions): {
  pool: BrowserPool;
  harness: HarnessResult;
  rec: Recorder;
} {
  const rec: Recorder = { mounts: 0, clicks: [], wheels: 0, cdpSends: [], observedReads: 0 };
  const raws = options.elements.map(rawElement);

  const evaluate = async (fn: unknown): Promise<unknown> => {
    const src = String(fn);
    if (src.includes("unmount()")) {
      rec.mounts++;
      return undefined;
    }
    if (src.includes("SCROLLABLE_OVERFLOW")) return { elements: raws, origin: HARNESS_ORIGIN };
    if (src.includes("aria-haspopup")) return [];
    if (src.includes("PerformanceObserver")) return undefined;
    if (src.includes("eventTimingUnavailable")) {
      rec.observedReads++;
      if (options.loseTargetOnRead === rec.observedReads) {
        throw new Error("Target closed");
      }
      return OBSERVED_WINDOW;
    }
    if (src.includes("performance.now()")) return undefined;
    if (src.includes("scrollBehavior")) return { x: 40, y: 40, delta: 100 };
    if (src.includes("getAttributeNames")) return {};
    if (src.includes("volatilePaths")) return '<div id="root"><div id="list"></div></div>';
    if (src.includes("requestAnimationFrame")) return undefined;
    if (src.includes("setTimeout")) return undefined;
    if (src.includes("viewport")) return undefined;
    // The escape check: this fake page never leaves the harness.
    if (src.includes("__120fps")) return true;
    throw new Error(`unhandled page.evaluate in fake: ${src.slice(0, 120)}`);
  };

  // M52: CDP fake answers Tracing.start/end; see test/unit/trace-recovery.test.ts.
  const listeners = new Map<string, ((arg: unknown) => void)[]>();
  const fire = (event: string, arg: unknown): void => {
    for (const fn of listeners.get(event) ?? []) fn(arg);
  };
  const cdp = {
    send: async (method: string) => {
      rec.cdpSends.push(method);
      if (method === "Tracing.end") {
        fire("Tracing.dataCollected", { value: [] });
        fire("Tracing.tracingComplete", undefined);
      }
      return {};
    },
    detach: async () => {},
    on: (event: string, fn: (arg: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    once: (event: string, fn: (arg: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    },
    off: (event: string, fn: (arg: unknown) => void) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn));
    },
  };

  const page = {
    on: () => {},
    off: () => {},
    context: () => ({ newCDPSession: async () => cdp }),
    goto: async () => {},
    waitForFunction: async () => {},
    setViewportSize: async () => {},
    evaluate,
    click: async (selector: string) => {
      rec.clicks.push(selector);
    },
    focus: async () => {},
    hover: async () => {},
    fill: async () => {},
    selectOption: async () => {},
    keyboard: { press: async () => {}, type: async () => {} },
    mouse: {
      move: async () => {},
      wheel: async () => {
        rec.wheels++;
        if (options.failWheelOnCall === rec.wheels) {
          throw new Error("Element is not attached to the DOM");
        }
      },
      down: async () => {},
      up: async () => {},
    },
  };

  const context = { newPage: async () => page, close: async () => {} };
  const pool = {
    acquire: async () => ({ newContext: async () => context }),
    stats: () => ({ launched: 1 }),
    closeAll: async () => {},
  } as unknown as BrowserPool;

  const harness = {
    url: "http://localhost:5173/harness/index.html",
    componentPath: "fixtures/large-dom.tsx",
    harnessDir: "/tmp/.120fps-harness-fake",
  } as unknown as HarnessResult;

  return { pool, harness, rec };
}

async function exploreWithFake(
  options: FakeOptions,
  samples: number,
): Promise<{ graph: StateGraph; rec: Recorder; warnings: string[] }> {
  const { pool, harness, rec } = fakeHarnessRun(options);
  const warnings: string[] = [];
  const results = await explore(harness, {
    pool,
    combos: [{}],
    samples,
    warmupRuns: 0,
    observerTiming: options.traceTiming !== true,
    seed: 42,
    onWarning: (w) => warnings.push(w),
  });
  return { graph: results[0].graph, rec, warnings };
}

function graphShape(graph: StateGraph): unknown {
  return {
    initialNodeId: graph.initialNodeId,
    nodeIds: [...graph.nodes.keys()],
    edges: graph.edges.map((e) => ({
      id: e.id,
      fromId: e.fromId,
      toId: e.toId,
      selector: e.interaction.selector,
      type: e.interaction.type,
      label: e.interaction.label,
      portal: e.interaction.portal,
      stressPattern: e.stressPattern,
      stressSteps: e.stressSteps,
    })),
  };
}

const SCROLL_ONLY: FakeOptions = {
  elements: [{ tagName: "DIV", selector: "#list", scrollAxis: "vertical" }],
};
const CLICK_ONLY: FakeOptions = {
  elements: [{ tagName: "BUTTON", selector: "button" }],
};

describe("a state-invariant edge replays its path once, not once per sample", () => {
  it("mounts once for a scroll sweep measured five times", async () => {
    const { graph, rec } = await exploreWithFake(SCROLL_ONLY, 5);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].stressPattern).toBe("scroll-sweep");
    expect(graph.edges[0].samples).toHaveLength(5);
    // One mount for the initial state, one for the edge's single replay.
    expect(rec.mounts).toBe(2);
  });

  it("still records the sample count the caller asked for", async () => {
    const { graph } = await exploreWithFake(SCROLL_ONLY, 5);
    expect(graph.edges[0].samples).toHaveLength(5);
    expect(graph.edges[0].median).toBeGreaterThan(0);
  });

  it("runs the pattern once per sample even though the path is replayed once", async () => {
    const { rec } = await exploreWithFake(SCROLL_ONLY, 5);
    // scroll-sweep is 20 wheel ticks; five samples exercise all of them.
    expect(rec.wheels).toBe(100);
  });

  it("collects garbage before every sample, as the per-sample replay did", async () => {
    const { rec } = await exploreWithFake(SCROLL_ONLY, 5);
    expect(rec.cdpSends.filter((m) => m === "HeapProfiler.collectGarbage")).toHaveLength(5);
  });
});

describe("the state graph is what the per-sample replay produced", () => {
  it("matches the one-sample arm, where hoisting the replay is a no-op", async () => {
    const five = await exploreWithFake(SCROLL_ONLY, 5);
    const one = await exploreWithFake(SCROLL_ONLY, 1);
    expect(graphShape(five.graph)).toEqual(graphShape(one.graph));
  });

  it("keeps the self-loop the state-invariant flag decides", async () => {
    const { graph } = await exploreWithFake(SCROLL_ONLY, 5);
    expect(graph.edges[0].toId).toBe(graph.initialNodeId);
    expect(graph.edges[0].fromId).toBe(graph.initialNodeId);
    expect([...graph.nodes.keys()]).toEqual([graph.initialNodeId]);
  });

  it("warns about nothing", async () => {
    const { warnings } = await exploreWithFake(SCROLL_ONLY, 5);
    expect(warnings).toEqual([]);
  });
});

describe("an edge whose pattern is not state-invariant replays per sample", () => {
  it("mounts once per sample for a click edge", async () => {
    const { graph, rec } = await exploreWithFake(CLICK_ONLY, 5);
    expect(graph.edges[0].interaction.type).toBe("click");
    expect(graph.edges[0].samples).toHaveLength(5);
    // One mount for the initial state, one per sample.
    expect(rec.mounts).toBe(6);
  });
});

describe("a retry replays the path before the sample that follows it", () => {
  it("re-navigates after a lost target instead of measuring from the wreck", async () => {
    const { graph, rec } = await exploreWithFake(
      { ...SCROLL_ONLY, loseTargetOnRead: 3 },
      5,
    );
    expect(graph.edges[0].samples).toHaveLength(5);
    // Initial state, the edge's first replay, and the replay the retry forces.
    expect(rec.mounts).toBe(3);
  });
});

describe("the trace path -- the shipped default -- replays the same way", () => {
  it("mounts once for a scroll sweep measured five times", async () => {
    const { graph, rec } = await exploreWithFake({ ...SCROLL_ONLY, traceTiming: true }, 5);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].stressPattern).toBe("scroll-sweep");
    expect(graph.edges[0].samples).toHaveLength(5);
    expect(rec.cdpSends).toContain("Tracing.start");
    expect(rec.mounts).toBe(2);
  });

  it("mounts once per sample for a click edge", async () => {
    const { graph, rec } = await exploreWithFake({ ...CLICK_ONLY, traceTiming: true }, 5);
    expect(graph.edges[0].interaction.type).toBe("click");
    expect(graph.edges[0].samples).toHaveLength(5);
    expect(rec.mounts).toBe(6);
  });
});

describe("a sample whose pattern step failed does not hand its state on", () => {
  it("replays the path after a swallowed wheel failure, on both timing paths", async () => {
    // A thrown wheel aborts the sweep but stepsRun===stepsPlanned; stepsFailed marks the miss.
    for (const traceTiming of [false, true]) {
      const { graph, rec } = await exploreWithFake(
        { ...SCROLL_ONLY, failWheelOnCall: 5, traceTiming },
        5,
      );
      expect(graph.edges[0].samples).toHaveLength(5);
      // Initial state, first replay, and the replay the failed step forces before sample 2.
      expect(rec.mounts).toBe(3);
    }
  });

  it("mounts twice when every sweep completes", async () => {
    const { rec } = await exploreWithFake(SCROLL_ONLY, 5);
    expect(rec.mounts).toBe(2);
  });
});
