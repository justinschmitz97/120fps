import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectStaticPreBuildWarnings } from "../../src/harness/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// The app's own tsconfig claims the sibling's subpaths, and every one of those targets is unbuilt.
function shadowedSibling(prefix: string): { app: string; entry: string } {
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
    "packages/app/package.json",
    JSON.stringify({ name: "app", dependencies: { "@fix/sib": "workspace:*" } }),
  );
  write(
    "packages/app/tsconfig.json",
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@fix/sib/*": ["../sib/*"] } } }),
  );
  const entry = write(
    "packages/app/src/Card.tsx",
    'import { sub } from "@fix/sib/sub";\n' +
      "export function Card() { return null; }\n" +
      "export const shown = sub;\n",
  );
  write(
    "packages/sib/package.json",
    JSON.stringify({
      name: "@fix/sib",
      exports: { ".": "./dist/index.js", "./sub": "./dist/sub.js" },
    }),
  );
  write("packages/sib/src/index.ts", 'export { sub } from "./sub.js";\n');
  write("packages/sib/src/sub.ts", 'import "clsx";\nexport const sub = 1;\n');

  const linkParent = path.join(root, "packages", "app", "node_modules", "@fix");
  fs.mkdirSync(linkParent, { recursive: true });
  fs.symlinkSync(
    path.join(root, "packages", "sib"),
    path.join(linkParent, "sib"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return { app: path.join(root, "packages", "app"), entry };
}

describe("a project alias that claims an unbuilt sibling's subpath", () => {
  it("does not hide the sibling's own source behind a stale target", () => {
    const { app, entry } = shadowedSibling("120fps-shadowed-sibling-");

    const built = collectStaticPreBuildWarnings(app, { componentPath: entry });

    expect(built.warnings.filter((warning) => warning.includes("path alias"))).toEqual([]);
    // clsx is only reachable through the sibling's own src/sub.ts.
    expect(built.externalDeps).toContain("clsx");
  });

  it("ranks the sibling's source ahead of the alias that matched first", () => {
    const { app, entry } = shadowedSibling("120fps-shadowed-sibling-order-");

    const built = collectStaticPreBuildWarnings(app, { componentPath: entry });

    const matching = built.aliases.filter((alias) => alias.find.test("@fix/sib/sub"));
    expect(matching.length).toBeGreaterThan(1);
    expect(matching[0].replacement).toContain("packages/sib/src/sub.ts");
  });
});
