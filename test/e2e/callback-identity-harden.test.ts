import { describe, it, expect } from "vitest";
import { buildAndServe } from "../../src/harness.js";
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

describe("callback identity edge cases", () => {
  // H10: the shape that produced the dogfood false positives: expensive tree,
  // no memoization, callback never forwarded. Both arms do identical work.
  it("never reports a callback the component ignores", async () => {
    expect(await deltasFor("./fixtures/m66-no-memo.tsx", ["onAction"])).toHaveLength(0);
  }, 240_000);

  // H9: a callback held in a ref is stable for the component's lifetime.
  it("never reports a useRef-held callback", async () => {
    expect(await deltasFor("./fixtures/m66-useref-callback.tsx", ["onAction"])).toHaveLength(0);
  }, 240_000);

  // H8: the component rebinds the callback itself, so the caller's identity
  // cannot change what renders.
  it("never reports a callback the component rebinds on every render", async () => {
    expect(await deltasFor("./fixtures/m66-rebound-callback.tsx", ["onAction"])).toHaveLength(0);
  }, 240_000);

  // H12: a memoized export bails out entirely on an unchanged callback.
  it("reports a memoized export whose only prop is the callback", async () => {
    const deltas = await deltasFor("./fixtures/m66-memo-export.tsx", ["onAction"]);
    expect(deltas).toHaveLength(1);
    expect(deltas[0].freshMs!).toBeGreaterThan(deltas[0].stableMs! * 3);
  }, 240_000);

  // H7: a dispatch reaching the component through context is not a prop, so
  // there is nothing to probe and nothing to report.
  it("reports nothing when the component has no function props", async () => {
    expect(await deltasFor("./fixtures/m66-usereducer-dispatch.tsx", [])).toHaveLength(0);
  }, 240_000);
});
