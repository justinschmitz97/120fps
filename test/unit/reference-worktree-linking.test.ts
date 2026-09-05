import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { nodeModulesLinkDirs, linkNodeModules, unlinkNodeModules } from "../../src/analysis/index.js";

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

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

// A naive recursive delete walks through the junction into real node_modules; unlink first.
describe("detaching node_modules links from a worktree", () => {
  it("detaches the link at every level the working tree linked", () => {
    installTree(repoRoot, ".", "react");
    installTree(repoRoot, "packages/ui", "vue");
    fs.mkdirSync(path.join(worktree, "packages", "ui"), { recursive: true });
    linkNodeModules(repoRoot, worktree, member());

    unlinkNodeModules(worktree, repoRoot, member());

    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(worktree, "packages", "ui", "node_modules"))).toBe(false);
  });

  // fs.rmSync treats a reparse point as a leaf; only `git worktree remove --force` exercises this.
  it("keeps the linked target's contents intact after `git worktree remove --force`", () => {
    git(["init", "-q"], repoRoot);
    git(["config", "user.email", "test@example.com"], repoRoot);
    git(["config", "user.name", "Test"], repoRoot);
    fs.writeFileSync(path.join(repoRoot, "a.txt"), "a");
    git(["add", "a.txt"], repoRoot);
    git(["commit", "-q", "-m", "init"], repoRoot);
    // `worktree` already exists via beforeEach; git worktree add accepts an existing empty dir.
    git(["worktree", "add", "--detach", worktree, "HEAD"], repoRoot);

    installTree(repoRoot, ".", "react");
    linkNodeModules(repoRoot, worktree, repoRoot);
    const marker = path.join(repoRoot, "node_modules", "react", "package.json");
    expect(fs.existsSync(marker)).toBe(true);

    unlinkNodeModules(worktree, repoRoot, repoRoot);
    git(["worktree", "remove", "--force", worktree], repoRoot);

    expect(fs.existsSync(marker)).toBe(true);
  });

  it("leaves a real, non-linked node_modules at the target path alone", () => {
    installTree(repoRoot, ".", "react");
    installTree(worktree, ".", "preact");

    unlinkNodeModules(worktree, repoRoot, repoRoot);

    expect(fs.existsSync(path.join(worktree, "node_modules", "preact", "package.json"))).toBe(true);
  });

  it("tolerates a level the working tree never linked", () => {
    installTree(repoRoot, ".", "react");
    installTree(repoRoot, "packages/ui", "vue");
    // Only the root got linked; packages/ui/node_modules was never created.
    linkNodeModules(repoRoot, worktree, repoRoot);

    expect(() => unlinkNodeModules(worktree, repoRoot, member())).not.toThrow();
    expect(fs.existsSync(path.join(worktree, "node_modules"))).toBe(false);
  });

  it("tolerates a worktree path that does not exist at all", () => {
    installTree(repoRoot, ".", "react");
    expect(() =>
      unlinkNodeModules(path.join(tmpDir, "missing-worktree"), repoRoot, repoRoot),
    ).not.toThrow();
  });
});
