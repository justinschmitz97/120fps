import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { isPackageAvailable, isPackageDeclared } from "../../src/project-model.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "120fps-availability-")));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTree(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

// A real, resolvable package: package.json plus the entry point node looks for
// when no "main" is declared.
function installInto(dir: string, name: string): void {
  const target = path.join(dir, ...name.split("/"));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  fs.writeFileSync(path.join(target, "index.js"), "module.exports = {};\n");
}

// The inverse of test/node-resolution.ts's withProductionResolution: it makes
// the runner's own resolution hazard explicit instead of hiding it, so a probe
// that reads NODE_PATH is caught here rather than in CI.
function withNodePath<T>(dir: string, fn: () => T): T {
  const initPaths = (Module as unknown as { _initPaths(): void })._initPaths;
  const saved = process.env.NODE_PATH;
  process.env.NODE_PATH = dir;
  initPaths();
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.NODE_PATH;
    else process.env.NODE_PATH = saved;
    initPaths();
  }
}

const member = (): string => path.join(tmpDir, "repo", "packages", "ui");
const repo = (): string => path.join(tmpDir, "repo");

describe("availability along the node resolution chain", () => {
  it("accepts a package installed above the workspace root", () => {
    makeTree({ "repo/package.json": "{}", "repo/packages/ui/package.json": "{}" });
    installInto(path.join(tmpDir, "node_modules"), "next");
    expect(isPackageAvailable("next", member(), repo())).toBe(true);
  });

  it("accepts a scoped package installed above the workspace root", () => {
    makeTree({ "repo/package.json": "{}", "repo/packages/ui/package.json": "{}" });
    installInto(path.join(tmpDir, "node_modules"), "@tailwindcss/vite");
    expect(isPackageAvailable("@tailwindcss/vite", member(), repo())).toBe(true);
  });

  it("refuses a package installed nowhere on the chain", () => {
    makeTree({ "repo/package.json": "{}", "repo/packages/ui/package.json": "{}" });
    expect(isPackageAvailable("next", member(), repo())).toBe(false);
  });

  it("refuses a package a sibling directory installs", () => {
    makeTree({ "repo/package.json": "{}", "repo/packages/ui/package.json": "{}" });
    installInto(path.join(tmpDir, "repo", "apps", "docs", "node_modules"), "unocss");
    expect(isPackageAvailable("unocss", member(), repo())).toBe(false);
  });

  it("ignores a package only NODE_PATH makes resolvable", () => {
    makeTree({ "repo/package.json": "{}", "repo/packages/ui/package.json": "{}" });
    const store = path.join(tmpDir, "store");
    installInto(store, "ghost-tool");
    withNodePath(store, () => {
      // The hazard is real in this process: node resolves the package from a
      // directory that has no node_modules anywhere on its chain.
      expect(createRequire(path.join(member(), "/")).resolve("ghost-tool")).toContain("ghost-tool");
      expect(isPackageAvailable("ghost-tool", member(), repo())).toBe(false);
    });
  });
});

describe("declaration stays a manifest-only question", () => {
  it("does not count an installed package as declared", () => {
    makeTree({ "repo/package.json": "{}", "repo/packages/ui/package.json": "{}" });
    installInto(path.join(tmpDir, "node_modules"), "babel-plugin-react-compiler");
    expect(isPackageAvailable("babel-plugin-react-compiler", member(), repo())).toBe(true);
    expect(isPackageDeclared("babel-plugin-react-compiler", member(), repo())).toBe(false);
  });

  it("counts a declared package that is not installed at all", () => {
    makeTree({
      "repo/package.json": JSON.stringify({ devDependencies: { "solid-js": "^1.9.0" } }),
      "repo/packages/ui/package.json": "{}",
    });
    expect(isPackageDeclared("solid-js", member(), repo())).toBe(true);
    expect(isPackageAvailable("solid-js", member(), repo())).toBe(true);
  });
});
