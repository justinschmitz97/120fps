import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nodeModulesLinkDirs, linkNodeModules } from "../../src/compare.js";

let tmpDir: string;
let repoRoot: string;
let worktree: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "120fps-compare-link-")));
  repoRoot = path.join(tmpDir, "repo");
  worktree = path.join(tmpDir, "worktree");
  fs.mkdirSync(repoRoot, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function installTree(root: string, relativeDir: string, pkg: string): void {
  const dir = path.join(root, relativeDir, "node_modules", pkg);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: pkg }));
}

const member = (): string => path.join(repoRoot, "packages", "ui");

describe("node_modules levels a reference worktree needs", () => {
  it("takes the repository root when only it has an install", () => {
    installTree(repoRoot, ".", "react");
    fs.mkdirSync(member(), { recursive: true });
    expect(nodeModulesLinkDirs(repoRoot, member())).toEqual([""]);
  });

  it("takes the member's own install as well", () => {
    installTree(repoRoot, ".", "react");
    installTree(repoRoot, "packages/ui", "vue");
    expect(nodeModulesLinkDirs(repoRoot, member())).toEqual(["", "packages/ui"]);
  });

  it("takes an intermediate level between the two", () => {
    installTree(repoRoot, "packages", "react");
    fs.mkdirSync(member(), { recursive: true });
    expect(nodeModulesLinkDirs(repoRoot, member())).toEqual(["packages"]);
  });

  it("takes the member level alone when the repository root has no install", () => {
    installTree(repoRoot, "packages/ui", "vue");
    expect(nodeModulesLinkDirs(repoRoot, member())).toEqual(["packages/ui"]);
  });

  it("is empty when nothing is installed anywhere", () => {
    fs.mkdirSync(member(), { recursive: true });
    expect(nodeModulesLinkDirs(repoRoot, member())).toEqual([]);
  });

  it("collapses to the root for a single-package repository", () => {
    installTree(repoRoot, ".", "react");
    expect(nodeModulesLinkDirs(repoRoot, repoRoot)).toEqual([""]);
  });

  it("ignores a member outside the repository", () => {
    installTree(repoRoot, ".", "react");
    expect(nodeModulesLinkDirs(repoRoot, path.join(tmpDir, "elsewhere"))).toEqual([""]);
  });
});

describe("linking node_modules into a reference worktree", () => {
  it("links every level the working tree has", () => {
    installTree(repoRoot, ".", "react");
    installTree(repoRoot, "packages/ui", "vue");
    fs.mkdirSync(path.join(worktree, "packages", "ui"), { recursive: true });

    linkNodeModules(repoRoot, worktree, member());

    expect(fs.existsSync(path.join(worktree, "node_modules", "react", "package.json"))).toBe(true);
    expect(
      fs.existsSync(path.join(worktree, "packages", "ui", "node_modules", "vue", "package.json")),
    ).toBe(true);
  });

  it("creates the parent directory a worktree level is missing", () => {
    installTree(repoRoot, "packages/ui", "vue");
    linkNodeModules(repoRoot, worktree, member());
    expect(
      fs.existsSync(path.join(worktree, "packages", "ui", "node_modules", "vue", "package.json")),
    ).toBe(true);
  });

  it("leaves an install the worktree already has alone", () => {
    installTree(repoRoot, ".", "react");
    installTree(worktree, ".", "preact");
    linkNodeModules(repoRoot, worktree, repoRoot);
    expect(fs.existsSync(path.join(worktree, "node_modules", "preact"))).toBe(true);
    expect(fs.existsSync(path.join(worktree, "node_modules", "react"))).toBe(false);
  });

  it("does nothing when the working tree has no install at all", () => {
    fs.mkdirSync(member(), { recursive: true });
    expect(() => linkNodeModules(repoRoot, worktree, member())).not.toThrow();
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });
});
