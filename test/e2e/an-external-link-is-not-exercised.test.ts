import { describe, it, expect, afterEach } from "vitest";
import { buildAndServe, type HarnessResult } from "../../src/harness/index.js";
import { discoverInteractions, type SkippedTarget } from "../../src/browser/index.js";
import { chromium, type Browser, type Page } from "playwright";

let harness: HarnessResult | undefined;
let browser: Browser | undefined;

afterEach(async () => {
  if (browser) await browser.close();
  browser = undefined;
  if (harness) await harness.cleanup();
  harness = undefined;
});

async function mount(fixturePath: string): Promise<Page> {
  harness = await buildAndServe(fixturePath);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(harness.url);
  await page.waitForFunction(() => typeof (window as any).__120fps === "object", { timeout: 10000 });
  await page.evaluate(() => (window as any).__120fps.mount({}));
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return page;
}

describe("a rendered page's links are sorted into what may be exercised", () => {
  it("keeps the same-page anchors and the button, declines the four that leave", async () => {
    const page = await mount("./fixtures/external-links.tsx");
    const skipped: SkippedTarget[] = [];
    const descriptors = await discoverInteractions(page, {
      onSkipped: (targets) => skipped.push(...targets),
    });

    expect(descriptors.map((d) => d.label).sort()).toEqual([
      "Settings",
      "Show",
      "Skip to content",
    ]);
    expect(skipped.map((s) => `${s.label}:${s.reason}`).sort()).toEqual([
      "Docs:new-tab-link",
      "Mail us:non-http-scheme",
      "Vite:external-link",
      "Vue 3:external-link",
    ]);
  }, 60000);

  it("declines a portal's external anchor and keeps the rest of the portal", async () => {
    const page = await mount("./fixtures/portal-external-links.fixture.tsx");
    const skipped: SkippedTarget[] = [];
    const descriptors = await discoverInteractions(page, {
      probePortals: true,
      remount: async () => {
        await page.evaluate(() => (window as any).__120fps.mount({}));
      },
      onSkipped: (targets) => skipped.push(...targets),
    });

    const portal = descriptors.filter((d) => d.portal);
    expect(portal.map((d) => d.selector).sort()).toEqual([
      '[data-testid="portal-close"]',
      '[data-testid="portal-fragment"]',
    ]);
    expect(skipped.map((t) => `${t.selector}:${t.reason}`)).toContain(
      '[data-testid="portal-external"]:external-link',
    );
  }, 60000);

  it("declines nothing on a component whose every link stays on the page", async () => {
    const page = await mount("./fixtures/interactive-basic.tsx");
    const skipped: SkippedTarget[] = [];
    const descriptors = await discoverInteractions(page, {
      onSkipped: (targets) => skipped.push(...targets),
    });

    expect(skipped).toEqual([]);
    expect(descriptors.map((d) => d.tagName)).toContain("A");
  }, 60000);
});
