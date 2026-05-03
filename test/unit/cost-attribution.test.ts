import { describe, it, expect } from "vitest";
import { attributeCost, type CostAttribution, type CostBucket } from "../../src/metrics.js";
import type { TraceEvent } from "../../src/measure.js";

function makeEvent(
  name: string,
  durUs: number,
  tsUs: number,
  url?: string,
): TraceEvent {
  const event: TraceEvent = {
    cat: "devtools.timeline",
    name,
    dur: durUs,
    ph: "X",
    ts: tsUs,
    args: url ? { data: { url } } : {},
  };
  return event;
}

describe("attributeCost", () => {
  it("returns empty buckets for empty events", () => {
    const result = attributeCost([]);
    expect(result.buckets).toHaveLength(0);
    expect(result.unattributed).toBe(0);
  });

  it("attributes FunctionCall to package from node_modules URL", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 5000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/motion.js?v=abc123"),
    ];
    const result = attributeCost(events);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].source).toBe("motion");
    expect(result.buckets[0].category).toBe("package");
    expect(result.buckets[0].durationMs).toBeCloseTo(5, 1);
    expect(result.buckets[0].percentage).toBeCloseTo(100, 1);
  });

  it("attributes scoped package from node_modules URL", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 4000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/@radix-ui_react-accordion.js?v=abc"),
    ];
    const result = attributeCost(events);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].source).toBe("@radix-ui/react-accordion");
    expect(result.buckets[0].category).toBe("package");
  });

  it("groups react/react-dom/scheduler into single react bucket", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 2000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/react-dom.js?v=abc"),
      makeEvent("FunctionCall", 1000, 4000,
        "http://localhost:5173/node_modules/.vite/deps/react.js?v=abc"),
      makeEvent("FunctionCall", 500, 6000,
        "http://localhost:5173/node_modules/.vite/deps/scheduler.js?v=abc"),
    ];
    const result = attributeCost(events);
    const reactBucket = result.buckets.find((b) => b.source === "react");
    expect(reactBucket).toBeDefined();
    expect(reactBucket!.category).toBe("react");
    expect(reactBucket!.durationMs).toBeCloseTo(3.5, 1);
    expect(result.buckets.filter((b) => b.category === "react")).toHaveLength(1);
  });

  it("attributes user code by relative file path", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 3000, 1000,
        "http://localhost:5173/src/components/Button.tsx"),
    ];
    const result = attributeCost(events);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].category).toBe("user");
    expect(result.buckets[0].source).toContain("Button.tsx");
  });

  it("puts events without URL into browser bucket", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 2000, 1000),
    ];
    const result = attributeCost(events);
    const browser = result.buckets.find((b) => b.category === "browser");
    expect(browser).toBeDefined();
    expect(browser!.source).toBe("browser");
    expect(browser!.durationMs).toBeCloseTo(2, 1);
  });

  it("strips query params from Vite URLs", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 1000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/motion.js?v=abc&t=123"),
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].source).toBe("motion");
  });

  it("resolves /@fs/ prefix URLs", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 1000, 1000,
        "http://localhost:5173/@fs/home/user/project/node_modules/motion/dist/index.js"),
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].source).toBe("motion");
    expect(result.buckets[0].category).toBe("package");
  });

  it("handles EvaluateScript events", () => {
    const events: TraceEvent[] = [
      makeEvent("EvaluateScript", 3000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/motion.js?v=abc"),
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].source).toBe("motion");
    expect(result.buckets[0].durationMs).toBeCloseTo(3, 1);
  });

  it("handles v8.compile events", () => {
    const events: TraceEvent[] = [
      makeEvent("v8.compile", 1000, 1000,
        "http://localhost:5173/src/App.tsx"),
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].category).toBe("user");
  });

  it("deduplicates nested events (child inside parent)", () => {
    const events: TraceEvent[] = [
      // Parent: 10ms total, starts at ts=1000
      makeEvent("FunctionCall", 10000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/react-dom.js"),
      // Child: 4ms, nested inside parent
      makeEvent("FunctionCall", 4000, 2000,
        "http://localhost:5173/node_modules/.vite/deps/motion.js"),
    ];
    const result = attributeCost(events);
    const reactBucket = result.buckets.find((b) => b.source === "react");
    const motionBucket = result.buckets.find((b) => b.source === "motion");
    expect(reactBucket).toBeDefined();
    expect(motionBucket).toBeDefined();
    // Parent gets 10ms - 4ms = 6ms, child gets 4ms
    expect(reactBucket!.durationMs).toBeCloseTo(6, 1);
    expect(motionBucket!.durationMs).toBeCloseTo(4, 1);
  });

  it("handles deeply nested events", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 10000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/react-dom.js"),
      makeEvent("FunctionCall", 6000, 2000,
        "http://localhost:5173/node_modules/.vite/deps/@radix-ui_react-accordion.js"),
      makeEvent("FunctionCall", 2000, 3000,
        "http://localhost:5173/src/Accordion.tsx"),
    ];
    const result = attributeCost(events);
    const react = result.buckets.find((b) => b.source === "react")!;
    const radix = result.buckets.find((b) => b.source === "@radix-ui/react-accordion")!;
    const user = result.buckets.find((b) => b.category === "user")!;
    // react: 10 - 6 = 4ms, radix: 6 - 2 = 4ms, user: 2ms
    expect(react.durationMs).toBeCloseTo(4, 1);
    expect(radix.durationMs).toBeCloseTo(4, 1);
    expect(user.durationMs).toBeCloseTo(2, 1);
  });

  it("computes percentages that sum to 100", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 6000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/motion.js"),
      makeEvent("FunctionCall", 4000, 8000,
        "http://localhost:5173/src/App.tsx"),
    ];
    const result = attributeCost(events);
    const totalPct = result.buckets.reduce((s, b) => s + b.percentage, 0);
    expect(totalPct).toBeCloseTo(100, 1);
  });

  it("skips non-scripting events", () => {
    const events: TraceEvent[] = [
      { cat: "devtools.timeline", name: "Paint", dur: 5000, ph: "X", ts: 1000 },
      { cat: "devtools.timeline", name: "Layout", dur: 3000, ph: "X", ts: 7000 },
      makeEvent("FunctionCall", 2000, 11000,
        "http://localhost:5173/src/App.tsx"),
    ];
    const result = attributeCost(events);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].durationMs).toBeCloseTo(2, 1);
  });

  it("groups multiple calls to same source", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 3000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/motion.js"),
      makeEvent("FunctionCall", 2000, 5000,
        "http://localhost:5173/node_modules/.vite/deps/motion.js"),
    ];
    const result = attributeCost(events);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].source).toBe("motion");
    expect(result.buckets[0].durationMs).toBeCloseTo(5, 1);
  });

  it("falls back to stackTrace callFrames when top-level url missing", () => {
    const events: TraceEvent[] = [
      {
        cat: "devtools.timeline",
        name: "FunctionCall",
        dur: 3000,
        ph: "X",
        ts: 1000,
        args: {
          data: {
            stackTrace: {
              callFrames: [
                { url: "http://localhost:5173/node_modules/.vite/deps/motion.js?v=abc" },
              ],
            },
          },
        },
      },
    ];
    const result = attributeCost(events);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].source).toBe("motion");
  });

  it("falls back to fileName field", () => {
    const events: TraceEvent[] = [
      {
        cat: "devtools.timeline",
        name: "FunctionCall",
        dur: 2000,
        ph: "X",
        ts: 1000,
        args: {
          data: {
            fileName: "http://localhost:5173/src/utils.ts",
          },
        },
      },
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].category).toBe("user");
  });

  it("falls back to scriptName field", () => {
    const events: TraceEvent[] = [
      {
        cat: "devtools.timeline",
        name: "EvaluateScript",
        dur: 2000,
        ph: "X",
        ts: 1000,
        args: {
          data: {
            scriptName: "http://localhost:5173/node_modules/.vite/deps/motion.js",
          },
        },
      },
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].source).toBe("motion");
  });

  it("handles chrome-extension and native URLs as browser", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 1000, 1000, "chrome-extension://abc/content.js"),
      makeEvent("FunctionCall", 1000, 3000, "native V8Runtime"),
    ];
    const result = attributeCost(events);
    const browser = result.buckets.find((b) => b.category === "browser");
    expect(browser).toBeDefined();
  });

  it("is deterministic — same events produce same result", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 5000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/motion.js"),
      makeEvent("FunctionCall", 3000, 7000,
        "http://localhost:5173/src/App.tsx"),
    ];
    const r1 = attributeCost(events);
    const r2 = attributeCost(events);
    expect(r1).toEqual(r2);
  });

  it("handles Vite pre-bundled scoped package underscore format", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 1000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/@radix-ui_react-collapsible.js"),
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].source).toBe("@radix-ui/react-collapsible");
  });

  it("handles react/jsx-runtime as react category", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 1000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/react_jsx-runtime.js"),
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].source).toBe("react");
    expect(result.buckets[0].category).toBe("react");
  });

  it("sorts buckets by durationMs descending", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 1000, 1000,
        "http://localhost:5173/src/A.tsx"),
      makeEvent("FunctionCall", 5000, 3000,
        "http://localhost:5173/node_modules/.vite/deps/motion.js"),
      makeEvent("FunctionCall", 3000, 9000,
        "http://localhost:5173/node_modules/.vite/deps/react-dom.js"),
    ];
    const result = attributeCost(events);
    for (let i = 1; i < result.buckets.length; i++) {
      expect(result.buckets[i - 1].durationMs).toBeGreaterThanOrEqual(
        result.buckets[i].durationMs,
      );
    }
  });

  it("sum of bucket durations + unattributed <= total scripting", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 6000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/motion.js"),
      makeEvent("FunctionCall", 4000, 2000,
        "http://localhost:5173/src/App.tsx"),
      makeEvent("FunctionCall", 2000, 8000,
        "http://localhost:5173/node_modules/.vite/deps/react-dom.js"),
    ];
    const result = attributeCost(events);
    const totalBucket = result.buckets.reduce((s, b) => s + b.durationMs, 0);
    expect(totalBucket + result.unattributed).toBeGreaterThan(0);
  });
});
