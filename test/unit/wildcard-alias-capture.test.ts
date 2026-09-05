import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { scanExternalDeps } from "../../src/harness/index.js";
import { loadTsconfigAliases, ALIAS_SHAPE_WARNING } from "../../src/project/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkProject(paths: Record<string, string[]>, extraFiles: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-wc-"));
  cleanupDirs.push(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "app" }));
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths } }),
  );
  for (const [rel, content] of Object.entries(extraFiles)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const fwd = (p: string) => p.replace(/\\/g, "/");

// M93: mantine's shape has a trailing wildcard pattern but a mid-path wildcard target.
describe("wildcard capture-group aliases (M93)", () => {
  it("builds a working alias for a mid-path target wildcard", () => {
    const dir = mkProject(
      { "@mantine/*": ["./packages/@mantine/*/src"] },
      { "packages/@mantine/hooks/src/index.ts": "export const useX = 1;" },
    );
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(dir, warnings);
    expect(warnings).toEqual([]);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@mantine/hooks")).toBe(true);
    expect(aliases[0].find.test("other/thing")).toBe(false);
    const replaced = "@mantine/hooks".replace(aliases[0].find, aliases[0].replacement);
    expect(replaced).toBe(`${fwd(dir)}/packages/@mantine/hooks/src`);
  });

  it("builds a working alias for an extension-suffixed target wildcard (material-ui shape)", () => {
    const dir = mkProject(
      { "@mui/icons-material/*": ["./packages/mui-icons-material/lib/*.mjs"] },
      { "packages/mui-icons-material/lib/Add.mjs": "export default 1;" },
    );
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(dir, warnings);
    expect(warnings).toEqual([]);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@mui/icons-material/Add")).toBe(true);
    const replaced = "@mui/icons-material/Add".replace(aliases[0].find, aliases[0].replacement);
    expect(replaced).toBe(`${fwd(dir)}/packages/mui-icons-material/lib/Add.mjs`);
  });

  it("still warns, with an accurate count, when the wildcard counts genuinely differ (pattern has one, target has none)", () => {
    const dir = mkProject({ "@/*": ["./src"] });
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(dir, warnings);
    expect(aliases).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@/*");
    expect(warnings[0]).toContain("./src");
    expect(warnings[0]).toMatch(/1 wildcard/);
    expect(warnings[0]).toMatch(/0/);
  });

  it("still warns when the target has a wildcard and the pattern has none", () => {
    const dir = mkProject({ "@utils": ["./src/*"] });
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(dir, warnings);
    expect(aliases).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("@utils");
    expect(warnings[0]).toContain("./src/*");
  });

  it("keeps building the trailing-both-sides shape exactly as before", () => {
    const dir = mkProject(
      { "@/*": ["./src/*"] },
      { "src/x.ts": "export const x = 1;" },
    );
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(dir, warnings);
    expect(warnings).toEqual([]);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(`${fwd(dir)}/src/`);
  });

  it("ALIAS_SHAPE_WARNING text describes the real mismatch, not a fixed 'one side has a star' claim", () => {
    // This exact call never matches mantine's shape; it isolates a genuine wildcard-count mismatch.
    const text = ALIAS_SHAPE_WARNING("@utils", "./src/*");
    expect(text).not.toMatch(/one side has a "\*" and the other does not/);
  });
});

// M93 MUST NOT: the wildcard alias hides @mantine/hooks from scanExternalDeps's type-only fallback.
describe("wildcard-rescued workspace packages never reach the type-only exclusion (mantine-F3)", () => {
  it("@mantine/hooks resolves locally via the alias and is not added to externalPkgs", () => {
    const dir = mkProject(
      { "@mantine/*": ["./packages/@mantine/*/src"] },
      {
        "packages/@mantine/hooks/src/index.ts": "export const useX = 1;",
        "packages/@mantine/core/src/Tabs.tsx":
          'import { useX } from "@mantine/hooks";\nexport const Tabs = () => null;',
      },
    );
    const aliases = loadTsconfigAliases(dir);
    const warnings: string[] = [];
    const externalDeps = scanExternalDeps(
      path.join(dir, "packages/@mantine/core/src/Tabs.tsx"),
      dir,
      aliases,
      undefined,
      warnings,
    );
    expect(externalDeps).not.toContain("@mantine/hooks");
    expect(warnings.some((w) => w.includes("@mantine/hooks") && w.includes("type-only"))).toBe(
      false,
    );
  });
});
