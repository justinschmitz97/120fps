import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findGitRoot,
  gitignoreCoversFile,
  needsGitignoreAdvisory,
  GITIGNORE_ADVISORY_HINT,
  GITIGNORE_SUGGESTED_PATTERNS,
} from "../../src/cli.js";

// M74 (E5): the tool writes 120fps-report*.json and 120fps-baseline.json into
// the user's repo with no gitignore awareness. This is a hint, never a file
// edit: nothing here ever writes to .gitignore.

describe("findGitRoot", () => {
  const tmpDirs: string[] = [];

  function makeDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-gitroot-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns the directory itself when it contains .git", () => {
    const dir = makeDir();
    fs.mkdirSync(path.join(dir, ".git"));
    expect(findGitRoot(dir)).toBe(dir);
  });

  it("returns the nearest ancestor containing .git", () => {
    const root = makeDir();
    fs.mkdirSync(path.join(root, ".git"));
    const nested = path.join(root, "packages", "app");
    fs.mkdirSync(nested, { recursive: true });
    expect(findGitRoot(nested)).toBe(root);
  });

  it("returns undefined when no ancestor has .git", () => {
    // A bare temp dir under the OS temp root has no .git ancestor short of
    // walking all the way to the filesystem root, which also lacks one.
    const dir = makeDir();
    expect(findGitRoot(dir)).toBeUndefined();
  });

  it("stops at the first .git found walking upward, not a farther one", () => {
    const root = makeDir();
    fs.mkdirSync(path.join(root, ".git"));
    const inner = path.join(root, "inner");
    fs.mkdirSync(path.join(inner, ".git"), { recursive: true });
    expect(findGitRoot(inner)).toBe(inner);
  });
});

describe("gitignoreCoversFile", () => {
  it("recognizes an exact literal line", () => {
    expect(gitignoreCoversFile("120fps-baseline.json\n", "120fps-baseline.json")).toBe(true);
  });

  it("recognizes a single-trailing-wildcard prefix pattern", () => {
    expect(gitignoreCoversFile("120fps-report*.json\n", "120fps-report.Card.json")).toBe(true);
  });

  it("ignores comments", () => {
    expect(gitignoreCoversFile("# 120fps-baseline.json\n", "120fps-baseline.json")).toBe(false);
  });

  it("ignores blank lines", () => {
    expect(gitignoreCoversFile("\n\n   \n", "120fps-baseline.json")).toBe(false);
  });

  it("recognizes a leading-wildcard pattern", () => {
    expect(gitignoreCoversFile("*.json\n", "120fps-baseline.json")).toBe(true);
  });

  it("recognizes a mid-string-wildcard pattern (its own suggested report pattern)", () => {
    expect(gitignoreCoversFile("120fps-report*.json\n", "120fps-report.json")).toBe(true);
  });

  it("does not recognize a pattern with two or more wildcards (documented approximation)", () => {
    expect(gitignoreCoversFile("120fps-*-*.json\n", "120fps-report-x.json")).toBe(false);
  });

  it("strips a leading slash before comparing", () => {
    expect(gitignoreCoversFile("/120fps-baseline.json\n", "120fps-baseline.json")).toBe(true);
  });

  it("returns false for an empty gitignore", () => {
    expect(gitignoreCoversFile("", "120fps-baseline.json")).toBe(false);
  });

  it("returns false when nothing matches", () => {
    expect(gitignoreCoversFile("node_modules\ndist\n", "120fps-baseline.json")).toBe(false);
  });
});

describe("needsGitignoreAdvisory", () => {
  const tmpDirs: string[] = [];

  function makeGitRoot(gitignore?: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-gitignore-"));
    tmpDirs.push(dir);
    if (gitignore !== undefined) {
      fs.writeFileSync(path.join(dir, ".gitignore"), gitignore);
    }
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns true when there is no .gitignore file at all", () => {
    const root = makeGitRoot();
    expect(needsGitignoreAdvisory(root, ["120fps-report.json"])).toBe(true);
  });

  it("returns false when every written filename is covered", () => {
    const root = makeGitRoot("120fps-report*.json\n120fps-baseline.json\n");
    expect(
      needsGitignoreAdvisory(root, ["120fps-report.json", "120fps-baseline.json"]),
    ).toBe(false);
  });

  it("returns true when at least one written filename is uncovered", () => {
    const root = makeGitRoot("120fps-report*.json\n");
    expect(
      needsGitignoreAdvisory(root, ["120fps-report.json", "120fps-baseline.json"]),
    ).toBe(true);
  });

  it("returns false for an empty written-filenames list", () => {
    const root = makeGitRoot();
    expect(needsGitignoreAdvisory(root, [])).toBe(false);
  });
});

describe("GITIGNORE_ADVISORY_HINT", () => {
  it("names every suggested pattern", () => {
    for (const pattern of GITIGNORE_SUGGESTED_PATTERNS) {
      expect(GITIGNORE_ADVISORY_HINT).toContain(pattern);
    }
  });

  it("names the report, baseline, and harness-dir patterns", () => {
    expect(GITIGNORE_ADVISORY_HINT).toContain("120fps-report*.json");
    expect(GITIGNORE_ADVISORY_HINT).toContain("120fps-baseline.json");
    expect(GITIGNORE_ADVISORY_HINT).toContain(".120fps-harness-*");
  });
});
