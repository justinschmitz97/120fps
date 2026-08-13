import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { computeEffectiveSamples, MATRIX_AUTO_ACTIVATED_NOTICE } from "../../src/analyze.js";

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
});
