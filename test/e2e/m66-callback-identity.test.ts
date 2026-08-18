import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness.js";
import { runReactAnalysis } from "../../src/react-profiler.js";

async function analyze(fixture: string, fnProp: string) {
  const harness = await buildAndServe(fixture);
  try {
    const results = await runReactAnalysis(harness, {
      combos: [{}],
      samples: 3,
      fnPropNames: [fnProp],
    });
    return results.get(0);
  } finally {
    await harness.cleanup();
  }
}

describe("M66: callback identity", () => {
  it("reports a prop the component forwards to a memoized child", async () => {
    const opts = await analyze("./fixtures/m66-callback-sensitive.tsx", "onAction");
    const deltas = opts?.callbackIdentityDeltas ?? [];
    expect(deltas).toHaveLength(1);
    expect(deltas[0].propName).toBe("onAction");
    // The stable arm lets the memoized subtree bail out, so the effect is the
    // whole subtree render rather than a few percent of drift.
    expect(deltas[0].freshMs!).toBeGreaterThan(deltas[0].stableMs! * 3);
  }, 240_000);

  it("never reports a useReducer dispatch reaching the memoized child", async () => {
    const opts = await analyze("./fixtures/m66-usereducer-dispatch.tsx", "dispatch");
    expect(opts?.callbackIdentityDeltas ?? []).toHaveLength(0);
  }, 240_000);

  it("never reports a useState setter reaching the memoized child", async () => {
    const opts = await analyze("./fixtures/m66-usestate-setter.tsx", "onChange");
    expect(opts?.callbackIdentityDeltas ?? []).toHaveLength(0);
  }, 240_000);
});
