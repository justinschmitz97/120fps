import { describe, it, expect } from "vitest";
import { afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { predictMode, explainProps, DRY_RUN_RUNTIME_ONLY_NOTE, formatExplainProps, type PropsExplanation } from "../../src/analyze.js";

// element-plus-F4: the dry run printed "Curve mode: would activate on max" and
// "Matrix mode: would auto-activate" as two independent booleans, while the
// real dispatcher returns at curve before the matrix branch is reached. One
// function now answers for both, in the dispatcher's own order.

const BASE = {
  isolation: false,
  curve: false,
  matrixEligible: true,
  matrixRequested: false,
  matrixAutoActivates: false,
};

describe("every branch of the real dispatcher, in its own precedence", () => {
  it("isolation wins over everything", () => {
    expect(predictMode({ ...BASE, isolation: true, curve: true, matrixAutoActivates: true }))
      .toBe("isolation");
  });

  it("curve wins over matrix, however matrix qualified", () => {
    expect(predictMode({ ...BASE, curve: true, matrixAutoActivates: true })).toBe("curve");
    expect(predictMode({ ...BASE, curve: true, matrixRequested: true })).toBe("curve");
  });

  it("matrix runs when it is eligible and either requested or auto-activating", () => {
    expect(predictMode({ ...BASE, matrixRequested: true })).toBe("matrix");
    expect(predictMode({ ...BASE, matrixAutoActivates: true })).toBe("matrix");
  });

  it("an ineligible matrix falls to combo however loudly it was asked for", () => {
    expect(predictMode({ ...BASE, matrixEligible: false, matrixRequested: true })).toBe("combo");
    expect(predictMode({ ...BASE, matrixEligible: false, matrixAutoActivates: true })).toBe("combo");
  });

  it("combo is what is left", () => {
    expect(predictMode(BASE)).toBe("combo");
  });
});

function explanation(overrides: Partial<PropsExplanation> = {}): PropsExplanation {
  return {
    componentPath: "./Badge.vue",
    componentName: "Badge",
    exports: ["Badge"],
    props: [],
    matrixWouldActivate: false,
    scaleProbeWillRun: false,
    predictedMode: "combo",
    warnings: [],
    ...overrides,
  };
}

describe("what the dry run prints about the mode it predicts", () => {
  it("claims a matrix only when the matrix is what would run", () => {
    const table = formatExplainProps(explanation({ matrixWouldActivate: true, predictedMode: "matrix" }));
    expect(table).toContain("Matrix mode:  would auto-activate");
    expect(table).not.toContain("takes precedence");
  });

  it("names curve as what beats a matching matrix predicate", () => {
    const table = formatExplainProps(explanation({
      matrixWouldActivate: true,
      predictedMode: "curve",
      curve: { propName: "max", reason: "numeric prop name matches scaling pattern" },
    }));
    expect(table).toContain("Curve mode:   would activate on max");
    expect(table).toContain("curve mode takes precedence");
  });

  it("says a fixture supplies the props rather than claiming combo precedence", () => {
    const table = formatExplainProps(explanation({
      matrixWouldActivate: true,
      predictedMode: "combo",
      matrixIneligibleReason: "fixture",
    }));
    expect(table).not.toContain("combo mode takes precedence");
    expect(table).toContain("a fixture supplies the props");
  });

  it("says nothing about precedence when the predicate did not match", () => {
    const table = formatExplainProps(explanation({ matrixWouldActivate: false, predictedMode: "combo" }));
    expect(table).toContain("Matrix mode:  would not auto-activate");
  });
});

describe("the dry run's footer states what it could not decide", () => {
  it("names the three runtime-only classes in one line", () => {
    const table = formatExplainProps(explanation());
    expect(table).toContain(DRY_RUN_RUNTIME_ONLY_NOTE);
    expect(DRY_RUN_RUNTIME_ONLY_NOTE).toContain("throws while it evaluates");
    expect(DRY_RUN_RUNTIME_ONLY_NOTE).toContain("throws at render");
    expect(DRY_RUN_RUNTIME_ONLY_NOTE).toContain("only at runtime");
  });

  it("keeps the no-side-effect sentence above it", () => {
    const table = formatExplainProps(explanation());
    const lines = table.split("\n");
    const dryRun = lines.findIndex((l) => l.startsWith("Dry run: nothing was measured"));
    const note = lines.findIndex((l) => l === DRY_RUN_RUNTIME_ONLY_NOTE);
    expect(dryRun).toBeGreaterThan(-1);
    expect(note).toBe(dryRun + 1);
  });
});

// Review C-5: the dry run predicted from its own detection alone, so five
// flags made it promise a mode the real run would not take. Lane A forwards
// `curveMode` / `matrixMode` / `isolation` / `fixturePath` under the same names
// the real run uses; these drive `predictMode` from them, one case per flag.
describe("the flags the real dispatcher reads reach the prediction", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // A component with two boolean props (matrix auto-activates) and an array
  // prop (curve auto-activates), so every flag has something to suppress.
  function project(extra: Record<string, string> = {}): { root: string; entry: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-predict-"));
    tmpDirs.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "predict-app" }));
    fs.mkdirSync(path.join(root, "node_modules/react-dom"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/react-dom/package.json"), JSON.stringify({ name: "react-dom", version: "18.2.0", main: "index.js" }));
    fs.writeFileSync(path.join(root, "node_modules/react-dom/index.js"), "module.exports = {};");
    fs.writeFileSync(path.join(root, "node_modules/react-dom/client.js"), "module.exports = {};");
    fs.writeFileSync(
      path.join(root, "List.tsx"),
      "export function List(props: { open?: boolean; dense?: boolean }) { return null; }",
    );
    for (const [rel, content] of Object.entries(extra)) {
      fs.writeFileSync(path.join(root, rel), content);
    }
    return { root, entry: path.join(root, "List.tsx") };
  }

  it("predicts matrix with no flags, which is the baseline the rest deviate from", async () => {
    const { entry } = project();
    const explained = await explainProps(entry);
    expect(explained.matrixWouldActivate).toBe(true);
    expect(explained.predictedMode).toBe("matrix");
  });

  it("--no-matrix predicts combo and says the flag is why", async () => {
    const { entry } = project();
    const explained = await explainProps(entry, { matrixMode: false });
    expect(explained.predictedMode).toBe("combo");
    expect(explained.matrixIneligibleReason).toBe("no-matrix-flag");
    expect(formatExplainProps(explained)).toContain("--no-matrix was passed");
  });

  it("--isolate predicts isolation, whatever else qualified", async () => {
    const { entry } = project();
    const explained = await explainProps(entry, { isolation: { phases: ["mount"] } });
    expect(explained.predictedMode).toBe("isolation");
    expect(formatExplainProps(explained)).toContain("isolation mode takes precedence");
  });

  it("--fixture predicts the fixture branch and names it", async () => {
    const { root, entry } = project({
      "scene.fixture.tsx": "export default function Scene() { return null; }",
    });
    const explained = await explainProps(entry, { fixturePath: path.join(root, "scene.fixture.tsx") });
    expect(explained.predictedMode).toBe("combo");
    expect(explained.matrixIneligibleReason).toBe("fixture");
    expect(formatExplainProps(explained)).toContain("a fixture supplies the props");
  });

  // Curve auto-activates on an array prop and beats matrix, so the two curve
  // cases need a component that has one; the matrix baseline above must not.
  function scalingEntry(): string {
    const { root } = project({
      "Grid.tsx": "export function Grid(props: { open?: boolean; dense?: boolean; items?: string[] }) { return null; }",
    });
    return path.join(root, "Grid.tsx");
  }

  it("an explicit --curve predicts curve on the prop the user named", async () => {
    const explained = await explainProps(scalingEntry(), {
      curveMode: { propName: "items", propKind: "array" },
    });
    expect(explained.predictedMode).toBe("curve");
  });

  it("--no-curve does not claim the component has no scaling prop", async () => {
    const explained = await explainProps(scalingEntry(), { curveMode: false });
    expect(explained.predictedMode).toBe("matrix");
    expect(explained.curveSuppressedByFlag).toBe(true);
    const table = formatExplainProps(explained);
    expect(table).toContain("--no-curve, though this component has a scaling prop");
    expect(table).not.toContain("no array or numeric scaling prop");
  });
});

