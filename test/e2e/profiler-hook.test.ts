import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { chromium, type Browser } from "playwright";
import { injectProfilerHook } from "../../src/analysis/index.js";
import { sharedAnalyze as analyze } from "./shared-analyze.js";

let browser: Browser | undefined;

afterAll(async () => {
  await browser?.close();
});

describe("injectProfilerHook", () => {
  // addScriptToEvaluateOnNewDocument no-ops without the Page domain enabled first.
  it("installs the DevTools global hook into the page", async () => {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);

    await injectProfilerHook(cdp);
    await page.goto("data:text/html,<div></div>", { waitUntil: "domcontentloaded" });

    const installed = await page.evaluate(
      () => typeof (window as any).__REACT_DEVTOOLS_GLOBAL_HOOK__ === "object",
    );
    expect(installed).toBe(true);

    const profilerReady = await page.evaluate(
      () => typeof (window as any).__120fps_profiler === "object",
    );
    expect(profilerReady).toBe(true);
  });
});

describe("React finding semantics", () => {
  // Guards a regression: counting a fiber as re-rendered by tree presence alone flagged everything.
  it("flags only the memo component whose memoization is defeated", async () => {
    const jsonPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "120fps-memo-")), "r.json");
    const report = await analyze(
      path.resolve(import.meta.dirname, "../../fixtures/memo-effective.tsx"),
      { samples: 1, scalePoints: [1], skipDeltas: true, skipAutoScale: true, jsonPath },
    );

    const opts = report.combos[0].reactOptimizations!;
    const bailouts = opts.memoBailoutComponents ?? [];

    // StableChild's prop is an equal string; DefeatedChild's is a fresh object each render.
    expect(bailouts.some((n) => n.startsWith("DefeatedChild"))).toBe(true);
    expect(bailouts.some((n) => n.startsWith("StableChild"))).toBe(false);
  }, 300000);

  it("reports no context fan-out for a component that reads no context", async () => {
    const jsonPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "120fps-ctx-")), "r.json");
    const report = await analyze(
      path.resolve(import.meta.dirname, "../../fixtures/memo-effective.tsx"),
      { samples: 1, scalePoints: [1], skipDeltas: true, skipAutoScale: true, jsonPath },
    );

    const opts = report.combos[0].reactOptimizations!;
    expect(opts.contextFanOut).toBe(false);
    expect(opts.contextFanOutComponents ?? []).toEqual([]);
  }, 300000);
});
