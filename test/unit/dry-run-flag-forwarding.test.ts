import { describe, it, expect } from "vitest";
import { parseArgs, explainPropsOptions } from "../../src/cli/index.js";

// element-plus: `--framework vue --explain-props` was byte-identical to
// `--explain-props`, while the same flag on a real run printed the
// "does not change how this file mounts" disclosure. The dry run's silence
// started at the call site, which never read the parsed flag.
describe("options a dry run receives from the command line", () => {
  it("carries --framework through to the dry run", () => {
    const args = parseArgs(["tabs.tsx", "--explain-props", "--framework", "vue"]);
    expect(explainPropsOptions(args, "tabs.tsx").framework).toBe("vue");
  });

  it("omits the framework when the flag is absent", () => {
    const args = parseArgs(["tabs.tsx", "--explain-props"]);
    expect(explainPropsOptions(args, "tabs.tsx")).not.toHaveProperty("framework");
  });

  it("carries the per-path export target and --no-preflight alongside it", () => {
    const args = parseArgs(["tabs.tsx#TabBar", "--explain-props", "--no-preflight", "--framework", "auto"]);
    const componentPath = args.componentPaths?.[0] ?? args.componentPath!;
    expect(explainPropsOptions(args, componentPath)).toEqual({
      target: "TabBar",
      noPreflight: true,
      framework: "auto",
    });
  });
});

// C-5: the dry run predicts the mode the real run would take, so every flag
// that decides a mode has to reach it. These four used to stop at the call
// site, exactly as --framework did.
describe("mode flags a dry run needs to predict the same mode", () => {
  it("carries --curve and --no-curve", () => {
    expect(explainPropsOptions(parseArgs(["a.tsx", "--curve"]), "a.tsx").curveMode).toBe(true);
    expect(explainPropsOptions(parseArgs(["a.tsx", "--no-curve"]), "a.tsx").curveMode).toBe(false);
    expect(
      explainPropsOptions(parseArgs(["a.tsx", "--curve", "items:array"]), "a.tsx").curveMode,
    ).toEqual({ propName: "items", propKind: "array" });
  });

  it("carries --matrix and --no-matrix", () => {
    expect(explainPropsOptions(parseArgs(["a.tsx", "--matrix"]), "a.tsx").matrixMode).toBe(true);
    expect(explainPropsOptions(parseArgs(["a.tsx", "--no-matrix"]), "a.tsx").matrixMode).toBe(false);
  });

  it("carries --isolate and --fixture", () => {
    const isolated = explainPropsOptions(parseArgs(["a.tsx", "--isolate", "mount,memory"]), "a.tsx");
    expect(isolated.isolation).toEqual({ phases: ["mount", "memory"], memoryCycles: undefined });
    const fixture = explainPropsOptions(parseArgs(["a.tsx", "--fixture", "a.fixture.tsx"]), "a.tsx");
    expect(fixture.fixturePath).toBe("a.fixture.tsx");
  });

  // M110 C1, C4, I2 (review): these three used to stop at the call site too,
  // so `--explain-props --no-auto-compose` predicted an auto-composed scene the
  // real run does not build, `--explain-props --no-transforms` printed the
  // `[transform:` lines the real run suppresses, and `--no-shims` changed the
  // external-dependency scan on one path only.
  it("carries --no-auto-compose, --no-transforms and --no-shims", () => {
    const options = explainPropsOptions(
      parseArgs(["a.tsx", "--explain-props", "--no-auto-compose", "--no-transforms", "--no-shims"]),
      "a.tsx",
    );
    expect(options.skipAutoCompose).toBe(true);
    expect(options.noTransforms).toBe(true);
    expect(options.noShims).toBe(true);
  });

  it("omits every mode flag that was not passed", () => {
    const options = explainPropsOptions(parseArgs(["a.tsx", "--explain-props"]), "a.tsx");
    expect(options).not.toHaveProperty("curveMode");
    expect(options).not.toHaveProperty("matrixMode");
    expect(options).not.toHaveProperty("isolation");
    expect(options).not.toHaveProperty("fixturePath");
    expect(options).not.toHaveProperty("skipAutoCompose");
    expect(options).not.toHaveProperty("noTransforms");
    expect(options).not.toHaveProperty("noShims");
  });
});

// M115 A2 / I12: the dry run prices the real run from combos and samples, so
// the two flags that decide those counts have to reach it. Without them
// `--explain-props --samples 5 --max-combos 4` priced the defaults instead of
// the run the same command line would take.
describe("cost flags a dry run needs to price the real run", () => {
  it("carries --samples and --max-combos", () => {
    const options = explainPropsOptions(
      parseArgs(["a.tsx", "--explain-props", "--samples", "5", "--max-combos", "4"]),
      "a.tsx",
    );
    expect(options.samples).toBe(5);
    expect(options.maxCombos).toBe(4);
  });

  it("omits both when neither flag was passed", () => {
    const options = explainPropsOptions(parseArgs(["a.tsx", "--explain-props"]), "a.tsx");
    expect(options).not.toHaveProperty("samples");
    expect(options).not.toHaveProperty("maxCombos");
  });

  it("carries each of the two flags on its own", () => {
    expect(
      explainPropsOptions(parseArgs(["a.tsx", "--samples", "3"]), "a.tsx"),
    ).not.toHaveProperty("maxCombos");
    expect(explainPropsOptions(parseArgs(["a.tsx", "--samples", "3"]), "a.tsx").samples).toBe(3);
    expect(
      explainPropsOptions(parseArgs(["a.tsx", "--max-combos", "2"]), "a.tsx"),
    ).not.toHaveProperty("samples");
    expect(explainPropsOptions(parseArgs(["a.tsx", "--max-combos", "2"]), "a.tsx").maxCombos).toBe(2);
  });
});
