import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadTsconfigAliases, TSCONFIG_EXTENDS_BROKEN_WARNING } from "../../src/project/index.js";
import { explainProps } from "../../src/pipeline/index.js";

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-tsconf-extends-"));
  cleanupDirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const fwd = (p: string) => p.replace(/\\/g, "/");

// M95: .nuxt/tsconfig.json (from nuxi prepare) is absent pre-build; its diagnostic must surface.
describe("loadTsconfigAliases: broken tsconfig extends chain (M95)", () => {
  it("warns naming the config file and the missing extends target", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({ extends: "./.nuxt/tsconfig.json" }),
      "src/x.ts": "export const x = 1;",
    });
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(dir, warnings);
    expect(aliases).toEqual([]);
    expect(warnings.some((w) => w.includes(fwd(dir)) && w.includes(".nuxt/tsconfig.json"))).toBe(
      true,
    );
  });

  it("still resolves paths declared directly in the config, alongside the broken-extends warning", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({
        extends: "./.nuxt/tsconfig.json",
        compilerOptions: { paths: { "@/*": ["./src/*"] } },
      }),
      "src/x.ts": "export const x = 1;",
    });
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(dir, warnings);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].find.test("@/thing")).toBe(true);
    expect(warnings.some((w) => w.includes(".nuxt/tsconfig.json"))).toBe(true);
  });

  it("produces no warning and no change for a config whose extends chain fully resolves", () => {
    const dir = mkProject({
      "tsconfig.json": JSON.stringify({ extends: "./base.json" }),
      "base.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
      "src/x.ts": "export const x = 1;",
    });
    const warnings: string[] = [];
    const aliases = loadTsconfigAliases(dir, warnings);
    expect(aliases).toHaveLength(1);
    expect(warnings).toEqual([]);
  });

  it("attributes a broken workspace-root extends chain to the root config file, independent of the member layer", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-tsconf-extends-ws-"));
    cleanupDirs.push(root);
    fs.writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - member\n");
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ extends: "./.generated/tsconfig.json" }),
    );
    const member = path.join(root, "member");
    fs.mkdirSync(member, { recursive: true });
    fs.writeFileSync(path.join(member, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));

    const warnings: string[] = [];
    loadTsconfigAliases(member, warnings);
    expect(
      warnings.some((w) => w.includes(fwd(root)) && w.includes(".generated/tsconfig.json")),
    ).toBe(true);
  });

  it("names both halves in TSCONFIG_EXTENDS_BROKEN_WARNING directly", () => {
    const text = TSCONFIG_EXTENDS_BROKEN_WARNING("/repo/tsconfig.json", "File '/repo/.nuxt/tsconfig.json' not found.");
    expect(text).toContain("/repo/tsconfig.json");
    expect(text).toContain(".nuxt/tsconfig.json");
  });
});

// M92/M95: dry-run --explain-props skipped loadTsconfigAliases, hiding the full-run warning.
describe("explainProps names a broken tsconfig extends chain (M92, nuxt-ui-F2)", () => {
  it("includes TSCONFIG_EXTENDS_BROKEN_WARNING when the component reports 0 props under a broken extends chain", async () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "broken-extends-app" }),
      "tsconfig.json": JSON.stringify({ extends: "./.nuxt/tsconfig.json" }),
      // react-dom/client must resolve; a stub node_modules file satisfies createRequire.resolve.
      "node_modules/react-dom/client.js": "module.exports = {};",
      // Untyped genuinely has 0 props, decoupled from Lane B's own type-resolution behavior.
      "src/Untyped.jsx": "export default function Untyped(props) { return null; }",
    });
    const explained = await explainProps(path.join(dir, "src/Untyped.jsx"));
    expect(explained.props).toEqual([]);
    const broken = explained.warnings.filter(
      (w) => w.includes(fwd(dir)) && w.includes(".nuxt/tsconfig.json"),
    );
    expect(broken).toHaveLength(1);
  });

  // M100: collectStaticPreBuildWarnings already runs loadTsconfigAliases; must not double-report.
  it("names the broken chain once, not once per probe that reads the tsconfig", async () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "broken-extends-once" }),
      "tsconfig.json": JSON.stringify({ extends: "./.nuxt/tsconfig.json" }),
      "node_modules/react-dom/client.js": "module.exports = {};",
      "src/Untyped.jsx": "export default function Untyped(props) { return null; }",
    });
    const explained = await explainProps(path.join(dir, "src/Untyped.jsx"));
    const seen = new Map<string, number>();
    for (const w of explained.warnings) seen.set(w, (seen.get(w) ?? 0) + 1);
    expect([...seen.entries()].filter(([, n]) => n > 1)).toEqual([]);
  });

  it("does not fire when the extends chain fully resolves", async () => {
    const dir = mkProject({
      "package.json": JSON.stringify({ name: "healthy-extends-app" }),
      "tsconfig.json": JSON.stringify({ extends: "./base.json" }),
      "base.json": JSON.stringify({ compilerOptions: {} }),
      "node_modules/react-dom/client.js": "module.exports = {};",
      "src/Untyped.jsx": "export default function Untyped(props) { return null; }",
    });
    const explained = await explainProps(path.join(dir, "src/Untyped.jsx"));
    expect(explained.props).toEqual([]);
    expect(explained.warnings.some((w) => w.includes("tsconfig.json"))).toBe(false);
  });
});
