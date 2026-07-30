// M24 wave-2 hardening: D1 (tsconfig aliases), D2 (export detection),
// D6 (prop-gen tsconfig warnings), D8 (stale harness sweep).
import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadTsconfigAliases,
  detectComponentExport,
  sweepStaleHarnessDirs,
} from "../../src/harness.js";
import { extractProps, extractExports } from "../../src/prop-gen.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-harden-"));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const fwd = (p: string) => p.replace(/\\/g, "/");

describe("H1: extends resolving into node_modules package", () => {
  it("resolves paths declared in a node_modules preset relative to the preset dir", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({ extends: "@acme/tsconfig/base.json" }),
      "node_modules/@acme/tsconfig/base.json": JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
      }),
      "node_modules/@acme/tsconfig/package.json": JSON.stringify({
        name: "@acme/tsconfig",
        version: "1.0.0",
      }),
      "src/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    // TS resolves paths relative to the declaring config (the preset)
    expect(aliases[0].replacement).toBe(
      `${fwd(dir)}/node_modules/@acme/tsconfig/src/`,
    );
  });
});

describe("H2: baseUrl declared in an extended config in a subdir", () => {
  it("uses the baseUrl resolved relative to the declaring config", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({ extends: "./config/base.json" }),
      "config/base.json": JSON.stringify({
        compilerOptions: { baseUrl: "./lib", paths: { "~/*": ["./x/*"] } },
      }),
      "config/lib/x/y.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/config/lib/x/`);
  });
});

describe("H6: no backslashes in alias replacements on Windows", () => {
  it("replacement paths are fully forward-slash normalized", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          paths: { "@/*": ["./src/*"], "#one": ["./src/one.ts"] },
        },
      }),
      "src/one.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(2);
    for (const alias of aliases) {
      expect(alias.replacement.includes("\\")).toBe(false);
    }
  });
});

describe("H7: two-level extends chain", () => {
  it("resolves paths declared two levels up the chain", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({ extends: "./mid.json" }),
      "mid.json": JSON.stringify({ extends: "./deep/base.json" }),
      "deep/base.json": JSON.stringify({
        compilerOptions: { paths: { "@/*": ["../src/*"] } },
      }),
      "src/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/`);
  });
});

describe("H8: circular extends", () => {
  it("does not throw or hang; aliases still produced", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        extends: "./other.json",
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
      }),
      "other.json": JSON.stringify({ extends: "./tsconfig.json" }),
      "src/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/`);
  });
});

describe("H9: sweep swallows rmSync failures", () => {
  it("does not throw when a stale dir cannot be removed", () => {
    const root = mkProject({});
    const old = path.join(root, ".120fps-harness-locked");
    fs.mkdirSync(old);
    const then = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(old, then, then);

    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("EBUSY: resource busy");
    });
    expect(() => sweepStaleHarnessDirs(root)).not.toThrow();
    rmSpy.mockRestore();
    expect(fs.existsSync(old)).toBe(true);
  });
});

describe("H10: type-annotated const export with stem match", () => {
  it("detects export const Button: React.FC<...> = ...", () => {
    const dir = mkProject({
      "badge.tsx": `import type React from "react";
export const helper = () => 1;
export const Badge: React.FC<{ label: string }> = () => null;`,
    });
    expect(detectComponentExport(path.join(dir, "badge.tsx"))).toEqual({
      name: "Badge",
      isDefaultOnly: false,
    });
  });
});

describe("H11: export default memo(X) call expression", () => {
  it("falls back to filename with a working default import", () => {
    const dir = mkProject({
      "fancy.tsx": `import { memo } from "react";
const Widget = () => null;
export default memo(Widget);`,
    });
    // Call expressions are not identifier assignments; the module still has
    // a default export, so the filename fallback with isDefaultOnly: true
    // generates a valid default import.
    expect(detectComponentExport(path.join(dir, "fancy.tsx"))).toEqual({
      name: "Fancy",
      isDefaultOnly: true,
    });
  });
});

describe("H12: distinct malformed tsconfigs each warn once", () => {
  it("emits one warning per config path", async () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const dirA = mkProject({
      "tsconfig.json": `{ broken `,
      "comp.tsx": `export function Comp(props: { a: string }) { return null; }`,
    });
    const dirB = mkProject({
      "tsconfig.json": `also not json`,
      "comp.tsx": `export function Comp(props: { b: string }) { return null; }`,
    });

    await extractProps(path.join(dirA, "comp.tsx"));
    await extractProps(path.join(dirA, "comp.tsx"));
    await extractProps(path.join(dirB, "comp.tsx"));

    const warnings = write.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes("tsconfig"));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).not.toBe(warnings[1]);
  });
});

describe("H13: tsconfig with BOM", () => {
  it("parses a BOM-prefixed tsconfig", () => {
    const dir = mkProject({
      "tsconfig.json":
        "﻿" +
        JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "src/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/`);
  });
});

describe("H14: extractExports on a missing file", () => {
  it("returns [] instead of throwing", async () => {
    const missing = path.join(os.tmpdir(), "120fps-nope", "gone.tsx");
    await expect(extractExports(missing)).resolves.toEqual([]);
  });
});

describe("H15: sweep age boundary", () => {
  it("keeps a harness dir younger than one hour", () => {
    const root = mkProject({});
    const young = path.join(root, ".120fps-harness-young");
    fs.mkdirSync(young);
    const then = new Date(Date.now() - 30 * 60 * 1000);
    fs.utimesSync(young, then, then);

    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(young)).toBe(true);
  });
});
