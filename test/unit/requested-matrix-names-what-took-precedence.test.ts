import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  explainProps,
  MATRIX_SUPPRESSED_BY_CURVE_WARNING,
  MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING,
  MATRIX_SUPPRESSED_BY_FIXTURE_WARNING,
} from "../../src/analyze.js";

// calcom-R1: an explicit --matrix that lost to an auto-composed scene printed
// nothing at all -- the curve branch has warned about exactly this since M83,
// the compose and fixture branches fell through to "mode: prop combos" in
// silence. The dry run and the real run push the same string.

const COMPOUND = path.resolve("fixtures/m30-strict-compound.tsx");
const FIXTURE_OWNED = path.resolve("fixtures/accordion-root.tsx");

describe("a --matrix the dispatcher cannot honour", () => {
  it("names the composed root that took precedence", async () => {
    const { warnings } = await explainProps(COMPOUND, { matrixMode: true });
    expect(warnings).toContain(MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING("Panel"));
    expect(MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING("Panel")).toContain("Panel");
  });

  it("names the fixture file that took precedence", async () => {
    const { warnings } = await explainProps(FIXTURE_OWNED, { matrixMode: true });
    const suppressed = warnings.filter((w) => w.startsWith("--matrix did not activate:"));
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toBe(
      MATRIX_SUPPRESSED_BY_FIXTURE_WARNING("fixtures/accordion-root.fixture.tsx"),
    );
  });

  it("stays silent on a run that never asked for a matrix", async () => {
    const composed = await explainProps(COMPOUND, {});
    const fixtureOwned = await explainProps(FIXTURE_OWNED, {});
    for (const { warnings } of [composed, fixtureOwned]) {
      expect(warnings.some((w) => w.startsWith("--matrix did not activate:"))).toBe(false);
    }
  });

  it("stays silent when the matrix is what would run", async () => {
    const { warnings } = await explainProps(COMPOUND, {
      matrixMode: true,
      skipAutoCompose: true,
    });
    expect(warnings.some((w) => w.startsWith("--matrix did not activate:"))).toBe(false);
  });

  it("words all three suppressors the way the curve suppressor already did", () => {
    for (const text of [
      MATRIX_SUPPRESSED_BY_CURVE_WARNING("count"),
      MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING("Panel"),
      MATRIX_SUPPRESSED_BY_FIXTURE_WARNING("fixtures/accordion-root.fixture.tsx"),
    ]) {
      expect(text).toMatch(/^--matrix did not activate: /);
      expect(text).toMatch(/Re-run with .+ force matrix instead\.$/);
    }
  });
});
