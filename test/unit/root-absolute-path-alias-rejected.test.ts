import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadTsconfigAliases, ROOT_ABSOLUTE_ALIAS_WARNING } from "../../src/project/index.js";

const ROOT_SLASH = path.resolve("fixtures/tsconfig-shapes/root-slash-alias");

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkProject(paths: Record<string, string[]>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-rootalias-"));
  cleanupDirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app" }));
  fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths } }));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "x.ts"), "export const x = 1;\n");
  return dir;
}

// react-spectrum's root declares `paths: { "/*": ["./*"] }`. Vite merges user
// aliases ahead of its own client alias, so an alias built from that key
// rewrote `/@vite/client` and the harness entry into the workspace root: two
// 404s and exit 2 before any component rendered.
describe("a path alias that would capture every root-absolute URL", () => {
  it("builds no alias for a key whose non-wildcard prefix is empty", () => {
    const warnings: string[] = [];

    const aliases = loadTsconfigAliases(ROOT_SLASH, warnings);

    expect(aliases.some((a) => a.find.test("/@vite/client"))).toBe(false);
    expect(aliases.some((a) => a.find.test("/@fs/C:/repo/src/x.tsx"))).toBe(false);
    expect(aliases.some((a) => a.find.test("/.120fps-harness-abc123/entry.tsx"))).toBe(false);
  });

  it("keeps every other key in the same config", () => {
    const aliases = loadTsconfigAliases(ROOT_SLASH);
    const entry = aliases.find((a) => a.find.test("@/widget"));

    expect(entry).toBeDefined();
    expect("@/widget".replace(entry!.find, entry!.replacement)).toBe(
      path.join(ROOT_SLASH, "src", "widget").replace(/\\/g, "/"),
    );
  });

  it("reports the key, its target and the config that declared it, once", () => {
    const warnings: string[] = [];

    loadTsconfigAliases(ROOT_SLASH, warnings);

    const configFile = path.join(ROOT_SLASH, "tsconfig.json").replace(/\\/g, "/");
    expect(warnings).toEqual([ROOT_ABSOLUTE_ALIAS_WARNING("/*", "./*", configFile)]);
    expect(warnings[0]).toContain('"/*"');
    expect(warnings[0]).toContain(configFile);
  });

  it("rejects a bare wildcard key the same way", () => {
    const dir = mkProject({ "*": ["./src/*"] });
    const warnings: string[] = [];

    const aliases = loadTsconfigAliases(dir, warnings);

    expect(aliases).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"*"');
  });

  it("keeps a key whose prefix is a real path segment", () => {
    const dir = mkProject({ "/app/*": ["./src/*"] });

    const aliases = loadTsconfigAliases(dir, []);

    expect(aliases.some((a) => a.find.test("/app/x"))).toBe(true);
    expect(aliases.some((a) => a.find.test("/@vite/client"))).toBe(false);
  });
});
