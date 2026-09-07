import { describe, it, expect } from "vitest";
import path from "node:path";
import { formatMountAbortHints } from "../../src/report/index.js";
import { autoImportMapEvidence } from "../../src/project/index.js";

const ABORT = "ReferenceError: useCounter is not defined\n    at Proxy._sfc_render";
const VITE_CONFIG = { file: "vite.config.ts", ignoredKeys: ["plugins"] };

const hints = (autoImportMap?: { file: string; names: string[] }) =>
  formatMountAbortHints(ABORT, {
    viteConfig: VITE_CONFIG,
    ...(autoImportMap ? { autoImportMap } : {}),
  });

describe("an undefined identifier reports the map the run consulted", () => {
  it("names the map when it declares the identifier", () => {
    const text = hints({ file: "src/auto-imports.d.ts", names: ["useCounter", "ref"] });
    expect(text).toContain("src/auto-imports.d.ts");
    expect(text).toContain("useCounter");
    expect(text).not.toContain("declares no useCounter");
  });

  it("says so when the map was read and does not declare it", () => {
    const text = hints({ file: "src/auto-imports.d.ts", names: ["ref"] });
    expect(text).toContain("src/auto-imports.d.ts");
    expect(text).toContain("declares no useCounter");
  });

  it("says no map was found when the project has none", () => {
    const text = hints();
    expect(text).toContain("No auto-import map was found");
    expect(text).not.toContain("src/auto-imports.d.ts");
  });

  it("keeps the two outcomes distinguishable", () => {
    expect(hints({ file: "src/auto-imports.d.ts", names: ["useCounter"] })).not.toBe(
      hints({ file: "src/auto-imports.d.ts", names: ["ref"] }),
    );
  });
});

describe("the evidence a run collects for that hint", () => {
  it("reads the project's own map", () => {
    const evidence = autoImportMapEvidence(path.resolve("fixtures/vue-auto-imports-map"));
    expect(evidence?.autoImportMap.file).toContain("auto-imports.d.ts");
    expect(evidence?.autoImportMap.names).toContain("useCounter");
  });

  it("reports nothing for a project without one", () => {
    expect(autoImportMapEvidence(path.resolve("fixtures/vue-no-generated-map"))).toBeUndefined();
  });
});
