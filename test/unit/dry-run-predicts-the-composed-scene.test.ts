import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  explainProps,
  formatExplainProps,
  MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING,
} from "../../src/analyze.js";
import { CURVE_NOT_ACTIVATED_WARNING } from "../../src/report.js";

// supabase-F3, calcom-R1: the dry run hard-coded `composed = false` and
// promised a matrix over components the dispatcher auto-composes. Composition
// is decided from export names and schemas, both of which the dry run already
// reads, so the prediction can be the dispatcher's own answer.

const COMPOUND = path.resolve("fixtures/m30-strict-compound.tsx");
const SINGLE = path.resolve("fixtures/button.tsx");
// Compound, and its root carries two matrix axes plus an array prop: the one
// shape where the composed answer decides curve, matrix and the scale probe at
// once.
const COMPOUND_WITH_AXES = path.resolve("fixtures/m110-compound-with-axes.tsx");

describe("what the dry run says about the scene the real run would build", () => {
  it("names the root it would compose and how many exports it read", async () => {
    const explained = await explainProps(COMPOUND, {});
    expect(explained.composition).toEqual({ root: "Panel", exportCount: 5 });
    expect(formatExplainProps(explained)).toContain(
      "Composition:  would auto-compose from Panel (5 exports)",
    );
  });

  it("says a single-export component would be measured alone", async () => {
    const explained = await explainProps(SINGLE, {});
    expect(explained.composition).toBeUndefined();
    expect(formatExplainProps(explained)).toContain("Composition:  would measure Button alone");
  });

  // A fixture owns its whole scene, so "would measure <Name> alone" was untrue
  // for every fixture-owned run.
  it("names the fixture that would supply the scene", async () => {
    const explained = await explainProps(path.resolve("fixtures/accordion-root.tsx"), {});
    expect(explained.fixtureFile).toBe("fixtures/accordion-root.fixture.tsx");
    expect(formatExplainProps(explained)).toContain(
      "Composition:  would measure the scene in fixtures/accordion-root.fixture.tsx",
    );
  });

  it("says the export would be measured alone when --no-auto-compose is passed", async () => {
    const explained = await explainProps(COMPOUND, { skipAutoCompose: true });
    expect(explained.composition).toBeUndefined();
    expect(formatExplainProps(explained)).toContain("Composition:  would measure Panel alone");
  });
});

describe("the mode the dry run predicts for a component the dispatcher composes", () => {
  it("falls to combo and says the composed scene supplies the props", async () => {
    const explained = await explainProps(COMPOUND, { matrixMode: true });
    expect(explained.predictedMode).toBe("combo");
    expect(explained.matrixIneligibleReason).toBe("composed");
    const table = formatExplainProps(explained);
    // Panel declares `children` only: the matrix predicate never matched, so
    // the line names the flag that got the run here, not a predicate.
    expect(explained.matrixWouldActivate).toBe(false);
    expect(table).toContain(
      "Matrix mode:  --matrix was passed, but an auto-composed scene supplies the props, so this " +
      "run would measure that scene's single combo (auto-composed from Panel)",
    );
    expect(table).not.toContain("predicate matches");
    expect(table).not.toContain("would auto-activate");
  });

  it("says the predicate matched when it did, over the same composed scene", async () => {
    const explained = await explainProps(COMPOUND_WITH_AXES, { matrixMode: true });
    expect(explained.matrixWouldActivate).toBe(true);
    expect(explained.matrixIneligibleReason).toBe("composed");
    expect(formatExplainProps(explained)).toContain(
      "Matrix mode:  predicate matches, but an auto-composed scene supplies the props, so this " +
      "run would measure that scene's single combo (auto-composed from Deck)",
    );
  });

  it("predicts the matrix the dispatcher would run once composition is off", async () => {
    const explained = await explainProps(COMPOUND, { matrixMode: true, skipAutoCompose: true });
    expect(explained.predictedMode).toBe("matrix");
    expect(explained.matrixIneligibleReason).toBeUndefined();
  });

  it("reports no reason at all when nothing asked for a matrix", async () => {
    const explained = await explainProps(COMPOUND, {});
    expect(explained.predictedMode).toBe("combo");
    expect(explained.matrixIneligibleReason).toBeUndefined();
  });

  it("lets an explicit --no-matrix outrank the composed scene", async () => {
    const explained = await explainProps(COMPOUND, { matrixMode: false });
    expect(explained.matrixIneligibleReason).toBe("no-matrix-flag");
  });

  it("lets a fixture outrank the composed scene", async () => {
    const explained = await explainProps(path.resolve("fixtures/accordion-root.tsx"), {
      matrixMode: true,
    });
    expect(explained.matrixIneligibleReason).toBe("fixture");
  });
});

// M110 review: `resolveCurveMatch` returns undefined for a composed scene, so
// a scaling prop on the composed root decides nothing about the real run.
describe("what a scaling prop on a composed root predicts", () => {
  it("predicts the composed scene's single combo, not a curve", async () => {
    const explained = await explainProps(COMPOUND_WITH_AXES, {});
    expect(explained.composition?.root).toBe("Deck");
    expect(explained.predictedMode).toBe("combo");
    const table = formatExplainProps(explained);
    expect(table).toContain(
      "Curve mode:   would not activate: an auto-composed scene supplies the props",
    );
    expect(table).not.toContain("Scale probe:");
  });

  it("keeps the composition suppressor for an explicit --matrix", async () => {
    const { warnings } = await explainProps(COMPOUND_WITH_AXES, { matrixMode: true });
    expect(warnings).toContain(MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING("Deck"));
  });

  it("says an explicit --curve did not activate, in the run path's own words", async () => {
    const { warnings } = await explainProps(COMPOUND_WITH_AXES, { curveMode: true });
    expect(warnings).toContain(CURVE_NOT_ACTIVATED_WARNING("the run measures a composed scene"));
  });

  it("says the same for an explicit --curve over a fixture-owned run", async () => {
    const { warnings } = await explainProps(path.resolve("fixtures/accordion-root.tsx"), {
      curveMode: true,
    });
    expect(warnings).toContain(CURVE_NOT_ACTIVATED_WARNING("the run measures a fixture file"));
  });
});
