import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { createCalibrationTrace } from "../../src/metrics.js";

describe("H15: calibration DOM cleanup", () => {
  it("removes calibration element after measurement", async () => {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);

      await page.goto("about:blank");
      await createCalibrationTrace(page, cdp);

      const hasCalibration = await page.evaluate(
        () => document.getElementById("__120fps_calibration") !== null,
      );
      expect(hasCalibration).toBe(false);
    } finally {
      if (browser) await browser.close();
    }
  }, 30_000);
});
