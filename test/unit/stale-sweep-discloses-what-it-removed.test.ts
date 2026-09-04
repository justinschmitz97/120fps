import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  HARNESS_PID_FILE,
  LIVE_PID_HARNESS_MAX_AGE_MS,
  STALE_HARNESS_MAX_AGE_MS,
  sweepStaleHarnessDirs,
} from "../../src/harness/index.js";

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function mkRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-swept-"));
  roots.push(dir);
  return dir;
}

function mkHarnessDir(root: string, name: string, pid?: number): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (pid !== undefined) fs.writeFileSync(path.join(dir, HARNESS_PID_FILE), String(pid));
  return dir;
}

function age(target: string, ms: number): void {
  const then = new Date(Date.now() - ms);
  fs.utimesSync(target, then, then);
}

// A pid the OS will not have handed out again.
const DEAD_PID = 4_194_303;

// base-ui-R1-verify-sweep: the next run removed the leftover and exited 0
// without a word, so the user had no evidence the previous run had left
// anything behind at all.
describe("what the next run's sweep removed", () => {
  it("names each removed directory and why it was stale", () => {
    const root = mkRoot();
    const dead = mkHarnessDir(root, ".120fps-harness-dead", DEAD_PID);
    const unmarked = mkHarnessDir(root, ".120fps-harness-unmarked");
    age(unmarked, STALE_HARNESS_MAX_AGE_MS + 60_000);
    // pid 4 is alive on every Windows and POSIX host and is not this process.
    const stuck = mkHarnessDir(root, ".120fps-harness-stuck", 4);
    age(path.join(stuck, HARNESS_PID_FILE), LIVE_PID_HARNESS_MAX_AGE_MS + 60_000);

    const warnings: string[] = [];
    sweepStaleHarnessDirs(root, warnings);

    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(unmarked)).toBe(false);
    expect(fs.existsSync(stuck)).toBe(false);
    expect(warnings).toHaveLength(3);
    expect(warnings.find((line) => line.includes(".120fps-harness-dead"))).toContain(
      "its owner process is gone",
    );
    expect(warnings.find((line) => line.includes(".120fps-harness-unmarked"))).toContain(
      "unmarked and older than the age gate",
    );
    expect(warnings.find((line) => line.includes(".120fps-harness-stuck"))).toContain(
      "its owner stopped heartbeating",
    );
  });

  it("names the directory the way the user sees it, below the member root", () => {
    const repoRoot = mkRoot();
    const memberRoot = path.join(repoRoot, "packages", "react");
    fs.mkdirSync(memberRoot, { recursive: true });
    mkHarnessDir(memberRoot, ".120fps-harness-nested", DEAD_PID);

    const warnings: string[] = [];
    sweepStaleHarnessDirs(memberRoot, warnings);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(".120fps-harness-nested");
    expect(warnings[0]).not.toContain("\\");
  });

  it("says nothing about a directory a live run is still writing into", () => {
    const root = mkRoot();
    const own = mkHarnessDir(root, ".120fps-harness-own", process.pid);
    const warnings: string[] = [];
    sweepStaleHarnessDirs(root, warnings);
    expect(fs.existsSync(own)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("says nothing when there was nothing to remove", () => {
    const root = mkRoot();
    const warnings: string[] = [];
    sweepStaleHarnessDirs(root, warnings);
    expect(warnings).toEqual([]);
  });
});
