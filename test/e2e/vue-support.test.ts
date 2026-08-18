import { describe, it, expect, afterAll } from "vitest";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { buildAndServe, type HarnessResult } from "../../src/harness.js";
import { attachPageErrorCapture } from "../../src/page-errors.js";
import { applyWrapperViewport, measureMount, measureRerender } from "../../src/measure.js";
import { explore } from "../../src/explorer.js";
import { sharedAnalyze as analyze } from "./shared-analyze.js";

const VUE = path.resolve("fixtures/vue-project");
const VUE_WRAP = path.resolve("fixtures/vue-wrap-project");

let browser: Browser | undefined;

afterAll(async () => {
  if (browser) await browser.close();
});

async function openHarness(
  harness: HarnessResult,
): Promise<{ page: Page; errors: ReturnType<typeof attachPageErrorCapture> }> {
  browser ??= await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = attachPageErrorCapture(page);
  await page.goto(harness.url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => typeof (window as any).__120fps === "object", undefined, {
    timeout: 30000,
  });
  return { page, errors };
}

// E1: an SFC mounts through the project's own @vitejs/plugin-vue.
describe("mounting an SFC", () => {
  it("renders the component and its scoped styles", async () => {
    const harness = await buildAndServe(path.join(VUE, "Button.vue"));
    try {
      const { page, errors } = await openHarness(harness);
      await page.evaluate(() => (window as any).__120fps.mount({ label: "save", variant: "primary" }));
      await page.waitForSelector(".btn", { timeout: 10000 });
      expect(await page.textContent(".btn")).toContain("save");
      // <style scoped> compiled: the plugin ran, not just the TS transform.
      const scoped = await page.evaluate(() => {
        const el = document.querySelector(".btn")!;
        return [...el.attributes].some((a) => a.name.startsWith("data-v-"));
      });
      expect(scoped).toBe(true);
      expect(errors.errors).toEqual([]);
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 90000);

  it("unmounts to an empty container and remounts", async () => {
    const harness = await buildAndServe(path.join(VUE, "Text.vue"));
    try {
      const { page } = await openHarness(harness);
      await page.evaluate(() => (window as any).__120fps.mount({ text: "one" }));
      await page.waitForSelector('[data-testid="text"]');
      await page.evaluate(() => (window as any).__120fps.unmount());
      expect(await page.evaluate(() => document.getElementById("root")!.children.length)).toBe(0);
      await page.evaluate(() => (window as any).__120fps.mount({ text: "two" }));
      expect(await page.textContent('[data-testid="text"]')).toBe("two");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 90000);
});

// E2: the scheduling hazard. A wrong answer here does not fail: it reports
// implausibly fast rerenders.
describe("rerender resolves after Vue patched the DOM", () => {
  it("shows the new content at the moment rerender() resolves", async () => {
    const harness = await buildAndServe(path.join(VUE, "Text.vue"));
    try {
      const { page } = await openHarness(harness);
      await page.evaluate(() => (window as any).__120fps.mount({ text: "before" }));
      await page.waitForSelector('[data-testid="text"]');

      const observed = await page.evaluate(async () => {
        const api = (window as any).__120fps;
        const read = () => document.querySelector('[data-testid="text"]')!.textContent;
        const result = api.rerender({ text: "after" });
        const beforeAwait = read();
        await result;
        return { beforeAwait, afterAwait: read() };
      });

      // The patch is queued, not applied, when rerender() is called...
      expect(observed.beforeAwait).toBe("before");
      // ...and applied by the time its promise resolves.
      expect(observed.afterAwait).toBe("after");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 90000);

  it("patches instead of remounting, so component state survives", async () => {
    const harness = await buildAndServe(path.join(VUE, "Counter.vue"));
    try {
      const { page } = await openHarness(harness);
      await page.evaluate(() => (window as any).__120fps.mount({ label: "inc", start: 0 }));
      await page.waitForSelector('[data-testid="count"]');
      await page.click("button");
      expect(await page.textContent('[data-testid="count"]')).toBe("1");
      await page.evaluate(() => (window as any).__120fps.rerender({ label: "bump", start: 0 }));
      expect(await page.textContent("button")).toBe("bump");
      // A remount would have reset the counter to `start`.
      expect(await page.textContent('[data-testid="count"]')).toBe("1");
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 90000);
});

// E3: the provider wrapper, applied through the default slot.
describe("provider wrapper", () => {
  it("wraps the component, runs setup first, and exposes viewport", async () => {
    const harness = await buildAndServe(path.join(VUE_WRAP, "Widget.vue"), {
      wrapPath: path.join(VUE_WRAP, "120fps.setup.vue"),
    });
    try {
      const { page, errors } = await openHarness(harness);
      // Readiness implies setup completed (M41).
      expect(await page.evaluate(() => (window as any).__vueWrapSeeded)).toBe(true);
      expect(await page.evaluate(() => (window as any).__120fps.hasSetup)).toBe(true);

      await page.evaluate(() => (window as any).__120fps.mount({ title: "hello" }));
      await page.waitForSelector(".widget");
      const wrapped = await page.evaluate(
        () => !!document.querySelector('[data-wrap="vue-provider"] .widget'),
      );
      expect(wrapped).toBe(true);

      await applyWrapperViewport(page);
      expect(page.viewportSize()).toEqual({ width: 500, height: 400 });

      await page.evaluate(() => (window as any).__120fps.teardown());
      expect(await page.evaluate(() => (window as any).__vueWrapSeeded)).toBeUndefined();
      expect(errors.errors).toEqual([]);
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 90000);

  it("mounts the wrapper alone for the overhead pass", async () => {
    const harness = await buildAndServe(path.join(VUE_WRAP, "Widget.vue"), {
      wrapPath: path.join(VUE_WRAP, "120fps.setup.vue"),
    });
    try {
      const { page } = await openHarness(harness);
      await page.evaluate(() => (window as any).__120fps.mountWrapperOnly());
      // Attached, not visible: an empty wrapper has no box of its own, which is
      // exactly what the overhead pass measures.
      await page.waitForSelector('[data-wrap="vue-provider"]', { state: "attached" });
      expect(await page.evaluate(() => document.querySelectorAll(".widget").length)).toBe(0);
      await page.close();
    } finally {
      await harness.cleanup();
    }
  }, 90000);
});

// E4: the framework-neutral measurement spine runs unchanged.
describe("measurement modules run unchanged", () => {
  it("measures mount and rerender through the standard passes", async () => {
    const harness = await buildAndServe(path.join(VUE, "Button.vue"));
    try {
      const combos = [{ label: "save", variant: "primary" }];
      const mounts = await measureMount(harness, { combos, samples: 3, warmupRuns: 1 });
      expect(mounts).toHaveLength(1);
      expect(mounts[0].mount.median).toBeGreaterThan(0);
      expect(mounts[0].domNodeCount).toBeGreaterThan(0);
      expect(mounts[0].measuredState).toBe("settled");

      const rerenders = await measureRerender(harness, { combos, samples: 3, warmupRuns: 1 });
      expect(rerenders[0].stable.median).toBeGreaterThan(0);
    } finally {
      await harness.cleanup();
    }
  }, 120000);

  it("discovers and exercises interactions", async () => {
    const harness = await buildAndServe(path.join(VUE, "Counter.vue"));
    try {
      const results = await explore(harness, {
        combos: [{ label: "inc", start: 0 }],
        samples: 2,
        maxNodes: 10,
        maxWallClockMs: 20000,
      });
      const edges = [...results[0].graph.edges.values()].flat();
      expect(edges.length).toBeGreaterThan(0);
      expect(edges.some((e) => e.interaction.type === "click")).toBe(true);
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});

// E5: open question 3: does M40's late-mutation probe read a Vue scene?
describe("measured-state integrity", () => {
  it("flags a component that mutates after the mount trace closes", async () => {
    const harness = await buildAndServe(path.join(VUE, "LateMutation.vue"));
    try {
      const mounts = await measureMount(harness, {
        combos: [{ seed: "x" }],
        samples: 2,
        warmupRuns: 1,
      });
      expect(mounts[0].measuredState).toBe("late-mutation");
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});

// E6: open question 4: build-stable data-v-* attributes are not volatility.
describe("scoped style attributes are stable", () => {
  it("finds no volatile regions in a scoped-style component", async () => {
    const harness = await buildAndServe(path.join(VUE, "Button.vue"));
    try {
      const results = await explore(harness, {
        combos: [{ label: "save", variant: "primary" }],
        samples: 2,
        maxNodes: 5,
        maxWallClockMs: 20000,
      });
      expect(results[0].volatileRegions ?? 0).toBe(0);
    } finally {
      await harness.cleanup();
    }
  }, 120000);
});

// E7: the whole pipeline, end to end.
describe("full report", () => {
  it("produces a report of the standard shape with no React block", async () => {
    const report = await analyze(path.join(VUE, "Counter.vue"), {
      samples: 2,
      warmupRuns: 1,
      maxCombos: 1,
      skipDeltas: true,
      skipAutoScale: true,
      exploreBudgetSeconds: 10,
    });
    expect(report.combos.length).toBeGreaterThan(0);
    expect(report.combos[0].mount.median).toBeGreaterThan(0);
    expect(report.combos[0].tier).toBeDefined();
    expect(report.combos[0].reactOptimizations).toBeUndefined();
    expect(report.reactCompiler).toBeUndefined();
    expect(report.projectTransforms).toContain("vue");
  }, 180000);

  it("measures a .fixture.vue scene as one combo", async () => {
    const report = await analyze(path.join(VUE, "Widget.fixture.vue"), {
      samples: 2,
      warmupRuns: 1,
      skipDeltas: true,
      skipAutoScale: true,
      exploreBudgetSeconds: 10,
    });
    expect(report.combos).toHaveLength(1);
    expect(report.combos[0].props).toEqual({});
    expect(report.combos[0].domNodeCount).toBeGreaterThan(2);
  }, 180000);
});
