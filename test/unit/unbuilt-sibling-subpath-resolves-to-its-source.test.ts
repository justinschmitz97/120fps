import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scanExternalDeps,
  UNALIASED_WORKSPACE_SUBPATH_WARNING,
} from "../../src/harness/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Same shape as workspace-sibling-entry-resolution.test.ts: the realpath check needs a real link.
function mkWorkspace(): {
  workspaceRoot: string;
  member: string;
  write: (rel: string, content: string) => void;
} {
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-subpath-source-"));
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

// twenty-ui's shape: every subpath builds flat into dist/, every source sits nested under src/.
const FLAT_DIST_NESTED_SOURCE = {
  main: "./dist/index.cjs",
  module: "./dist/index.mjs",
  exports: {
    ".": { types: "./dist/index.d.ts", import: "./dist/index.mjs" },
    "./theme-constants": {
      types: "./dist/theme-constants/index.d.ts",
      import: "./dist/theme-constants.mjs",
      require: "./dist/theme-constants.cjs",
    },
    "./package.json": "./package.json",
  },
};

function scan(
  workspaceRoot: string,
  member: string,
): {
  deps: string[];
  aliases: Array<{ find: RegExp; replacement: string }>;
  warnings: string[];
} {
  const aliases: Array<{ find: RegExp; replacement: string }> = [];
  const warnings: string[] = [];
  const deps = scanExternalDeps(
    path.join(workspaceRoot, "packages/ui/src/button.tsx"),
    member,
    [],
    undefined,
    warnings,
    workspaceRoot,
    aliases,
  );
  return { deps, aliases, warnings };
}

describe("an exports subpath whose build output is missing", () => {
  it("resolves to the source nested under the sibling's src directory", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    const real = linkSibling(workspaceRoot, member, "@w/ui", FLAT_DIST_NESTED_SOURCE, {
      "src/index.ts": SOURCE,
      "src/theme-constants/index.ts": SOURCE,
    });
    write(
      "packages/ui/src/button.tsx",
      'import { value } from "@w/ui/theme-constants";\nexport default 1;\n',
    );

    const { deps, aliases, warnings } = scan(workspaceRoot, member);

    expect(aliases.find((a) => a.find.test("@w/ui/theme-constants"))?.replacement).toBe(
      realPosix(real, "src", "theme-constants", "index.ts"),
    );
    expect(deps).not.toContain("@w/ui/theme-constants");
    expect(warnings).not.toContain(
      UNALIASED_WORKSPACE_SUBPATH_WARNING("@w/ui/theme-constants", "@w/ui"),
    );
  });

  it("walks the rescued source's own imports", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    linkSibling(workspaceRoot, member, "@w/ui", FLAT_DIST_NESTED_SOURCE, {
      "src/index.ts": SOURCE,
      "src/theme-constants/index.ts": 'import { clsx } from "clsx";\nexport const value = clsx;\n',
    });
    write(
      "packages/ui/src/button.tsx",
      'import { value } from "@w/ui/theme-constants";\nexport default 1;\n',
    );

    expect(scan(workspaceRoot, member).deps).toContain("clsx");
  });

  it("keeps the target beside the build output when both layouts exist", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    const real = linkSibling(
      workspaceRoot,
      member,
      "@w/flat",
      {
        main: "./dist/index.js",
        exports: { ".": "./dist/index.js", "./browser": "./dist/browser.js" },
      },
      { "index.ts": SOURCE, "browser/index.ts": SOURCE, "src/browser/index.ts": SOURCE },
    );
    write(
      "packages/ui/src/button.tsx",
      'import { value } from "@w/flat/browser";\nexport default 1;\n',
    );

    const { aliases } = scan(workspaceRoot, member);

    expect(aliases.find((a) => a.find.test("@w/flat/browser"))?.replacement).toBe(
      realPosix(real, "browser", "index.ts"),
    );
  });
});

describe("an exports subpath with no source of its own", () => {
  it("stays out of the pre-bundle and keeps its disclosure", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    linkSibling(workspaceRoot, member, "@w/ui", FLAT_DIST_NESTED_SOURCE, {
      "src/index.ts": SOURCE,
    });
    write(
      "packages/ui/src/button.tsx",
      'import { value } from "@w/ui/theme-constants";\nexport default 1;\n',
    );

    const { deps, aliases, warnings } = scan(workspaceRoot, member);

    expect(aliases.find((a) => a.find.test("@w/ui/theme-constants"))).toBeUndefined();
    expect(deps).not.toContain("@w/ui/theme-constants");
    expect(warnings).toContain(
      UNALIASED_WORKSPACE_SUBPATH_WARNING("@w/ui/theme-constants", "@w/ui"),
    );
  });

  it("is not aliased to a declaration file that sits where the source would", () => {
    const { workspaceRoot, member, write } = mkWorkspace();
    linkSibling(workspaceRoot, member, "@w/ui", FLAT_DIST_NESTED_SOURCE, {
      "src/index.ts": SOURCE,
      "src/theme-constants/index.d.ts": "export declare const value: number;\n",
    });
    write(
      "packages/ui/src/button.tsx",
      'import { value } from "@w/ui/theme-constants";\nexport default 1;\n',
    );

    const { aliases, warnings } = scan(workspaceRoot, member);

    expect(aliases.find((a) => a.find.test("@w/ui/theme-constants"))).toBeUndefined();
    expect(warnings).toContain(
      UNALIASED_WORKSPACE_SUBPATH_WARNING("@w/ui/theme-constants", "@w/ui"),
    );
  });
});
