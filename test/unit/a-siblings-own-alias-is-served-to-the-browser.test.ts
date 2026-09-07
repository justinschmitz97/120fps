import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectStaticPreBuildWarnings } from "../../src/harness/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Both packages declare "~/*" against their own src/; only the sibling has an icons/ under it.
function workspaceWithSiblingAlias(
  prefix: string,
  options: { appIcons?: boolean } = {},
): { app: string; entry: string } {
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
    JSON.stringify({ name: "app", dependencies: { "@fix/kit": "workspace:*" } }),
  );
  write(
    "packages/app/tsconfig.json",
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["./src/*"] } } }),
  );
  const entry = write(
    "packages/app/src/Card.tsx",
    'import { Avatar } from "@fix/kit";\n' +
      "export function Card() { return null; }\n" +
      "export const shown = Avatar;\n",
  );
  if (options.appIcons) write("packages/app/src/icons.ts", "export const appIcon = 1;\n");

  write(
    "packages/kit/package.json",
    JSON.stringify({ name: "@fix/kit", main: "./dist/index.js" }),
  );
  write(
    "packages/kit/tsconfig.json",
    JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["./src/*"] } } }),
  );
  write("packages/kit/src/index.ts", 'export { Avatar } from "./Avatar.js";\n');
  write(
    "packages/kit/src/Avatar.tsx",
    'import { UserIcon } from "~/icons";\nexport const Avatar = UserIcon;\n',
  );
  write("packages/kit/src/icons/index.ts", 'import "clsx";\nexport const UserIcon = 1;\n');

  const linkParent = path.join(root, "packages", "app", "node_modules", "@fix");
  fs.mkdirSync(linkParent, { recursive: true });
  fs.symlinkSync(
    path.join(root, "packages", "kit"),
    path.join(linkParent, "kit"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return { app: path.join(root, "packages", "app"), entry };
}

// Two siblings, one alias name, two different files: the measured package resolves neither.
const esc = String.fromCharCode(10);

function twoSiblingsOneAliasName(prefix: string): { app: string; entry: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(root);
  const write = (rel: string, content: string): string => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  };
  write("pnpm-workspace.yaml", "packages:" + esc + "  - packages/*" + esc);
  write("package.json", JSON.stringify({ name: "root", private: true }));
  write(
    "packages/app/package.json",
    JSON.stringify({
      name: "app",
      dependencies: { "@fix/kit": "workspace:*", "@fix/other": "workspace:*" },
    }),
  );
  write("packages/app/tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: "." } }));
  const entry = write(
    "packages/app/src/Card.tsx",
    'import { Avatar } from "@fix/kit";' + esc +
      'import { Badge } from "@fix/other";' + esc +
      "export function Card() { return null; }" + esc +
      "export const shown = [Avatar, Badge];" + esc,
  );
  for (const [name, member] of [["kit", "Avatar"], ["other", "Badge"]] as const) {
    write(
      `packages/${name}/package.json`,
      JSON.stringify({ name: `@fix/${name}`, main: "./dist/index.js" }),
    );
    write(
      `packages/${name}/tsconfig.json`,
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "~/*": ["./src/*"] } } }),
    );
    write(`packages/${name}/src/index.ts`, `export { ${member} } from "./${member}.js";` + esc);
    write(
      `packages/${name}/src/${member}.tsx`,
      'import { thing } from "~/shared";' + esc + `export const ${member} = thing;` + esc,
    );
    write(`packages/${name}/src/shared/index.ts`, `export const thing = "${name}";` + esc);
    const linkParent = path.join(root, "packages", "app", "node_modules", "@fix");
    fs.mkdirSync(linkParent, { recursive: true });
    fs.symlinkSync(
      path.join(root, "packages", name),
      path.join(linkParent, name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  return { app: path.join(root, "packages", "app"), entry };
}

describe("two workspace siblings that alias one name to different files", () => {
  it("serves the first and names the file the second wanted", () => {
    const { app, entry } = twoSiblingsOneAliasName("120fps-two-siblings-one-name-");

    const built = collectStaticPreBuildWarnings(app, { componentPath: entry });

    const conflicts = built.warnings.filter((warning) => warning.includes('"~/shared"'));
    expect(conflicts).toHaveLength(1);
    const served = built.aliases.filter((alias) => alias.find.test("~/shared"));
    expect(served).toHaveLength(1);
    // The conflict line names the file that is not served, and the one that is.
    expect(conflicts[0]).toContain("src/shared/index.ts");
  });
});

describe("an aliased import written inside an unbuilt sibling", () => {
  it("is aliased to the file the sibling's own tsconfig names", () => {
    const { app, entry } = workspaceWithSiblingAlias("120fps-sibling-alias-served-");

    const built = collectStaticPreBuildWarnings(app, { componentPath: entry });

    const matching = built.aliases.filter((alias) => alias.find.test("~/icons"));
    expect(matching.length).toBeGreaterThan(0);
    expect(matching[0].replacement).toContain("packages/kit/src/icons");
    expect(built.externalDeps).toContain("clsx");
  });

  it("is disclosed instead of served when the measured package claims the same name", () => {
    const { app, entry } = workspaceWithSiblingAlias("120fps-sibling-alias-conflict-", {
      appIcons: true,
    });

    const built = collectStaticPreBuildWarnings(app, { componentPath: entry });

    const conflict = built.warnings.filter((warning) => warning.includes("~/icons"));
    expect(conflict).toHaveLength(1);
    expect(conflict[0]).toContain("packages/kit/src/icons");
    expect(conflict[0]).toContain("packages/app/src/icons.ts");
    const exact = built.aliases.filter((alias) => alias.find.source.includes("icons"));
    expect(exact).toEqual([]);
  });
});
