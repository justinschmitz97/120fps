import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scanExternalDeps,
  UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING,
  UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING,
  TYPE_ONLY_PACKAGE_WARNING,
} from "../../src/harness.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// M94 (dub-F1/F2): a bare-imported workspace-sibling package whose main
// points at an unbuilt dist/, imported as a real value (not type-only), used
// to be excluded from optimizeDeps.include with a warning claiming that
// exclusion prevents a crash -- it does not, because Vite's own per-request
// resolution hits the same unresolvable bare specifier the moment the
// browser loads the importing file. The fix redirects it to its own
// resolvable source instead of merely excluding it.
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

// Same real-symlink-under-node_modules shape import-scanner-coverage.test.ts's
// own "workspace-sibling subpath substitution" describe block already uses:
// isWorkspaceSibling requires the installed location's realpath to resolve
// outside any node_modules segment, which only a genuine link (not a plain
// directory copy) produces.
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
    // The realpath through the node_modules junction, not the link location:
    // both point at the same file on disk (a Windows junction/symlink is
    // transparent to fs.realpathSync), matching what isWorkspaceSibling
    // itself already resolves through.
    const sourceEntry = fs.realpathSync(path.join(real, "src", "index.ts")).replace(/\\/g, "/");
    expect(extraAliases[0].replacement).toBe(sourceEntry);
    expect(warnings).toContain(UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING("@dub/utils", sourceEntry));
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
    expect(warnings).toContain(UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING("@dub/utils", "tsup"));
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
