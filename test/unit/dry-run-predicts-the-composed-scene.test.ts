import { describe, it, expect } from "vitest";
import path from "node:path";
import { explainProps, formatExplainProps } from "../../src/analyze.js";

// supabase-F3, calcom-R1: the dry run hard-coded `composed = false` and
// promised a matrix over components the dispatcher auto-composes. Composition
// is decided from export names and schemas, both of which the dry run already
// reads, so the prediction can be the dispatcher's own answer.

const COMPOUND = path.resolve("fixtures/m30-strict-compound.tsx");
const SINGLE = path.resolve("fixtures/button.tsx");

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
    expect(table).toContain(
      "Matrix mode:  predicate matches, but an auto-composed scene supplies the props, so this run " +
      "would measure that scene's single combo",
    );
    expect(table).toContain("Panel");
    expect(table).not.toContain("would auto-activate");
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
