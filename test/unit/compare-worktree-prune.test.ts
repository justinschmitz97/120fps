import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pruneStaleWorktrees } from "../../src/compare.js";

// M70: a hard-killed --compare leaves <repo>/.git/worktrees/<name> registered
// with no working directory behind it; nothing today sweeps that. These use a
// real temp git repository, matching how reference-worktree-linking.test.ts
// exercises linkNodeModules.

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

let tmpDir: string;
let repoRoot: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "120fps-compare-prune-")));
  repoRoot = path.join(tmpDir, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  git(["init", "-q"], repoRoot);
  git(["config", "user.email", "test@example.com"], repoRoot);
  git(["config", "user.name", "Test"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "a.txt"), "a");
  git(["add", "a.txt"], repoRoot);
  git(["commit", "-q", "-m", "init"], repoRoot);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("pruneStaleWorktrees", () => {
  it("clears a worktree registration whose directory was removed out from under git", () => {
    const worktreeDir = path.join(tmpDir, "orphan");
    git(["worktree", "add", "--detach", worktreeDir, "HEAD"], repoRoot);
    // Simulates a SIGKILL/OOM that never reached the compare flow's own
    // `git worktree remove` cleanup: the directory is gone, the metadata isn't.
    fs.rmSync(worktreeDir, { recursive: true, force: true });
    expect(git(["worktree", "list"], repoRoot)).toContain("orphan");

    pruneStaleWorktrees(repoRoot);

    expect(git(["worktree", "list"], repoRoot)).not.toContain("orphan");
  });

  it("leaves a live worktree's registration alone", () => {
    const worktreeDir = path.join(tmpDir, "live");
    git(["worktree", "add", "--detach", worktreeDir, "HEAD"], repoRoot);

    pruneStaleWorktrees(repoRoot);

    expect(git(["worktree", "list"], repoRoot)).toContain("live");
  });

  it("does not throw when repoRoot is not a git repository", () => {
    const notARepo = path.join(tmpDir, "not-a-repo");
    fs.mkdirSync(notARepo, { recursive: true });
    expect(() => pruneStaleWorktrees(notARepo)).not.toThrow();
  });

  it("does not throw when repoRoot does not exist at all", () => {
    expect(() => pruneStaleWorktrees(path.join(tmpDir, "missing"))).not.toThrow();
  });
});
