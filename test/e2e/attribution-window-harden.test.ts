import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness.js";
import { measureMount } from "../../src/measure.js";
import { attributeCost } from "../../src/metrics.js";

async function attributionFor(fixture: string, options: { samples: number; warmupRuns: number }) {
  const harness = await buildAndServe(fixture);
  try {
    const results = await measureMount(harness, options);
    return { mount: results[0], attribution: attributeCost(results[0].mountTraces!) };
  } finally {
    await harness.cleanup();
  }
}

describe("attribution window edge cases", () => {
  // H1: a single-sample run has no averaging to do and must not divide.
  it("one sample reports the mount's own scripting", async () => {
    const { mount, attribution } = await attributionFor("./fixtures/large-dom.tsx", {
      samples: 1,
      warmupRuns: 1,
    });
    expect(attribution.sampleCount).toBe(1);
    const total = attribution.buckets.reduce((s, b) => s + b.durationMs, 0);
    expect(total).toBeCloseTo(attribution.totalScriptingMs, 6);
    expect(total).toBeLessThanOrEqual(mount.mount.samples[0]);
  }, 240_000);

  // H2: warmup renders are discarded before recording, so they must not
  // inflate the divisor or the sum.
  it("warmups stay out of the window count", async () => {
    const { mount, attribution } = await attributionFor("./fixtures/large-dom.tsx", {
      samples: 3,
      warmupRuns: 0,
    });
    expect(attribution.sampleCount).toBe(3);
    expect(mount.mountTraces!.length).toBe(3);
    const withWarmups = await attributionFor("./fixtures/large-dom.tsx", {
      samples: 3,
      warmupRuns: 2,
    });
    expect(withWarmups.attribution.sampleCount).toBe(3);
  }, 480_000);
});
