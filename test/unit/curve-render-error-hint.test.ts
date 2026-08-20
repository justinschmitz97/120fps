import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { hintsForReport } from "../../src/hints.js";
import type { Report } from "../../src/report.js";

const src = (name: string): string => fs.readFileSync(path.resolve("src", name), "utf-8");

// M79 (4b, chakra-ui-F1). hintsForReport used to only inspect report.combos
// to detect a render error (combo.renderHealth === "error"); curve mode
// always sets combos: [], so a render error could never reach hint
// selection there. runCurveMode already detects a broken scale point
// correctly and pushes CURVE_RENDER_ERROR_WARNING (a "scale point N=..."
// line) into report.warnings — the same signal renderFailed() (analyze.ts)
// already keys on. hintsForReport now reads that same signal.

function curveReport(opts: {
  warnings?: string[];
  domFlat?: boolean;
  renderErrorPoints?: Array<{ n: number; pageErrors: string[] }>;
}): Report {
  return {
    combos: [],
    warnings: opts.warnings ?? [],
    scalingCurveReport: {
      propName: "items",
      propKind: "array",
      ...(opts.domFlat ? { domFlat: true } : {}),
      ...(opts.renderErrorPoints ? { renderErrorPoints: opts.renderErrorPoints } : {}),
    },
  } as unknown as Report;
}

describe("M79 4b: curve-mode render error reaches hintsForReport", () => {
  it("adds renderError when a scale-point warning is present", () => {
    const report = curveReport({
      warnings: [
        "scale point N=10 rendered 0 DOM nodes while the page threw, so the curve describes a " +
          "broken render: TypeError: cannot read properties of undefined",
      ],
    });
    expect(hintsForReport(report)).toContain("renderError");
  });

  it("does not add renderError for a healthy curve report", () => {
    const report = curveReport({ warnings: [] });
    expect(hintsForReport(report)).not.toContain("renderError");
  });

  it("suppresses domFlat when the same report also has a render error", () => {
    const report = curveReport({
      domFlat: true,
      warnings: [
        "scale point N=1 rendered 0 DOM nodes while the page threw, so the curve describes a " +
          "broken render: TypeError: boom",
      ],
    });
    const ids = hintsForReport(report);
    expect(ids).toContain("renderError");
    expect(ids).not.toContain("domFlat");
  });

  it("keeps domFlat when the curve is genuinely flat (no render error)", () => {
    const report = curveReport({ domFlat: true, warnings: [] });
    const ids = hintsForReport(report);
    expect(ids).toContain("domFlat");
    expect(ids).not.toContain("renderError");
  });

  it("does not confuse an unrelated warning for the scale-point signal", () => {
    const report = curveReport({ warnings: ["unrelated: something else happened"] });
    expect(hintsForReport(report)).not.toContain("renderError");
  });
});

// M79 gap (structural field). Migrated from the string-signature convention
// per M83's own instruction: hintsForReport now reads
// scalingCurveReport.renderErrorPoints directly. No "scale point N=" string
// appears in report.warnings in any of these — the field alone must drive
// the hint, proving the switch actually happened rather than merely adding
// a redundant check.
describe("M79 gap: hintsForReport reads renderErrorPoints structurally (no warnings string)", () => {
  it("adds renderError from the structural field alone", () => {
    const report = curveReport({
      renderErrorPoints: [{ n: 10, pageErrors: ["TypeError: cannot read properties of undefined"] }],
    });
    expect(report.warnings).toEqual([]);
    expect(hintsForReport(report)).toContain("renderError");
  });

  it("does not add renderError for a healthy report with an empty renderErrorPoints array", () => {
    const report = curveReport({ renderErrorPoints: [] });
    expect(hintsForReport(report)).not.toContain("renderError");
  });

  it("suppresses domFlat from the structural field alone", () => {
    const report = curveReport({
      domFlat: true,
      renderErrorPoints: [{ n: 1, pageErrors: ["boom"] }],
    });
    const ids = hintsForReport(report);
    expect(ids).toContain("renderError");
    expect(ids).not.toContain("domFlat");
  });
});

// Wiring: runCurveMode (analyze.ts) is an integration entry point that
// cannot be reached without a real browser/harness (matches the established
// convention for matrix-transparency.test.ts's "matrix branch wiring"
// section), so the population site is pinned by source content instead.
describe("M79 gap: runCurveMode populates renderErrorPoints", () => {
  it("sets curveReport.renderErrorPoints at the same point CURVE_RENDER_ERROR_WARNING is pushed", () => {
    const analyzeSrc = src("analyze.ts");
    const fn = analyzeSrc.slice(
      analyzeSrc.indexOf("async function runCurveMode("),
      analyzeSrc.indexOf("const curveVerdict = computeCurveVerdict("),
    );
    expect(fn).toContain("curveReport.renderErrorPoints = brokenPoints.map(");
    expect(fn).toContain("CURVE_RENDER_ERROR_WARNING(");
    // Both read the same brokenPoints array, so they cannot drift apart.
    const fieldIdx = fn.indexOf("curveReport.renderErrorPoints = brokenPoints.map(");
    const warningIdx = fn.indexOf("CURVE_RENDER_ERROR_WARNING(");
    expect(fieldIdx).toBeGreaterThan(-1);
    expect(warningIdx).toBeGreaterThan(fieldIdx);
  });
});
