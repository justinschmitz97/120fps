import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness.js";
import { chromium } from "playwright";
import {
  collectTrace,
  parseTraceDuration,
  type TraceEvent,
} from "../../src/measure.js";
import { parseMetrics, createCalibrationTrace } from "../../src/metrics.js";

describe("parseMetrics e2e", () => {
  it("extracts real metrics from a mount trace", async () => {
    const harness = await buildAndServe("./fixtures/counter.tsx");
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);

      await page.goto(harness.url);
      await page.waitForFunction(
        () => typeof (window as any).__120fps === "object",
        { timeout: 10000 },
      );

      const events = await collectTrace(cdp, async () => {
        await page.evaluate(() => (window as any).__120fps.mount({}));
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
      });

      const metrics = parseMetrics(events);

      expect(metrics.scriptDuration).toBeGreaterThan(0);
      expect(metrics.totalDuration).toBeGreaterThan(0);
      expect(metrics.longTasks).toBeInstanceOf(Array);
      expect(metrics.frames).toBeInstanceOf(Array);
      expect(metrics.jankFrameCount).toBeGreaterThanOrEqual(0);
      expect(metrics.droppedFrameCount).toBeGreaterThanOrEqual(0);
      expect(metrics.layoutShiftScore).toBeGreaterThanOrEqual(0);
    } finally {
      if (browser) await browser.close();
      await harness.cleanup();
    }
  }, 30_000);

  it("fixed parseTraceDuration returns <= old parser for nested events", async () => {
    const harness = await buildAndServe("./fixtures/counter.tsx");
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);

      await page.goto(harness.url);
      await page.waitForFunction(
        () => typeof (window as any).__120fps === "object",
        { timeout: 10000 },
      );

      const events = await collectTrace(cdp, async () => {
        await page.evaluate(() => (window as any).__120fps.mount({}));
        await page.evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(r)),
            ),
        );
      });

      const parsed = parseTraceDuration(events);
      const metrics = parseMetrics(events);

      // Fixed totalDuration should be <= the old sum (which double-counted nested)
      expect(metrics.totalDuration).toBeLessThanOrEqual(
        parsed.totalDuration * 1.01,
      );
      expect(metrics.totalDuration).toBeGreaterThan(0);
    } finally {
      if (browser) await browser.close();
      await harness.cleanup();
    }
  }, 30_000);
});

describe("createCalibrationTrace e2e", () => {
  it("produces non-zero baseline metrics", async () => {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);

      const metrics = await createCalibrationTrace(page, cdp);

      expect(metrics.totalDuration).toBeGreaterThan(0);
      expect(metrics.scriptDuration).toBeGreaterThan(0);
      expect(metrics.domNodeCount).toBeGreaterThan(0);
    } finally {
      if (browser) await browser.close();
    }
  }, 30_000);
});
