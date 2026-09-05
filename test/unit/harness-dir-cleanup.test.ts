import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHarnessDir, sweepStaleHarnessDirs, sweepActiveHarnessDirs } from "../../src/harness/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// M88 (heroui-F4): the harness builds inside the workspace member's directory, not the repo root.
describe("harness directory cleanup targets the workspace member root, not only a repo root", () => {
  it("creates and stale-sweeps a harness dir inside a nested workspace member directory", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-repo-"));
    cleanupDirs.push(repoRoot);
    const memberRoot = path.join(repoRoot, "packages", "react");
    fs.mkdirSync(memberRoot, { recursive: true });

    const dir = createHarnessDir(memberRoot);
    expect(path.dirname(dir)).toBe(memberRoot);
    expect(fs.existsSync(dir)).toBe(true);

    // Fake pid: M101 exempts the current process's own dir; a live pid would skip this one.
    fs.writeFileSync(path.join(dir, ".pid"), "4194303");
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(dir, past, past);
    sweepStaleHarnessDirs(memberRoot);
    expect(fs.existsSync(dir)).toBe(false);

    // Repo root itself has nothing to sweep: the call is scoped to memberRoot, not walked upward.
    expect(
      fs.readdirSync(repoRoot).filter((n) => n.startsWith(".120fps-harness-")),
    ).toEqual([]);
  });

  it("tracks a harness dir created under a nested workspace member through the exit sweep", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-repo-"));
    cleanupDirs.push(repoRoot);
    const memberRoot = path.join(repoRoot, "packages", "react");
    fs.mkdirSync(memberRoot, { recursive: true });

    const dir = createHarnessDir(memberRoot);
    expect(fs.existsSync(dir)).toBe(true);
    sweepActiveHarnessDirs();
    expect(fs.existsSync(dir)).toBe(false);
  });
});
