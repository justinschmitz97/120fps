import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VITE_CONFIG_IGNORED_WARNING, readViteConfigData } from "../../src/harness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-vite-config-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(body: string, name = "vite.config.ts"): string {
  const full = path.join(tmpDir, name);
  fs.writeFileSync(full, body);
  return full;
}

function mkdir(relative: string): string {
  const full = path.join(tmpDir, relative);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

describe("reading a project's vite.config without executing it", () => {
  it("reports nothing for a project with no config file", () => {
    expect(readViteConfigData(tmpDir)).toEqual({ aliases: [], ignoredKeys: [] });
  });

  it("names the config file it read", () => {
    const file = writeConfig("export default { root: '.' };");
    expect(readViteConfigData(tmpDir).configFile).toBe(file);
  });

  it("prefers vite.config.ts over vite.config.js", () => {
    writeConfig("export default {};", "vite.config.js");
    const ts = writeConfig("export default {};", "vite.config.ts");
    expect(readViteConfigData(tmpDir).configFile).toBe(ts);
  });
});

describe("recovering publicDir from the config text", () => {
  it("resolves a literal publicDir that exists", () => {
    const dir = mkdir("static");
    writeConfig("import { defineConfig } from 'vite';\nexport default defineConfig({ publicDir: 'static' });");
    expect(readViteConfigData(tmpDir).publicDir).toBe(dir);
  });

  it("reads publicDir from a plain default-exported object", () => {
    const dir = mkdir("assets");
    writeConfig("export default { publicDir: './assets' };");
    expect(readViteConfigData(tmpDir).publicDir).toBe(dir);
  });

  it("reads publicDir from a config factory", () => {
    const dir = mkdir("static");
    writeConfig("export default defineConfig(({ mode }) => ({ publicDir: 'static' }));");
    expect(readViteConfigData(tmpDir).publicDir).toBe(dir);
  });

  it("reads publicDir from a factory with a return statement", () => {
    const dir = mkdir("static");
    writeConfig("export default defineConfig(() => { return { publicDir: 'static' }; });");
    expect(readViteConfigData(tmpDir).publicDir).toBe(dir);
  });

  it("reads publicDir from a commonjs config", () => {
    const dir = mkdir("static");
    writeConfig("module.exports = { publicDir: 'static' };", "vite.config.js");
    expect(readViteConfigData(tmpDir).publicDir).toBe(dir);
  });

  it("ignores a publicDir naming a directory that does not exist", () => {
    writeConfig("export default { publicDir: 'gone' };");
    expect(readViteConfigData(tmpDir).publicDir).toBeUndefined();
  });

  it("treats a computed publicDir as an ignored key", () => {
    writeConfig("export default { publicDir: resolve(__dirname, 'static') };");
    const data = readViteConfigData(tmpDir);
    expect(data.publicDir).toBeUndefined();
    expect(data.ignoredKeys).toContain("publicDir");
  });

  it("ignores a publicDir declared by a plugin's own options", () => {
    mkdir("static");
    writeConfig("export default { plugins: [copy({ publicDir: 'static' })] };");
    expect(readViteConfigData(tmpDir).publicDir).toBeUndefined();
  });
});

describe("recovering literal resolve.alias entries", () => {
  it("builds one alias per literal entry", () => {
    mkdir("src");
    writeConfig("export default { resolve: { alias: { '@': './src' } } };");
    const { aliases, ignoredKeys } = readViteConfigData(tmpDir);
    expect(aliases).toHaveLength(1);
    expect(aliases[0].replacement).toBe(path.join(tmpDir, "src").replace(/\\/g, "/"));
    expect(ignoredKeys).toEqual([]);
  });

  it("matches a whole leading segment only", () => {
    mkdir("src");
    writeConfig("export default { resolve: { alias: { '@': './src' } } };");
    const [alias] = readViteConfigData(tmpDir).aliases;
    expect(alias.find.test("@/Button")).toBe(true);
    expect(alias.find.test("@")).toBe(true);
    expect(alias.find.test("@scope/pkg")).toBe(false);
  });

  it("drops an alias whose target does not exist", () => {
    writeConfig("export default { resolve: { alias: { '@': './gone' } } };");
    const { aliases, ignoredKeys } = readViteConfigData(tmpDir);
    expect(aliases).toEqual([]);
    expect(ignoredKeys).toContain("resolve.alias");
  });

  it("treats a computed alias target as an ignored key", () => {
    writeConfig(
      "export default { resolve: { alias: { '@': path.resolve(__dirname, 'src') } } };",
    );
    const { aliases, ignoredKeys } = readViteConfigData(tmpDir);
    expect(aliases).toEqual([]);
    expect(ignoredKeys).toContain("resolve.alias");
  });

  it("treats an array-shaped alias as an ignored key", () => {
    writeConfig("export default { resolve: { alias: [{ find: '@', replacement: './src' }] } };");
    const { aliases, ignoredKeys } = readViteConfigData(tmpDir);
    expect(aliases).toEqual([]);
    expect(ignoredKeys).toContain("resolve.alias");
  });
});

describe("naming the config data the harness cannot honor", () => {
  it("reports preprocessor options and plugins", () => {
    writeConfig(
      [
        "export default defineConfig({",
        "  plugins: [react()],",
        "  css: { preprocessorOptions: { scss: { additionalData: '@use \"vars\";' } } },",
        "});",
      ].join("\n"),
    );
    expect(readViteConfigData(tmpDir).ignoredKeys).toEqual(["css.preprocessorOptions", "plugins"]);
  });

  it("reports nothing for an empty plugin list", () => {
    writeConfig("export default { plugins: [] };");
    expect(readViteConfigData(tmpDir).ignoredKeys).toEqual([]);
  });

  it("reports a config whose shape could not be read", () => {
    writeConfig("export default buildConfig(process.env.MODE);");
    expect(readViteConfigData(tmpDir).ignoredKeys).toEqual(["a computed config object"]);
  });

  it("reports nothing for a config that is only a root and a server block", () => {
    writeConfig("export default { root: '.', server: { port: 3000 } };");
    expect(readViteConfigData(tmpDir).ignoredKeys).toEqual([]);
  });

  it("survives a config file with a syntax error", () => {
    writeConfig("export default { plugins: [react()],,, };");
    expect(() => readViteConfigData(tmpDir)).not.toThrow();
  });
});

describe("the ignored-config warning", () => {
  it("names the file and every key it found", () => {
    const warning = VITE_CONFIG_IGNORED_WARNING("vite.config.ts", ["resolve.alias", "plugins"]);
    expect(warning).toContain("vite.config.ts");
    expect(warning).toContain("resolve.alias");
    expect(warning).toContain("plugins");
  });

  it("explains that preprocessor globals are not replicated", () => {
    const warning = VITE_CONFIG_IGNORED_WARNING("vite.config.ts", ["css.preprocessorOptions"]);
    expect(warning).toMatch(/additionalData|preprocessor/i);
  });
});
