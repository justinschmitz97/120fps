import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadTsconfigAliases } from "../../src/harness.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-tsconf-"));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const fwd = (p: string) => p.replace(/\\/g, "/");

describe("loadTsconfigAliases", () => {
  it("resolves plain paths without baseUrl relative to the config dir", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
      }),
      "src/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@/components/Button")).toBe(true);
    expect(aliases[0].find.test("other/thing")).toBe(false);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/`);
  });

  it("tolerates JSONC comments and trailing commas", () => {
    const dir = mkProject({
      "tsconfig.json": `{
  // line comment
  "compilerOptions": {
    /* block comment */
    "paths": {
      "@/*": ["./src/*"],
    },
  },
}`,
      "src/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/`);
  });

  it("resolves paths declared in an extends chain relative to the declaring config", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({ extends: "./config/base.json" }),
      "config/base.json": JSON.stringify({
        compilerOptions: { paths: { "@/*": ["../src/*"] } },
      }),
      "src/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    // ../src relative to config/ → <root>/src
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/`);
  });

  it("resolves extends given as an array", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({ extends: ["./a.json", "./b.json"] }),
      "a.json": JSON.stringify({
        compilerOptions: { paths: { "@a/*": ["./liba/*"] } },
      }),
      "b.json": JSON.stringify({ compilerOptions: { target: "es2020" } }),
      "liba/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@a/thing")).toBe(true);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/liba/`);
  });

  it("uses resolved baseUrl as the alias base when set", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: "./app", paths: { "~/*": ["lib/*"] } },
      }),
      "app/lib/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/app/lib/`);
  });

  it("returns [] when there is no tsconfig.json", () => {
    const dir = mkProject({ "src/x.ts": "export const x = 1;" });
    expect(loadTsconfigAliases(dir)).toEqual([]);
  });

  it("returns [] plus one stderr warning for malformed tsconfig", () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const dir = mkProject({
      "tsconfig.json": `{ "compilerOptions": { "paths": { `,
    });
    expect(loadTsconfigAliases(dir)).toEqual([]);
    const warnings = write.mock.calls.filter((c) =>
      String(c[0]).includes("tsconfig"),
    );
    expect(warnings).toHaveLength(1);
  });

  it("uses only the first target for multi-target paths", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          paths: { "multi/*": ["./first/*", "./second/*"] },
        },
      }),
      "first/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/first/`);
  });

  it("supports exact (non-wildcard) aliases", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "#utils": ["./src/utils/index.ts"] } },
      }),
      "src/utils/index.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("#utils")).toBe(true);
    expect(aliases[0].find.test("#utils/deep")).toBe(false);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/utils/index.ts`);
  });

  it("returns [] when paths is absent", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "src/x.ts": "export const x = 1;",
    });
    expect(loadTsconfigAliases(dir)).toEqual([]);
  });

  it("escapes regex metacharacters in alias patterns", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "$lib/*": ["./src/lib/*"] } },
      }),
      "src/lib/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("$lib/thing")).toBe(true);
    expect(aliases[0].find.test("xlib/thing")).toBe(false);
  });

  it("skips paths entries with an empty target list", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { paths: { "@empty/*": [], "@ok/*": ["./ok/*"] } },
      }),
      "ok/x.ts": "export const x = 1;",
    });
    const aliases = loadTsconfigAliases(dir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@ok/x")).toBe(true);
  });
});
