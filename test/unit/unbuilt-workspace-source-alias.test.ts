import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  packageScriptCommand,
  scanExternalDeps,
  UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING,
  UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING,
  TYPE_ONLY_PACKAGE_WARNING,
} from "../../src/harness/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// M94: an unbuilt workspace-sibling import must redirect to source; excluding it leaves the crash.
function mkWorkspace(): { workspaceRoot: string; member: string; write: (rel: string, c: string) => void } {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m94-unbuilt-"));
  cleanupDirs.push(workspaceRoot);
  fs.writeFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  const member = path.join(workspaceRoot, "packages", "ui");
  fs.mkdirSync(member, { recursive: true });
  const write = (rel: string, content: string) => {
    const full = path.join(workspaceRoot, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  return { workspaceRoot, member, write };
}

// isWorkspaceSibling needs a realpath outside node_modules; a symlink gives that, a copy does not.
function linkSibling(workspaceRoot: string, member: string, scopedName: string): string {
  const [scope, name] = scopedName.split("/");
  const real = path.join(workspaceRoot, "packages", name);
  fs.mkdirSync(real, { recursive: true });
  const linkParent = path.join(member, "node_modules", scope);
  fs.mkdirSync(linkParent, { recursive: true });
  fs.symlinkSync(real, path.join(linkParent, name), process.platform === "win32" ? "junction" : "dir");
  return real;
}

describe("workspace-sibling packages with unbuilt dist but resolvable source (M94)", () => {
  it("aliases a bare-imported sibling to its own src/ entry instead of excluding it", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    const real = linkSibling(workspaceRoot, member, "@dub/utils");
    fs.writeFileSync(
      path.join(real, "package.json"),
      JSON.stringify({ name: "@dub/utils", main: "./dist/index.mjs" }),
    );
    fs.mkdirSync(path.join(real, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(real, "src", "index.ts"),
      "export const cn = (...a: unknown[]) => a.join(' ');",
    );
    write(
      "packages/ui/src/button.tsx",
      'import { cn } from "@dub/utils";\nexport default function Button() { return null; }\n',
    );
    const entryPath = path.join(workspaceRoot, "packages/ui/src/button.tsx");

    const extraAliases: Array<{ find: RegExp; replacement: string }> = [];
    const warnings: string[] = [];
    const deps = scanExternalDeps(entryPath, member, [], undefined, warnings, workspaceRoot, extraAliases);

    expect(deps).not.toContain("@dub/utils");
    expect(extraAliases).toHaveLength(1);
    expect(extraAliases[0].find.test("@dub/utils")).toBe(true);
    // realpathSync via the junction matches isWorkspaceSibling; a junction is transparent to it.
    const sourceEntry = fs.realpathSync(path.join(real, "src", "index.ts")).replace(/\\/g, "/");
    expect(extraAliases[0].replacement).toBe(sourceEntry);
    // specs/milestones/m107-workspace-siblings-resolve-by-their-real-entry.md: names field + path.
    expect(warnings).toContain(
      UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING("@dub/utils", sourceEntry, {
        field: "main",
        declared: "./dist/index.mjs",
        exists: false,
      }),
    );
    expect(warnings.some((w) => w.includes("type-only"))).toBe(false);
  });

  it("falls back to exclusion, with honest wording naming the build command, when no source resolves", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    const real = linkSibling(workspaceRoot, member, "@dub/utils");
    fs.writeFileSync(
      path.join(real, "package.json"),
      JSON.stringify({ name: "@dub/utils", main: "./dist/index.mjs", scripts: { build: "tsup" } }),
    );
    // No src/ directory at all.
    write(
      "packages/ui/src/button.tsx",
      'import { cn } from "@dub/utils";\nexport default function Button() { return null; }\n',
    );
    const entryPath = path.join(workspaceRoot, "packages/ui/src/button.tsx");

    const warnings: string[] = [];
    const deps = scanExternalDeps(entryPath, member, [], undefined, warnings, workspaceRoot);

    expect(deps).not.toContain("@dub/utils");
    // specs/milestones/m111-a-run-works-from-any-directory-in-the-workspace.md A5: script + dir.
    expect(warnings).toContain(
      UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING(
        "@dub/utils",
        packageScriptCommand(real, "build", process.cwd()),
        {
          field: "main",
          declared: "./dist/index.mjs",
          exists: false,
        },
      ),
    );
    expect(warnings.join("\n")).toContain("run build");
    expect(warnings.join("\n")).not.toContain("tsup");
    expect(warnings).not.toContain(TYPE_ONLY_PACKAGE_WARNING("@dub/utils"));
  });

  it("leaves a genuinely external type-only package (not a workspace sibling) unaffected", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    fs.mkdirSync(path.join(member, "node_modules", "csstype"), { recursive: true });
    fs.writeFileSync(
      path.join(member, "node_modules", "csstype", "package.json"),
      JSON.stringify({ name: "csstype", main: "" }),
    );
    write(
      "packages/ui/src/button.tsx",
      'import "csstype";\nexport default function Button() { return null; }\n',
    );
    const entryPath = path.join(workspaceRoot, "packages/ui/src/button.tsx");

    const warnings: string[] = [];
    const deps = scanExternalDeps(entryPath, member, [], undefined, warnings, workspaceRoot);

    expect(deps).not.toContain("csstype");
    expect(warnings).toContain(TYPE_ONLY_PACKAGE_WARNING("csstype"));
  });
});
