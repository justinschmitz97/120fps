import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { probeMachineNoise, computeCvPercent, NOISE_PROBE_SAMPLES } from "../../src/noise.js";
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

// C1 — the probe measures the machine, not the component.
describe("m46 C1 — busy-loop probe", () => {
  it("returns one timing per sample, all positive", async () => {
    browser ??= await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      const timings = await probeMachineNoise(page);
      expect(timings).toHaveLength(NOISE_PROBE_SAMPLES);
      expect(timings.every((t) => t > 0)).toBe(true);
    } finally {
      await page.close();
    }
  }, 90000);

  it("is repeatable enough on an idle page to mean something", async () => {
    browser ??= await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      // Not an assertion about this machine's quietness — only that the probe
      // itself does not manufacture dispersion out of nothing.
      const timings = await probeMachineNoise(page, 9);
      expect(computeCvPercent(timings)).toBeLessThan(100);
    } finally {
      await page.close();
    }
  }, 90000);
});

// C2 — every run carries an assessment.
describe("m46 C2 — the report says how trustworthy the machine was", () => {
  it("records a level and its signals", async () => {
    const report = await analyze("./fixtures/m40-settled.tsx", {
      ...FAST,
      jsonPath: "test-results/m46-noise.json",
    });
    expect(["quiet", "noisy", "hostile"]).toContain(report.noise?.level);
    expect(report.noise?.signals.probeMedianMs).toBeGreaterThan(0);
    expect(report.noise?.signals.probeCv).toBeGreaterThanOrEqual(0);
    expect(report.noise?.signals.unstableFraction).toBeGreaterThanOrEqual(0);
    expect(report.noise?.signals.contextRetries).toBeGreaterThanOrEqual(0);
  }, 300000);

  it("warns only when the machine was not quiet", async () => {
    const report = await analyze("./fixtures/m40-settled.tsx", {
      ...FAST,
      jsonPath: "test-results/m46-noise2.json",
    });
    const warned = (report.warnings ?? []).some((w) => w.includes("machine was"));
    expect(warned).toBe(report.noise!.level !== "quiet");
  }, 300000);
});
