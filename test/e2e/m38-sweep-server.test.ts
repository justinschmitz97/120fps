import { describe, it, expect } from "vitest";
import { buildAndServe, createServerPool } from "../../src/harness.js";
import { createBrowserPool, measureMount } from "../../src/measure.js";

describe("M38: shared sweep server", () => {
  it("two components share one server; cleanup keeps it; both measure", async () => {
    const serverPool = createServerPool();
    const browserPool = createBrowserPool();
    const a = await buildAndServe("./fixtures/static-buttons.tsx", { serverPool });
    const b = await buildAndServe("./fixtures/toggle-button.tsx", { serverPool });
    try {
      expect(a.server).toBe(b.server);
      expect(new URL(a.url).port).toBe(new URL(b.url).port);
      expect(serverPool.stats().booted).toBe(1);

      const ra = await measureMount(a, { samples: 2, combos: [{}], pool: browserPool });
      expect(ra[0].mount.median).toBeGreaterThan(0);

      // Component A finishing must not tear the server from under B.
      await a.cleanup();
      const rb = await measureMount(b, { samples: 2, combos: [{}], pool: browserPool });
      expect(rb[0].mount.median).toBeGreaterThan(0);
    } finally {
      await browserPool.closeAll();
      await b.cleanup();
      await serverPool.closeAll();
    }
  });

  it("a differing css tuple boots its own server", async () => {
    const serverPool = createServerPool();
    const a = await buildAndServe("./fixtures/static-buttons.tsx", { serverPool });
    const b = await buildAndServe("./fixtures/with-css.tsx", {
      serverPool,
      cssFiles: ["./fixtures/with-css.css"],
    });
    try {
      expect(a.server).not.toBe(b.server);
      expect(serverPool.stats().booted).toBe(2);
    } finally {
      await a.cleanup();
      await b.cleanup();
      await serverPool.closeAll();
    }
  });

  it("without a pool, cleanup still closes the owned server", async () => {
    const harness = await buildAndServe("./fixtures/static-buttons.tsx");
    await harness.cleanup();
    // A closed dev server has no address anymore.
    expect(harness.server.httpServer?.address()).toBeNull();
  });
});
