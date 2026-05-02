import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { buildAndServe } from "../../src/harness.js";

let browser: Browser;

afterAll(async () => {
  if (browser) await browser.close();
});

describe("harness e2e", () => {
  it("renders button component with default props", async () => {
    browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/button.tsx");

    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector("button", { timeout: 10000 });
      const tag = await page.evaluate(() => document.querySelector("button")?.tagName);
      expect(tag).toBe("BUTTON");
    } finally {
      await harness.cleanup();
    }
  });

  it("exposes __120fps control API", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/button.tsx");

    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector("button", { timeout: 10000 });

      const hasApi = await page.evaluate(() => {
        const api = (window as any).__120fps;
        return (
          typeof api === "object" &&
          typeof api.mount === "function" &&
          typeof api.unmount === "function" &&
          typeof api.rerender === "function" &&
          typeof api.getContainer === "function"
        );
      });
      expect(hasApi).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("mount with label prop renders label text", async () => {
    if (!browser) browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/button.tsx");

    try {
      const page = await browser.newPage();
      await page.goto(harness.url);
      await page.waitForSelector("button", { timeout: 10000 });

      await page.evaluate(() => {
        (window as any).__120fps.mount({ label: "ClickMe" });
      });
      await page.waitForFunction(
        () => document.querySelector("button")?.textContent === "ClickMe",
        { timeout: 5000 },
      );
      const text = await page.textContent("button");
      expect(text).toBe("ClickMe");
    } finally {
      await harness.cleanup();
    }
  });
});
