import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanExternalDeps } from "../../src/harness.js";

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
