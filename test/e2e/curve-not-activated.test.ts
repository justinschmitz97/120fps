import { describe, it, expect } from "vitest";
import { sharedAnalyze as analyze } from "./shared-analyze.js";
import { CURVE_NOT_ACTIVATED_WARNING, formatTable } from "../../src/report.js";

const NO_ARRAY_PROP = CURVE_NOT_ACTIVATED_WARNING(
  "no array or list prop was found in the extracted schema",
);

describe("an explicit --curve that cannot run says so", () => {
  it("warns and falls back to combo mode when no array prop exists", async () => {
    const report = await analyze("./fixtures/static-buttons.tsx", {
      samples: 3,
      curveMode: true,
    });

    expect(report.scalingCurveReport).toBeUndefined();
    expect(report.warnings ?? []).toContain(NO_ARRAY_PROP);

    const out = formatTable(report);
    expect(out).toContain("Mode: prop combos");
    expect(out).toContain("--curve did not activate");
  }, 180_000);

  it("stays silent when curve mode was never requested", async () => {
    const report = await analyze("./fixtures/static-buttons.tsx", { samples: 3 });

    expect(report.scalingCurveReport).toBeUndefined();
    expect(report.warnings ?? []).not.toContain(NO_ARRAY_PROP);
    expect(formatTable(report)).not.toContain("--curve did not activate");
  }, 180_000);
});
