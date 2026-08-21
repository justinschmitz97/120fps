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
