import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import { applyWrapperViewport, measureMount, measureWrapperOverhead } from "../../src/measure.js";
import { attachPageErrorCapture } from "../../src/page-errors.js";
import { sharedAnalyze as analyze } from "./shared-analyze.js";

let browser: Browser | undefined;

afterAll(async () => {
  if (browser) await browser.close();
});

async function getBrowser(): Promise<Browser> {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

async function openHarness(harness: HarnessResult): Promise<{ page: Page; errors: ReturnType<typeof attachPageErrorCapture> }> {
  const page = await (await getBrowser()).newPage();
  const errors = attachPageErrorCapture(page);
  await page.goto(harness.url);
  await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, { timeout: 20000 });
  return { page, errors };
}

function tmpJson(): string {
  return path.join(os.tmpdir(), `120fps-wrap-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

describe("wrapper e2e: context dependency", () => {
  it("fails to render a context-dependent component without a wrapper", async () => {
    const harness = await buildAndServe("./fixtures/needs-context.tsx");
    try {
      const { page, errors } = await openHarness(harness);
      await page.evaluate(() => (window as any).__120fps.mount({}));
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      const found = await page.evaluate(() => document.querySelectorAll(".needs-context").length);
      expect(found).toBe(0);
      expect(errors.errors.join("\n")).toContain("requires WrapContext");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);

  it("renders the same component inside a wrapper", async () => {
    const harness = await buildAndServe("./fixtures/needs-context.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-basic.tsx"),
    });
    try {
      const { page } = await openHarness(harness);
      await page.evaluate(() => (window as any).__120fps.mount({}));
      await page.waitForSelector(".needs-context", { timeout: 10000 });
      const text = await page.textContent(".needs-context");
      expect(text).toBe("wrapped");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});

describe("wrapper e2e: import-time side effects", () => {
  it("applies the wrapper stylesheet and theme attribute before the first mount", async () => {
    const harness = await buildAndServe("./fixtures/theme-probe.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-theme.tsx"),
    });
    try {
      const { page } = await openHarness(harness);
      const theme = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
      expect(theme).toBe("dark");

      await page.evaluate(() => (window as any).__120fps.mount({}));
      await page.waitForSelector(".theme-probe", { timeout: 10000 });
      const color = await page.evaluate(
        () => getComputedStyle(document.querySelector(".theme-probe")!).color,
      );
      expect(color).toBe("rgb(200, 100, 50)");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});

describe("wrapper e2e: viewport export", () => {
  it("re-exposes viewport and applies it to the session", async () => {
    const harness = await buildAndServe("./fixtures/viewport-reporter.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-viewport.tsx"),
    });
    try {
      const { page } = await openHarness(harness);
      const vp = await page.evaluate(() => (window as any).__120fps.viewport);
      expect(vp).toEqual({ width: 375, height: 667 });

      await applyWrapperViewport(page);
      await page.evaluate(() => (window as any).__120fps.mount({}));
      await page.waitForSelector(".viewport-reporter", { timeout: 10000 });
      const reported = await page.textContent(".viewport-reporter");
      expect(reported).toBe("375");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);

  it("omits the viewport key when the wrapper does not export one", async () => {
    const harness = await buildAndServe("./fixtures/needs-context.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-basic.tsx"),
    });
    try {
      const { page } = await openHarness(harness);
      const hasKey = await page.evaluate(() => "viewport" in (window as any).__120fps);
      expect(hasKey).toBe(false);
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});

describe("wrapper e2e: overhead pass", () => {
  it("reports wrapper-only mount cost and DOM node delta", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-expensive.tsx"),
    });
    try {
      const { page } = await openHarness(harness);
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      const overhead = await measureWrapperOverhead(page, cdp, 3);
      expect(overhead.overheadMs).toBeGreaterThan(1);
      expect(overhead.domNodes).toBe(1);
      await page.close();

      const wrapped = await measureMount(harness, { samples: 3, combos: [{ label: "x" }] });
      expect(overhead.overheadMs).toBeLessThanOrEqual(wrapped[0].mount.median * 1.5);
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("reports a zero DOM delta for a wrapper that renders no elements", async () => {
    const harness = await buildAndServe("./fixtures/needs-context.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-basic.tsx"),
    });
    try {
      const { page } = await openHarness(harness);
      const cdp = await page.context().newCDPSession(page);
      const overhead = await measureWrapperOverhead(page, cdp, 2);
      expect(overhead.domNodes).toBe(0);
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});

describe("wrapper e2e: full pipeline", () => {
  it("auto-detects 120fps.setup.tsx and profiles a context-dependent component", async () => {
    const jsonPath = tmpJson();
    const report = await analyze("./fixtures/wrap-project/Widget.tsx", {
      samples: 2,
      scalePoints: [1],
      jsonPath,
    });

    expect(report.wrapper).toBeDefined();
    expect(report.wrapper!.path).toBe("120fps.setup.tsx");
    expect(report.wrapper!.autoDetected).toBe(true);
    expect(report.wrapper!.overheadMs).toBeGreaterThanOrEqual(0);
    expect(report.wrapper!.domNodes).toBe(0);

    const primary = report.combos[0];
    // M31 C1: component DOM only, so the ~8 element chrome floor is gone and
    // the wrapped component's own two elements are the whole count.
    expect(primary.domNodeCount).toBeGreaterThanOrEqual(2);
    expect(primary.interactions.length).toBeGreaterThan(0);
    expect(primary.reactOptimizations).toBeDefined();

    fs.unlinkSync(jsonPath);
  }, 180000);

  it("--no-wrap suppresses auto-detection", async () => {
    const jsonPath = tmpJson();
    const report = await analyze("./fixtures/wrap-project/Widget.tsx", {
      samples: 1,
      scalePoints: [1],
      noWrap: true,
      skipReactAnalysis: true,
      jsonPath,
    });

    expect(report.wrapper).toBeUndefined();
    expect((report.warnings ?? []).some((w) => w.startsWith("Wrapper "))).toBe(false);

    fs.unlinkSync(jsonPath);
  }, 180000);
});
