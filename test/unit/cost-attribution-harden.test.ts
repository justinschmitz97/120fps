import { describe, it, expect } from "vitest";
import { attributeCost } from "../../src/report/index.js";
import type { TraceEvent } from "../../src/browser/index.js";

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

describe("attributeCost hardening", () => {
  it("H1: skips events without ts field without crashing", () => {
    const events: TraceEvent[] = [
      { cat: "devtools.timeline", name: "FunctionCall", dur: 1000, ph: "X", args: { data: { url: "http://localhost:5173/src/A.tsx" } } },
      makeEvent("FunctionCall", 2000, 5000, "http://localhost:5173/src/B.tsx"),
    ];
    const result = attributeCost(events);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].source).toContain("B.tsx");
  });

  it("H2: events with dur=0 do not contribute duration", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 0, 1000, "http://localhost:5173/src/A.tsx"),
      makeEvent("FunctionCall", 3000, 2000, "http://localhost:5173/src/B.tsx"),
    ];
    const result = attributeCost(events);
    const bBucket = result.buckets.find((b) => b.source.includes("B.tsx"));
    expect(bBucket).toBeDefined();
    expect(bBucket!.durationMs).toBeCloseTo(3, 1);
  });

  it("H3: Vite chunk files classified as package", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 2000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/chunk-ABCDEF.js?v=123"),
    ];
    const result = attributeCost(events);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].category).toBe("package");
    expect(result.buckets[0].source).toBe("chunk-ABCDEF");
  });

  it("H4: /@id/ virtual module URLs treated as user code", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 1000, 1000,
        "http://localhost:5173/@id/virtual:module"),
    ];
    const result = attributeCost(events);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].category).toBe("user");
  });

  it("H5: deeply nested 5 levels correctly deducts child durations", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 50000, 1000, "http://localhost:5173/node_modules/.vite/deps/react-dom.js"),
      makeEvent("FunctionCall", 40000, 2000, "http://localhost:5173/node_modules/.vite/deps/@radix-ui_react-accordion.js"),
      makeEvent("FunctionCall", 30000, 3000, "http://localhost:5173/node_modules/.vite/deps/motion.js"),
      makeEvent("FunctionCall", 20000, 4000, "http://localhost:5173/src/Accordion.tsx"),
      makeEvent("FunctionCall", 10000, 5000, "http://localhost:5173/src/utils.ts"),
    ];
    const result = attributeCost(events);
    const react = result.buckets.find((b) => b.source === "react")!;
    const radix = result.buckets.find((b) => b.source === "@radix-ui/react-accordion")!;
    const motion = result.buckets.find((b) => b.source === "motion")!;
    // Each level gets 10ms net (50-40=10, 40-30=10, 30-20=10, 20-10=10, 10=10)
    expect(react.durationMs).toBeCloseTo(10, 1);
    expect(radix.durationMs).toBeCloseTo(10, 1);
    expect(motion.durationMs).toBeCloseTo(10, 1);
    const totalPct = result.buckets.reduce((s, b) => s + b.percentage, 0);
    expect(totalPct).toBeCloseTo(100, 0);
  });

  it("H6: sequential events at different timestamps are not nested", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 3000, 1000, "http://localhost:5173/src/A.tsx"),
      makeEvent("FunctionCall", 3000, 5000, "http://localhost:5173/src/B.tsx"),
    ];
    const result = attributeCost(events);
    const a = result.buckets.find((b) => b.source.includes("A.tsx"))!;
    const b = result.buckets.find((b) => b.source.includes("B.tsx"))!;
    expect(a.durationMs).toBeCloseTo(3, 1);
    expect(b.durationMs).toBeCloseTo(3, 1);
  });

  it("H7: Windows /@fs/ path with drive letter resolves node_modules", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 2000, 1000,
        "http://localhost:5173/@fs/C:/Users/dev/project/node_modules/motion/dist/index.js"),
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].source).toBe("motion");
    expect(result.buckets[0].category).toBe("package");
  });

  it("H8: empty string URL treated as browser", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 1000, 1000, ""),
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].category).toBe("browser");
  });

  it("H9: URL with different port resolves correctly", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 1000, 1000,
        "http://localhost:3000/node_modules/.vite/deps/motion.js"),
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].source).toBe("motion");
  });

  it("H10: single event percentage is exactly 100", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 5000, 1000, "http://localhost:5173/src/A.tsx"),
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].percentage).toBe(100);
  });

  it("H11: handles 500 events without issues", () => {
    const events: TraceEvent[] = [];
    for (let i = 0; i < 500; i++) {
      events.push(
        makeEvent("FunctionCall", 100, i * 200,
          `http://localhost:5173/src/file${i % 10}.tsx`),
      );
    }
    const result = attributeCost(events);
    expect(result.buckets.length).toBeGreaterThan(0);
    expect(result.buckets.length).toBeLessThanOrEqual(10);
    const total = result.buckets.reduce((s, b) => s + b.durationMs, 0);
    expect(total).toBeGreaterThan(0);
  });

  it("H12: FunctionCall + EvaluateScript + v8.compile from same source merge", () => {
    const url = "http://localhost:5173/node_modules/.vite/deps/motion.js";
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 1000, 1000, url),
      makeEvent("EvaluateScript", 2000, 3000, url),
      makeEvent("v8.compile", 500, 6000, url),
    ];
    const result = attributeCost(events);
    expect(result.buckets).toHaveLength(1);
    expect(result.buckets[0].source).toBe("motion");
    expect(result.buckets[0].durationMs).toBeCloseTo(3.5, 1);
  });

  it("H13: scoped package @org/complex-pkg-name resolves correctly", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 1000, 1000,
        "http://localhost:5173/node_modules/.vite/deps/@tanstack_react-query.js"),
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].source).toBe("@tanstack/react-query");
  });

  it("H14: deeply nested user file retains relative path", () => {
    const events: TraceEvent[] = [
      makeEvent("FunctionCall", 1000, 1000,
        "http://localhost:5173/src/components/ui/Button.tsx"),
    ];
    const result = attributeCost(events);
    expect(result.buckets[0].category).toBe("user");
    expect(result.buckets[0].source).toBe("src/components/ui/Button.tsx");
  });

  it("H15: B/E phase events (not X) are skipped", () => {
    const events: TraceEvent[] = [
      { cat: "devtools.timeline", name: "FunctionCall", dur: 1000, ph: "B", ts: 1000, args: { data: { url: "http://localhost:5173/src/A.tsx" } } },
      { cat: "devtools.timeline", name: "FunctionCall", dur: 1000, ph: "E", ts: 2000, args: { data: { url: "http://localhost:5173/src/A.tsx" } } },
    ];
    const result = attributeCost(events);
    expect(result.buckets).toHaveLength(0);
  });
});
