import { describe, it, expect } from "vitest";
import fs from "node:fs";
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

  // The dispatcher consults a sibling fixture only when no --target was given
  // (analyze(): `else if (!fixturePath && !options.target)`), so naming one
  // here would name a file the real run ignores.
  it("ignores a sibling fixture the real run would not read, under --target", async () => {
    const { warnings, predictedMode } = await explainProps(FIXTURE_OWNED, {
      target: "Accordion",
      matrixMode: true,
    });
    expect(warnings.some((w) => w.startsWith("--matrix did not activate:"))).toBe(false);
    expect(predictedMode).toBe("matrix");
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
      expect(text).toMatch(/Re-run .+ force matrix instead\.$/);
    }
  });
});

// M110 review: `--target` throws TARGET_WITH_FIXTURE_ERROR against an explicit
// --fixture and against a fixture input, so the `<file>#Export` remedy is
// only a command the sibling case can actually run.
describe("the remedy each fixture provenance can actually run", () => {
  it("offers <file>#Export only for the auto-detected sibling", async () => {
    const { warnings } = await explainProps(FIXTURE_OWNED, { matrixMode: true });
    const suppressed = warnings.find((w) => w.startsWith("--matrix did not activate:"))!;
    expect(suppressed).toContain("<file>#Export");
  });

  it("tells an explicit --fixture run to drop the flag", async () => {
    const { warnings } = await explainProps(FIXTURE_OWNED, {
      matrixMode: true,
      fixturePath: path.resolve("fixtures/accordion-root.fixture.tsx"),
    });
    const suppressed = warnings.find((w) => w.startsWith("--matrix did not activate:"))!;
    expect(suppressed).toBe(
      MATRIX_SUPPRESSED_BY_FIXTURE_WARNING(
        "fixtures/accordion-root.fixture.tsx",
        "explicit-flag",
      ),
    );
    expect(suppressed).toContain("without --fixture");
    expect(suppressed).not.toContain("<file>#Export");
  });

  it("tells a fixture-input run to re-run against the component file", async () => {
    const { warnings } = await explainProps(
      path.resolve("fixtures/accordion-root.fixture.tsx"),
      { matrixMode: true },
    );
    const suppressed = warnings.find((w) => w.startsWith("--matrix did not activate:"))!;
    expect(suppressed).toBe(
      MATRIX_SUPPRESSED_BY_FIXTURE_WARNING(
        "fixtures/accordion-root.fixture.tsx",
        "fixture-input",
      ),
    );
    expect(suppressed).toContain("not this fixture");
    expect(suppressed).not.toContain("<file>#Export");
  });
});

// The run path pushes these same two lines, and no unit test can reach it
// (analyze() needs a browser), so the wiring is pinned at source level -- the
// pattern matrix-transparency.test.ts already uses for this branch.
describe("the run path's own suppression push", () => {
  const analyzeSrc = fs.readFileSync(path.resolve("src/analyze.ts"), "utf-8");
  const dispatch = analyzeSrc.slice(analyzeSrc.indexOf("const matrixAutoActivated = activateMatrix"));

  it("pushes the same two constants the dry run pushes", () => {
    const branch = dispatch.slice(0, dispatch.indexOf("if (activateMatrix)"));
    expect(branch).toContain("if (matrixRequested && !activateMatrix)");
    expect(branch).toContain("MATRIX_SUPPRESSED_BY_COMPOSITION_WARNING(compositionTree!.root)");
    expect(branch).toContain("MATRIX_SUPPRESSED_BY_FIXTURE_WARNING(");
  });

  it("passes the fixture's provenance, so the remedy stays runnable", () => {
    expect(dispatch).toContain(
      'inputIsFixture ? "fixture-input" : fixtureAutoDetected ? "sibling" : "explicit-flag"',
    );
  });
});
