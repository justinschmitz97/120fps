import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatGitignoreTip,
  gitignoreTipPatterns,
  harnessLeftoverDirs,
} from "../../src/cli/index.js";

// M117 A1, A2 (dx-audit, shadcn-admin/dialog-real2.log:67): the tip fired for
// a report written to a directory outside the repository, because the gate
// only ever looked at the file's basename. It now follows the resolved path,
// and names only the patterns the paths that fired it need.

const tmpDirs: string[] = [];

function makeGitRoot(gitignore?: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "120fps-tip-")));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, ".git"));
  if (gitignore !== undefined) fs.writeFileSync(path.join(dir, ".gitignore"), gitignore);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("the patterns a run's written paths ask a repository to ignore", () => {
  it("names nothing for a report written outside the repository", () => {
    const root = makeGitRoot();
    const outside = path.join(os.tmpdir(), "120fps-logs", "120fps-report.json");
    expect(gitignoreTipPatterns(root, [outside])).toEqual([]);
  });

  it("names the report pattern for an uncovered report inside the repository", () => {
    const root = makeGitRoot();
    expect(gitignoreTipPatterns(root, [path.join(root, "120fps-report.json")])).toEqual([
      "120fps-report*.json",
    ]);
  });

  it("names nothing for a report the repository already ignores", () => {
    const root = makeGitRoot("120fps-report*.json\n");
    expect(gitignoreTipPatterns(root, [path.join(root, "120fps-report.json")])).toEqual([]);
  });

  it("names the harness-directory pattern for a leftover harness directory", () => {
    const root = makeGitRoot();
    fs.mkdirSync(path.join(root, ".120fps-harness-abc"));
    expect(gitignoreTipPatterns(root, harnessLeftoverDirs(root))).toEqual([".120fps-harness-*"]);
  });

  it("names the baseline pattern for a baseline written inside a package of the repository", () => {
    const root = makeGitRoot();
    const packageRoot = path.join(root, "packages", "ui");
    fs.mkdirSync(packageRoot, { recursive: true });
    expect(gitignoreTipPatterns(root, [path.join(packageRoot, "120fps-baseline.json")])).toEqual([
      "120fps-baseline.json",
    ]);
  });

  it("names each pattern once, whatever the paths that triggered it", () => {
    const root = makeGitRoot();
    expect(
      gitignoreTipPatterns(root, [
        path.join(root, "120fps-report.Card.json"),
        path.join(root, "120fps-report.Dialog.json"),
        path.join(root, "120fps-baseline.json"),
      ]),
    ).toEqual(["120fps-report*.json", "120fps-baseline.json"]);
  });

  it("names nothing for a path that is neither a report, a baseline nor a harness directory", () => {
    const root = makeGitRoot();
    expect(gitignoreTipPatterns(root, [path.join(root, "src", "widget.tsx")])).toEqual([]);
  });
});

describe("leftover harness directories at a root", () => {
  it("lists only the harness directories present", () => {
    const root = makeGitRoot();
    fs.mkdirSync(path.join(root, ".120fps-harness-xyz"));
    fs.mkdirSync(path.join(root, "src"));
    expect(harnessLeftoverDirs(root)).toEqual([path.join(root, ".120fps-harness-xyz")]);
  });

  it("lists nothing for a directory that does not exist", () => {
    expect(harnessLeftoverDirs(path.join(os.tmpdir(), "120fps-absent-root"))).toEqual([]);
  });
});

describe("the tip itself", () => {
  it("names only the patterns it was given", () => {
    const tip = formatGitignoreTip(["120fps-report*.json"]);
    expect(tip).toContain("120fps-report*.json");
    expect(tip).not.toContain("120fps-baseline.json");
    expect(tip).not.toContain(".120fps-harness-*");
  });

  it("is empty when nothing triggered it", () => {
    expect(formatGitignoreTip([])).toBe("");
  });
});
