import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  collectStaticPreBuildWarnings,
  scanExternalDeps,
  UNRESOLVED_PREBUNDLE_ENTRY_WARNING,
} from "../../src/harness.js";

// epic-stack-F2: `#app/root` in a package whose manifest declares no `imports`
// map resolves to no file, no package and no alias. The scan used to walk past
// it without a word, so `--explain-props` promised a run the dev server killed
// at dep-optimization one minute later.
const FIXTURE = path.resolve(import.meta.dirname, "..", "..", "fixtures", "unresolvable-include");
const ENTRY = path.join(FIXTURE, "app", "widget.tsx");

describe("a pre-bundle candidate that resolves to nothing", () => {
  it("is never returned as an optimizeDeps entry", () => {
    const externals = scanExternalDeps(ENTRY, FIXTURE, []);

    expect(externals.filter((e) => e.startsWith("#"))).toEqual([]);
  });

  it("is reported once, naming the specifier and the file that imported it", () => {
    const warnings: string[] = [];
    scanExternalDeps(ENTRY, FIXTURE, [], undefined, warnings);

    const reported = warnings.filter((w) => w.includes("#app/root"));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("app/widget.tsx");
    expect(reported[0]).toBe(UNRESOLVED_PREBUNDLE_ENTRY_WARNING("#app/root", "app/widget.tsx"));
  });

  it("is published on the scan's unresolved list", () => {
    const unresolved: Array<{ specifier: string; importer: string }> = [];
    scanExternalDeps(ENTRY, FIXTURE, [], undefined, [], undefined, undefined, unresolved);

    expect(unresolved).toEqual([{ specifier: "#app/root", importer: "app/widget.tsx" }]);
  });

  it("leaves an ordinary package specifier in the include list", () => {
    expect(scanExternalDeps(ENTRY, FIXTURE, [])).toContain("clsx");
  });

  it("reaches both modes through the one static pre-build both of them read", () => {
    const preBuild = collectStaticPreBuildWarnings(FIXTURE, { componentPath: ENTRY });

    expect(preBuild.unresolvedExternals).toEqual([
      { specifier: "#app/root", importer: "app/widget.tsx" },
    ]);
    expect(preBuild.warnings).toContain(
      UNRESOLVED_PREBUNDLE_ENTRY_WARNING("#app/root", "app/widget.tsx"),
    );
    expect(preBuild.externalDeps.filter((e) => e.startsWith("#"))).toEqual([]);
  });
});
