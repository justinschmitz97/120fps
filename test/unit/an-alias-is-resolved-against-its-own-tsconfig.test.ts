import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectStaticPreBuildWarnings } from "../../src/harness/index.js";
import { tsconfigAliasesForFile, resetTsconfigAliasTables } from "../../src/project/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface Workspace {
  root: string;
  front: string;
  shared: string;
  write: (rel: string, content: string) => string;
}

// Two packages declare the same "@/*" pattern against different roots: the classic monorepo shape.
function twoPackagesOneAliasPattern(prefix: string): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(root);
  const write = (rel: string, content: string): string => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  write("package.json", JSON.stringify({ name: "root", private: true }));

  write(
    "packages/front/package.json",
    JSON.stringify({ name: "front", dependencies: { "@fix/shared": "workspace:*" } }),
  );
  write(
    "packages/front/tsconfig.json",
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/modules/*"] } } }),
  );
  write(
    "packages/front/src/modules/Card.tsx",
    'import { helper } from "@/helpers/helper";\n' +
      'import { shared } from "@fix/shared";\n' +
      "export function Card() { return null; }\n" +
      "export const used = [helper, shared];\n",
  );
  write("packages/front/src/modules/helpers/helper.ts", "export const helper = 1;\n");

  write(
    "packages/shared/package.json",
    JSON.stringify({ name: "@fix/shared", main: "./dist/index.js" }),
  );
  write(
    "packages/shared/tsconfig.json",
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./src/*"] } } }),
  );
  write("packages/shared/src/index.ts", 'export { shared } from "@/util";\n');
  write("packages/shared/src/util.ts", 'import "clsx";\nexport const shared = 2;\n');

  const linkParent = path.join(root, "packages", "front", "node_modules", "@fix");
  fs.mkdirSync(linkParent, { recursive: true });
  fs.symlinkSync(
    path.join(root, "packages", "shared"),
    path.join(linkParent, "shared"),
    process.platform === "win32" ? "junction" : "dir",
  );

  return {
    root,
    front: path.join(root, "packages", "front"),
    shared: path.join(root, "packages", "shared"),
    write,
  };
}

describe("an import inside a workspace sibling", () => {
  it("is judged against the tsconfig that governs the file it was written in", () => {
    const ws = twoPackagesOneAliasPattern("120fps-alias-per-file-");

    const built = collectStaticPreBuildWarnings(ws.front, {
      componentPath: path.join(ws.front, "src", "modules", "Card.tsx"),
    });

    expect(built.warnings.filter((warning) => warning.includes("path alias"))).toEqual([]);
    // clsx is only reachable through "@/util", which only the sibling's own tsconfig resolves.
    expect(built.externalDeps).toContain("clsx");
  });

  it("never produces a warning derived from the measured package's table", () => {
    const ws = twoPackagesOneAliasPattern("120fps-alias-per-file-warn-");

    const built = collectStaticPreBuildWarnings(ws.front, {
      componentPath: path.join(ws.front, "src", "modules", "Card.tsx"),
    });

    expect(built.warnings.join("\n")).not.toContain("src/modules/util");
  });
});

describe("the governing alias table", () => {
  it("answers differently for two files with the same name under two configs", () => {
    resetTsconfigAliasTables();
    const ws = twoPackagesOneAliasPattern("120fps-alias-memo-");

    const frontTable = tsconfigAliasesForFile(ws.front, path.join(ws.front, "src/modules/Card.tsx"));
    const sharedTable = tsconfigAliasesForFile(ws.front, path.join(ws.shared, "src/index.ts"));

    const frontHit = frontTable.find((alias) => alias.find.test("@/x"));
    const sharedHit = sharedTable.find((alias) => alias.find.test("@/x"));
    expect(frontHit).toBeDefined();
    expect(sharedHit).toBeDefined();
    expect(frontHit!.replacement).not.toBe(sharedHit!.replacement);
    expect(frontHit!.replacement).toContain("src/modules");
    expect(sharedHit!.replacement).not.toContain("src/modules");
  });

  it("returns the same table object for two files under one config", () => {
    resetTsconfigAliasTables();
    const ws = twoPackagesOneAliasPattern("120fps-alias-memo-same-");

    const first = tsconfigAliasesForFile(ws.front, path.join(ws.front, "src/modules/Card.tsx"));
    const second = tsconfigAliasesForFile(
      ws.front,
      path.join(ws.front, "src/modules/helpers/helper.ts"),
    );

    expect(second).toBe(first);
  });
});
