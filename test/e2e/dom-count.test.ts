import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { buildAndServe } from "../../src/harness.js";
import { countComponentNodes } from "../../src/measure.js";

let browser: Browser;

afterAll(async () => {
  if (browser) await browser.close();
});

async function mounted(componentPath: string, props: Record<string, unknown> = {}) {
  browser ??= await chromium.launch({ headless: true });
  const harness = await buildAndServe(componentPath);
  const page = await browser.newPage();
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
    timeout: 20000,
  });
  await page.evaluate((p) => (window as any).__120fps.mount(p), props);
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return { page, harness };
}

// C1: the count must describe the component, not the browser chrome.
describe("domNodeCount is scoped to component DOM", () => {
  it("counts zero for a scene that renders nothing", async () => {
    const { page, harness } = await mounted("./fixtures/m31-renders-nothing.tsx");
    try {
      expect(await countComponentNodes(page)).toBe(0);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("excludes html, head, body, #root and Vite's injected scripts", async () => {
    const { page, harness } = await mounted("./fixtures/button.tsx", { label: "x" });
    try {
      const scoped = await countComponentNodes(page);
      const documentWide = await page.evaluate(() => document.querySelectorAll("*").length);
      expect(scoped).toBeLessThan(documentWide);
      // One <button>; the document-wide count adds the chrome floor.
      expect(scoped).toBe(1);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("counts portal content rendered onto document.body", async () => {
    const { page, harness } = await mounted("./fixtures/m31-portal-count.tsx", { open: true });
    try {
      const scoped = await countComponentNodes(page);
      const inRoot = await page.evaluate(
        () => document.getElementById("root")?.querySelectorAll("*").length ?? 0,
      );
      expect(scoped).toBeGreaterThan(inRoot);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);
});
