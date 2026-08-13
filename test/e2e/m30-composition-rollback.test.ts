import { describe, it, expect } from "vitest";
import { sharedAnalyze as analyze } from "./shared-analyze.js";
import { COMPOSITION_EMPTY_WARNING } from "../../src/composition.js";

// F3 — the fixture's parts throw outside their required parent, so whatever
// tree the taxonomy infers mounts to an empty root. The run must fall back to
// the bare export and say so, not report timings for a scene that rendered
// nothing.
describe("m30 F3 — composition rollback", () => {
  it("measures the bare export and warns when the composed scene is empty", async () => {
    const report = await analyze("./fixtures/m30-strict-compound.tsx", {
      samples: 2,
      warmupRuns: 1,
      skipReactAnalysis: true,
      skipAttribution: true,
      jsonPath: "./m30-rollback-report.json",
    });

    expect(report.warnings).toBeDefined();
    expect(report.warnings).toContain(COMPOSITION_EMPTY_WARNING("Panel"));
    expect(report.autoComposition).toBeUndefined();
    expect(report.compositionTree).toBeUndefined();
    expect(report.combos.length).toBeGreaterThan(0);
  }, 300000);
});
