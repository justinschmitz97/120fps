import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  collectStaticPreBuildWarnings,
  harnessServerCompileOptions,
  resolveServerConditions,
} from "../../src/harness/index.js";

const REFERENCES = path.resolve("fixtures/tsconfig-shapes/project-references");
const BUTTON = path.join(REFERENCES, "src", "components", "Button.tsx");
const APP_CONFIG = path.join(REFERENCES, "tsconfig.app.json").replace(/\\/g, "/");

// react-spectrum's root declares `customConditions: ["source"]`, and react-aria
// publishes its subpaths only under that condition with no dist/. Without the
// condition the dev server answered 500 for every one of them; nothing in the
// harness ever read customConditions.
describe("customConditions from the governing config reach the dev server", () => {
  it("forwards the condition the referenced config declares", () => {
    const resolved = resolveServerConditions(REFERENCES, [], { forFile: BUTTON });

    expect(resolved.conditions).toEqual(["source"]);
  });

  it("keeps the vite config's own list first and appends what it does not contain", () => {
    const resolved = resolveServerConditions(REFERENCES, ["browser"], {
      forFile: BUTTON,
      viteConfigFile: path.join(REFERENCES, "vite.config.ts"),
    });

    expect(resolved.conditions).toEqual(["browser", "source"]);
  });

  it("adds a condition the vite config already declares only once", () => {
    const resolved = resolveServerConditions(REFERENCES, ["source", "browser"], {
      forFile: BUTTON,
    });

    expect(resolved.conditions).toEqual(["source", "browser"]);
  });

  it("names both sources in the disclosure", () => {
    const resolved = resolveServerConditions(REFERENCES, ["browser"], {
      forFile: BUTTON,
      viteConfigFile: path.join(REFERENCES, "vite.config.ts"),
    });

    expect(resolved.warning).toBeDefined();
    expect(resolved.warning!).toContain("browser, source");
    expect(resolved.warning!).toContain("vite.config.ts");
    expect(resolved.warning!).toContain(APP_CONFIG);
  });

  it("discloses the condition list once in the run's warnings", () => {
    const preBuild = collectStaticPreBuildWarnings(REFERENCES, { componentPath: BUTTON });
    const disclosures = preBuild.warnings.filter((w) => w.includes("resolve.conditions"));

    expect(disclosures).toHaveLength(1);
    expect(disclosures[0]).toContain("customConditions");
    expect(preBuild.resolveConditions).toEqual(["source"]);
  });

  // The spec words A5 as a fact about the built server options, so the wiring
  // between the resolved list and createServer is asserted, not only the list.
  it("reaches the server options the harness builds", () => {
    const compile = harnessServerCompileOptions("react", REFERENCES, REFERENCES, BUTTON, [
      "source",
    ]);

    expect(compile.conditions).toEqual(["source"]);
  });

  it("says nothing and forwards nothing for a project that declares no conditions", () => {
    const jsxPreserve = path.resolve("fixtures/tsconfig-shapes/jsx-preserve");

    const resolved = resolveServerConditions(jsxPreserve, [], {
      forFile: path.join(jsxPreserve, "src", "badge.tsx"),
    });

    expect(resolved.conditions).toEqual([]);
    expect(resolved.warning).toBeUndefined();
  });
});
