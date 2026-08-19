import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanExternalDeps, BROKEN_ALIAS_WARNING } from "../../src/harness.js";

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
const srcAlias = () => [{ find: /^@\//, replacement: `${fwd(tmpDir)}/src/` }];

// A stale alias used to be indistinguishable from a bare npm import, so the
// harness asked Vite to pre-bundle "@/gone" as if a package by that name
// existed.
describe("an alias that matches but points nowhere", () => {
  it("warns instead of registering the specifier as a package", () => {
    const entry = write("Entry.tsx", `import { gone } from "@/gone";\nexport default gone;\n`);

    const specs = new Set<string>();
    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, srcAlias(), specs, warnings);

    expect(pkgs).toEqual([]);
    expect(specs.size).toBe(0);
    expect(warnings).toEqual([BROKEN_ALIAS_WARNING("@/gone", `${fwd(tmpDir)}/src/gone`)]);
  });

  it("names the specifier and the missing target", () => {
    const message = BROKEN_ALIAS_WARNING("@/gone", "/project/src/gone");
    expect(message).toContain("@/gone");
    expect(message).toContain("/project/src/gone");
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
    expect(warnings).toEqual([]);
  });

  it("says nothing about a relative import that resolves to nothing", () => {
    const entry = write("Entry.tsx", `import { x } from "./missing";\nexport default x;\n`);

    const warnings: string[] = [];
    const pkgs = scanExternalDeps(entry, tmpDir, srcAlias(), undefined, warnings);

    expect(pkgs).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
