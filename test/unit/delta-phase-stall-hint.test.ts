import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  enrichPhaseError,
  retagPhaseError,
  HARNESS_STALL_HINT,
  DELTA_PHASE_STALL_HINT,
  RERENDER_PHASE_STALL_HINT,
} from "../../src/browser/index.js";

// M89 gap: only --no-deltas touches the delta pass; a delta stall must name it, not attribution.

describe("M89 gap: delta-phase stall hint", () => {
  it("enrichPhaseError names --no-deltas for phase: delta on a stall signature", () => {
    const err = enrichPhaseError(new Error("frame starvation: rAF fence exceeded 10000ms"), {
      phase: "delta",
      component: "App.tsx",
    });
    expect(err.message).toContain("delta phase failed");
    expect(err.message).toContain(DELTA_PHASE_STALL_HINT);
    expect(err.message).toContain("--no-deltas");
    expect(err.message).not.toContain("--no-attribution");
  });

  // M106 A1 moved "explore" to its own hint: --no-attribution did nothing against calcom's stall.
  it.each(["mount", "attribution"] as const)(
    "enrichPhaseError still names --no-attribution for phase: %s on a stall signature",
    (phase) => {
      const err = enrichPhaseError(new Error("Tracing.tracingComplete timed out"), { phase });
      expect(err.message).toContain(HARNESS_STALL_HINT);
      expect(err.message).toContain("--no-attribution");
      expect(err.message).not.toContain("--no-deltas");
    },
  );

  // M89 defect 2: live failure was "rerender", not "delta" (delta pass retags); own hint needed.
  it.each([
    "Tracing.tracingComplete timed out",
    "frame starvation: rAF fence exceeded 10000ms",
    "Target page, context or browser has been closed",
  ])(
    "enrichPhaseError names --samples/--max-combos, not --no-attribution, for phase: rerender on %s",
    (message) => {
      const err = enrichPhaseError(new Error(message), { phase: "rerender", component: "button.tsx" });
      expect(err.message).toContain("rerender phase failed");
      expect(err.message).toContain(RERENDER_PHASE_STALL_HINT);
      expect(err.message).toContain("--samples");
      expect(err.message).toContain("--max-combos");
      expect(err.message).not.toContain("--no-attribution");
      expect(err.message).not.toContain("--no-deltas");
    },
  );

  // enrichPhaseError no-ops on an already-tagged error; this re-enriches the preserved .cause.
  it("retagPhaseError re-enriches an already mount-tagged error under delta", () => {
    const tagged = enrichPhaseError(new Error("Target crashed"), { phase: "mount", component: "App.tsx" });
    expect(tagged.message).toContain("--no-attribution");

    const retagged = retagPhaseError(tagged, { phase: "delta", component: "App.tsx" });
    expect(retagged.message).toContain("delta phase failed");
    expect(retagged.message).toContain("--no-deltas");
    expect(retagged.message).not.toContain("--no-attribution");
  });

  it("retagPhaseError re-enriches an already rerender-tagged error under delta", () => {
    const tagged = enrichPhaseError(new Error("frame starvation: rAF fence exceeded 10000ms"), {
      phase: "rerender",
      component: "App.tsx",
    });
    const retagged = retagPhaseError(tagged, { phase: "delta", component: "App.tsx" });
    expect(retagged.message).toContain("delta phase failed");
    expect(retagged.message).toContain("--no-deltas");
    expect(retagged.message).not.toContain("--no-attribution");
  });

  it("retagPhaseError falls back to enriching directly when the error was never tagged", () => {
    const raw = new Error("frame starvation: rAF fence exceeded 10000ms");
    const retagged = retagPhaseError(raw, { phase: "delta", component: "App.tsx" });
    expect(retagged.message).toContain("delta phase failed");
    expect(retagged.message).toContain("--no-deltas");
  });

  it("h1: a rerender-phase failure that is not a stall signature gets no hint at all", () => {
    const err = enrichPhaseError(new Error("Calibration produced zero duration"), {
      phase: "rerender",
      comboIndex: 2,
    });
    expect(err.message).toContain("Calibration produced zero duration");
    expect(err.message).not.toContain(RERENDER_PHASE_STALL_HINT);
    expect(err.message).not.toContain("--samples");
    expect(err.message).not.toContain("--max-combos");
    expect(err.message).not.toContain("--no-attribution");
  });

  it("h2: RERENDER_PHASE_STALL_HINT and DELTA_PHASE_STALL_HINT are distinct and neither names --no-attribution", () => {
    expect(RERENDER_PHASE_STALL_HINT).not.toBe(DELTA_PHASE_STALL_HINT);
    expect(RERENDER_PHASE_STALL_HINT).not.toContain("--no-attribution");
    expect(DELTA_PHASE_STALL_HINT).not.toContain("--no-attribution");
    expect(HARNESS_STALL_HINT).toContain("--no-attribution");
  });

  it("retagPhaseError adds no hint when the underlying failure is not a stall", () => {
    const tagged = enrichPhaseError(new Error("Calibration produced zero duration"), { phase: "mount" });
    const retagged = retagPhaseError(tagged, { phase: "delta" });
    expect(retagged.message).toContain("Calibration produced zero duration");
    expect(retagged.message).not.toContain("--no-deltas");
    expect(retagged.message).not.toContain("--no-attribution");
  });

  it("retagPhaseError preserves the original error as .cause", () => {
    const original = new Error("Target crashed");
    const tagged = enrichPhaseError(original, { phase: "mount" });
    const retagged = retagPhaseError(tagged, { phase: "delta" });
    expect(retagged.cause).toBe(original);
  });

  it("a non-Error thrown value is still handled without crashing", () => {
    const retagged = retagPhaseError("plain string failure", { phase: "delta" });
    expect(retagged.message).toContain("plain string failure");
  });
});

describe("M89 gap: analyze.ts wiring (source-level check)", () => {
  it("measureStandardPropDeltas's extra-measurement calls are wrapped and retagged as delta", () => {
    const src = fs.readFileSync(path.resolve("src", "pipeline/modes/matrix.ts"), "utf-8");
    const fn = src.slice(
      src.indexOf("async function measureStandardPropDeltas("),
      src.indexOf("const propDeltas = pairs.map"),
    );
    expect(fn).toContain('retagPhaseError(err, deltaPhaseContext)');
    expect(fn).toContain('phase: "delta"');
    // Both measureMount and measureRerender must be guarded; a stall in either hits the same fence.
    expect(fn.match(/retagPhaseError\(err, deltaPhaseContext\)/g)?.length).toBe(2);
  });
});
