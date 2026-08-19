import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadBudgetConfig } from "../../src/budget.js";
import { projectConfigFingerprintFiles } from "../../src/analyze.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "120fps-workspace-config-")));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeWorkspace(): string {
  fs.writeFileSync(path.join(tmpDir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
  const member = path.join(tmpDir, "packages", "ui");
  fs.mkdirSync(member, { recursive: true });
  fs.writeFileSync(path.join(member, "package.json"), "{}");
  return member;
}

function writeConfig(root: string, mountTolerance: number): void {
  fs.writeFileSync(
    path.join(root, "120fps.config.json"),
    JSON.stringify({ tolerance: { mount: mountTolerance } }),
  );
}

describe("budget config lookup across workspace levels", () => {
  it("reads the workspace root's config for a member that has none", () => {
    const member = makeWorkspace();
    writeConfig(tmpDir, 25);
    expect(loadBudgetConfig(member)!.tolerance!.mount).toBe(25);
  });

  it("lets the member's own config win", () => {
    const member = makeWorkspace();
    writeConfig(tmpDir, 25);
    writeConfig(member, 5);
    expect(loadBudgetConfig(member)!.tolerance!.mount).toBe(5);
  });

  it("returns null when no level has one", () => {
    expect(loadBudgetConfig(makeWorkspace())).toBeNull();
  });

  it("still reads a single-package repo's own config", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    writeConfig(tmpDir, 40);
    expect(loadBudgetConfig(tmpDir)!.tolerance!.mount).toBe(40);
  });

  it("reports an invalid workspace-root config instead of ignoring it", () => {
    const member = makeWorkspace();
    fs.writeFileSync(path.join(tmpDir, "120fps.config.json"), "{ not json");
    expect(() => loadBudgetConfig(member)).toThrow(/120fps\.config\.json/);
  });
});

describe("dependency fingerprint sources across workspace levels", () => {
  it("takes the member's own lockfile", () => {
    const member = makeWorkspace();
    fs.writeFileSync(path.join(member, "pnpm-lock.yaml"), "lock");
    expect(projectConfigFingerprintFiles(member, tmpDir)).toEqual([
      path.join(member, "pnpm-lock.yaml"),
    ]);
  });

  it("falls back to the workspace root's lockfile", () => {
    const member = makeWorkspace();
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "lock");
    expect(projectConfigFingerprintFiles(member, tmpDir)).toEqual([
      path.join(tmpDir, "pnpm-lock.yaml"),
    ]);
  });

  it("counts each name once, member level first", () => {
    const member = makeWorkspace();
    fs.writeFileSync(path.join(member, "pnpm-lock.yaml"), "member");
    fs.writeFileSync(path.join(tmpDir, "pnpm-lock.yaml"), "root");
    expect(projectConfigFingerprintFiles(member, tmpDir)).toEqual([
      path.join(member, "pnpm-lock.yaml"),
    ]);
  });

  it("picks up tooling configs kept at the workspace root", () => {
    const member = makeWorkspace();
    fs.writeFileSync(path.join(tmpDir, "tailwind.config.ts"), "export default {}");
    fs.writeFileSync(path.join(tmpDir, "postcss.config.js"), "module.exports = {}");
    expect(projectConfigFingerprintFiles(member, tmpDir)).toEqual([
      path.join(tmpDir, "tailwind.config.ts"),
      path.join(tmpDir, "postcss.config.js"),
    ]);
  });

  it("is empty when neither level has anything", () => {
    expect(projectConfigFingerprintFiles(makeWorkspace(), tmpDir)).toEqual([]);
  });

  it("discovers the workspace root itself when none is given", () => {
    const member = makeWorkspace();
    fs.writeFileSync(path.join(tmpDir, "yarn.lock"), "lock");
    expect(projectConfigFingerprintFiles(member)).toEqual([path.join(tmpDir, "yarn.lock")]);
  });
});
