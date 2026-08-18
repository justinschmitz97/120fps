import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { buildAndServe } from "../../src/harness.js";
import { attachPageErrorCapture } from "../../src/page-errors.js";

let browser: Browser | undefined;

afterAll(async () => {
  if (browser) await browser.close();
});

const PROJECT = path.resolve("fixtures/transform-project");

async function mountIn(componentPath: string, options: Parameters<typeof buildAndServe>[1] = {}) {
  browser ??= await chromium.launch({ headless: true });
  const harness = await buildAndServe(componentPath, options);
  const page = await browser.newPage();
  const errors = attachPageErrorCapture(page);
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page
    .waitForFunction(() => typeof (window as any).__120fps === "object", undefined, { timeout: 20000 })
    .catch(() => undefined);
  return { page, harness, errors };
}

// C3: the spike: do these plugins actually compile in the harness?
describe("the passthrough compiles real transforms", () => {
  it("SVGR: an .svg?react import mounts as a component", async () => {
    const { page, harness, errors } = await mountIn(
      path.join(PROJECT, "app/SvgrCard.tsx"),
    );
    try {
      expect(errors.errors.join("\n")).not.toContain("Failed to resolve import");
      await page.evaluate(() => (window as any).__120fps.mount({ label: "x" }));
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      // The SVG became a real element, not a failed import.
      expect(await page.locator("svg[data-testid=icon]").count()).toBe(1);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 120000);

  it("vanilla-extract: a .css.ts stylesheet applies real styles", async () => {
    const { page, harness, errors } = await mountIn(path.join(PROJECT, "app/VeCard.tsx"));
    try {
      expect(errors.errors.join("\n")).not.toContain("Failed to resolve import");
      await page.evaluate(() => (window as any).__120fps.mount({ label: "y" }));
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );
      const style = await page.evaluate(() => {
        const el = document.querySelector("[data-testid=ve-card]") as HTMLElement;
        return el ? getComputedStyle(el).backgroundColor : "";
      });
      // The style only exists if the plugin compiled styles.css.ts.
      expect(style).toBe("rgb(18, 52, 86)");
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 120000);

  it("--no-transforms measures without them, and the component fails visibly", async () => {
    const { page, harness } = await mountIn(path.join(PROJECT, "app/VeCard.tsx"), {
      noTransforms: true,
    });
    try {
      const style = await page
        .evaluate(() => {
          const el = document.querySelector("[data-testid=ve-card]") as HTMLElement;
          return el ? getComputedStyle(el).backgroundColor : "";
        })
        .catch(() => "");
      // Without the plugin the styles cannot have been applied.
      expect(style).not.toBe("rgb(18, 52, 86)");
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 120000);
});
