import { describe, it, expect, afterAll, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import {
  installMeasuredStateProbe,
  readNetworkProbe,
  probeLateMutation,
  MEASURED_STATE_HOLD_MS,
} from "../../src/measure.js";
import { analyze, MEASURED_STATE_WARNING, type AnalyzeOptions } from "../../src/analyze.js";

let browser: Browser;

afterAll(async () => {
  if (browser) await browser.close();
});

// Mirrors the measurement preamble: probe installed once the harness is ready,
// before anything mounts.
async function opened(
  componentPath: string,
  setup?: (page: Page) => Promise<void>,
): Promise<{ page: Page; harness: HarnessResult }> {
  browser ??= await chromium.launch({ headless: true });
  const harness = await buildAndServe(componentPath);
  const page = await browser.newPage();
  if (setup) await setup(page);
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
    timeout: 20000,
  });
  await installMeasuredStateProbe(page);
  return { page, harness };
}

async function mount(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__120fps.mount({}));
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

// C1 — a request still in flight at the fence is visible to the probe.
describe("m40 C1 — pending-network signal", () => {
  it("sees a mount-time fetch that has not answered", async () => {
    const { page, harness } = await opened("./fixtures/m40-fetch-on-mount.tsx", async (p) => {
      // Never fulfilled: the request stays in flight for the life of the page.
      await p.route("**/m40-stall", () => {});
    });
    try {
      const before = await readNetworkProbe(page);
      await mount(page);
      await probeLateMutation(page, MEASURED_STATE_HOLD_MS, false);
      const after = await readNetworkProbe(page);
      expect(after.pending.some((id) => id > before.started)).toBe(true);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("sees nothing pending for a component that requests nothing", async () => {
    const { page, harness } = await opened("./fixtures/m40-settled.tsx");
    try {
      const before = await readNetworkProbe(page);
      await mount(page);
      const after = await readNetworkProbe(page);
      expect(after.pending.some((id) => id > before.started)).toBe(false);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);
});

// C2 — DOM that moves after the fence without input is a late mutation.
describe("m40 C2 — late-mutation signal", () => {
  it("catches a timer-driven swap that lands after the fence", async () => {
    const { page, harness } = await opened("./fixtures/m40-late-mutation.tsx");
    try {
      await mount(page);
      expect(await probeLateMutation(page, MEASURED_STATE_HOLD_MS, true)).toBe(true);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("stays quiet for a scene that is already final", async () => {
    const { page, harness } = await opened("./fixtures/m40-settled.tsx");
    try {
      await mount(page);
      expect(await probeLateMutation(page, MEASURED_STATE_HOLD_MS, true)).toBe(false);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("holds without observing when the caller opts out", async () => {
    const { page, harness } = await opened("./fixtures/m40-late-mutation.tsx");
    try {
      await mount(page);
      expect(await probeLateMutation(page, MEASURED_STATE_HOLD_MS, false)).toBe(false);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);
});

// C3 — the classification survives the pipeline into the report and the baseline.
const PROJECT_DIR = path.resolve(`.m40-measured-state-${process.pid}`);
const COMPONENT = path.join(PROJECT_DIR, "late-mutation.tsx");

const FAST: AnalyzeOptions = {
  samples: 2,
  warmupRuns: 1,
  skipDeltas: true,
  skipAutoScale: true,
  skipAttribution: true,
  skipAutoCompose: true,
  skipReactAnalysis: true,
};

function run(options: AnalyzeOptions = {}) {
  return analyze(COMPONENT, {
    ...FAST,
    ...options,
    jsonPath: path.join(PROJECT_DIR, "report.json"),
  });
}

describe("m40 C3 — pipeline integration", () => {
  beforeAll(() => {
    fs.mkdirSync(PROJECT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(PROJECT_DIR, "package.json"),
      JSON.stringify({ name: "m40-fixture", version: "0.0.0", private: true }),
      "utf-8",
    );
    fs.copyFileSync(path.resolve("fixtures/m40-late-mutation.tsx"), COMPONENT);
  });

  afterAll(() => {
    fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
  });

  // The classification itself is best-effort by design: the observation window
  // opens once trace collection has finished, at an offset that varies with
  // machine load, so a mutation outside it is missed. False negatives are
  // acceptable, false positives are not — the probe's own reliability is
  // covered deterministically by C1/C2. What the pipeline must guarantee is
  // that whatever it classified reaches the report and the warnings together.
  it("carries every combo's classification into the report, with one disclosure each", async () => {
    const report = await run();
    for (const combo of report.combos) {
      expect(["settled", "late-mutation", "pending-network"]).toContain(combo.measuredState);
    }

    const nonSettled = report.combos.filter(
      (c) => c.measuredState && c.measuredState !== "settled",
    );
    const disclosures = (report.warnings ?? []).filter((w) => w.includes("measured in a"));

    // One warning per non-settled combo, naming that combo and its signal.
    expect(disclosures).toHaveLength(nonSettled.length);
    for (const combo of nonSettled) {
      expect(
        disclosures.some(
          (w) => w.includes(`combo ${combo.comboIndex}`) && w.includes(combo.measuredState!),
        ),
      ).toBe(true);
    }
  }, 300000);

  it("repeats whatever disclosure the saved entry carries", async () => {
    const saved = await run({ saveBaseline: true });
    // The baseline records the primary combo, so that is the scene a cached
    // verdict can repeat.
    const state = saved.combos[0].measuredState;

    const cached = await run({ check: true });
    expect(cached.cached).toBe(true);
    // A reused verdict repeats the saved scene's disclosure, and stays silent
    // when the saved scene was settled.
    if (state && state !== "settled") {
      expect(cached.warnings).toContain(MEASURED_STATE_WARNING(state));
    } else {
      expect((cached.warnings ?? []).some((w) => w.includes("measured in a"))).toBe(false);
    }
  }, 300000);
});
