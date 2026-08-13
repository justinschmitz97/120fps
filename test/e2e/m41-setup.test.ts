import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { buildAndServe } from "../../src/harness.js";
import { analyze } from "../../src/analyze.js";
import type { AnalyzeOptions } from "../../src/analyze.js";
import { attachPageErrorCapture } from "../../src/page-errors.js";
import { runWrapperTeardown } from "../../src/measure.js";

let browser: Browser | undefined;

afterAll(async () => {
  if (browser) await browser.close();
});

async function getBrowser(): Promise<Browser> {
  browser ??= await chromium.launch({ headless: true });
  return browser;
}

const FAST: AnalyzeOptions = {
  samples: 2,
  warmupRuns: 1,
  skipDeltas: true,
  skipAutoScale: true,
  skipAttribution: true,
  skipAutoCompose: true,
  skipReactAnalysis: true,
};

// C1 — readiness implies setup completed.
describe("m41 C1 — setup runs before first render", () => {
  it("has already run when the control API appears", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-setup-async.tsx"),
    });
    const page = await (await getBrowser()).newPage();
    try {
      await page.goto(harness.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
        timeout: 20000,
      });
      // Read in the same evaluation that observes readiness: no rAF, no mount.
      expect(await page.evaluate(() => (window as any).__m41SetupRan)).toBe(true);
      expect(await page.evaluate(() => (window as any).__120fps.hasSetup)).toBe(true);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("exposes no setup surface for a wrapper without one", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-basic.tsx"),
    });
    const page = await (await getBrowser()).newPage();
    try {
      await page.goto(harness.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
        timeout: 20000,
      });
      expect(await page.evaluate(() => (window as any).__120fps.hasSetup)).toBe(false);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);
});

// C2 — a failing setup must name itself, not the harness.
describe("m41 C2 — setup failure surfaces", () => {
  it("reaches the page-error capture instead of vanishing", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-setup-throws.tsx"),
    });
    const page = await (await getBrowser()).newPage();
    const errors = attachPageErrorCapture(page);
    try {
      await page.goto(harness.url, { waitUntil: "domcontentloaded" });
      await page
        .waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
          timeout: 3000,
        })
        .catch(() => {
          /* expected: setup rejected, so the API is never exposed */
        });
      expect(errors.errors.join("\n")).toContain("m41 setup failed on purpose");
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("fails the analyze run rather than reporting numbers", async () => {
    await expect(
      analyze("./fixtures/button.tsx", {
        ...FAST,
        wrapPath: path.resolve("./fixtures/wrap-setup-throws.tsx"),
        jsonPath: "test-results/m41-throws.json",
      }),
    ).rejects.toThrow();
  }, 300000);
});

// C3 — the point of the milestone: mock the request, measure the real scene.
describe("m41 C3 — setup turns M40's disclosure into an action", () => {
  it("a stubbed fetch settles a component that would otherwise be pending", async () => {
    const report = await analyze("./fixtures/m40-fetch-on-mount.tsx", {
      ...FAST,
      wrapPath: path.resolve("./fixtures/wrap-setup-stub-fetch.tsx"),
      jsonPath: "test-results/m41-stub.json",
    });
    expect(report.combos[0].measuredState).not.toBe("pending-network");
    expect(report.wrapper?.hasSetup).toBe(true);
  }, 300000);
});

// H1..H4 — hardening.
describe("m41 hardening", () => {
  // H1 — teardown is session-scoped; running it per unmount would dismantle
  // the mocks the remaining samples depend on.
  it("H1: teardown runs at session close, not between samples", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-setup-async.tsx"),
    });
    const page = await (await getBrowser()).newPage();
    try {
      await page.goto(harness.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
        timeout: 20000,
      });
      await page.evaluate(() => (window as any).__120fps.mount({ label: "x" }));
      await page.evaluate(() => (window as any).__120fps.unmount());
      expect(await page.evaluate(() => (window as any).__m41TeardownRan)).toBeUndefined();

      await runWrapperTeardown(page);
      expect(await page.evaluate(() => (window as any).__m41TeardownRan)).toBe(true);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H2 — a closed page must not turn a completed measurement into a failure.
  it("H2: teardown on a closed page is a no-op", async () => {
    const page = await (await getBrowser()).newPage();
    await page.close();
    await expect(runWrapperTeardown(page)).resolves.toBeUndefined();
  }, 90000);

  // H3 — a wrapper with no teardown export is the common case.
  it("H3: teardown without the export is a no-op", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx", {
      wrapPath: path.resolve("./fixtures/wrap-basic.tsx"),
    });
    const page = await (await getBrowser()).newPage();
    try {
      await page.goto(harness.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
        timeout: 20000,
      });
      await expect(runWrapperTeardown(page)).resolves.toBeUndefined();
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H4 — an entry without a wrapper must not gain a top-level await or any
  // reference to a module it never imported.
  it("H4: a wrapper-less run still reaches readiness", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx");
    const page = await (await getBrowser()).newPage();
    const errors = attachPageErrorCapture(page);
    try {
      await page.goto(harness.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
        timeout: 20000,
      });
      expect(await page.evaluate(() => (window as any).__120fps.hasSetup)).toBeUndefined();
      expect(errors.errors).toEqual([]);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);
});
