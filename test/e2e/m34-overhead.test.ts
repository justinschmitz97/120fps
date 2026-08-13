import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness.js";
import { measureMount } from "../../src/measure.js";

// M34: domNodeCount and hasAnimation are read once per combo (first sample) —
// not during warmup and not on later samples. The fixture counts every
// detectAnimations() aux read via a patched document.getAnimations and renders
// one <span> per call, so domNodeCount exposes how many aux reads happened
// before it was taken.
//
// The fixture's base DOM is 1 (the wrapping <div>).
describe("M34: aux DOM reads run once per combo", () => {
  it("warmup runs make no aux reads", async () => {
    const harness = await buildAndServe("./fixtures/m34-aux-counter.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        warmupRuns: 2,
        combos: [{}],
      });
      // Before M34, each warmup ran detectAnimations, so combo 0's first-sample
      // count already saw 2 calls (domNodeCount 3).
      expect(results[0].domNodeCount).toBe(1);
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("samples after the first make no aux reads", async () => {
    const harness = await buildAndServe("./fixtures/m34-aux-counter.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 3,
        warmupRuns: 0,
        combos: [{}, {}],
      });
      // Combo 1's first-sample count sees every aux read combo 0 made. One read
      // per combo means exactly one span more than combo 0's count (which saw
      // zero). Before M34 this delta was 3 (one read per sample).
      expect(results[1].domNodeCount - results[0].domNodeCount).toBe(1);
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});
