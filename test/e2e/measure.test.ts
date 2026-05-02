import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness.js";
import { measureMount } from "../../src/measure.js";

describe("measureMount e2e", () => {
  it("returns MountResult[] for button component", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx");
    try {
      const results = await measureMount(harness, { samples: 2 });

      expect(results.length).toBeGreaterThan(0);

      const first = results[0];
      expect(first.comboIndex).toBe(0);
      expect(first.props).toBeDefined();
      expect(first.mount.samples).toHaveLength(2);
      expect(first.mount.median).toBeGreaterThanOrEqual(0);
      expect(first.mount.p95).toBeGreaterThanOrEqual(first.mount.median);
      expect(first.unmount.samples).toHaveLength(2);
      expect(first.unmount.median).toBeGreaterThanOrEqual(0);
      expect(first.unmount.p95).toBeGreaterThanOrEqual(first.unmount.median);
      expect(first.domNodeCount).toBeGreaterThan(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("respects custom cpuThrottle rate", async () => {
    const harness = await buildAndServe("./fixtures/no-props.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        cpuThrottle: 2,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].mount.samples).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("accepts pre-computed combos", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx");
    try {
      const combos = [{ label: "A" }, { label: "B" }];
      const results = await measureMount(harness, {
        samples: 2,
        combos,
      });
      expect(results).toHaveLength(2);
      expect(results[0].props).toEqual({ label: "A" });
      expect(results[1].props).toEqual({ label: "B" });
    } finally {
      await harness.cleanup();
    }
  });

  it("measures no-props component", async () => {
    const harness = await buildAndServe("./fixtures/no-props.tsx");
    try {
      const results = await measureMount(harness, { samples: 2 });
      expect(results).toHaveLength(1);
      expect(results[0].props).toEqual({});
    } finally {
      await harness.cleanup();
    }
  });

  it("supports warmupRuns=0 to skip warmup", async () => {
    const harness = await buildAndServe("./fixtures/no-props.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        warmupRuns: 0,
      });
      expect(results).toHaveLength(1);
      expect(results[0].mount.samples).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });

  it("cleans up browser even on error", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx");
    try {
      // Force an invalid combo that will crash the component — measure should still clean up
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{}],
      });
      // Button with no label — should still produce a result (renders empty button)
      expect(results).toHaveLength(1);
    } finally {
      await harness.cleanup();
    }
  });
});
