import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING,
  findLikelyGenerateCommand,
  packageManagerRunCommand,
  packageScriptCommand,
} from "../../src/harness.js";

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function mkRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-remedy-dir-"));
  roots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const UI_MANIFEST = JSON.stringify({ name: "@acme/ui", scripts: { build: "tsup src/index.ts" } });

function pnpmWorkspace(): { root: string; member: string } {
  const root = mkRepo({
    "package.json": JSON.stringify({ name: "repo", private: true }),
    "pnpm-lock.yaml": "",
    "packages/ui/package.json": UI_MANIFEST,
  });
  return { root, member: path.join(root, "packages", "ui") };
}

describe("a remedy that asks the user to run a package script", () => {
  it("names the directory to run in when it is not the directory the run started in", () => {
    const { root, member } = pnpmWorkspace();
    const command = packageScriptCommand(member, "build", root);
    expect(command).toBe("cd packages/ui && pnpm run build");
    expect(UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING("@acme/ui", command)).toContain(
      "Run `cd packages/ui && pnpm run build` in that package first.",
    );
  });

  it("names no directory when the run started in that package", () => {
    const { member } = pnpmWorkspace();
    const command = packageScriptCommand(member, "build", member);
    expect(command).toBe("pnpm run build");
    expect(UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING("@acme/ui", command)).toContain(
      "Run `pnpm run build` in that package first.",
    );
  });

  it("prints no command when the package declares no such script", () => {
    const { root, member } = pnpmWorkspace();
    fs.writeFileSync(path.join(member, "package.json"), JSON.stringify({ name: "@acme/ui" }));
    expect(packageScriptCommand(member, "build", root)).toBeUndefined();
    expect(UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING("@acme/ui", undefined)).not.toContain("Run `");
  });

  it("uses the workspace's own package manager", () => {
    const root = mkRepo({
      "package.json": JSON.stringify({ name: "repo", private: true, workspaces: ["packages/*"] }),
      "yarn.lock": "",
      "packages/ui/package.json": UI_MANIFEST,
    });
    expect(packageScriptCommand(path.join(root, "packages", "ui"), "build", root)).toBe(
      "cd packages/ui && yarn build",
    );
  });

  it("never prints a raw script body", () => {
    const { root, member } = pnpmWorkspace();
    expect(packageScriptCommand(member, "build", root)).not.toContain("tsup");
  });

  it("names an absolute directory when no relative path exists", () => {
    if (process.platform !== "win32") return;
    const { member } = pnpmWorkspace();
    const otherDrive = member.startsWith("Z:") ? "Y:\\elsewhere" : "Z:\\elsewhere";
    expect(packageManagerRunCommand(member, "build", otherDrive)).toBe(
      `cd ${member} && pnpm run build`,
    );
  });
});

describe("a remedy naming a directory whose name contains a space", () => {
  it("quotes the directory so the command stays pasteable", () => {
    const root = mkRepo({
      "package.json": JSON.stringify({ name: "repo", private: true }),
      "pnpm-lock.yaml": "",
      "packages/my ui/package.json": UI_MANIFEST,
    });
    expect(packageScriptCommand(path.join(root, "packages", "my ui"), "build", root)).toBe(
      'cd "packages/my ui" && pnpm run build',
    );
  });
});

describe("the generate remedies", () => {
  function generatorWorkspace(): { root: string; member: string } {
    const root = mkRepo({
      "package.json": JSON.stringify({ name: "repo", private: true }),
      "pnpm-lock.yaml": "",
      "packages/ui/package.json": JSON.stringify({
        name: "@acme/ui",
        scripts: { generate: "nuxi generate", "build:types": "gen -o src/generated/types.ts" },
      }),
    });
    return { root, member: path.join(root, "packages", "ui") };
  }

  it("names the directory when no missing file points at a script", () => {
    const { root, member } = generatorWorkspace();
    expect(findLikelyGenerateCommand(member, undefined, root)).toBe(
      "cd packages/ui && pnpm run generate",
    );
  });

  it("names the directory when the missing generated file points at a script", () => {
    const { root, member } = generatorWorkspace();
    expect(findLikelyGenerateCommand(member, "src/generated/types.ts", root)).toBe(
      "cd packages/ui && pnpm run build:types",
    );
  });
});
