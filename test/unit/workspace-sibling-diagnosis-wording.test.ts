import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scanExternalDeps,
  diagnoseUnbuiltWorkspacePackage,
  TYPES_ONLY_WORKSPACE_PACKAGE_WARNING,
  UNBUILT_WORKSPACE_PACKAGE_WARNING,
} from "../../src/harness.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkWorkspace(): {
  workspaceRoot: string;
  member: string;
  write: (rel: string, content: string) => void;
} {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-sibling-wording-"));
  cleanupDirs.push(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const member = path.join(workspaceRoot, "packages", "app");
  fs.mkdirSync(member, { recursive: true });
  const write = (rel: string, content: string) => {
    const full = path.join(workspaceRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  return { workspaceRoot, member, write };
}

function linkSibling(
  workspaceRoot: string,
  member: string,
  scopedName: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): string {
  const [scope, name] = scopedName.split("/");
  const real = path.join(workspaceRoot, "packages", name);
  fs.mkdirSync(real, { recursive: true });
  fs.writeFileSync(
    path.join(real, "package.json"),
    JSON.stringify({ name: scopedName, ...manifest }),
  );
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(real, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const linkParent = path.join(member, "node_modules", scope);
  fs.mkdirSync(linkParent, { recursive: true });
  fs.symlinkSync(real, path.join(linkParent, name), process.platform === "win32" ? "junction" : "dir");
  return real;
}

describe("a workspace sibling that ships declarations only is not called unbuilt", () => {
  it("names the types path and claims no dist or browser-load risk", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    linkSibling(
      workspaceRoot,
      member,
      "@w/types-only",
      { types: "src/index.d.ts" },
      { "src/index.d.ts": "export type Value = string;\n" },
    );
    write(
      "packages/app/src/button.tsx",
      'import { Value } from "@w/types-only";\nexport default 1;\n',
    );

    const extraAliases: Array<{ find: RegExp; replacement: string }> = [];
    const warnings: string[] = [];
    const deps = scanExternalDeps(
      path.join(workspaceRoot, "packages/app/src/button.tsx"),
      member,
      [],
      undefined,
      warnings,
      workspaceRoot,
      extraAliases,
    );

    expect(warnings).toContain(
      TYPES_ONLY_WORKSPACE_PACKAGE_WARNING("@w/types-only", "src/index.d.ts"),
    );
    const warning = warnings.find((w) => w.includes("@w/types-only"))!;
    expect(warning).not.toContain("dist/");
    expect(warning).not.toContain("may still fail when the browser loads it");
    expect(extraAliases).toEqual([]);
    expect(deps).not.toContain("@w/types-only");
  });
});

describe("the needs-a-build diagnosis is withheld when a package has its source on disk", () => {
  it("returns undefined for a sibling whose declared entry is unbuilt but whose source resolves", () => {
    const { workspaceRoot, member } = mkWorkspace();
    linkSibling(
      workspaceRoot,
      member,
      "@w/utils",
      { main: "./dist/index.js" },
      { "src/index.ts": "export const value = 1;\n" },
    );

    const diagnosis = diagnoseUnbuiltWorkspacePackage(
      'Failed to resolve entry for package "@w/utils". The package may have incorrect main/module/exports specified in its package.json.',
      member,
    );

    expect(diagnosis).toBeUndefined();
  });

  it("keeps the build-step text when no source resolves anywhere in the package", () => {
    const { workspaceRoot, member } = mkWorkspace();
    linkSibling(workspaceRoot, member, "@w/nosource", { main: "./dist/index.js" }, {});

    const diagnosis = diagnoseUnbuiltWorkspacePackage(
      'Failed to resolve entry for package "@w/nosource". The package may have incorrect main/module/exports specified in its package.json.',
      member,
    );

    expect(diagnosis).toBe(UNBUILT_WORKSPACE_PACKAGE_WARNING("@w/nosource", "dist/index.js"));
  });
});
