import { describe, it, expect } from "vitest";
import {
  enrichPhaseError,
  EXPLORE_PHASE_STALL_HINT,
  HARNESS_STALL_HINT,
} from "../../src/page-errors.js";

function stalled(phase: "explore" | "mount" | "attribution" | "rerender"): string {
  return enrichPhaseError(new Error("Tracing.tracingComplete timed out"), { phase }).message;
}

// calcom: the explore phase stalled on a Radix portal trigger and advised
// `--no-attribution`, which the M106 investigation measured against the same
// component: identical 124 s failure. The flags that bound explore are the
// exploration budget and the sample count.
describe("the flags an explore-phase stall names", () => {
  it("names the budget and the sample count", () => {
    expect(EXPLORE_PHASE_STALL_HINT).toContain("--explore-budget");
    expect(EXPLORE_PHASE_STALL_HINT).toContain("--samples");
  });

  it("never advises the flag that was measured ineffective for it", () => {
    expect(EXPLORE_PHASE_STALL_HINT).not.toContain("--no-attribution");
    expect(stalled("explore")).not.toContain("--no-attribution");
  });

  it("reaches a stalled explore phase", () => {
    expect(stalled("explore")).toContain(EXPLORE_PHASE_STALL_HINT);
    expect(stalled("explore")).toContain("explore phase failed");
  });

  it("leaves the phases --no-attribution really does bound alone", () => {
    expect(stalled("attribution")).toContain(HARNESS_STALL_HINT);
    expect(stalled("mount")).toContain(HARNESS_STALL_HINT);
  });

  it("adds no hint to a failure that is not a stall", () => {
    const message = enrichPhaseError(new Error("boom"), { phase: "explore" }).message;
    expect(message).not.toContain("--explore-budget");
  });
});
