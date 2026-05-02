import { describe, it, expect, afterEach } from "vitest";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import { explore } from "../../src/explorer.js";

let harness: HarnessResult | undefined;

afterEach(async () => {
  if (harness) await harness.cleanup();
  harness = undefined;
});

describe("explore e2e", () => {
  it("builds single-node graph for static component", async () => {
    harness = await buildAndServe("./fixtures/static-buttons.tsx");
    const results = await explore(harness, {
      samples: 3,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    expect(results).toHaveLength(1);
    const graph = results[0].graph;
    expect(graph.nodes.size).toBe(1);
    expect(graph.edges.length).toBeGreaterThan(0);
    for (const edge of graph.edges) {
      expect(edge.fromId).toBe(edge.toId);
    }
  }, 60000);

  it("discovers state transitions for toggle component", async () => {
    harness = await buildAndServe("./fixtures/toggle-button.tsx");
    const results = await explore(harness, {
      samples: 3,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    expect(results).toHaveLength(1);
    const graph = results[0].graph;
    expect(graph.nodes.size).toBeGreaterThanOrEqual(2);
    const nonSelfLoops = graph.edges.filter((e) => e.fromId !== e.toId);
    expect(nonSelfLoops.length).toBeGreaterThan(0);
  }, 60000);

  it("captures N timing samples per edge", async () => {
    harness = await buildAndServe("./fixtures/static-buttons.tsx");
    const N = 3;
    const results = await explore(harness, {
      samples: N,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    for (const edge of results[0].graph.edges) {
      expect(edge.samples).toHaveLength(N);
      expect(edge.median).toBeGreaterThanOrEqual(0);
      expect(edge.p95).toBeGreaterThanOrEqual(0);
    }
  }, 60000);

  it("respects depth limit", async () => {
    harness = await buildAndServe("./fixtures/counter.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxDepth: 2,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    const graph = results[0].graph;
    for (const [, node] of graph.nodes) {
      expect(node.depth).toBeLessThanOrEqual(2);
    }
  }, 60000);

  it("handles component with no interactions", async () => {
    harness = await buildAndServe("./fixtures/no-interactive.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    expect(results).toHaveLength(1);
    const graph = results[0].graph;
    expect(graph.nodes.size).toBe(1);
    expect(graph.edges).toHaveLength(0);
  }, 60000);

  it("includes raw trace events per edge", async () => {
    harness = await buildAndServe("./fixtures/static-buttons.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    for (const edge of results[0].graph.edges) {
      expect(edge.traces).toHaveLength(edge.samples.length);
      for (const trace of edge.traces) {
        expect(Array.isArray(trace)).toBe(true);
      }
    }
  }, 60000);

  it("produces deterministic graph with same seed", async () => {
    harness = await buildAndServe("./fixtures/toggle-button.tsx");
    const r1 = await explore(harness, {
      samples: 2,
      seed: 42,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    const r2 = await explore(harness, {
      samples: 2,
      seed: 42,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    const g1 = r1[0].graph;
    const g2 = r2[0].graph;
    expect(g1.nodes.size).toBe(g2.nodes.size);
    expect(g1.edges.length).toBe(g2.edges.length);
    const eids1 = g1.edges.map((e) => e.id).sort();
    const eids2 = g2.edges.map((e) => e.id).sort();
    expect(eids1).toEqual(eids2);
  }, 90000);

  it("records wall clock time", async () => {
    harness = await buildAndServe("./fixtures/static-buttons.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    expect(results[0].graph.wallClockMs).toBeGreaterThan(0);
  }, 60000);

  it("graph initial node matches first state", async () => {
    harness = await buildAndServe("./fixtures/toggle-button.tsx");
    const results = await explore(harness, {
      samples: 2,
      maxWallClockMs: 30000,
      combos: [{}],
    });
    const graph = results[0].graph;
    expect(graph.nodes.has(graph.initialNodeId)).toBe(true);
    const initial = graph.nodes.get(graph.initialNodeId)!;
    expect(initial.depth).toBe(0);
    expect(initial.pathFromRoot).toHaveLength(0);
  }, 60000);

  it("converges early for component with no interactions", async () => {
    harness = await buildAndServe("./fixtures/no-interactive.tsx");
    const maxMs = 60000;
    const results = await explore(harness, {
      samples: 2,
      maxWallClockMs: maxMs,
      maxNodes: 200,
      combos: [{}],
    });
    const graph = results[0].graph;
    expect(graph.nodes.size).toBe(1);
    expect(graph.edges).toHaveLength(0);
    expect(graph.wallClockMs).toBeLessThan(maxMs * 0.5);
  }, 90000);
});
