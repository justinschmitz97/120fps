import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness.js";
import { createBrowserPool, measureMount } from "../../src/measure.js";

describe("pooled measurement sessions", () => {
  it("two components share one driven browser across passes", async () => {
    const pool = createBrowserPool();
    const a = await buildAndServe("./fixtures/static-buttons.tsx");
    const b = await buildAndServe("./fixtures/toggle-button.tsx");
    try {
      const ra = await measureMount(a, { samples: 2, combos: [{}], pool });
      const rb = await measureMount(b, { samples: 2, combos: [{}], pool });
      expect(ra[0].pacing).toBe("driven");
      expect(rb[0].pacing).toBe("driven");
      expect(ra[0].mount.median).toBeGreaterThan(0);
      expect(rb[0].mount.median).toBeGreaterThan(0);
      expect(pool.stats().launched).toBe(1);
    } finally {
      await pool.closeAll();
      await a.cleanup();
      await b.cleanup();
    }
  });

  it("animated fallback acquires the pooled vsync browser", async () => {
    const pool = createBrowserPool();
    const harness = await buildAndServe("./fixtures/m35-animated.tsx");
    try {
      const results = await measureMount(harness, { samples: 2, combos: [{}], pool });
      expect(results[0].pacing).toBe("vsync");
      expect(pool.stats().launched).toBe(2);
    } finally {
      await pool.closeAll();
      await harness.cleanup();
    }
  });
});
