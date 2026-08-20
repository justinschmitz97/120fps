import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  computeEffectiveSamples,
  MATRIX_AUTO_ACTIVATED_NOTICE,
  MATRIX_NO_AXES_WARNING,
  MATRIX_SUPPRESSED_BY_CURVE_WARNING,
} from "../../src/analyze.js";

const src = (name: string) => fs.readFileSync(path.resolve("src", name), "utf-8");

describe("computeEffectiveSamples", () => {
  it("leaves samples unchanged at or below the 20-combo threshold", () => {
    expect(computeEffectiveSamples(20, 10)).toBe(10);
    expect(computeEffectiveSamples(5, 10)).toBe(10);
  });

  it("throttles once combo count exceeds 20", () => {
    // 200 / 50 = 4, within [3, samples]
    expect(computeEffectiveSamples(50, 10)).toBe(4);
    // 200 / 21 = 9 (floored), within [3, samples]
    expect(computeEffectiveSamples(21, 10)).toBe(9);
  });

  it("floors at 3 samples for very large combo counts", () => {
    expect(computeEffectiveSamples(1000, 10)).toBe(3);
  });

  it("never drops below the 3-sample floor, even under a smaller request", () => {
    expect(computeEffectiveSamples(25, 2)).toBe(3);
  });

  it("never exceeds the requested sample count when above the floor", () => {
    expect(computeEffectiveSamples(25, 10)).toBeLessThanOrEqual(10);
  });

  it("applies identically for a matrix-sized combo count as for a plain combo count", () => {
    // Parity: one function, so a 256-cell forced matrix and a 256-combo plain
    // run throttle identically by construction.
    const matrixCells = 256;
    const plainCombos = 256;
    expect(computeEffectiveSamples(matrixCells, 10)).toBe(computeEffectiveSamples(plainCombos, 10));
  });
});

describe("MATRIX_AUTO_ACTIVATED_NOTICE", () => {
  it("names the cell count and mentions --no-matrix", () => {
    const notice = MATRIX_AUTO_ACTIVATED_NOTICE(16);
    expect(notice).toContain("16");
    expect(notice).toContain("--no-matrix");
    expect(notice.toLowerCase()).toContain("run time");
  });
});

// Source-level wiring checks: buildReport-style behavioral tests can't reach
// the matrix branch without a real browser/harness (analyze() is an
// integration entry point), so these confirm the specific lines exist and are
// gated correctly, matching the pattern used elsewhere in this suite (see
// m28-isolation-harden.test.ts's `src()` helper).
describe("matrix branch wiring", () => {
  const analyzeSrc = src("analyze.ts");
  const branch = analyzeSrc.slice(
    analyzeSrc.indexOf("async function runMatrixMode("),
    analyzeSrc.indexOf("function computeMedianFromSamples("),
  );

  it("only announces auto-activation, never a forced --matrix run", () => {
    expect(branch).toContain("matrixAutoActivated");
    expect(branch).toContain("if (matrixAutoActivated && !options.ci)");
  });

  it("applies computeEffectiveSamples to both matrixMounts and matrixRerenders", () => {
    expect(branch).toContain("const matrixEffectiveSamples = computeEffectiveSamples(matrixCombos.length, samples);");
    const mountsCall = branch.slice(branch.indexOf("const matrixMounts = await measureMount"), branch.indexOf("const matrixRerenders"));
    const rerendersCall = branch.slice(branch.indexOf("const matrixRerenders = await measureRerender"));
    expect(mountsCall).toContain("samples: matrixEffectiveSamples");
    expect(rerendersCall.slice(0, 300)).toContain("samples: matrixEffectiveSamples");
  });

  it("the plain-combo path uses the same computeEffectiveSamples helper", () => {
    expect(analyzeSrc).toContain("const effectiveSamples = computeEffectiveSamples(combos.length, samples);");
  });

  // M83 #4c (commerce-F5): an explicit --matrix with zero eligible axes must
  // not silently print an unexplained "Prop Matrix ()".
  it("warns when matrixAxes is empty, right alongside the pairwise-cover check", () => {
    expect(branch).toContain("if (matrixAxes.length === 0)");
    expect(branch).toContain("MATRIX_NO_AXES_WARNING");
    const axesIdx = branch.indexOf("const matrixAxes: MatrixAxis[]");
    const noAxesIdx = branch.indexOf("if (matrixAxes.length === 0)");
    const measureIdx = branch.indexOf("const matrixMounts = await measureMount(");
    expect(axesIdx).toBeGreaterThan(-1);
    expect(noAxesIdx).toBeGreaterThan(axesIdx);
    expect(noAxesIdx).toBeLessThan(measureIdx);
  });
});

describe("MATRIX_NO_AXES_WARNING", () => {
  it("names the anchor combo and points at --explain-props", () => {
    expect(MATRIX_NO_AXES_WARNING).toContain("anchor");
    expect(MATRIX_NO_AXES_WARNING).toContain("--explain-props");
  });
});

// M83 #4a (twenty-F6): an explicit --matrix must not silently lose to an
// auto-activated curve mode.
describe("MATRIX_SUPPRESSED_BY_CURVE_WARNING", () => {
  it("names the winning prop and the escape hatch", () => {
    const msg = MATRIX_SUPPRESSED_BY_CURVE_WARNING("items");
    expect(msg).toContain("items");
    expect(msg).toContain("--matrix");
    expect(msg).toContain("--no-curve");
  });
});

describe("M83 #4a: curve-vs-matrix dispatch wiring", () => {
  it("checks options.matrixMode before returning runCurveMode, and pushes the warning first", () => {
    const fullSrc = src("analyze.ts");
    const dispatchBranch = fullSrc.slice(
      fullSrc.indexOf("// --- Curve mode check ---"),
      fullSrc.indexOf("// --- Matrix mode check ---"),
    );
    expect(dispatchBranch).toContain("options.matrixMode === true");
    expect(dispatchBranch).toContain("MATRIX_SUPPRESSED_BY_CURVE_WARNING(curveMatch.schema.name)");
    const warnIdx = dispatchBranch.indexOf("MATRIX_SUPPRESSED_BY_CURVE_WARNING");
    const returnIdx = dispatchBranch.indexOf("return await runCurveMode(");
    expect(warnIdx).toBeGreaterThan(-1);
    expect(returnIdx).toBeGreaterThan(warnIdx);
  });
});
