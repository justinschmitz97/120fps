import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import { explore } from "../../src/explorer.js";
import {
  installObservers,
  beginObservedWindow,
  readObservedWindow,
  observedInteractionMs,
  EVENT_TIMING_THRESHOLD_MS,
  OBSERVER_STATE_KEY,
} from "../../src/observers.js";

let browser: Browser;

afterAll(async () => {
  if (browser) await browser.close();
});

async function mounted(componentPath: string): Promise<{ page: Page; harness: HarnessResult }> {
  browser ??= await chromium.launch({ headless: true });
  const harness = await buildAndServe(componentPath);
  const page = await browser.newPage();
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
    timeout: 20000,
  });
  await installObservers(page);
  await page.evaluate(() => (window as any).__120fps.mount({}));
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  return { page, harness };
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await page.evaluate(() => new Promise((r) => setTimeout(r, 60)));
}

// C1 — the acquisition path works against a real interaction.
describe("m52 C1 — observed interaction windows", () => {
  it("reports a slow click as an event with delay and processing split out", async () => {
    const { page, harness } = await mounted("./fixtures/m52-slow-click.tsx");
    try {
      await beginObservedWindow(page);
      await page.click("button");
      await settle(page);

      const observed = await readObservedWindow(page);
      expect(observed.eventTimingUnavailable).toBe(false);
      expect(observed.events.length).toBeGreaterThan(0);

      const click = observed.events.find((e) => e.name === "click");
      expect(click).toBeDefined();
      // The handler blocks 60ms, so the presentation-inclusive duration must
      // clear the reporting threshold by a wide margin.
      expect(click!.durationMs).toBeGreaterThanOrEqual(EVENT_TIMING_THRESHOLD_MS);
      expect(click!.processingMs).toBeGreaterThan(0);
      expect(click!.delayMs).toBeGreaterThanOrEqual(0);
      expect(observedInteractionMs(observed)).toBeGreaterThanOrEqual(EVENT_TIMING_THRESHOLD_MS);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("attributes a blocked frame through long-animation-frame", async () => {
    const { page, harness } = await mounted("./fixtures/m52-slow-click.tsx");
    try {
      await beginObservedWindow(page);
      await page.click("button");
      await settle(page);

      const observed = await readObservedWindow(page);
      // LoAF is Chromium-only and version-dependent; when present it must carry
      // real numbers rather than zeros.
      if (observed.longFrames.length > 0) {
        expect(observed.longFrames[0].durationMs).toBeGreaterThan(0);
      }
      expect(observed.windowMs).toBeGreaterThan(0);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("scopes entries to the window that was opened", async () => {
    const { page, harness } = await mounted("./fixtures/m52-slow-click.tsx");
    try {
      await beginObservedWindow(page);
      await page.click("button");
      await settle(page);
      const first = await readObservedWindow(page);
      expect(first.events.length).toBeGreaterThan(0);

      // A fresh window with no interaction in it must be empty, even though the
      // previous window's entries are still in the buffer.
      await beginObservedWindow(page);
      await settle(page);
      expect((await readObservedWindow(page)).events).toEqual([]);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("reports an idle window as quiet rather than unobservable", async () => {
    const { page, harness } = await mounted("./fixtures/m52-slow-click.tsx");
    try {
      await beginObservedWindow(page);
      await settle(page);
      const observed = await readObservedWindow(page);
      expect(observed.events).toEqual([]);
      expect(observed.eventTimingUnavailable).toBe(false);
      expect(observedInteractionMs(observed)).toBe(0);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("observes the last interaction without a settle of the caller's own", async () => {
    // An observer callback is queued after its frame presents, so a read that
    // followed only the double-rAF fence a stress pattern ends with used to
    // drop the entry it was opened for.
    const { page, harness } = await mounted("./fixtures/m52-slow-click.tsx");
    try {
      await beginObservedWindow(page);
      await page.click("button");
      await page.evaluate(
        () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
      );

      const observed = await readObservedWindow(page);
      expect(observed.events.length).toBeGreaterThan(0);
      expect(observedInteractionMs(observed)).toBeGreaterThanOrEqual(EVENT_TIMING_THRESHOLD_MS);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);
});

// C3 — the timing source explore actually uses.
describe("m52 C3 — explore keeps timing with traces", () => {
  it("collects a trace per sample unless observer timing is asked for", async () => {
    // Event Timing's 16ms floor is an order of magnitude above the per-step cost
    // of a real component, so the observer path cannot be the default without
    // reporting fast interactions as free.
    const harness = await buildAndServe("./fixtures/aria-tabs.tsx");
    try {
      const results = await explore(harness, {
        samples: 1,
        maxCombos: 1,
        maxNodes: 2,
        maxDepth: 1,
      });
      const edges = results.flatMap((r) => r.graph.edges);
      expect(edges.length).toBeGreaterThan(0);
      expect(edges.every((e) => e.traces.some((t) => t.length > 0))).toBe(true);
      expect(edges.some((e) => e.median > 0)).toBe(true);
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});

// C2 — the open question the spec asked to answer empirically.
describe("m52 C2 — Event Timing reporting floor", () => {
  it("emits entries at the requested 16ms threshold in the harness Chromium", async () => {
    const { page, harness } = await mounted("./fixtures/m52-slow-click.tsx");
    try {
      await beginObservedWindow(page);
      await page.click("button");
      await settle(page);
      const durations = (await readObservedWindow(page)).events.map((e) => e.durationMs);
      // Every reported entry is at or above the threshold we asked for; nothing
      // below it is observable, which is what bounds the mapping.
      expect(durations.every((d) => d >= EVENT_TIMING_THRESHOLD_MS - 1)).toBe(true);
      expect(durations.length).toBeGreaterThan(0);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("installs once however often it is called", async () => {
    const { page, harness } = await mounted("./fixtures/m52-slow-click.tsx");
    try {
      await installObservers(page);
      await installObservers(page);
      await beginObservedWindow(page);
      await page.click("button");
      await settle(page);
      const observed = await readObservedWindow(page);
      const clicks = observed.events.filter((e) => e.name === "click");
      expect(clicks.length).toBe(1);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("degrades to absence, not to zero, when nothing is installed", async () => {
    browser ??= await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      const observed = await readObservedWindow(page);
      expect(observed.eventTimingUnavailable).toBe(true);
      expect(observed.events).toEqual([]);
      expect(observed.layoutShiftScore).toBe(0);
      expect(await page.evaluate((k: string) => (window as any)[k], OBSERVER_STATE_KEY))
        .toBeUndefined();
    } finally {
      await page.close();
    }
  }, 90000);
});
