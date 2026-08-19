import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { findCompilerConfig } from "../../src/project-model.js";
import { loadTsconfigAliases } from "../../src/harness.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkTree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-cfgdisc-"));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const fwd = (p: string) => p.replace(/\\/g, "/");

// A workspace root that governs the install, plus a member declaring nothing.
function mkWorkspace(extra: Record<string, string> = {}): string {
  return mkTree({
    "repo/package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    "repo/pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "repo/packages/ui/package.json": JSON.stringify({ name: "ui" }),
    "repo/packages/ui/src/Button.tsx": "export function Button() { return null; }\n",
    ...extra,
  });
}

describe("compiler config discovery", () => {
  it("finds a config in the start directory", () => {
    const dir = mkTree({ "tsconfig.json": "{}" });
    expect(findCompilerConfig(dir)).toBe(`${fwd(dir)}/tsconfig.json`);
  });

  it("prefers tsconfig.json over jsconfig.json at the same level", () => {
    const dir = mkTree({ "tsconfig.json": "{}", "jsconfig.json": "{}" });
    expect(findCompilerConfig(dir)).toBe(`${fwd(dir)}/tsconfig.json`);
  });

  it("falls back to jsconfig.json when the level has no tsconfig.json", () => {
    const dir = mkTree({ "jsconfig.json": "{}" });
    expect(findCompilerConfig(dir)).toBe(`${fwd(dir)}/jsconfig.json`);
  });

  it("prefers a nearer jsconfig.json over a tsconfig.json further up", () => {
    const dir = mkTree({ "tsconfig.json": "{}", "app/jsconfig.json": "{}" });
    expect(findCompilerConfig(path.join(dir, "app"), dir)).toBe(`${fwd(dir)}/app/jsconfig.json`);
  });

  it("walks upward to the stop directory", () => {
    const dir = mkTree({ "tsconfig.json": "{}", "packages/ui/src/.keep": "" });
    const start = path.join(dir, "packages", "ui", "src");
    expect(findCompilerConfig(start, dir)).toBe(`${fwd(dir)}/tsconfig.json`);
  });

  it("stops after the stop directory", () => {
    const dir = mkTree({ "tsconfig.json": "{}", "repo/packages/ui/.keep": "" });
    const start = path.join(dir, "repo", "packages", "ui");
    expect(findCompilerConfig(start, path.join(dir, "repo"))).toBeUndefined();
  });

  it("returns undefined when no level has a config", () => {
    const dir = mkTree({ "src/x.ts": "export const x = 1;" });
    expect(findCompilerConfig(path.join(dir, "src"), dir)).toBeUndefined();
  });
});

describe("aliases inherited from an ancestor config", () => {
  it("a workspace member with no config of its own uses the workspace root config", () => {
    const dir = mkWorkspace({
      "repo/tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@ui/*": ["./packages/ui/src/*"] } },
      }),
    });
    const member = path.join(dir, "repo", "packages", "ui");

    const aliases = loadTsconfigAliases(member);

    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@ui/Button")).toBe(true);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/repo/packages/ui/src/`);
  });

  it("the member's own config wins over the workspace root config", () => {
    const dir = mkWorkspace({
      "repo/tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@root/*": ["./shared/*"] } },
      }),
      "repo/packages/ui/tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@own/*": ["./src/*"] } },
      }),
    });
    const member = path.join(dir, "repo", "packages", "ui");

    const aliases = loadTsconfigAliases(member);

    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@own/Button")).toBe(true);
    expect(aliases[0].find.test("@root/Button")).toBe(false);
  });

  it("does not walk past the workspace root", () => {
    const dir = mkWorkspace({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@outside/*": ["./elsewhere/*"] } },
      }),
    });
    const member = path.join(dir, "repo", "packages", "ui");

    expect(loadTsconfigAliases(member)).toEqual([]);
  });

  it("reads a jsconfig.json when the project has no tsconfig.json", () => {
    const dir = mkTree({
      "package.json": JSON.stringify({ name: "js-app" }),
      "jsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
      }),
      "src/x.js": "export const x = 1;",
    });

    const aliases = loadTsconfigAliases(dir);

    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@/thing")).toBe(true);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/`);
  });

  it("resolves an extends chain declared in the inherited config", () => {
    const dir = mkWorkspace({
      "repo/tsconfig.json": JSON.stringify({ extends: "./config/base.json" }),
      "repo/config/base.json": JSON.stringify({
        compilerOptions: { paths: { "@ui/*": ["../packages/ui/src/*"] } },
      }),
    });
    const member = path.join(dir, "repo", "packages", "ui");

    const aliases = loadTsconfigAliases(member);

    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/repo/packages/ui/src/`);
  });
});
