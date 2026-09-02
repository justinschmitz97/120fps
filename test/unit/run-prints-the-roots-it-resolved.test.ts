import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatResolvedRoots, resolveProjectModel } from "../../src/project-model.js";

const FIXTURE_ROOT = path.resolve(__dirname, "..", "..", "fixtures", "tailwind3-monorepo");
const FIXTURE_MEMBER = path.join(FIXTURE_ROOT, "packages", "ui");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-roots-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("the line naming the roots a run resolved", () => {
  it("names the member root and the workspace root of a workspace member", () => {
    const model = resolveProjectModel(path.join(FIXTURE_MEMBER, "src"));
    expect(model.memberRoot).toBe(FIXTURE_MEMBER);
    expect(model.workspaceRoot).toBe(FIXTURE_ROOT);
    const line = formatResolvedRoots(model.memberRoot, model.workspaceRoot);
    expect(line).toBe(`Roots: member ${FIXTURE_MEMBER}, workspace ${FIXTURE_ROOT}`);
    expect(path.isAbsolute(FIXTURE_MEMBER)).toBe(true);
  });

  it("names one root for a single-package project", () => {
    const root = path.join(tmpDir, "app");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app" }));
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
    const model = resolveProjectModel(root);
    expect(model.memberRoot).toBe(model.workspaceRoot);
    expect(formatResolvedRoots(model.memberRoot, model.workspaceRoot)).toBe(`Root: ${root}`);
  });

  it("is one line per component across a two-component sweep", () => {
    const block = [
      path.join(FIXTURE_MEMBER, "src", "Button.tsx"),
      path.join(FIXTURE_MEMBER, "src", "Other.tsx"),
    ]
      .map((component) => {
        const model = resolveProjectModel(path.dirname(component));
        return formatResolvedRoots(model.memberRoot, model.workspaceRoot);
      })
      .join("\n");
    expect(block.split("\n").filter((l) => l.startsWith("Roots:"))).toHaveLength(2);
  });
});
