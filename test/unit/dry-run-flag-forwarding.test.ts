import { describe, it, expect } from "vitest";
import { parseArgs, explainPropsOptions } from "../../src/cli.js";

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

  it("omits every mode flag that was not passed", () => {
    const options = explainPropsOptions(parseArgs(["a.tsx", "--explain-props"]), "a.tsx");
    expect(options).not.toHaveProperty("curveMode");
    expect(options).not.toHaveProperty("matrixMode");
    expect(options).not.toHaveProperty("isolation");
    expect(options).not.toHaveProperty("fixturePath");
  });
});
