import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { chromium, type Browser } from "playwright";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import { detectAnimations } from "../../src/measure.js";
import { sharedAnalyze as analyze } from "./shared-analyze.js";

let browser: Browser;

afterAll(async () => {
  if (browser) await browser.close();
});

// A plain vsync browser: the measurement args put Chromium on driven frames,
// where rAF only advances when a CDP beginFrame is issued.
async function opened(fixture: string): Promise<{ page: import("playwright").Page; harness: HarnessResult }> {
  browser ??= await chromium.launch({ headless: true });
  const harness = await buildAndServe(fixture);
  const page = await browser.newPage();
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
    timeout: 20000,
  });
  await page.evaluate(() => (window as any).__120fps.mount({}));
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return { page, harness };
}

// M64.6a — a declared transition is not an animation.
describe("M64: observed animation only", () => {
  it("reports no animation for a static component declaring transition-all", async () => {
    const { page, harness } = await opened("./fixtures/m64-transition-idle.tsx");
    try {
      expect(await detectAnimations(page)).toBe(false);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("still reports animation for a running CSS animation", async () => {
    const { page, harness } = await opened("./fixtures/m35-animated.tsx");
    try {
      expect(await detectAnimations(page)).toBe(true);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("keeps the static toolbar at T1 instead of promoting it to T3", async () => {
    const jsonPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m64-")), "r.json");
    const report = await analyze(
      path.resolve(import.meta.dirname, "../../fixtures/m64-transition-idle.tsx"),
      { samples: 1, skipDeltas: true, skipAutoScale: true, skipReactAnalysis: true, jsonPath },
    );
    expect(report.combos[0].hasAnimation).toBe(false);
    expect(report.combos[0].tier).toBe("T1");
  }, 300000);
});

// M64.7 — memo/forwardRef names reach render attribution.
describe("M64: render attribution unwrapping", () => {
  it("attributes memo and forwardRef renders to a real name", async () => {
    const jsonPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m64-")), "r.json");
    const report = await analyze(
      path.resolve(import.meta.dirname, "../../fixtures/m64-memo-arrow.tsx"),
      { samples: 1, skipDeltas: true, skipAutoScale: true, jsonPath },
    );
    const attribution = report.combos[0].reactOptimizations?.renderAttribution ?? [];
    expect(attribution.length).toBeGreaterThan(0);
    expect(attribution.every((entry) => entry.component !== "Anonymous")).toBe(true);
  }, 300000);
});
