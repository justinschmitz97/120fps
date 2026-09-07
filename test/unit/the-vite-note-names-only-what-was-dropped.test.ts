import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectStaticPreBuildWarnings,
  readViteConfigData,
  resetPreBuildDisclosures,
} from "../../src/harness/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-vite-dropped-"));
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "dropped-fixture" }));
  resetPreBuildDisclosures();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetPreBuildDisclosures();
});

function writeConfig(body: string): void {
  fs.writeFileSync(path.join(tmpDir, "vite.config.ts"), body);
}

describe("the resolve.alias clause of the vite-config note", () => {
  it("names the one entry that was dropped when the others were honored", () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    writeConfig(
      [
        "export default defineConfig({",
        "  resolve: {",
        "    alias: {",
        '      "@": "./src",',
        '      "@img": "./assets",',
        "    },",
        "  },",
        "});",
      ].join("\n"),
    );
    const data = readViteConfigData(tmpDir, tmpDir);
    expect(data.aliases).toHaveLength(1);
    expect(data.ignoredKeys.join(" ")).toContain('"@img"');
    expect(data.ignoredKeys).not.toContain("resolve.alias");
  });

  it("names the key itself when no alias entry was honored", () => {
    writeConfig(
      [
        "export default defineConfig({",
        "  resolve: {",
        "    alias: {",
        '      "@img": "./assets",',
        "    },",
        "  },",
        "});",
      ].join("\n"),
    );
    const data = readViteConfigData(tmpDir, tmpDir);
    expect(data.aliases).toHaveLength(0);
    expect(data.ignoredKeys).toContain("resolve.alias");
  });

  it("names no alias at all when every entry resolves", () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    writeConfig(
      [
        "export default defineConfig({",
        "  resolve: {",
        "    alias: {",
        '      "@": "./src",',
        "    },",
        "  },",
        "});",
      ].join("\n"),
    );
    const data = readViteConfigData(tmpDir, tmpDir);
    expect(data.ignoredKeys.join(" ")).not.toContain("resolve.alias");
  });
});

describe("a computed plugins expression in a vite config", () => {
  it("is named by the function the config calls", () => {
    writeConfig(
      [
        'import { setupVitePlugins } from "./build/plugins";',
        "export default defineConfig({",
        "  plugins: setupVitePlugins(viteEnv, enable),",
        "});",
      ].join("\n"),
    );
    const data = readViteConfigData(tmpDir, tmpDir);
    expect(data.ignoredKeys).toContain("plugins");
    expect(data.pluginNames).toEqual(["setupVitePlugins"]);
    const { warnings } = collectStaticPreBuildWarnings(tmpDir, {
      componentPath: path.join(tmpDir, "Card.tsx"),
    });
    const note = warnings.find((w) => w.includes("vite.config.ts declares"));
    expect(note).toContain(
      "vite.config.ts declares plugins the harness cannot honor: setupVitePlugins — " +
        "the project's Vite config is never executed",
    );
  });

  it("is named through an await the config awaits the list behind", () => {
    writeConfig(
      [
        'import { getPluginsList } from "./build/plugins";',
        "export default defineConfig({",
        "  plugins: await getPluginsList(VITE_CDN, VITE_COMPRESSION),",
        "});",
      ].join("\n"),
    );
    expect(readViteConfigData(tmpDir, tmpDir).pluginNames).toEqual(["getPluginsList"]);
  });

  it("stays anonymous for an expression with no callee to name", () => {
    writeConfig(
      [
        'import basePlugins from "./build/plugins";',
        "export default defineConfig({",
        "  plugins: basePlugins,",
        "});",
      ].join("\n"),
    );
    const data = readViteConfigData(tmpDir, tmpDir);
    expect(data.ignoredKeys).toContain("plugins");
    expect(data.pluginNames).toBeUndefined();
  });

  it("keeps naming a spread element positionally", () => {
    writeConfig(
      [
        "export default defineConfig({",
        "  plugins: [...basePlugins],",
        "});",
      ].join("\n"),
    );
    expect(readViteConfigData(tmpDir, tmpDir).pluginNames).toEqual(["unnamed plugin #1"]);
  });
});

describe("the project-level vite-config note across a multi-candidate dry run", () => {
  it("is produced once per project, not once per candidate", () => {
    writeConfig(
      [
        "export default defineConfig({",
        "  plugins: [react()],",
        "});",
      ].join("\n"),
    );
    const noteCount = (): number => {
      const { warnings } = collectStaticPreBuildWarnings(tmpDir, {
        componentPath: path.join(tmpDir, "Card.tsx"),
      });
      return warnings.filter((w) => w.includes("vite.config.ts declares")).length;
    };
    expect(noteCount()).toBe(1);
    expect(noteCount()).toBe(0);
    expect(noteCount()).toBe(0);
  });

  it("starts over for the next run", () => {
    writeConfig(
      [
        "export default defineConfig({",
        "  plugins: [react()],",
        "});",
      ].join("\n"),
    );
    const noteCount = (): number =>
      collectStaticPreBuildWarnings(tmpDir, { componentPath: path.join(tmpDir, "Card.tsx") })
        .warnings.filter((w) => w.includes("vite.config.ts declares")).length;
    expect(noteCount()).toBe(1);
    resetPreBuildDisclosures();
    expect(noteCount()).toBe(1);
  });
});
