import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness.js";
import { measureMount } from "../../src/measure.js";
import { attributeCost } from "../../src/metrics.js";
import { runReactAnalysis } from "../../src/react-profiler.js";

async function deltasFor(fixture: string, fnPropNames: string[]) {
  const harness = await buildAndServe(fixture);
  try {
    const results = await runReactAnalysis(harness, { combos: [{}], samples: 3, fnPropNames });
    return results.get(0)?.callbackIdentityDeltas ?? [];
  } finally {
    await harness.cleanup();
  }
}

async function attributionFor(fixture: string, options: { samples: number; warmupRuns: number }) {
  const harness = await buildAndServe(fixture);
  try {
    const results = await measureMount(harness, options);
    return { mount: results[0], attribution: attributeCost(results[0].mountTraces!) };
  } finally {
    await harness.cleanup();
  }
}

describe("M66 harden: attribution window", () => {
  // H1 — a single-sample run has no averaging to do and must not divide.
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

  // H2 — warmup renders are discarded before recording, so they must not
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

  // H3 — unmount is traced in its own window and never reaches attribution.
  it("excludes unmount cost", async () => {
    const { mount, attribution } = await attributionFor("./fixtures/large-dom.tsx", {
      samples: 3,
      warmupRuns: 1,
    });
    expect(mount.unmount.median).toBeGreaterThan(0);
    const meanMount =
      mount.mount.samples.reduce((a, b) => a + b, 0) / mount.mount.samples.length;
    const total = attribution.buckets.reduce((s, b) => s + b.durationMs, 0);
    expect(total).toBeLessThanOrEqual(meanMount);
  }, 240_000);
});

describe("M66 harden: callback identity", () => {
  // H10 — the shape that produced the dogfood false positives: expensive tree,
  // no memoization, callback never forwarded. Both arms do identical work.
  it("never reports a callback the component ignores", async () => {
    expect(await deltasFor("./fixtures/m66-no-memo.tsx", ["onAction"])).toHaveLength(0);
  }, 240_000);

  // H9 — a callback held in a ref is stable for the component's lifetime.
  it("never reports a useRef-held callback", async () => {
    expect(await deltasFor("./fixtures/m66-useref-callback.tsx", ["onAction"])).toHaveLength(0);
  }, 240_000);

  // H8 — the component rebinds the callback itself, so the caller's identity
  // cannot change what renders.
  it("never reports a callback the component rebinds on every render", async () => {
    expect(await deltasFor("./fixtures/m66-rebound-callback.tsx", ["onAction"])).toHaveLength(0);
  }, 240_000);

  // H12 — a memoized export bails out entirely on an unchanged callback.
  it("reports a memoized export whose only prop is the callback", async () => {
    const deltas = await deltasFor("./fixtures/m66-memo-export.tsx", ["onAction"]);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].freshMs!).toBeGreaterThan(deltas[0].stableMs! * 3);
  }, 240_000);

  // H7 — a dispatch reaching the component through context is not a prop, so
  // there is nothing to probe and nothing to report.
  it("reports nothing when the component has no function props", async () => {
    expect(await deltasFor("./fixtures/m66-usereducer-dispatch.tsx", [])).toHaveLength(0);
  }, 240_000);
});
