import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scanExternalDeps,
  UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING,
  UNALIASED_WORKSPACE_SUBPATH_WARNING,
} from "../../src/harness/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Same as unbuilt-workspace-source-alias.test.ts: needs a genuine link for the realpath check.
function mkWorkspace(): {
  workspaceRoot: string;
  member: string;
  write: (rel: string, content: string) => void;
} {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-entry-resolution-"));
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

function realPosix(...segments: string[]): string {
  return fs.realpathSync(path.join(...segments)).replace(/\\/g, "/");
}

const SOURCE = "export const value = 1;\n";

describe("an unbuilt workspace sibling is aliased to the source its own package.json points at", () => {
  it("follows a main whose build-output segment hides the source directory", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    const real = linkSibling(
      workspaceRoot,
      member,
      "@w/utils",
      {
        main: "./dist/shared/index.js",
        exports: {
          ".": "./dist/shared/index.js",
          "./browser": "./dist/browser.js",
          "./package.json": "./package.json",
        },
      },
      { "shared/index.ts": SOURCE, "browser/index.ts": SOURCE },
    );
    write(
      "packages/ui/src/button.tsx",
      'import { value } from "@w/utils";\nimport { value as b } from "@w/utils/browser";\nexport default function Button() { return null; }\n',
    );

    const extraAliases: Array<{ find: RegExp; replacement: string }> = [];
    const warnings: string[] = [];
    const deps = scanExternalDeps(
      path.join(workspaceRoot, "packages/ui/src/button.tsx"),
      member,
      [],
      undefined,
      warnings,
      workspaceRoot,
      extraAliases,
    );

    const rootEntry = realPosix(real, "shared", "index.ts");
    const rootAlias = extraAliases.find((a) => a.find.test("@w/utils"));
    expect(rootAlias?.replacement).toBe(rootEntry);
    expect(warnings).toContain(
      UNBUILT_WORKSPACE_SOURCE_ALIAS_WARNING("@w/utils", rootEntry, {
        field: 'exports["."]',
        declared: "./dist/shared/index.js",
        exists: false,
      }),
    );
    // A5, pinned literally: a builder rewrite dropping the field name would otherwise still pass.
    expect(warnings.find((w) => w.includes("@w/utils"))).toContain(
      'whose exports["."] names ./dist/shared/index.js, which does not exist on disk',
    );

    // A2: the subpath key resolves through the same derivation.
    const browserAlias = extraAliases.find((a) => a.find.test("@w/utils/browser"));
    expect(browserAlias?.replacement).toBe(realPosix(real, "browser", "index.ts"));
    expect(deps).not.toContain("@w/utils");
    expect(deps).not.toContain("@w/utils/browser");
  });

  it("keeps the src/ target for a sibling whose source lives under src/", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    const real = linkSibling(
      workspaceRoot,
      member,
      "@w/src-layout",
      { main: "./dist/index.js" },
      { "src/index.ts": SOURCE },
    );
    write("packages/ui/src/button.tsx", 'import { value } from "@w/src-layout";\nexport default 1;\n');

    const extraAliases: Array<{ find: RegExp; replacement: string }> = [];
    const deps = scanExternalDeps(
      path.join(workspaceRoot, "packages/ui/src/button.tsx"),
      member,
      [],
      undefined,
      [],
      workspaceRoot,
      extraAliases,
    );

    expect(extraAliases[0]?.replacement).toBe(realPosix(real, "src", "index.ts"));
    expect(deps).not.toContain("@w/src-layout");
  });

  it("prefers a declared source field and names it in the warning, with no dist claim", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    const real = linkSibling(
      workspaceRoot,
      member,
      "@w/source-field",
      { source: "./lib/index.ts" },
      { "lib/index.ts": SOURCE },
    );
    write("packages/ui/src/button.tsx", 'import { value } from "@w/source-field";\nexport default 1;\n');

    const extraAliases: Array<{ find: RegExp; replacement: string }> = [];
    const warnings: string[] = [];
    scanExternalDeps(
      path.join(workspaceRoot, "packages/ui/src/button.tsx"),
      member,
      [],
      undefined,
      warnings,
      workspaceRoot,
      extraAliases,
    );

    expect(extraAliases[0]?.replacement).toBe(realPosix(real, "lib", "index.ts"));
    const warning = warnings.find((w) => w.includes("@w/source-field"));
    expect(warning).toBeDefined();
    expect(warning).toContain("whose source names ./lib/index.ts");
    expect(warning).not.toContain("dist/");
  });

  it("lets the source field win over a main-derived candidate that also resolves", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    const real = linkSibling(
      workspaceRoot,
      member,
      "@w/both",
      { source: "./lib/index.ts", main: "./dist/index.js" },
      { "lib/index.ts": SOURCE, "index.ts": SOURCE, "src/index.ts": SOURCE },
    );
    write("packages/ui/src/button.tsx", 'import { value } from "@w/both";\nexport default 1;\n');

    const extraAliases: Array<{ find: RegExp; replacement: string }> = [];
    const warnings: string[] = [];
    scanExternalDeps(
      path.join(workspaceRoot, "packages/ui/src/button.tsx"),
      member,
      [],
      undefined,
      warnings,
      workspaceRoot,
      extraAliases,
    );

    expect(extraAliases[0]?.replacement).toBe(realPosix(real, "lib", "index.ts"));
    expect(warnings.find((w) => w.includes("@w/both"))).toContain("whose source names ./lib/index.ts");
  });
});

describe("a subpath the root alias removed from the pre-bundle is disclosed", () => {
  it("names the specifier and its sibling when nothing aliased that subpath", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    linkSibling(
      workspaceRoot,
      member,
      "@w/deep",
      { main: "./dist/index.js" },
      { "src/index.ts": SOURCE },
    );
    write(
      "packages/ui/src/button.tsx",
      'import { value } from "@w/deep";\nimport { other } from "@w/deep/not-exported";\nexport default 1;\n',
    );

    const extraAliases: Array<{ find: RegExp; replacement: string }> = [];
    const warnings: string[] = [];
    const deps = scanExternalDeps(
      path.join(workspaceRoot, "packages/ui/src/button.tsx"),
      member,
      [],
      undefined,
      warnings,
      workspaceRoot,
      extraAliases,
    );

    expect(deps).not.toContain("@w/deep/not-exported");
    expect(warnings).toContain(
      UNALIASED_WORKSPACE_SUBPATH_WARNING("@w/deep/not-exported", "@w/deep"),
    );
    expect(warnings.filter((w) => w.includes("@w/deep/not-exported"))).toHaveLength(1);
  });
});
