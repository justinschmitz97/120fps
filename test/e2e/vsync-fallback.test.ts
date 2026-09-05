import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { buildAndServe } from "../../src/harness/index.js";
import { analyze } from "../../src/pipeline/index.js";
import {
  measureMount,
  rafFence,
  MEASUREMENT_BROWSER_ARGS,
} from "../../src/browser/index.js";

// H2: the vsync fallback is a per-combo decision, so one run carries both pacings.
describe("combo-dependent animation", () => {
  it("mixes driven and vsync pacing across combos of one run", async () => {
    const harness = await buildAndServe("./fixtures/m35-conditional-anim.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{ spin: false }, { spin: true }],
      });
      expect(results).toHaveLength(2);
      expect(results[0].hasAnimation).toBe(false);
      expect(results[0].pacing).toBe("driven");
      expect(results[1].hasAnimation).toBe(true);
      expect(results[1].pacing).toBe("vsync");
      // Both combos keep full sample counts: the fallback re-measures, never truncates.
      expect(results[0].mount.samples).toHaveLength(2);
      expect(results[1].mount.samples).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });
});

// H3: WAAPI animation from a passive effect registers before pacing's first-sample detection.
describe("WAAPI animation from useEffect", () => {
  it("is detected and re-measured under vsync pacing", async () => {
    const harness = await buildAndServe("./fixtures/m35-waapi.tsx");
    try {
      const results = await measureMount(harness, { samples: 2, combos: [{}] });
      expect(results[0].hasAnimation).toBe(true);
      expect(results[0].pacing).toBe("vsync");
    } finally {
      await harness.cleanup();
    }
  });
});

// H13: beginFrame fails on a plain vsync browser; that failure is the fallback's own signal.
describe("probe discriminates begin-frame support", () => {
  it("beginFrame errors on a browser launched without the flags", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      const cdp = await page.context().newCDPSession(page);
      await expect(
        cdp.send("HeadlessExperimental.beginFrame" as never, {} as never),
      ).rejects.toThrow();
    } finally {
      await browser.close();
    }
  });
});

// H15: with no frame pump, the fence watchdog converts a frame-starved hang into an error.
describe("fence watchdog bounds frame starvation", () => {
  it("rafFence rejects within the watchdog bound when frames never come", async () => {
    const browser = await chromium.launch({
      headless: true,
      args: MEASUREMENT_BROWSER_ARGS,
    });
    try {
      const page = await browser.newPage();
      await page.goto("about:blank");
      const t0 = Date.now();
      await expect(rafFence(page)).rejects.toThrow(/frame starvation/);
      expect(Date.now() - t0).toBeLessThan(15_000);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

// H18: the fallback path composes with calibration, explore, react analysis, and report building.
describe("animated component through analyze()", () => {
  it("produces a report with vsync pacing and T3 animation classification", async () => {
    const report = await analyze("./fixtures/m35-animated.tsx", {
      samples: 2,
      skipReactAnalysis: true,
      skipDeltas: true,
      skipAutoScale: true,
      noBaseline: true,
    });
    expect(report.combos.length).toBeGreaterThan(0);
    expect(report.combos[0].hasAnimation).toBe(true);
    expect(report.pass).toBeDefined();
  }, 120_000);
});
