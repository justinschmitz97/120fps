import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanExternalDeps } from "../../src/harness.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Same temp-workspace shape unbuilt-workspace-source-alias.test.ts uses: only a
// genuine link makes isWorkspaceSibling's realpath check pass.
function mkWorkspace(): {
  workspaceRoot: string;
  member: string;
  write: (rel: string, content: string) => void;
} {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-transitive-rescue-"));
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

const UNBUILT = { main: "./dist/index.js" };

describe("a workspace sibling reached only through another sibling is rescued in the same pass", () => {
  it("aliases a sibling that only an already-aliased sibling's source imports", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    linkSibling(workspaceRoot, member, "@w/ui", UNBUILT, {
      "src/index.ts": 'export * from "./with-filters";\n',
      "src/with-filters.ts": 'import { addFilter } from "@w/hooks";\nexport const f = addFilter;\n',
    });
    const hooks = linkSibling(workspaceRoot, member, "@w/hooks", UNBUILT, {
      "src/index.ts": "export const addFilter = () => undefined;\n",
    });
    write("packages/app/src/button.tsx", 'import { f } from "@w/ui";\nexport default 1;\n');

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

    const hooksEntry = fs.realpathSync(path.join(hooks, "src", "index.ts")).replace(/\\/g, "/");
    expect(extraAliases.find((a) => a.find.test("@w/hooks"))?.replacement).toBe(hooksEntry);
    expect(deps).not.toContain("@w/hooks");
    expect(warnings.filter((w) => w.includes("@w/hooks"))).toHaveLength(1);
  });

  it("follows the sibling's own NodeNext .js specifiers to their TypeScript sources", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    linkSibling(workspaceRoot, member, "@w/utils", { main: "./dist/index.js" }, {
      "shared/index.ts": 'export * from "./parse-now.js";\n',
      "shared/parse-now.ts": 'import { addFilter } from "@w/hooks";\nexport const p = addFilter;\n',
      "src/index.ts": 'export * from "../shared/index.js";\n',
    });
    const hooks = linkSibling(workspaceRoot, member, "@w/hooks", UNBUILT, {
      "src/index.ts": "export const addFilter = () => undefined;\n",
    });
    write("packages/app/src/button.tsx", 'import { p } from "@w/utils";\nexport default 1;\n');

    const extraAliases: Array<{ find: RegExp; replacement: string }> = [];
    const deps = scanExternalDeps(
      path.join(workspaceRoot, "packages/app/src/button.tsx"),
      member,
      [],
      undefined,
      [],
      workspaceRoot,
      extraAliases,
    );

    const hooksEntry = fs.realpathSync(path.join(hooks, "src", "index.ts")).replace(/\\/g, "/");
    expect(extraAliases.find((a) => a.find.test("@w/hooks"))?.replacement).toBe(hooksEntry);
    expect(deps).not.toContain("@w/hooks");
  });

  it("resolves a rescued sibling installed only under the package that imports it", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    const ui = linkSibling(workspaceRoot, member, "@w/ui", UNBUILT, {
      "src/index.ts": 'import { addFilter } from "@w/hooks";\nexport const f = addFilter;\n',
    });
    // The link lives under @w/ui, never under the entry project: a pnpm
    // install links a package's own dependencies beside that package.
    const hooks = linkSibling(workspaceRoot, ui, "@w/hooks", UNBUILT, {
      "src/index.ts": "export const addFilter = () => undefined;\n",
    });
    write("packages/app/src/button.tsx", 'import { f } from "@w/ui";\nexport default 1;\n');

    const extraAliases: Array<{ find: RegExp; replacement: string }> = [];
    const deps = scanExternalDeps(
      path.join(workspaceRoot, "packages/app/src/button.tsx"),
      member,
      [],
      undefined,
      [],
      workspaceRoot,
      extraAliases,
    );

    const hooksEntry = fs.realpathSync(path.join(hooks, "src", "index.ts")).replace(/\\/g, "/");
    expect(extraAliases.find((a) => a.find.test("@w/hooks"))?.replacement).toBe(hooksEntry);
    expect(deps).not.toContain("@w/hooks");
  });

  it("terminates on a cycle between two siblings and reports each alias once", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    linkSibling(workspaceRoot, member, "@w/a", UNBUILT, {
      "src/index.ts": 'import { b } from "@w/b";\nexport const a = b;\n',
    });
    linkSibling(workspaceRoot, member, "@w/b", UNBUILT, {
      "src/index.ts": 'import { a } from "@w/a";\nexport const b = a;\n',
    });
    write("packages/app/src/button.tsx", 'import { a } from "@w/a";\nexport default 1;\n');

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

    expect(extraAliases).toHaveLength(2);
    expect(warnings.filter((w) => w.includes("@w/a"))).toHaveLength(1);
    expect(warnings.filter((w) => w.includes("@w/b"))).toHaveLength(1);
    expect(deps).toEqual([]);
  });
});
