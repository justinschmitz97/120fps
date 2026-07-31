import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import { applyWrapperViewport, measureWrapperOverhead } from "../../src/measure.js";
import { attachPageErrorCapture, type PageErrorCapture } from "../../src/page-errors.js";

let browser: Browser | undefined;

afterAll(async () => {
  if (browser) await browser.close();
});

async function getBrowser(): Promise<Browser> {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

async function openHarness(harness: HarnessResult): Promise<{ page: Page; errors: PageErrorCapture }> {
  const page = await (await getBrowser()).newPage();
  const errors = attachPageErrorCapture(page);
  await page.goto(harness.url);
  await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, { timeout: 20000 });
  return { page, errors };
}

// H3/H4: .jsx wrapper with an arrow-function default export renders
describe("H3/H4: .jsx arrow wrapper", () => {
  it("renders the component inside the wrapper", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-arrow.jsx"),
    });
    try {
      const { page } = await openHarness(harness);
      await page.evaluate(() => (window as any).__120fps.mount({ label: "x" }));
      await page.waitForSelector(".wrap-arrow button", { timeout: 10000 });
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});

// H5: class-component wrapper renders
describe("H5: class wrapper", () => {
  it("renders the component inside the wrapper", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-class.tsx"),
    });
    try {
      const { page } = await openHarness(harness);
      await page.evaluate(() => (window as any).__120fps.mount({ label: "x" }));
      await page.waitForSelector(".wrap-class button", { timeout: 10000 });
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});

// H8: wrapper that throws at import time
describe("H8: wrapper throwing at import time", () => {
  it("surfaces the throw as a captured page error", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-throws.tsx"),
    });
    try {
      const page = await (await getBrowser()).newPage();
      const errors = attachPageErrorCapture(page);
      await page.goto(harness.url);
      await expect(
        page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, { timeout: 5000 }),
      ).rejects.toThrow();
      expect(errors.errors.join("\n")).toContain("wrapper setup exploded");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});

// H14: auto-scale fan-out is wrapped once, not N times
describe("H14: wrapper + auto-scale fan-out", () => {
  it("renders one wrapper around N component instances", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-dom.tsx"),
    });
    try {
      const { page } = await openHarness(harness);
      await page.evaluate(() => (window as any).__120fps.mount({ label: "x", __120fps_scaleN: 4 }));
      await page.waitForSelector(".wrap-surface button", { timeout: 10000 });
      const counts = await page.evaluate(() => ({
        wrappers: document.querySelectorAll(".wrap-surface").length,
        buttons: document.querySelectorAll("button").length,
      }));
      expect(counts).toEqual({ wrappers: 1, buttons: 4 });
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});

// H15: non-numeric viewport values are ignored
describe("H15: invalid viewport export", () => {
  it("leaves the session viewport untouched", async () => {
    const harness = await buildAndServe("./fixtures/viewport-reporter.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-bad-viewport.tsx"),
    });
    try {
      const { page } = await openHarness(harness);
      const before = page.viewportSize();
      await applyWrapperViewport(page);
      expect(page.viewportSize()).toEqual(before);
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);

  it("is a no-op when no wrapper is active", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx");
    try {
      const { page } = await openHarness(harness);
      const before = page.viewportSize();
      await applyWrapperViewport(page);
      expect(page.viewportSize()).toEqual(before);
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});

// H16: overhead pass with a single sample
describe("H16: single-sample overhead pass", () => {
  it("returns a finite median and a DOM delta", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-dom.tsx"),
    });
    try {
      const { page } = await openHarness(harness);
      const cdp = await page.context().newCDPSession(page);
      const overhead = await measureWrapperOverhead(page, cdp, 1);
      expect(Number.isFinite(overhead.overheadMs)).toBe(true);
      expect(overhead.overheadMs).toBeGreaterThanOrEqual(0);
      expect(overhead.domNodes).toBe(1);
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});

// H19: re-exported default renders
describe("H19: re-exported default wrapper", () => {
  it("renders the re-exported component", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-reexport.tsx"),
    });
    try {
      const { page } = await openHarness(harness);
      await page.evaluate(() => (window as any).__120fps.mount({ label: "x" }));
      await page.waitForSelector(".wrap-surface button", { timeout: 10000 });
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});

// H20: unmount after mountWrapperOnly leaves an empty root
describe("H20: mountWrapperOnly lifecycle", () => {
  it("unmounts cleanly and can mount the component afterwards", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-dom.tsx"),
    });
    try {
      const { page } = await openHarness(harness);
      await page.evaluate(() => (window as any).__120fps.mountWrapperOnly());
      await page.waitForSelector(".wrap-surface", { state: "attached", timeout: 10000 });
      await page.evaluate(() => (window as any).__120fps.unmount());
      const afterUnmount = await page.evaluate(
        () => document.getElementById("root")!.childElementCount,
      );
      expect(afterUnmount).toBe(0);

      await page.evaluate(() => (window as any).__120fps.mount({ label: "x" }));
      await page.waitForSelector(".wrap-surface button", { timeout: 10000 });
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});
