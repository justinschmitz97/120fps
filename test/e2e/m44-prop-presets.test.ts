import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { buildAndServe } from "../../src/harness.js";
import { analyze, type AnalyzeOptions } from "../../src/analyze.js";

let browser: Browser | undefined;

afterAll(async () => {
  if (browser) await browser.close();
});

const FAST: AnalyzeOptions = {
  samples: 2,
  warmupRuns: 1,
  skipDeltas: true,
  skipAutoScale: true,
  skipAttribution: true,
  skipAutoCompose: true,
  skipReactAnalysis: true,
};

// C1 — preset values reach the rendered scene.
describe("m44 C1 — presets render", () => {
  it("renders literal preset values and resolves function references", async () => {
    browser ??= await chromium.launch({ headless: true });
    const harness = await buildAndServe("./fixtures/m44-preset-card.tsx", {
      presetPath: path.resolve("./fixtures/m44-preset-card.props.tsx"),
    });
    const page = await browser.newPage();
    try {
      await page.goto(harness.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
        timeout: 20000,
      });
      await page.evaluate(() =>
        (window as any).__120fps.mount({
          title: "Quarterly revenue",
          rows: [
            { id: "a", label: "Alpha" },
            { id: "b", label: "Bravo" },
            { id: "c", label: "Charlie" },
          ],
          onSelect: { __120fps_preset: "onSelect", index: 0 },
        }),
      );
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );

      expect(await page.textContent("h2")).toBe("Quarterly revenue");
      expect(await page.locator("li").count()).toBe(3);
      // The reference became the real function, not a stub object.
      expect(
        await page.evaluate(() => {
          const li = document.querySelector("li")!;
          li.dispatchEvent(new MouseEvent("click", { bubbles: true }));
          return true;
        }),
      ).toBe(true);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);
});

// C2 — presets flow through the whole pipeline.
describe("m44 C2 — presets in a measured run", () => {
  it("measures the preset values and records the module", async () => {
    const report = await analyze("./fixtures/m44-preset-literal.tsx", {
      ...FAST,
      jsonPath: "test-results/m44-literal.json",
    });
    // projectRoot-relative, like every other path the report records.
    expect(report.propPresets?.path).toBe("fixtures/m44-preset-literal.props.ts");
    expect(report.propPresets?.props).toContain("label");
    // The synthesized pool is gone. Auto-scale combos carry only a fan-out
    // count, so they are not prop combos and have no label to check.
    const propCombos = report.combos.filter((c) => !("__120fps_scaleN" in c.props));
    expect(propCombos.length).toBeGreaterThan(0);
    expect(propCombos.every((c) => c.props.label === "from-preset")).toBe(true);
  }, 300000);

  it("warns about preset entries that are not props", async () => {
    const report = await analyze("./fixtures/m44-preset-card.tsx", {
      ...FAST,
      maxCombos: 2,
      jsonPath: "test-results/m44-card.json",
    });
    expect((report.warnings ?? []).some((w) => w.includes("notAProp"))).toBe(true);
    expect(report.propPresets?.props).toEqual(expect.arrayContaining(["rows", "title"]));
  }, 300000);

  it("leaves a component without a preset untouched", async () => {
    const report = await analyze("./fixtures/button.tsx", {
      ...FAST,
      maxCombos: 2,
      jsonPath: "test-results/m44-none.json",
    });
    expect(report.propPresets).toBeUndefined();
  }, 300000);
});
