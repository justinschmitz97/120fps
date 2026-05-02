import { describe, it, expect, afterEach } from "vitest";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import { explore } from "../../src/explorer.js";

let harness: HarnessResult | undefined;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = undefined;
});

describe("H1: nondeterministic component", () => {
  it("respects maxNodes limit even when every mount produces a unique state", async () => {
    harness = await buildAndServe("./fixtures/nondeterministic.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxNodes: 5,
      maxWallClockMs: 30000,
      maxDepth: 3,
      combos: [{}],
    });
    const graph = results[0].graph;
    expect(graph.nodes.size).toBeLessThanOrEqual(5);
  }, 60000);
});

describe("H2: link navigation safety", () => {
  it("does not crash when clicking a link that could navigate away", async () => {
    // interactive-basic.tsx has <a href="#link">
    harness = await buildAndServe("./fixtures/interactive-basic.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    expect(results).toHaveLength(1);
    expect(results[0].graph.nodes.size).toBeGreaterThanOrEqual(1);
  }, 60000);
});

describe("H3: many interactions wall clock", () => {
  it("completes within wall clock even with many buttons", async () => {
    harness = await buildAndServe("./fixtures/many-buttons.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxWallClockMs: 15000,
      combos: [{}],
    });
    expect(results[0].graph.wallClockMs).toBeLessThan(20000);
    expect(results[0].graph.edges.length).toBeGreaterThan(0);
  }, 30000);
});

describe("H4: depth-1 path replay", () => {
  it("correctly replays path to reach toggled state and explores from there", async () => {
    harness = await buildAndServe("./fixtures/toggle-button.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxDepth: 2,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    const graph = results[0].graph;
    // Should have at least the initial state and one toggled state
    expect(graph.nodes.size).toBeGreaterThanOrEqual(2);
    // Depth-1 node should have a non-empty pathFromRoot
    for (const [, node] of graph.nodes) {
      if (node.depth > 0) {
        expect(node.pathFromRoot.length).toBe(node.depth);
      }
    }
  }, 60000);
});

describe("H5: empty select element", () => {
  it("does not crash when select has no options", async () => {
    harness = await buildAndServe("./fixtures/empty-select.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxWallClockMs: 20000,
      combos: [{}],
    });
    expect(results).toHaveLength(1);
    expect(results[0].graph.nodes.size).toBeGreaterThanOrEqual(1);
  }, 60000);
});

describe("H6: file input", () => {
  it("does not crash when encountering input type=file", async () => {
    harness = await buildAndServe("./fixtures/file-input.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxWallClockMs: 20000,
      combos: [{}],
    });
    expect(results).toHaveLength(1);
    expect(results[0].graph.nodes.size).toBeGreaterThanOrEqual(1);
  }, 60000);
});

describe("H7: contenteditable exercise", () => {
  it("exercises contenteditable element without crash", async () => {
    harness = await buildAndServe("./fixtures/contenteditable.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxWallClockMs: 20000,
      combos: [{}],
    });
    expect(results).toHaveLength(1);
    expect(results[0].graph.edges.length).toBeGreaterThan(0);
  }, 60000);
});

describe("H8: discovery varies by state", () => {
  it("discovers potentially different interactions from different states", async () => {
    harness = await buildAndServe("./fixtures/toggle-button.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxDepth: 2,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    const graph = results[0].graph;
    // Initial state should have the toggle button
    const initial = graph.nodes.get(graph.initialNodeId)!;
    expect(initial.interactions.length).toBeGreaterThan(0);
    // Non-initial states should also have interactions recorded
    for (const [id, node] of graph.nodes) {
      if (id !== graph.initialNodeId) {
        expect(node.interactions).toBeDefined();
      }
    }
  }, 60000);
});

describe("H9: shadow DOM interaction exercise", () => {
  it("exercises shadow DOM elements without crash", async () => {
    harness = await buildAndServe("./fixtures/shadow-dom.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxWallClockMs: 20000,
      combos: [{}],
    });
    expect(results).toHaveLength(1);
    expect(results[0].graph.nodes.size).toBeGreaterThanOrEqual(1);
  }, 60000);
});

describe("H10: maxNodes halts exploration", () => {
  it("stops at maxNodes even when more states available", async () => {
    harness = await buildAndServe("./fixtures/counter.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxNodes: 3,
      maxDepth: 10,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    expect(results[0].graph.nodes.size).toBeLessThanOrEqual(3);
  }, 60000);
});

describe("H11: convergence on self-loops", () => {
  it("converges when all edges are self-loops (no new states)", async () => {
    harness = await buildAndServe("./fixtures/static-buttons.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    const graph = results[0].graph;
    // Only one node since buttons don't change state
    expect(graph.nodes.size).toBe(1);
    // All edges are self-loops
    for (const edge of graph.edges) {
      expect(edge.fromId).toBe(edge.toId);
    }
  }, 60000);
});

describe("H12: wall clock stops mid-sample", () => {
  it("respects wall clock even during sample collection", async () => {
    harness = await buildAndServe("./fixtures/counter.tsx");
    const results = await explore(harness, {
      samples: 20,
      maxWallClockMs: 5000,
      combos: [{}],
    });
    // Should have stopped before exhausting all possibilities
    expect(results[0].graph.wallClockMs).toBeLessThan(10000);
  }, 30000);
});

describe("H14: adaptive deepening prioritization", () => {
  it("explores slow-handler component and builds valid graph", async () => {
    harness = await buildAndServe("./fixtures/slow-handler.tsx");
    const results = await explore(harness, {
      samples: 3,
      maxDepth: 2,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    const graph = results[0].graph;
    expect(graph.nodes.size).toBeGreaterThanOrEqual(1);
    expect(graph.edges.length).toBeGreaterThan(0);
    // All edges should have valid timing data
    for (const edge of graph.edges) {
      expect(edge.samples.length).toBeGreaterThan(0);
      expect(edge.median).toBeGreaterThanOrEqual(0);
      expect(edge.p95).toBeGreaterThanOrEqual(0);
    }
  }, 60000);
});

describe("H15: browser cleanup on error", () => {
  it("cleans up browser even when exploration is cut short by limits", async () => {
    harness = await buildAndServe("./fixtures/counter.tsx");
    // Very tight limits to force early termination
    const results = await explore(harness, {
      samples: 2,
      maxNodes: 2,
      maxWallClockMs: 5000,
      maxDepth: 1,
      combos: [{}],
    });
    expect(results).toHaveLength(1);
    // No dangling browser — if cleanup failed, subsequent tests would leak
  }, 30000);
});
