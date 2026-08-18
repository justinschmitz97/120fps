import { describe, it, expect, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import {
  installMeasuredStateProbe,
  readNetworkProbe,
  probeLateMutation,
  detectAnimations,
  MEASURED_STATE_HOLD_MS,
} from "../../src/measure.js";
import { analyze, type AnalyzeOptions } from "../../src/analyze.js";

let browser: Browser;

afterAll(async () => {
  if (browser) await browser.close();
});

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

const FAST: AnalyzeOptions = {
  samples: 2,
  warmupRuns: 1,
  skipDeltas: true,
  skipAutoScale: true,
  skipAttribution: true,
  skipAutoCompose: true,
  skipReactAnalysis: true,
};

describe("measured-state probe edge cases", () => {
  // H1: the false-positive that would make the signal useless: a single
  // passive effect setting state is the most common React shape there is.
  it("H1: one useEffect setState settles inside the mount fence", async () => {
    const { page, harness } = await opened("./fixtures/m40-effect-once.tsx");
    try {
      await mount(page);
      expect(await probeLateMutation(page, MEASURED_STATE_HOLD_MS, true)).toBe(false);
      expect(await page.textContent("[data-testid=body]")).toBe("ready");
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H2: an animated component mutates by design.
  it("H2: an animated component is not blamed for its own mutation", async () => {
    const report = await analyze("./fixtures/m40-animated-mutation.tsx", {
      ...FAST,
      jsonPath: "test-results/m40-animated.json",
    });
    expect(report.combos[0].measuredState).toBe("settled");
  }, 300000);

  it("H2b: the animation is detected in the first place", async () => {
    const { page, harness } = await opened("./fixtures/m40-animated-mutation.tsx");
    try {
      await mount(page);
      expect(await detectAnimations(page)).toBe(true);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H3: a request left hanging by an earlier combo must not follow the next
  // one around: pending is scoped by request id, not by count.
  it("H3: a request from an earlier combo does not flag the next", async () => {
    const { page, harness } = await opened("./fixtures/m40-fetch-on-mount.tsx", async (p) => {
      await p.route("**/m40-stall", () => {});
    });
    try {
      await mount(page);
      const stillHanging = await readNetworkProbe(page);
      expect(stillHanging.pending.length).toBe(1);

      // A later combo starts from this watermark and starts nothing new.
      const before = await readNetworkProbe(page);
      await probeLateMutation(page, MEASURED_STATE_HOLD_MS, false);
      const after = await readNetworkProbe(page);
      expect(after.pending.some((id) => id > before.started)).toBe(false);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H4: a request that fails must not stay pending forever.
  it("H4: an aborted request clears from the pending set", async () => {
    const { page, harness } = await opened("./fixtures/m40-settled.tsx", async (p) => {
      await p.route("**/m40-abort", (route) => route.abort());
    });
    try {
      await page.evaluate(() => {
        (window as any).fetch("/m40-abort").catch(() => {});
      });
      await page.waitForFunction(() => (window as any).__120fpsNet.pending.size === 0, undefined, {
        timeout: 10000,
      });
      expect((await readNetworkProbe(page)).pending).toEqual([]);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H5: a malformed URL rejects rather than resolving; same requirement.
  it("H5: a rejected fetch clears from the pending set", async () => {
    const { page, harness } = await opened("./fixtures/m40-settled.tsx");
    try {
      await page.evaluate(async () => {
        try {
          await (window as any).fetch("http://[bad");
        } catch {
          /* expected */
        }
      });
      expect((await readNetworkProbe(page)).pending).toEqual([]);
      expect((await readNetworkProbe(page)).started).toBeGreaterThan(0);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H6: XHR is the other half of the contract's wording.
  it("H6: a pending XHR counts as in flight", async () => {
    const { page, harness } = await opened("./fixtures/m40-settled.tsx", async (p) => {
      await p.route("**/m40-stall", () => {});
    });
    try {
      const before = await readNetworkProbe(page);
      await page.evaluate(() => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "/m40-stall");
        xhr.send();
      });
      const after = await readNetworkProbe(page);
      expect(after.pending.some((id) => id > before.started)).toBe(true);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  it("H7: a completed XHR clears from the pending set", async () => {
    const { page, harness } = await opened("./fixtures/m40-settled.tsx", async (p) => {
      await p.route("**/m40-ok", (route) => route.fulfill({ status: 200, body: "ok" }));
    });
    try {
      await page.evaluate(() => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "/m40-ok");
        xhr.send();
      });
      await page.waitForFunction(() => (window as any).__120fpsNet.pending.size === 0, undefined, {
        timeout: 10000,
      });
      expect((await readNetworkProbe(page)).pending).toEqual([]);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H8: the probe re-installs on every enterHarness (page reloads mid-run,
  // M30 context retry). A second install must not double-wrap fetch.
  it("H8: installing twice does not double-count", async () => {
    const { page, harness } = await opened("./fixtures/m40-settled.tsx", async (p) => {
      await p.route("**/m40-ok", (route) => route.fulfill({ status: 200, body: "ok" }));
    });
    try {
      await installMeasuredStateProbe(page);
      await installMeasuredStateProbe(page);
      await page.evaluate(() => (window as any).fetch("/m40-ok").catch(() => {}));
      await page.waitForFunction(() => (window as any).__120fpsNet.started > 0, undefined, {
        timeout: 10000,
      });
      expect((await readNetworkProbe(page)).started).toBe(1);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H9: nothing to observe must not throw.
  it("H9: a component that renders nothing probes cleanly", async () => {
    const { page, harness } = await opened("./fixtures/m31-renders-nothing.tsx");
    try {
      await page.evaluate(() => (window as any).__120fps.mount({}));
      expect(await probeLateMutation(page, MEASURED_STATE_HOLD_MS, true)).toBe(false);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H10: the late change can land outside #root entirely.
  it("H10: a portal that appears during the hold is caught", async () => {
    const { page, harness } = await opened("./fixtures/m40-late-portal.tsx");
    try {
      await mount(page);
      expect(await probeLateMutation(page, MEASURED_STATE_HOLD_MS, true)).toBe(true);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H11: the hold is real time, so it must actually cost the stated window.
  it("H11: the hold spans the grace window", async () => {
    const { page, harness } = await opened("./fixtures/m40-settled.tsx");
    try {
      await mount(page);
      const started = Date.now();
      await probeLateMutation(page, MEASURED_STATE_HOLD_MS, true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(MEASURED_STATE_HOLD_MS - 20);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H13: send() throws when the request was never opened. No loadend is
  // coming, so the id must not sit in the pending set forever.
  it("H13: a throwing send does not leak a pending id", async () => {
    const { page, harness } = await opened("./fixtures/m40-settled.tsx");
    try {
      await page.evaluate(() => {
        const xhr = new XMLHttpRequest();
        try {
          xhr.send();
        } catch {
          /* expected: not opened */
        }
      });
      expect((await readNetworkProbe(page)).pending).toEqual([]);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H14: a synchronous XHR fires loadend inside send().
  it("H14: a synchronous XHR clears from the pending set", async () => {
    const { page, harness } = await opened("./fixtures/m40-settled.tsx", async (p) => {
      await p.route("**/m40-ok", (route) => route.fulfill({ status: 200, body: "ok" }));
    });
    try {
      await page.evaluate(() => {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "/m40-ok", false);
        xhr.send();
      });
      const state = await readNetworkProbe(page);
      expect(state.started).toBe(1);
      expect(state.pending).toEqual([]);
    } finally {
      await page.close();
      await harness.cleanup();
    }
  }, 90000);

  // H12: a settled component must not pick up a state from a neighbour.
  it("H12: a settled component reports settled end to end", async () => {
    const report = await analyze("./fixtures/m40-settled.tsx", {
      ...FAST,
      jsonPath: "test-results/m40-settled.json",
    });
    expect(report.combos.every((c) => c.measuredState === "settled")).toBe(true);
    expect((report.warnings ?? []).some((w) => w.includes("measured in a"))).toBe(false);
  }, 300000);
});
