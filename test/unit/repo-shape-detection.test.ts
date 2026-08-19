import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runPreflight, preflightFailureMessage } from "../../src/preflight.js";
import {
  findCompilerConfig,
  findWorkspaceRoot,
  isPackageDeclared,
} from "../../src/project-model.js";
import { loadTsconfigAliases } from "../../src/harness.js";

const SOLID = path.resolve("fixtures/solid-project");
const PREACT = path.resolve("fixtures/preact-project");
const JSCONFIG = path.resolve("fixtures/jsconfig-project");

// Every fixture here sits inside this repository, whose root declares react and
// react-dom. The two framework fixtures carry their own lockfile so
// findWorkspaceRoot stops at them; without it they would inherit a React
// declaration and the case each exists to test would be unconstructable.
describe("a Solid project on disk", () => {
  it("governs its own install rather than inheriting this repository's", () => {
    expect(findWorkspaceRoot(SOLID)).toBe(SOLID);
    expect(isPackageDeclared("react", SOLID)).toBe(false);
    expect(isPackageDeclared("solid-js", SOLID)).toBe(true);
  });

  it("is rejected before anything is built", () => {
    const result = runPreflight({
      projectRoot: SOLID,
      entries: [path.join(SOLID, "Counter.tsx")],
    });
    const hit = result.hard.find((h) => h.kind === "unsupported-framework");
    expect(hit?.specifier).toBe("solid-js");
    expect(hit?.chain).toEqual(["Counter.tsx"]);
  });

  it("says Solid is unsupported instead of pointing at a server boundary", () => {
    const result = runPreflight({
      projectRoot: SOLID,
      entries: [path.join(SOLID, "Counter.tsx")],
    });
    const message = preflightFailureMessage(result.hard);
    expect(message).toContain("Solid");
    expect(message).not.toContain("Extract the client part");
  });
});

describe("a Preact project on disk", () => {
  it("passes preflight, because only Solid is rejected by name", () => {
    const result = runPreflight({
      projectRoot: PREACT,
      entries: [path.join(PREACT, "Card.tsx")],
    });
    expect(result.hard).toEqual([]);
  });

  // The blind spot M72 documented: an npm: alias keeps the react-dom key, so a
  // manifest read cannot tell this project from a React one. Only the resolved
  // package's own name can, which needs an install.
  it("reads as declaring react-dom although the alias points at preact", () => {
    expect(isPackageDeclared("react-dom", PREACT)).toBe(true);
    expect(isPackageDeclared("preact", PREACT)).toBe(true);
    expect(isPackageDeclared("react", PREACT)).toBe(false);
  });
});

describe("a JavaScript project configured by jsconfig.json", () => {
  it("is governed by its own jsconfig, not this repository's tsconfig", () => {
    const config = findCompilerConfig(path.join(JSCONFIG, "src"));
    expect(config).toBe(path.join(JSCONFIG, "jsconfig.json").replace(/\\/g, "/"));
  });

  it("supplies aliases that resolve to files that exist", () => {
    const aliases = loadTsconfigAliases(JSCONFIG);
    const alias = aliases.find((entry) => entry.find.test("@/tokens.js"));
    expect(alias).toBeDefined();
    const resolved = "@/tokens.js".replace(alias!.find, alias!.replacement);
    expect(resolved).toBe(path.join(JSCONFIG, "src", "tokens.js").replace(/\\/g, "/"));
    expect(fs.existsSync(resolved)).toBe(true);
  });
});
