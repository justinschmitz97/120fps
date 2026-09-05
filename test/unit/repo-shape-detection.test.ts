import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { runPreflight, preflightFailureMessage } from "../../src/project/index.js";
import {
  findCompilerConfig,
  findWorkspaceRoot,
  isPackageDeclared,
} from "../../src/project/index.js";
import { loadTsconfigAliases } from "../../src/project/index.js";

const SOLID = path.resolve("fixtures/solid-project");
const PREACT = path.resolve("fixtures/preact-project");
const JSCONFIG = path.resolve("fixtures/jsconfig-project");

// M78: empty node_modules decouples these fixtures from the directory-existence-only install check.
beforeAll(() => {
  fs.mkdirSync(path.join(SOLID, "node_modules"), { recursive: true });
  fs.mkdirSync(path.join(PREACT, "node_modules"), { recursive: true });
});

// Each fixture carries its own lockfile so findWorkspaceRoot stops there, not at this repo's react.
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

  // M72: an npm: alias keeps the react-dom key; only the resolved package name tells them apart.
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
