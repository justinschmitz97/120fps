import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness/index.js";
import { measureMount } from "../../src/browser/index.js";

// M34: domNodeCount proxies aux-read count; fixture renders one <span> per detectAnimations() call.
describe("aux DOM reads run once per combo", () => {
  it("warmup runs make no aux reads", async () => {
    const harness = await buildAndServe("./fixtures/m34-aux-counter.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        warmupRuns: 2,
        combos: [{}],
      });
      // Regression check: before M34, warmup itself triggered aux reads (domNodeCount was 3).
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
      // Combo 1 sees combo 0's reads too; one read per combo makes the delta 1, was 3 before M34.
      expect(results[1].domNodeCount - results[0].domNodeCount).toBe(1);
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});
