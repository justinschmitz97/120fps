import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness.js";
import { measureMount } from "../../src/measure.js";
import { attributeCost } from "../../src/metrics.js";

describe("attribution window", () => {
  it("reports one mount's scripting, bounded by the mount it describes", async () => {
    const harness = await buildAndServe("./fixtures/large-dom.tsx");
    try {
      const results = await measureMount(harness, { samples: 4, warmupRuns: 1 });
      const mount = results[0];
      const traces = mount.mountTraces!;
      expect(traces.length).toBe(mount.mount.samples.length);

      const attribution = attributeCost(traces);
      expect(attribution.sampleCount).toBe(traces.length);
      const total = attribution.buckets.reduce((sum, b) => sum + b.durationMs, 0);
      expect(total).toBeGreaterThan(0);
      expect(total).toBeCloseTo(attribution.totalScriptingMs / traces.length, 6);

      // Every window's script time nests inside that window's top-level events,
      // so the per-mount breakdown cannot exceed the average mount.
      const meanMount =
        mount.mount.samples.reduce((a, b) => a + b, 0) / mount.mount.samples.length;
      expect(total).toBeLessThanOrEqual(meanMount);

      // The Mount column is a median of the same samples: same order of
      // magnitude, not a multiple of the sample count.
      expect(total).toBeLessThan(mount.mount.median * 2);
    } finally {
      await harness.cleanup();
    }
  }, 240_000);
});
