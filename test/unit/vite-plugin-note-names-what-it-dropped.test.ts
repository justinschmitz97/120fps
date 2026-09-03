import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  VITE_CONFIG_IGNORED_WARNING,
  readViteConfigData,
  collectStaticPreBuildWarnings,
} from "../../src/harness.js";

// M117 A3 (I10, dx-audit item 6): the note said `plugins` and named none of
// them, so a reader could not tell whether the harness dropped anything that
// mattered. The names come from the config's own text, in the config's order.

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-vite-plugins-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeConfig(body: string, name = "vite.config.ts"): string {
  const full = path.join(tmpDir, name);
  fs.writeFileSync(full, body);
  return full;
}

describe("the plugin names a vite.config declares", () => {
  it("names call-expression plugins by their callee, in config order", () => {
    // The shape /e/repositories-run5/ark/packages/react/vite.config.mts uses.
    writeConfig(
      [
        "export default defineConfig({",
        "  plugins: [",
        "    dts({ entryRoot: 'src' }),",
        "    react(),",
        "  ],",
        "});",
      ].join("\n"),
    );
    expect(readViteConfigData(tmpDir).pluginNames).toEqual(["dts", "react"]);
  });

  // M117 review: getText() returns the raw source slice, so a callee broken
  // across lines put a newline inside a note that must stay one line.
  it("keeps a callee written across lines on one line", () => {
    writeConfig(
      [
        "export default {",
        "  plugins: [",
        "    plugin",
        "      .default(),",
        "  ],",
        "};",
      ].join("\n"),
    );
    expect(readViteConfigData(tmpDir).pluginNames).toEqual(["plugin.default"]);
  });

  it("names an inline object plugin by its name property", () => {
    const data = readViteConfigData(path.resolve("fixtures/vite-config-project"));
    expect(data.pluginNames).toEqual(["hostile-transform"]);
  });

  it("names anything else by its position in the array", () => {
    writeConfig(
      [
        "export default {",
        "  plugins: [react(), legacyPlugin, isProd && analyzer()],",
        "};",
      ].join("\n"),
    );
    expect(readViteConfigData(tmpDir).pluginNames).toEqual([
      "react",
      "unnamed plugin #2",
      "unnamed plugin #3",
    ]);
  });

  it("records no plugin names for an empty plugins array", () => {
    writeConfig("export default { plugins: [] };");
    const data = readViteConfigData(tmpDir);
    expect(data.pluginNames).toBeUndefined();
    expect(data.ignoredKeys).toEqual([]);
  });

  it("records no plugin names for a config that declares no plugins", () => {
    writeConfig("export default { root: '.', server: { port: 3000 } };");
    expect(readViteConfigData(tmpDir).pluginNames).toBeUndefined();
  });
});

describe("the note the harness prints for the plugins it dropped", () => {
  it("names every dropped plugin in config order", () => {
    expect(
      VITE_CONFIG_IGNORED_WARNING("vite.config.ts", ["plugins"], [
        "tanstackRouter",
        "react",
        "tailwindcss",
      ]),
    ).toBe(
      "vite.config.ts declares plugins the harness cannot honor: tanstackRouter, react, " +
        "tailwindcss — the project's Vite config is never executed",
    );
  });

  it("keeps the other ignored keys and the preprocessor-globals clause", () => {
    const warning = VITE_CONFIG_IGNORED_WARNING(
      "vite.config.js",
      ["resolve.alias", "css.preprocessorOptions", "plugins"],
      ["sass", "vue"],
    );
    expect(warning).toContain(
      "vite.config.js declares resolve.alias, css.preprocessorOptions and plugins the harness " +
        "cannot honor: sass, vue — the project's Vite config is never executed",
    );
    expect(warning).toContain("preprocessor globals (additionalData) are not replicated");
  });

  it("keeps the key-only wording for a config with no plugins key", () => {
    expect(VITE_CONFIG_IGNORED_WARNING("vite.config.ts", ["resolve.alias"])).toBe(
      "vite.config.ts declares resolve.alias, which the harness read but cannot honor: the " +
        "project's Vite config is never executed",
    );
  });
});

describe("the note a real run produces", () => {
  it("names the plugin the fixture's config declares", () => {
    const project = path.resolve("fixtures/vite-config-project");
    const pre = collectStaticPreBuildWarnings(project, {
      componentPath: path.join(project, "src", "widget.tsx"),
    });
    const note = pre.warnings.find((w) => w.startsWith("vite.config.ts"));
    expect(note).toBe(
      "vite.config.ts declares plugins the harness cannot honor: hostile-transform — the " +
        "project's Vite config is never executed",
    );
  });
});
