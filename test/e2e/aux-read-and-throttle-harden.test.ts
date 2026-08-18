import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness.js";
import { measureMount } from "../../src/measure.js";

// M34 hardening: the aux-read hoist must not collapse per-combo DOM facts, and
// throttle suspension must survive the identity throttle rate.

// HH4: domNodeCount is a per-combo fact: every combo still gets its own read.
describe("HH4: per-combo domNodeCount survives the aux hoist", () => {
  it("reports distinct counts for distinct combos", async () => {
    const harness = await buildAndServe("./fixtures/large-dom.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        warmupRuns: 1,
        combos: [{ count: 3 }, { count: 12 }],
      });
      // 1 wrapper div + count items × (div + span)
      expect(results[0].domNodeCount).toBe(1 + 3 * 2);
      expect(results[1].domNodeCount).toBe(1 + 12 * 2);
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});

// HH5: --cpu-throttle 1 makes suspend and restore the same rate; the sample
// loop must run unchanged.
describe("HH5: throttle suspension at rate 1", () => {
  it("measures normally when cpuThrottle is 1", async () => {
    const harness = await buildAndServe("./fixtures/large-dom.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 3,
        warmupRuns: 0,
        cpuThrottle: 1,
        combos: [{ count: 5 }],
      });
      expect(results[0].mount.samples).toHaveLength(3);
      expect(results[0].mount.median).toBeGreaterThan(0);
      expect(results[0].unmount.median).toBeGreaterThan(0);
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});
