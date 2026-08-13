import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { buildAndServe } from "../../src/harness.js";

let browser: Browser;

afterAll(async () => {
  if (browser) await browser.close();
});

// F1 — the target's vite.config is not ours to run. The fixture project
// registers a plugin that throws in `transform`; if the config is loaded the
// entry 500s and the harness never becomes ready.
describe("m30 F1 — project vite.config is not loaded", () => {
  it("serves the harness entry for a project whose config would break every transform", async () => {
    browser = await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/vite-config-project/src/widget.tsx");

    try {
      const page = await browser.newPage();
      await page.goto(harness.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => typeof (window as any).__120fps === "object",
        undefined,
        { timeout: 20000 },
      );
      await page.evaluate(() => (window as any).__120fps.mount({ label: "ok" }));
      await page.waitForSelector("button", { timeout: 10000 });
      expect(await page.textContent("button")).toBe("ok");
    } finally {
      await harness.cleanup();
    }
  }, 90000);

  it("does not adopt server options from the project config", async () => {
    const harness = await buildAndServe("./fixtures/vite-config-project/src/widget.tsx");
    try {
      // `server.open: true` in the fixture config must not reach the harness.
      expect(harness.server.config.server.open).toBeFalsy();
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});
