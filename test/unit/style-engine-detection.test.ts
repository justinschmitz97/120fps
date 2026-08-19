import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  UNSUPPORTED_STYLE_ENGINES,
  UNSUPPORTED_STYLE_ENGINE_WARNING,
  detectUnsupportedStyleEngines,
  findPostcssConfigAbove,
  resolveStyleTooling,
} from "../../src/harness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-style-engine-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function manifest(dir: string, deps: Record<string, string>): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p", dependencies: deps }));
  return dir;
}

function workspace(): { root: string; member: string } {
  const root = path.join(tmpDir, "repo");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "root" }));
  const member = path.join(root, "packages", "app");
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, "package.json"), JSON.stringify({ name: "app" }));
  return { root, member };
}

describe("loading the Tailwind plugin", () => {
  it("is decided by the project's dependency, not by whether a stylesheet was found", () => {
    manifest(tmpDir, { "@tailwindcss/vite": "^4.0.0" });
    expect(resolveStyleTooling(tmpDir).tailwind).toBe(true);
  });

  it("stays off for a project without the plugin", () => {
    manifest(tmpDir, { tailwindcss: "^4.0.0" });
    expect(resolveStyleTooling(tmpDir).tailwind).toBe(false);
  });
});

describe("recognizing styling engines the harness cannot replicate", () => {
  it("lists the engines it knows about", () => {
    expect(UNSUPPORTED_STYLE_ENGINES).toEqual([
      "unocss",
      "@unocss/vite",
      "@linaria/vite",
      "@linaria/core",
      "@pandacss/dev",
    ]);
  });

  it("finds none in a plain project", () => {
    manifest(tmpDir, { react: "^19.0.0" });
    expect(detectUnsupportedStyleEngines(tmpDir)).toEqual([]);
  });

  it("names each engine the project depends on", () => {
    manifest(tmpDir, { unocss: "^0.60.0", "@pandacss/dev": "^0.40.0" });
    expect(detectUnsupportedStyleEngines(tmpDir)).toEqual(["unocss", "@pandacss/dev"]);
  });

  it("finds an engine declared at the workspace root", () => {
    const { root, member } = workspace();
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "root", devDependencies: { "@linaria/vite": "^5.0.0" } }),
    );
    expect(detectUnsupportedStyleEngines(member)).toEqual(["@linaria/vite"]);
  });

  it("says the styling is not replicated", () => {
    const warning = UNSUPPORTED_STYLE_ENGINE_WARNING(["unocss"]);
    expect(warning).toContain("unocss");
    expect(warning).toMatch(/not replicated|unstyled/i);
  });

  it("carries one warning naming every engine found", () => {
    manifest(tmpDir, { unocss: "^0.60.0", "@linaria/core": "^6.0.0" });
    expect(resolveStyleTooling(tmpDir).warnings).toEqual([
      UNSUPPORTED_STYLE_ENGINE_WARNING(["unocss", "@linaria/core"]),
    ]);
  });

  it("warns about nothing for a project with no such engine", () => {
    manifest(tmpDir, { react: "^19.0.0" });
    expect(resolveStyleTooling(tmpDir).warnings).toEqual([]);
  });
});

describe("finding a PostCSS config Vite's own search would miss", () => {
  it("returns nothing when the member has its own config", () => {
    const { root, member } = workspace();
    fs.writeFileSync(path.join(root, "postcss.config.js"), "module.exports = {};");
    fs.writeFileSync(path.join(member, "postcss.config.js"), "module.exports = {};");
    expect(findPostcssConfigAbove(member, root)).toBeUndefined();
  });

  it("returns the ancestor directory that holds the config", () => {
    const { root, member } = workspace();
    fs.writeFileSync(path.join(root, "postcss.config.mjs"), "export default {};");
    expect(findPostcssConfigAbove(member, root)).toBe(root);
  });

  it("recognizes an rc-style config file", () => {
    const { root, member } = workspace();
    fs.writeFileSync(path.join(root, ".postcssrc.json"), "{}");
    expect(findPostcssConfigAbove(member, root)).toBe(root);
  });

  it("returns nothing when no level has a config", () => {
    const { root, member } = workspace();
    expect(findPostcssConfigAbove(member, root)).toBeUndefined();
  });

  it("never walks above the workspace root", () => {
    const { root, member } = workspace();
    fs.writeFileSync(path.join(tmpDir, "postcss.config.js"), "module.exports = {};");
    expect(findPostcssConfigAbove(member, root)).toBeUndefined();
  });

  it("is carried by the style tooling of a member that inherits it", () => {
    const { root, member } = workspace();
    fs.writeFileSync(path.join(root, "postcss.config.js"), "module.exports = {};");
    expect(resolveStyleTooling(member, root).postcssConfigDir).toBe(root);
  });

  it("is absent for a single-package project", () => {
    manifest(tmpDir, { react: "^19.0.0" });
    fs.writeFileSync(path.join(tmpDir, "postcss.config.js"), "module.exports = {};");
    expect(resolveStyleTooling(tmpDir).postcssConfigDir).toBeUndefined();
  });
});
