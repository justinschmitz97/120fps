import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  scanExternalDeps,
  TYPE_ONLY_PACKAGE_WARNING,
  UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING,
} from "../../src/harness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-scan-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const file = path.join(tmpDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

const fwd = (p: string) => p.replace(/\\/g, "/");
const srcAlias = () => [{ find: /^@\//, replacement: `${fwd(tmpDir)}/src/` }];

// Every specifier the scanner misses is a package Vite discovers on demand,
// which reloads the page in the middle of a measurement (M34).
describe("dynamic import and require specifiers", () => {
  it("follows a dynamically imported local module", () => {
    write("Lazy.tsx", `import "lazy-only-pkg";\nexport default function Lazy() { return null; }\n`);
    const entry = write(
      "Entry.tsx",
      `const Lazy = () => import("./Lazy");\nexport function Entry() { return Lazy; }\n`,
    );

    expect(scanExternalDeps(entry, tmpDir, [])).toContain("lazy-only-pkg");
  });

  it("registers a dynamically imported package", () => {
    const entry = write(
      "Entry.tsx",
      `export async function load() { return await import("chart-lib"); }\n`,
    );

    expect(scanExternalDeps(entry, tmpDir, [])).toContain("chart-lib");
  });

  it("registers a required package", () => {
    const entry = write(
      "Entry.tsx",
      `const legacy = require("cjs-pkg");\nexport function Entry() { return legacy; }\n`,
    );

    expect(scanExternalDeps(entry, tmpDir, [])).toContain("cjs-pkg");
  });

  it("follows a required local module", () => {
    write("helper.js", `require("helper-dep");\nmodule.exports = null;\n`);
    const entry = write("Entry.tsx", `const h = require("./helper");\nexport default h;\n`);

    expect(scanExternalDeps(entry, tmpDir, [])).toContain("helper-dep");
  });

  it("ignores a computed specifier it cannot read", () => {
    const entry = write(
      "Entry.tsx",
      "const load = (name: string) => import(`./pages/${name}`);\nexport default load;\n",
    );

    expect(scanExternalDeps(entry, tmpDir, [])).toEqual([]);
  });

  it("does not mistake an identifier ending in import or require for a call", () => {
    const entry = write(
      "Entry.tsx",
      `function myrequire(x: string) { return x; }\nfunction preimport(x: string) { return x; }\nexport default myrequire("not-a-package") + preimport("also-not-a-package");\n`,
    );

    expect(scanExternalDeps(entry, tmpDir, [])).toEqual([]);
  });
});

describe("query-suffixed specifiers", () => {
  it("resolves an aliased asset import instead of registering it as a package", () => {
    write("src/styles/app.css", ".a { color: red; }\n");
    const entry = write("Entry.tsx", `import "@/styles/app.css?inline";\nexport const x = 1;\n`);

    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, srcAlias(), undefined, warnings);

    expect(pkgs).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("follows a local module imported with a query", () => {
    write("work.ts", `import "worker-pkg";\nexport default null;\n`);
    const entry = write("Entry.tsx", `import W from "./work?worker";\nexport default W;\n`);

    expect(scanExternalDeps(entry, tmpDir, [])).toContain("worker-pkg");
  });

  it("keeps the package name of a query-suffixed package import", () => {
    const entry = write("Entry.tsx", `import "swiper/css/pagination?inline";\nexport const x = 1;\n`);

    expect(scanExternalDeps(entry, tmpDir, [])).toEqual(["swiper"]);
  });
});

describe("resolution targets beyond source files and index files", () => {
  it("resolves an aliased .json target", () => {
    write("src/data.json", `{ "a": 1 }\n`);
    const entry = write("Entry.tsx", `import data from "@/data";\nexport default data;\n`);

    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, srcAlias(), undefined, warnings);

    expect(pkgs).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("does not read a resolved .json file for imports", () => {
    write("data.json", `{ "note": " import x from 'ghost-pkg' " }\n`);
    const entry = write("Entry.tsx", `import data from "./data.json";\nexport default data;\n`);

    expect(scanExternalDeps(entry, tmpDir, [])).toEqual([]);
  });

  it("resolves a .cjs target and follows its requires", () => {
    write("legacy.cjs", `const dep = require("legacy-dep");\nmodule.exports = dep;\n`);
    const entry = write("Entry.tsx", `const legacy = require("./legacy");\nexport default legacy;\n`);

    expect(scanExternalDeps(entry, tmpDir, [])).toContain("legacy-dep");
  });

  it("resolves a .cts target", () => {
    write("typed.cts", `import "cts-dep";\nexport const x = 1;\n`);
    const entry = write("Entry.tsx", `import { x } from "./typed";\nexport default x;\n`);

    expect(scanExternalDeps(entry, tmpDir, [])).toContain("cts-dep");
  });

  it("resolves a directory through its package.json main", () => {
    write("src/pkg/package.json", JSON.stringify({ name: "inner", main: "./lib/entry.js" }));
    write("src/pkg/lib/entry.js", `import "dir-main-pkg";\nexport default null;\n`);
    const entry = write("Entry.tsx", `import inner from "@/pkg";\nexport default inner;\n`);

    expect(scanExternalDeps(entry, tmpDir, srcAlias())).toContain("dir-main-pkg");
  });

  it("prefers the package.json exports entry over main", () => {
    write(
      "src/pkg/package.json",
      JSON.stringify({
        name: "inner",
        main: "./lib/cjs.js",
        exports: { ".": { import: "./lib/esm.js" } },
      }),
    );
    write("src/pkg/lib/cjs.js", `import "cjs-entry-pkg";\nexport default null;\n`);
    write("src/pkg/lib/esm.js", `import "esm-entry-pkg";\nexport default null;\n`);
    const entry = write("Entry.tsx", `import inner from "@/pkg";\nexport default inner;\n`);

    const pkgs = scanExternalDeps(entry, tmpDir, srcAlias());

    expect(pkgs).toContain("esm-entry-pkg");
    expect(pkgs).not.toContain("cjs-entry-pkg");
  });

  it("still falls back to an index file when the directory has no manifest", () => {
    write("src/pkg/index.ts", `import "index-pkg";\nexport default null;\n`);
    const entry = write("Entry.tsx", `import inner from "@/pkg";\nexport default inner;\n`);

    expect(scanExternalDeps(entry, tmpDir, srcAlias())).toContain("index-pkg");
  });
});

// M76: a workspace-sibling package whose own root has no resolvable entry and
// is never imported bare contributes the subpath actually scanned instead of
// its unresolvable collapsed root name.
describe("workspace-sibling subpath substitution", () => {
  function mkWorkspace(): { workspaceRoot: string; member: string } {
    const workspaceRoot = tmpDir;
    fs.writeFileSync(path.join(workspaceRoot, "pnpm-workspace.yaml"), "packages:\n  - member\n");
    const member = path.join(workspaceRoot, "member");
    fs.mkdirSync(member, { recursive: true });
    return { workspaceRoot, member };
  }

  function linkSibling(workspaceRoot: string, member: string, scopedName: string): string {
    const [scope, name] = scopedName.split("/");
    const real = path.join(workspaceRoot, "packages", name);
    fs.mkdirSync(real, { recursive: true });
    const linkParent = path.join(member, "node_modules", scope);
    fs.mkdirSync(linkParent, { recursive: true });
    fs.symlinkSync(real, path.join(linkParent, name), process.platform === "win32" ? "junction" : "dir");
    return real;
  }

  it("substitutes the scanned subpath for a bare root with no '.' export", () => {
    const { workspaceRoot, member } = mkWorkspace();
    const real = linkSibling(workspaceRoot, member, "@scope/ui");
    fs.writeFileSync(
      path.join(real, "package.json"),
      JSON.stringify({ name: "@scope/ui", exports: { "./classNames": "./classNames.js" } }),
    );
    fs.writeFileSync(path.join(real, "classNames.js"), "export const x = 1;\n");
    const entry = write("member/Entry.tsx", `import "@scope/ui/classNames";\nexport const x = 1;\n`);

    const pkgs = scanExternalDeps(entry, member, []);
    expect(pkgs).toContain("@scope/ui/classNames");
    expect(pkgs).not.toContain("@scope/ui");
  });

  it("keeps the bare root name in the collapse decision when the same sibling is also imported bare elsewhere", () => {
    const { workspaceRoot, member } = mkWorkspace();
    const real = linkSibling(workspaceRoot, member, "@scope/ui");
    fs.writeFileSync(
      path.join(real, "package.json"),
      JSON.stringify({ name: "@scope/ui", exports: { "./classNames": "./classNames.js" } }),
    );
    fs.writeFileSync(path.join(real, "classNames.js"), "export const x = 1;\n");
    const entry = write(
      "member/Entry.tsx",
      `import "@scope/ui/classNames";\nimport "@scope/ui";\nexport const x = 1;\n`,
    );

    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, member, [], undefined, warnings);
    // M76's collapse decision keeps the bare name once anything in the graph
    // imports it bare, matching today's behavior — proven here because the
    // bare name has no resolvable root either, so it only reaches M77's/M94's
    // separate, later exclusion check if M76 actually added it.
    // M94: @scope/ui is a workspace sibling (linked via node_modules, not a
    // real install), so the honest "no resolvable source, may still fail at
    // request time" wording applies here, not the type-only claim — this
    // fixture has no src/ directory either, so it falls all the way through
    // to that no-source branch.
    expect(warnings).toContain(UNBUILT_WORKSPACE_PACKAGE_NO_SOURCE_WARNING("@scope/ui", undefined));
    expect(warnings).not.toContain(TYPE_ONLY_PACKAGE_WARNING("@scope/ui"));
    // M77/M94: that bare name has no resolvable root entry or src/, so the
    // later exclusion check removes it from the final list instead of
    // leaving an unresolvable optimizeDeps entry there — the fixes compose
    // without reintroducing calcom-F1's crash.
    expect(pkgs).not.toContain("@scope/ui");
  });

  it("keeps the bare root name for a workspace sibling whose own root does resolve", () => {
    const { workspaceRoot, member } = mkWorkspace();
    const real = linkSibling(workspaceRoot, member, "@scope/ok");
    fs.writeFileSync(
      path.join(real, "package.json"),
      JSON.stringify({ name: "@scope/ok", main: "./index.js" }),
    );
    fs.writeFileSync(path.join(real, "index.js"), "export const x = 1;\n");
    fs.mkdirSync(path.join(real, "sub"), { recursive: true });
    fs.writeFileSync(path.join(real, "sub", "index.js"), "export const y = 1;\n");
    const entry = write("member/Entry.tsx", `import "@scope/ok/sub";\nexport const x = 1;\n`);

    const pkgs = scanExternalDeps(entry, member, []);
    expect(pkgs).toContain("@scope/ok");
    expect(pkgs).not.toContain("@scope/ok/sub");
  });

  it("keeps the bare root name in the collapse decision for a non-workspace-sibling package (real install, not a symlink)", () => {
    const pkgDir = path.join(tmpDir, "node_modules", "no-entry-pkg");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ main: "" }));
    const entry = write("Entry.tsx", `import "no-entry-pkg/subpath";\nexport const x = 1;\n`);

    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, [], undefined, warnings);
    // M76: not a workspace sibling, so the subpath collapses to the bare
    // root exactly as it always has — never substituted.
    expect(pkgs).not.toContain("no-entry-pkg/subpath");
    // This particular fixture's bare root also happens to have no runtime
    // entry (`main: ""`), so M77's separate, later check removes it too.
    expect(warnings).toContain(TYPE_ONLY_PACKAGE_WARNING("no-entry-pkg"));
    expect(pkgs).not.toContain("no-entry-pkg");
  });
});

// M77: a bare specifier that resolves to an installed package with no
// runtime entry is almost certainly type-only. Left in optimizeDeps.include
// it aborts Vite's boot before any per-file transform gets a chance to elide
// the import the way it would without the eager pre-bundle.
describe("type-only package exclusion", () => {
  function mkNoEntryPackage(name: string): void {
    const dir = path.join(tmpDir, "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, main: "" }));
  }

  it("excludes a value-imported package with no runtime entry, and warns", () => {
    mkNoEntryPackage("csstype-like");
    const entry = write("Entry.tsx", `import * as X from "csstype-like";\nexport const x = X;\n`);

    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, [], undefined, warnings);

    expect(pkgs).not.toContain("csstype-like");
    expect(warnings).toEqual([TYPE_ONLY_PACKAGE_WARNING("csstype-like")]);
  });

  it("a whole-clause `import type` never reaches the scanner's specifier collection, so no warning is needed", () => {
    mkNoEntryPackage("csstype-like");
    const entry = write(
      "Entry.tsx",
      `import type { X } from "csstype-like";\nexport const x: X = 1 as unknown as X;\n`,
    );

    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, [], undefined, warnings);

    expect(pkgs).not.toContain("csstype-like");
    expect(warnings).toEqual([]);
  });

  it("a type-only import plus a real value import in the same file still ends up excluded, with the warning", () => {
    mkNoEntryPackage("csstype-like");
    const entry = write(
      "Entry.tsx",
      `import type { X } from "csstype-like";\nimport * as Y from "csstype-like";\nexport const x = Y;\n`,
    );

    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, [], undefined, warnings);

    expect(pkgs).not.toContain("csstype-like");
    expect(warnings).toEqual([TYPE_ONLY_PACKAGE_WARNING("csstype-like")]);
  });

  it("a mixed named-import clause (type + value binding) still scans the specifier", () => {
    const entry = write(
      "Entry.tsx",
      `import { type A, b } from "mixed-clause-pkg";\nexport const x = b;\nexport type { A };\n`,
    );

    expect(scanExternalDeps(entry, tmpDir, [])).toContain("mixed-clause-pkg");
  });

  it("leaves a package alone when it cannot be found on the resolution chain at all (not proven non-loadable)", () => {
    const entry = write("Entry.tsx", `import "nowhere-to-be-found";\nexport const x = 1;\n`);

    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, [], undefined, warnings);

    expect(pkgs).toContain("nowhere-to-be-found");
    expect(warnings).toEqual([]);
  });
});
