import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadTsconfigAliases, ALIAS_SHAPE_WARNING } from "../../src/harness.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkProject(paths: Record<string, string[]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-shape-"));
  cleanupDirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app" }));
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths } }),
  );
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "x.ts"), "export const x = 1;\n");
  return dir;
}

// A pattern whose wildcard shape does not match its target used to produce a
// regex that could never match any specifier, so the alias was silently absent.
describe("wildcard shape mismatch in tsconfig paths", () => {
  it("emits no alias and one warning when the pattern has a wildcard and the target has none", () => {
    const dir = mkProject({ "@/*": ["./src"] });
    const warnings: string[] = [];

    const aliases = loadTsconfigAliases(dir, warnings);

    expect(aliases).toEqual([]);
    expect(warnings).toEqual([ALIAS_SHAPE_WARNING("@/*", "./src")]);
  });

  it("emits no alias and one warning when the target has a wildcard and the pattern has none", () => {
    const dir = mkProject({ "@utils": ["./src/*"] });
    const warnings: string[] = [];

    const aliases = loadTsconfigAliases(dir, warnings);

    expect(aliases).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@utils");
    expect(warnings[0]).toContain("./src/*");
  });

  it("warns about a wildcard that is not a trailing path segment", () => {
    const dir = mkProject({ "@*": ["./src/*"] });
    const warnings: string[] = [];

    expect(loadTsconfigAliases(dir, warnings)).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  it("keeps the sound entries of a config that also has a broken one", () => {
    const dir = mkProject({ "@/*": ["./src/*"], "#broken/*": ["./src"] });
    const warnings: string[] = [];

    const aliases = loadTsconfigAliases(dir, warnings);

    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@/x")).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it("says nothing about matching wildcard shapes or exact aliases", () => {
    const dir = mkProject({ "@/*": ["./src/*"], "#utils": ["./src/x.ts"] });
    const warnings: string[] = [];

    expect(loadTsconfigAliases(dir, warnings)).toHaveLength(2);
    expect(warnings).toEqual([]);
  });

  it("collects nothing and throws nothing when no warning sink is passed", () => {
    const dir = mkProject({ "@/*": ["./src"] });
    expect(loadTsconfigAliases(dir)).toEqual([]);
  });

  it("names both halves of the broken entry", () => {
    expect(ALIAS_SHAPE_WARNING("@/*", "./src")).toContain("@/*");
    expect(ALIAS_SHAPE_WARNING("@/*", "./src")).toContain("./src");
  });
});
