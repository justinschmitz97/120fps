import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanExternalDeps, BROKEN_ALIAS_WARNING } from "../../src/harness/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-alias-miss-"));
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
const srcAlias = () => [
  { find: /^@\//, replacement: `${fwd(tmpDir)}/src/`, pattern: "@/*", target: "./src/*" },
];

// A stale alias must not be mistaken for a bare import; Vite would pre-bundle "@/gone" as a pkg.
describe("an alias that matches but points nowhere", () => {
  it("warns instead of registering the specifier as a package", () => {
    const entry = write("Entry.tsx", `import { gone } from "@/gone";\nexport default gone;\n`);

    const specs = new Set<string>();
    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, srcAlias(), specs, warnings);

    expect(pkgs).toEqual([]);
    expect(specs.size).toBe(0);
    expect(warnings).toEqual([
      BROKEN_ALIAS_WARNING("@/*", `${fwd(tmpDir)}/src/`, ["@/gone"], 1),
    ]);
  });

  it("names the alias, its target root and the specifier", () => {
    const message = BROKEN_ALIAS_WARNING("@/*", "/project/src/", ["@/gone"], 1);
    expect(message).toContain("@/*");
    expect(message).toContain("/project/src/");
    expect(message).toContain("@/gone");
  });

  it("shows three examples and counts the rest when one alias matched many", () => {
    const examples = ["@/gone0", "@/gone1", "@/gone2"];
    const message = BROKEN_ALIAS_WARNING("@/*", "/project/src/", examples, 40);

    expect(message).toContain("@/gone0, @/gone1, @/gone2");
    expect(message).toContain("and 37 more");
    expect(message).not.toContain("@/gone3");
  });

  it("reports one line per alias pattern, not one per specifier", () => {
    const imports = Array.from(
      { length: 40 },
      (_unused, index) => `import "@/gone${index}";`,
    ).join("\n");
    const entry = write("Entry.tsx", `${imports}\nexport const entry = 1;\n`);

    const warnings: string[] = [];
    scanExternalDeps(entry, tmpDir, srcAlias(), undefined, warnings);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@/*");
    expect(warnings[0]).toContain("and 37 more");
  });

  it("falls back to the alias's own pattern text when the alias declares none", () => {
    const entry = write("Entry.tsx", `import "@/gone";\nexport const entry = 1;\n`);
    const alias = [{ find: /^@\//, replacement: `${fwd(tmpDir)}/src/` }];

    const warnings: string[] = [];
    scanExternalDeps(entry, tmpDir, alias, undefined, warnings);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@/gone");
  });

  it("reports one warning per broken specifier, not one per occurrence", () => {
    write("Helper.tsx", `import "@/gone";\nexport const helper = 1;\n`);
    const entry = write(
      "Entry.tsx",
      `import "./Helper";\nimport "@/gone";\nexport const entry = 1;\n`,
    );

    const warnings: string[] = [];
    scanExternalDeps(entry, tmpDir, srcAlias(), undefined, warnings);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("more");
  });

  it("still records a shim specifier when the shim file is missing", () => {
    const entry = write("Entry.tsx", `import Image from "next/image";\nexport default Image;\n`);
    const alias = [
      { find: /^next\/image$/, replacement: `${fwd(tmpDir)}/shims/next-image.js`, isShim: true },
    ];

    const specs = new Set<string>();
    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, alias, specs, warnings);

    expect(specs.has("next/image")).toBe(true);
    expect(pkgs).not.toContain("next");
    expect(warnings).toEqual([]);
  });

  it("leaves an unaliased bare specifier registered as a package", () => {
    const entry = write("Entry.tsx", `import clsx from "clsx";\nexport default clsx;\n`);

    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, srcAlias(), undefined, warnings);

    expect(pkgs).toEqual(["clsx"]);
    // The unresolvable entry gets its own warning; no alias warning is due.
    expect(warnings.filter((w) => !w.includes("resolves to no installed package"))).toEqual([]);
  });

  it("says nothing about a relative import that resolves to nothing", () => {
    const entry = write("Entry.tsx", `import { x } from "./missing";\nexport default x;\n`);

    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, srcAlias(), undefined, warnings);

    expect(pkgs).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
