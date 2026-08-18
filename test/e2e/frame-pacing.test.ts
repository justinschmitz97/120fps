import { describe, it, expect } from "vitest";
import { chromium } from "playwright";
import { buildAndServe } from "../../src/harness.js";
import {
  measureMount,
  measureRerender,
  createFramePump,
  MEASUREMENT_BROWSER_ARGS,
} from "../../src/measure.js";

async function doubleRafMedian(args: string[], pumped: boolean): Promise<number> {
  const browser = await chromium.launch({ headless: true, args });
  try {
    const page = await browser.newPage();
    const cdp = await page.context().newCDPSession(page);
    const pump = pumped ? createFramePump({ cdp }) : undefined;
    await page.goto("about:blank");
    const median = await page.evaluate(async () => {
      const raf2 = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      for (let i = 0; i < 5; i++) await raf2();
      const times: number[] = [];
      for (let i = 0; i < 20; i++) {
        const t0 = performance.now();
        await raf2();
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      return times[10];
    });
    if (pump) await pump.stop();
    return median;
  } finally {
    await browser.close();
  }
}

describe("begin-frame control mechanism", () => {
  it("driven frames break the 60Hz floor; vsync stays on it", async () => {
    const driven = await doubleRafMedian(MEASUREMENT_BROWSER_ARGS, true);
    const vsync = await doubleRafMedian([], false);
    expect(driven).toBeLessThan(15);
    expect(vsync).toBeGreaterThan(25);
  });
});

describe("measureMount pacing", () => {
  it("plain component measures under driven pacing with paint-inclusive traces", async () => {
    const harness = await buildAndServe("./fixtures/large-dom.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{ count: 200 }],
      });
      expect(results).toHaveLength(1);
      expect(results[0].pacing).toBe("driven");
      expect(results[0].mount.median).toBeGreaterThan(0);
      const names = new Set(
        (results[0].mountTraces ?? []).flat().map((e) => e.name),
      );
      // Frames are driven, not scheduled: paint work must still land in
      // every combo's traces.
      expect(
        names.has("Paint") || names.has("PrePaint") || names.has("Layerize"),
      ).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });

  it("animated component is re-measured under vsync pacing", async () => {
    const harness = await buildAndServe("./fixtures/m35-animated.tsx");
    try {
      const results = await measureMount(harness, {
        samples: 2,
        combos: [{}],
      });
      expect(results).toHaveLength(1);
      expect(results[0].hasAnimation).toBe(true);
      expect(results[0].pacing).toBe("vsync");
      expect(results[0].mount.samples).toHaveLength(2);
      expect(results[0].mount.median).toBeGreaterThan(0);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("measureRerender pacing", () => {
  it("defaults to driven pacing", async () => {
    const harness = await buildAndServe("./fixtures/static-buttons.tsx");
    try {
      const results = await measureRerender(harness, {
        samples: 2,
        combos: [{}],
      });
      expect(results).toHaveLength(1);
      expect(results[0].pacing).toBe("driven");
      expect(results[0].stable.median).toBeGreaterThanOrEqual(0);
    } finally {
      await harness.cleanup();
    }
  });

  it("combos named in animatedComboIndices run under vsync pacing", async () => {
    const harness = await buildAndServe("./fixtures/static-buttons.tsx");
    try {
      const results = await measureRerender(harness, {
        samples: 2,
        combos: [{}],
        animatedComboIndices: [0],
      });
      expect(results).toHaveLength(1);
      expect(results[0].pacing).toBe("vsync");
      expect(results[0].stable.samples).toHaveLength(2);
    } finally {
      await harness.cleanup();
    }
  });
});
