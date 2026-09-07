import { describe, it, expect, afterEach } from "vitest";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { buildAndServe, type HarnessResult } from "../../src/harness/index.js";
import { exploreCombo } from "../../src/analysis/index.js";

let harness: HarnessResult | undefined;
let browser: Browser | undefined;

afterEach(async () => {
  if (browser) await browser.close();
  browser = undefined;
  if (harness) await harness.cleanup();
  harness = undefined;
});

describe("a click the discovery rule cannot see coming", () => {
  it("closes the page it opened, drops the target and says so", async () => {
    harness = await buildAndServe("./fixtures/opens-a-window.tsx");
    browser = await chromium.launch({ headless: true });
    const context: BrowserContext = await browser.newContext();
    const page: Page = await context.newPage();
    const session = { cdp: await context.newCDPSession(page) };

    const enter = async (): Promise<void> => {
      await page.goto(harness!.url);
      await page.waitForFunction(
        () => typeof (window as any).__120fps === "object",
        undefined,
        { timeout: 10000 },
      );
    };
    await enter();

    const warnings: string[] = [];
    const graph = await exploreCombo(
      page,
      session,
      {},
      {
        sampleCount: 1,
        maxNodes: 3,
        maxWallClockMs: 30000,
        maxDepth: 1,
        warmupRuns: 0,
        seed: 1,
        cpuThrottle: 1,
        observerTiming: false,
        comboIndex: 0,
      },
      enter,
      (warning) => warnings.push(warning),
    );

    // The close is fired from the popup event; a short settle beats a fixed sleep.
    for (let i = 0; i < 50 && context.pages().length > 1; i++) {
      await page.waitForTimeout(100);
    }
    expect(context.pages()).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
    expect(warnings.join(" ")).toContain("1 opened a new page");
    expect(warnings.join(" ")).toContain("whose click left the harness page");
  }, 120000);
});
