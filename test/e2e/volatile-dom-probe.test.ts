import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import {
  probeVolatileRegions,
  explore,
  VOLATILE_DOM_NOTICE,
  VOLATILITY_PROBE_GAP_MS,
} from "../../src/explorer.js";

let browser: Browser;

afterAll(async () => {
  if (browser) await browser.close();
});

async function mounted(componentPath: string): Promise<{ page: Page; harness: HarnessResult }> {
  browser ??= await chromium.launch({ headless: true });
  const harness = await buildAndServe(componentPath);
  const page = await browser.newPage();
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
    timeout: 20000,
  });
  await page.evaluate(() => (window as any).__120fps.mount({}));
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return { page, harness };
}

// C1: measure the DOM's own noise floor.
describe("volatility probe", () => {
  it("finds the region a ticking clock lives in", async () => {
    const { page, harness } = await mounted("./fixtures/m47-volatile-clock.tsx");
    try {
      const volatile = await probeVolatileRegions(page);
      expect(volatile.length).toBeGreaterThan(0);
      // The changing text is inside the span, so its own path is volatile.
      expect(volatile.some((p) => p.includes("SPAN"))).toBe(true);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("finds nothing in a tree that does not move", async () => {
    const { page, harness } = await mounted("./fixtures/m47-stable-tree.tsx");
    try {
      expect(await probeVolatileRegions(page)).toEqual([]);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("is deterministic: the same component yields the same regions", async () => {
    const { page, harness } = await mounted("./fixtures/m47-volatile-clock.tsx");
    try {
      const first = await probeVolatileRegions(page);
      const second = await probeVolatileRegions(page);
      expect(second).toEqual(first);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("waits long enough to outlast a frame", async () => {
    expect(VOLATILITY_PROBE_GAP_MS).toBeGreaterThanOrEqual(100);
  });
});

// C2: exploration stops chasing phantoms.
describe("exploration on a volatile component", () => {
  it("does not inflate the state graph on a ticking clock", async () => {
    const harness = await buildAndServe("./fixtures/m47-volatile-clock.tsx");
    try {
      const [result] = await explore(harness, {
        samples: 1,
        warmupRuns: 0,
        maxWallClockMs: 30000,
        combos: [{}],
      });
      expect(result.volatileRegions).toBeGreaterThan(0);
      // One button, one state. Without the probe every click would mint a node.
      expect(result.graph.nodes.size).toBeLessThanOrEqual(2);
    } finally {
      await harness.cleanup();
    }
  }, 300000);

  it("still sees a real structural change through a volatile region", async () => {
    const harness = await buildAndServe("./fixtures/m47-volatile-then-structural.tsx");
    try {
      const [result] = await explore(harness, {
        samples: 1,
        warmupRuns: 0,
        maxWallClockMs: 30000,
        combos: [{}],
      });
      expect(result.volatileRegions).toBeGreaterThan(0);
      // The toggle adds a <p>: the graph must gain the state it opens.
      expect(result.graph.nodes.size).toBeGreaterThanOrEqual(2);
    } finally {
      await harness.cleanup();
    }
  }, 300000);

  it("reports no volatile regions for a stable component", async () => {
    const harness = await buildAndServe("./fixtures/m47-stable-tree.tsx");
    try {
      const [result] = await explore(harness, {
        samples: 1,
        warmupRuns: 0,
        maxWallClockMs: 30000,
        combos: [{}],
      });
      expect(result.volatileRegions).toBeUndefined();
      expect(result.graph.volatilePaths).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  }, 300000);

  it("says what it did and why", () => {
    const notice = VOLATILE_DOM_NOTICE(0, 2);
    expect(notice).toContain("combo 0");
    expect(notice).toContain("without input");
    expect(notice).toContain("structural change");
  });
});
