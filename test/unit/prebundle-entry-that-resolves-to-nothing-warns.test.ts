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
// at dep-optimization one minute later. `clsx` is the same failure one layer
// out: an ordinary bare package installed nowhere the fixture can reach.
const FIXTURE = path.resolve(import.meta.dirname, "..", "..", "fixtures", "unresolvable-include");
const ENTRY = path.join(FIXTURE, "app", "widget.tsx");

describe("a pre-bundle candidate that resolves to nothing", () => {
  it("is dropped from the include list and reported in the same scan", () => {
    const unresolved: Array<{ specifier: string; importer: string }> = [];
    const externals = scanExternalDeps(
      ENTRY,
      FIXTURE,
      [],
      undefined,
      [],
      undefined,
      undefined,
      unresolved,
    );

    expect(externals.filter((e) => e.startsWith("#"))).toEqual([]);
    expect(unresolved).toContainEqual({ specifier: "#app/root", importer: "app/widget.tsx" });
  });

  it("is reported once, naming the specifier and the file that imported it", () => {
    const warnings: string[] = [];
    scanExternalDeps(ENTRY, FIXTURE, [], undefined, warnings);

    const reported = warnings.filter((w) => w.includes("#app/root"));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("app/widget.tsx");
    expect(reported[0]).toBe(UNRESOLVED_PREBUNDLE_ENTRY_WARNING("#app/root", "app/widget.tsx"));
  });

  it("reports a bare package that resolves to no installed directory either", () => {
    const warnings: string[] = [];
    const unresolved: Array<{ specifier: string; importer: string }> = [];
    const externals = scanExternalDeps(
      ENTRY,
      FIXTURE,
      [],
      undefined,
      warnings,
      undefined,
      undefined,
      unresolved,
    );

    expect(unresolved).toContainEqual({ specifier: "clsx", importer: "app/widget.tsx" });
    expect(warnings.filter((w) => w.includes('"clsx"'))).toEqual([
      UNRESOLVED_PREBUNDLE_ENTRY_WARNING("clsx", "app/widget.tsx"),
    ]);
    // M77/M94: the entry itself stays; a package this scanner cannot see is
    // still one Vite may resolve per request.
    expect(externals).toContain("clsx");
  });

  it("says nothing about a package that is installed above the project", () => {
    const warnings: string[] = [];
    const externals = scanExternalDeps(ENTRY, FIXTURE, [], undefined, warnings);

    expect(externals).toContain("typescript");
    expect(warnings.filter((w) => w.includes('"typescript"'))).toEqual([]);
  });

  it("reaches both modes through the one static pre-build both of them read", () => {
    const preBuild = collectStaticPreBuildWarnings(FIXTURE, { componentPath: ENTRY });

    expect(preBuild.unresolvedExternals).toEqual([
      { specifier: "#app/root", importer: "app/widget.tsx" },
      { specifier: "clsx", importer: "app/widget.tsx" },
    ]);
    expect(preBuild.warnings).toContain(
      UNRESOLVED_PREBUNDLE_ENTRY_WARNING("#app/root", "app/widget.tsx"),
    );
    expect(preBuild.externalDeps.filter((e) => e.startsWith("#"))).toEqual([]);
  });

  it("reports a specifier both the component walk and the wrapper walk reach once", () => {
    const preBuild = collectStaticPreBuildWarnings(FIXTURE, {
      componentPath: ENTRY,
      wrapPath: path.join(FIXTURE, "app", "wrap.tsx"),
    });

    expect(preBuild.unresolvedExternals.filter((e) => e.specifier === "clsx")).toHaveLength(1);
    expect(
      preBuild.warnings.filter(
        (w) => w === UNRESOLVED_PREBUNDLE_ENTRY_WARNING("clsx", "app/widget.tsx"),
      ),
    ).toHaveLength(1);
  });
});
