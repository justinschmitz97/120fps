import { describe, it, expect } from "vitest";
import { sharedAnalyze as analyze } from "./shared-analyze.js";
import { COMPOSITION_EMPTY_WARNING } from "../../src/props/index.js";

// F3: parts throw outside their parent, so the inferred tree mounts empty; falls back and says so.
describe("composition rollback", () => {
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
