import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { attachPageErrorCapture, enrichTimeoutError } from "../../src/page-errors.js";

describe("page error capture e2e", () => {
  it("captures a load-time throw and enriches the harness wait timeout", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const capture = attachPageErrorCapture(page);
      await page.setContent(
        `<script>throw new Error("boom at load");</script><div id="root"></div>`,
      );

      let enriched: Error | undefined;
      try {
        await page.waitForFunction(
          () => typeof (window as any).__120fps === "object",
          undefined,
          { timeout: 1500 },
        );
      } catch (err) {
        enriched = enrichTimeoutError(err, capture, "mount harness");
      }

      expect(capture.errors.some((e) => e.includes("boom at load"))).toBe(true);
      expect(enriched).toBeDefined();
      expect(enriched!.message).toContain("mount harness did not become ready within timeout.");
      expect(enriched!.message).toContain("boom at load");
    } finally {
      await browser.close();
    }
  }, 30000);
});
