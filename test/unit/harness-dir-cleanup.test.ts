import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHarnessDir, sweepStaleHarnessDirs, sweepActiveHarnessDirs } from "../../src/harness.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// M88 (heroui-F4): the harness builds inside the component's own package
// directory in a workspace (projectRoot), which for a monorepo member is
// nested well below the repository root -- e.g. packages/react, not the repo
// root. A check that only looks at the repo root cannot see a leak there.
// createHarnessDir/sweepStaleHarnessDirs/sweepActiveHarnessDirs are already
// called with that member directory as projectRoot (src/harness.ts,
// buildAndServe), never the repository root; this pins that down.
describe("harness directory cleanup targets the workspace member root, not only a repo root", () => {
  it("creates and stale-sweeps a harness dir inside a nested workspace member directory", () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-repo-"));
    cleanupDirs.push(repoRoot);
    const memberRoot = path.join(repoRoot, "packages", "react");
    fs.mkdirSync(memberRoot, { recursive: true });

    const dir = createHarnessDir(memberRoot);
    expect(path.dirname(dir)).toBe(memberRoot);
    expect(fs.existsSync(dir)).toBe(true);

    // Age it past the stale cutoff and sweep only the member root: a repo-root
    // check would never see this directory at all. M101 (review A6) exempts a
    // directory the *current* process owns, so the marker names a dead pid —
    // this test is about where the sweep looks, not about whose dir it is.
    fs.writeFileSync(path.join(dir, ".pid"), "4194303");
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(dir, past, past);
    sweepStaleHarnessDirs(memberRoot);
    expect(fs.existsSync(dir)).toBe(false);

    // Nothing was swept at the repo root itself: sweeping is scoped to the
    // directory it's called with, not walked upward.
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
