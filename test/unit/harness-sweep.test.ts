import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { sweepStaleHarnessDirs } from "../../src/harness.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-sweep-"));
  cleanupDirs.push(dir);
  return dir;
}

function ageEntry(fullPath: string, hoursAgo: number): void {
  const then = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
  fs.utimesSync(fullPath, then, then);
}

describe("sweepStaleHarnessDirs (M24 D8)", () => {
  it("removes .120fps-harness-* dirs older than 1 hour", () => {
    const root = mkRoot();
    const old = path.join(root, ".120fps-harness-abc123");
    fs.mkdirSync(old);
    ageEntry(old, 2);

    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(old)).toBe(false);
  });

  it("keeps fresh .120fps-harness-* dirs", () => {
    const root = mkRoot();
    const fresh = path.join(root, ".120fps-harness-fresh");
    fs.mkdirSync(fresh);

    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("removes old dirs recursively even when non-empty", () => {
    const root = mkRoot();
    const old = path.join(root, ".120fps-harness-full");
    fs.mkdirSync(path.join(old, "nested"), { recursive: true });
    fs.writeFileSync(path.join(old, "nested", "entry.tsx"), "// leftover");
    ageEntry(old, 3);

    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(old)).toBe(false);
  });

  it("does not touch old directories with other names", () => {
    const root = mkRoot();
    const other = path.join(root, ".other-dir");
    fs.mkdirSync(other);
    ageEntry(other, 5);

    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("does not remove files that merely share the prefix", () => {
    const root = mkRoot();
    const file = path.join(root, ".120fps-harness-file");
    fs.writeFileSync(file, "not a dir");
    ageEntry(file, 4);

    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("is a no-op on a root without harness dirs", () => {
    const root = mkRoot();
    expect(() => sweepStaleHarnessDirs(root)).not.toThrow();
  });

  it("swallows errors for a nonexistent root", () => {
    expect(() =>
      sweepStaleHarnessDirs(path.join(os.tmpdir(), "120fps-does-not-exist-xyz")),
    ).not.toThrow();
  });

  it("mixed population: only stale harness dirs go", () => {
    const root = mkRoot();
    const oldA = path.join(root, ".120fps-harness-a");
    const oldB = path.join(root, ".120fps-harness-b");
    const fresh = path.join(root, ".120fps-harness-c");
    const unrelated = path.join(root, "src");
    fs.mkdirSync(oldA);
    fs.mkdirSync(oldB);
    fs.mkdirSync(fresh);
    fs.mkdirSync(unrelated);
    ageEntry(oldA, 2);
    ageEntry(oldB, 48);
    ageEntry(unrelated, 48);

    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(oldA)).toBe(false);
    expect(fs.existsSync(oldB)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });
});
