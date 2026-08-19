import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import { needsStyleSettle, settleStyles } from "../../src/measure.js";
import { attachPageErrorCapture, type PageErrorCapture } from "../../src/page-errors.js";
import { sharedAnalyze as analyze } from "./shared-analyze.js";
import type { CompositionTree } from "../../src/composition.js";

let browser: Browser | undefined;

afterAll(async () => {
  if (browser) await browser.close();
});

async function getBrowser(): Promise<Browser> {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}

async function openHarness(
  harness: HarnessResult,
  options: {
    prepare?: (page: Page) => Promise<void>;
    waitUntil?: "load" | "domcontentloaded" | "commit";
  } = {},
): Promise<{ page: Page; errors: PageErrorCapture }> {
  const page = await (await getBrowser()).newPage();
  const errors = attachPageErrorCapture(page);
  if (options.prepare) await options.prepare(page);
  await page.goto(harness.url, { waitUntil: options.waitUntil ?? "load" });
  await waitForHarness(page);
  return { page, errors };
}

function waitForHarness(page: Page): Promise<unknown> {
  return page.waitForFunction(
    () => typeof (window as any).__120fps === "object",
    undefined,
    { timeout: 20000 },
  );
}

// Vite's dep optimizer can force a full page reload right after the first load
// when it discovers a module outside optimizeDeps.include; that destroys the
// execution context mid-call. One retry after re-waiting for the harness.
async function mount(page: Page, props: Record<string, unknown>): Promise<void> {
  try {
    await page.evaluate((p) => (window as any).__120fps.mount(p), props);
  } catch (err) {
    if (!/Execution context was destroyed/.test(String(err))) throw err;
    await waitForHarness(page);
    await page.evaluate((p) => (window as any).__120fps.mount(p), props);
  }
}

function tmpJson(): string {
  return path.join(
    os.tmpdir(),
    `120fps-css-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

const TAILWIND_COMPONENT = "./fixtures/css-tailwind/app/Card.tsx";
const TAILWIND_CSS = path.resolve("fixtures/css-tailwind/app/globals.css");

// --- C4: the project's own PostCSS toolchain runs ---

describe("css e2e: PostCSS toolchain", () => {
  it("runs the project's postcss.config.mjs and applies Tailwind output", async () => {
    const harness = await buildAndServe(TAILWIND_COMPONENT, { cssFiles: [TAILWIND_CSS] });
    try {
      const { page, errors } = await openHarness(harness);
      await mount(page, { title: "hi" });
      await page.waitForSelector(".card", { timeout: 10000 });

      const styles = await page.evaluate(() => {
        const card = document.querySelector(".card") as HTMLElement;
        return {
          // @theme token, only produced when the Tailwind PostCSS plugin ran
          background: getComputedStyle(card).backgroundColor,
          // preflight, only present when @import "tailwindcss" was expanded
          bodyMargin: getComputedStyle(document.body).marginTop,
          // utility class, only present when source scanning found Card.tsx
          padding: getComputedStyle(card).paddingTop,
          // utility built from the @theme token
          buttonColor: getComputedStyle(
            document.querySelector("button") as HTMLElement,
          ).color,
        };
      });

      expect(errors.errors).toEqual([]);
      expect(styles.background).toBe("rgb(18, 52, 86)");
      expect(styles.bodyMargin).toBe("0px");
      expect(styles.padding).toBe("16px");
      expect(styles.buttonColor).toBe("rgb(18, 52, 86)");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("measures the browser default when injection is off", async () => {
    const harness = await buildAndServe(TAILWIND_COMPONENT);
    try {
      expect(harness.cssFiles).toBeUndefined();
      const { page } = await openHarness(harness);
      await mount(page, { title: "hi" });
      await page.waitForSelector(".card", { timeout: 10000 });

      const styles = await page.evaluate(() => {
        const card = document.querySelector(".card") as HTMLElement;
        return {
          background: getComputedStyle(card).backgroundColor,
          bodyMargin: getComputedStyle(document.body).marginTop,
          padding: getComputedStyle(card).paddingTop,
        };
      });

      expect(styles.background).toBe("rgba(0, 0, 0, 0)");
      expect(styles.bodyMargin).toBe("8px");
      expect(styles.padding).toBe("0px");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("surfaces a stylesheet compile error through the page-error capture", async () => {
    const harness = await buildAndServe("./fixtures/css-broken/app/Broken.tsx", {
      cssFiles: [path.resolve("fixtures/css-broken/app/globals.css")],
    });
    try {
      const page = await (await getBrowser()).newPage();
      const errors = attachPageErrorCapture(page);
      await page.goto(harness.url);
      await expect(
        page.waitForFunction(
          () => typeof (window as any).__120fps === "object",
          undefined,
          { timeout: 8000 },
        ),
      ).rejects.toThrow();
      const text = errors.errors.join("\n");
      expect(text).toContain("[postcss]");
      expect(text).toContain("does-not-exist.css");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});

// --- C2: injection shape ---

describe("css e2e: injection", () => {
  it("applies multiple stylesheets in the given cascade order", async () => {
    const harness = await buildAndServe("./fixtures/css-ordered.tsx", {
      cssFiles: [
        path.resolve("fixtures/css-order-a.css"),
        path.resolve("fixtures/css-order-b.css"),
      ],
    });
    try {
      const { page } = await openHarness(harness);
      await mount(page, { label: "x" });
      await page.waitForSelector(".ordered", { timeout: 10000 });
      const styles = await page.evaluate(() => {
        const el = document.querySelector(".ordered") as HTMLElement;
        return {
          color: getComputedStyle(el).color,
          outline: getComputedStyle(el).outlineColor,
        };
      });
      // b.css is imported last, so it wins the cascade
      expect(styles.color).toBe("rgb(2, 2, 2)");
      // a.css is still applied for properties b.css does not set
      expect(styles.outline).toBe("rgb(11, 11, 11)");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("serves a stylesheet outside the project root over /@fs/", async () => {
    const outside = path.resolve("fixtures/css-widget-outside.css");
    const harness = await buildAndServe("./fixtures/wrap-project/Widget.tsx", {
      wrapPath: path.resolve("fixtures/wrap-project/120fps.setup.tsx"),
      cssFiles: [outside],
    });
    try {
      const entry = fs.readFileSync(path.join(harness.harnessDir, "entry.tsx"), "utf-8");
      expect(entry).toContain('import "/@fs/');
      expect(entry).not.toContain("\\");

      const { page } = await openHarness(harness);
      await mount(page, {});
      await page.waitForSelector(".widget", { timeout: 10000 });
      const color = await page.evaluate(
        () => getComputedStyle(document.querySelector(".widget") as HTMLElement).color,
      );
      expect(color).toBe("rgb(7, 7, 7)");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("injects into the composed entry too", async () => {
    const composition: CompositionTree = {
      root: "Accordion",
      structure: [{ component: "Accordion", props: {}, children: [] }],
      repeatCount: 1,
    };
    const harness = await buildAndServe("./fixtures/accordion-root.tsx", {
      composition,
      exports: [{ name: "Accordion", isDefault: false }],
      cssFiles: [path.resolve("fixtures/css-composed.css")],
    });
    try {
      const { page } = await openHarness(harness);
      await mount(page, {});
      await page.waitForSelector("[data-accordion]", { timeout: 10000, state: "attached" });
      const color = await page.evaluate(
        () => getComputedStyle(document.querySelector("[data-accordion]") as HTMLElement).color,
      );
      expect(color).toBe("rgb(4, 4, 4)");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("leaves index.html untouched", async () => {
    const harness = await buildAndServe(TAILWIND_COMPONENT, { cssFiles: [TAILWIND_CSS] });
    try {
      const html = fs.readFileSync(path.join(harness.harnessDir, "index.html"), "utf-8");
      expect(html).not.toContain("globals.css");
      expect(html).not.toContain("<link");
    } finally {
      await harness.cleanup();
    }
  }, 60000);
});

// --- C5: settle gate ---

describe("css e2e: settle gate", () => {
  it("settles and reports success for an injected stylesheet with a webfont", async () => {
    const harness = await buildAndServe("./fixtures/css-font/app/Probe.tsx", {
      cssFiles: [path.resolve("fixtures/css-font/app/globals.css")],
    });
    try {
      expect(needsStyleSettle(harness)).toBe(true);
      const { page } = await openHarness(harness);
      await expect(settleStyles(page, harness)).resolves.toMatchObject({ settled: true });
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("reports not-settled after the 5s bound when a font request stalls", async () => {
    const harness = await buildAndServe("./fixtures/css-font/app/Probe.tsx", {
      cssFiles: [path.resolve("fixtures/css-font/app/globals.css")],
    });
    try {
      const { page } = await openHarness(harness, {
        // a pending font request also blocks the load event
        waitUntil: "domcontentloaded",
        prepare: async (p) => {
          await p.route("**/*.woff2", () => {
            // never fulfilled: document.fonts.ready stays pending
          });
        },
      });
      const started = Date.now();
      const result = await settleStyles(page, harness);
      const elapsed = Date.now() - started;
      expect(result.settled).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(4500);
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("does not hang when document.fonts is unavailable", async () => {
    const harness = await buildAndServe("./fixtures/css-font/app/Probe.tsx", {
      cssFiles: [path.resolve("fixtures/css-font/app/globals.css")],
    });
    try {
      const { page } = await openHarness(harness, {
        prepare: async (p) => {
          await p.addInitScript(() => {
            Object.defineProperty(Document.prototype, "fonts", {
              get: () => undefined,
              configurable: true,
            });
          });
        },
      });
      const started = Date.now();
      await expect(settleStyles(page, harness)).resolves.toMatchObject({ settled: true });
      expect(Date.now() - started).toBeLessThan(4000);
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("arms for a wrapper-only run with no --css", async () => {
    const harness = await buildAndServe("./fixtures/theme-probe.tsx", {
      wrapPath: path.resolve("fixtures/wrap-theme.tsx"),
    });
    try {
      expect(harness.cssFiles).toBeUndefined();
      expect(needsStyleSettle(harness)).toBe(true);

      const { page } = await openHarness(harness);
      await expect(settleStyles(page, harness)).resolves.toMatchObject({ settled: true });
      await mount(page, {});
      await page.waitForSelector(".theme-probe", { timeout: 10000 });
      const color = await page.evaluate(
        () => getComputedStyle(document.querySelector(".theme-probe") as HTMLElement).color,
      );
      expect(color).toBe("rgb(200, 100, 50)");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("stays inactive for a bare component", async () => {
    const harness = await buildAndServe("./fixtures/button.tsx");
    try {
      expect(needsStyleSettle(harness)).toBe(false);
      const { page } = await openHarness(harness);
      const started = Date.now();
      await expect(settleStyles(page, harness)).resolves.toMatchObject({ settled: true });
      expect(Date.now() - started).toBeLessThan(1000);
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});

// --- C6/C7: full pipeline ---

describe("css e2e: full pipeline", () => {
  it("auto-detects app/globals.css and reports it", async () => {
    const jsonPath = tmpJson();
    const report = await analyze(TAILWIND_COMPONENT, {
      samples: 2,
      scalePoints: [1],
      skipReactAnalysis: true,
      jsonPath,
    });

    expect(report.css).toEqual({ files: ["app/globals.css"], autoDetected: true });
    expect((report.warnings ?? []).some((w) => /not comparable/i.test(w))).toBe(false);
    expect(report.combos[0].mount.median).toBeGreaterThan(0);

    fs.unlinkSync(jsonPath);
  }, 300000);

  it("--no-css restores the pre-injection behaviour", async () => {
    const jsonPath = tmpJson();
    const report = await analyze(TAILWIND_COMPONENT, {
      samples: 2,
      scalePoints: [1],
      skipReactAnalysis: true,
      noCss: true,
      jsonPath,
    });

    expect(report.css).toBeUndefined();
    fs.unlinkSync(jsonPath);
  }, 300000);

  it("records the injected list in the saved baseline fingerprint", async () => {
    const projectRoot = path.resolve("fixtures/css-tailwind");
    const baselinePath = path.join(projectRoot, "120fps-baseline.json");
    fs.rmSync(baselinePath, { force: true });
    const jsonPath = tmpJson();
    try {
      await analyze(TAILWIND_COMPONENT, {
        samples: 2,
        scalePoints: [1],
        skipReactAnalysis: true,
        saveBaseline: true,
        jsonPath,
      });
      const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
      // M45: entries are keyed by component and environment slot.
      const entry = baseline.entries[
        Object.keys(baseline.entries).find((k: string) => k.startsWith("./app/Card.tsx#"))!
      ];
      expect(entry.env.css).toEqual(["app/globals.css"]);
    } finally {
      fs.rmSync(baselinePath, { force: true });
      fs.rmSync(jsonPath, { force: true });
    }
  }, 300000);

  it("omits the fingerprint field entirely when nothing is injected", async () => {
    const projectRoot = path.resolve("fixtures/css-tailwind");
    const baselinePath = path.join(projectRoot, "120fps-baseline.json");
    fs.rmSync(baselinePath, { force: true });
    const jsonPath = tmpJson();
    try {
      await analyze(TAILWIND_COMPONENT, {
        samples: 2,
        scalePoints: [1],
        skipReactAnalysis: true,
        noCss: true,
        saveBaseline: true,
        jsonPath,
      });
      const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf-8"));
      // M45: entries are keyed by component and environment slot.
      const entry = baseline.entries[
        Object.keys(baseline.entries).find((k: string) => k.startsWith("./app/Card.tsx#"))!
      ];
      expect("css" in entry.env).toBe(false);
    } finally {
      fs.rmSync(baselinePath, { force: true });
      fs.rmSync(jsonPath, { force: true });
    }
  }, 300000);
});
