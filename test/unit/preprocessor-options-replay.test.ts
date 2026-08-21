import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readViteConfigData, VITE_CONFIG_PREPROCESSOR_OPTION_WARNING } from "../../src/harness.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-pre-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "twenty-ui" }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function config(body: string): void {
  fs.writeFileSync(path.join(root, "vite.config.ts"), body);
}

// twenty declares its sass globals as a joined array of @use lines plus a
// loadPaths entry; none of it reached the harness, so every component that used
// one of those mixins failed the transform with `Undefined mixin`.
const TWENTY = `import { defineConfig } from 'vite';
export default defineConfig({
  css: {
    preprocessorOptions: {
      scss: {
        api: 'modern-compiler',
        loadPaths: [path.resolve(__dirname, 'src/styles')],
        additionalData: [
          "@use 'abstracts/functions' as *;",
          "@use 'abstracts/mixins' as *;",
          '',
        ].join('\\n'),
      },
    },
  },
});
`;

describe("preprocessor globals a text read can prove", () => {
  it("folds a joined array of @use lines and resolves an existing loadPath", () => {
    fs.mkdirSync(path.join(root, "src", "styles"), { recursive: true });
    config(TWENTY);
    const data = readViteConfigData(root);
    expect(data.preprocessorOptions?.scss?.additionalData).toBe(
      "@use 'abstracts/functions' as *;\n@use 'abstracts/mixins' as *;\n",
    );
    expect(data.preprocessorOptions?.scss?.loadPaths).toEqual([path.resolve(root, "src", "styles")]);
  });

  it("names the option it cannot honor instead of dropping the whole block", () => {
    fs.mkdirSync(path.join(root, "src", "styles"), { recursive: true });
    config(TWENTY);
    const data = readViteConfigData(root);
    expect(data.warnings).toContain(
      VITE_CONFIG_PREPROCESSOR_OPTION_WARNING("vite.config.ts", ["css.preprocessorOptions.scss.api"]),
    );
    expect(data.ignoredKeys).not.toContain("css.preprocessorOptions");
  });

  it("drops a loadPath that does not exist", () => {
    config(TWENTY);
    expect(readViteConfigData(root).preprocessorOptions?.scss?.loadPaths).toBeUndefined();
  });

  it("folds a plain string and a substitution-free template", () => {
    config(`export default { css: { preprocessorOptions: { scss: { additionalData: '@use "a";' }, less: { additionalData: \`@x: 1;\` } } } };`);
    const data = readViteConfigData(root);
    expect(data.preprocessorOptions?.scss?.additionalData).toBe('@use "a";');
    expect(data.preprocessorOptions?.less?.additionalData).toBe("@x: 1;");
  });

  it("folds a + concatenation", () => {
    config(`export default { css: { preprocessorOptions: { scss: { additionalData: '@use "a";' + '\\n' + '@use "b";' } } } };`);
    expect(readViteConfigData(root).preprocessorOptions?.scss?.additionalData).toBe(
      '@use "a";\n@use "b";',
    );
  });

  it("keeps the existing disclosure for an additionalData it cannot fold", () => {
    config(`export default { css: { preprocessorOptions: { scss: { additionalData: (source) => source } } } };`);
    const data = readViteConfigData(root);
    expect(data.ignoredKeys).toContain("css.preprocessorOptions");
    expect(data.preprocessorOptions).toBeUndefined();
  });

  // One language's unfoldable additionalData used to set the blanket ignored
  // key, whose text says preprocessor globals "are not replicated" — false for
  // the run that replays another language's globals and this one's loadPaths.
  it("names the language and option it dropped instead of the whole block", () => {
    fs.mkdirSync(path.join(root, "src", "styles"), { recursive: true });
    config(
      "export default { css: { preprocessorOptions: { " +
        "scss: { additionalData: (source) => source, loadPaths: [path.resolve(__dirname, 'src/styles')] }, " +
        "less: { additionalData: '@x: 1;' } } } };",
    );
    const data = readViteConfigData(root);
    expect(data.preprocessorOptions?.less?.additionalData).toBe("@x: 1;");
    expect(data.preprocessorOptions?.scss?.loadPaths).toEqual([path.resolve(root, "src", "styles")]);
    expect(data.ignoredKeys).not.toContain("css.preprocessorOptions");
    const named = data.warnings.find((w) => w.includes("additionalData"));
    expect(named).toContain("css.preprocessorOptions.scss.additionalData (function)");
  });

  it("keeps the blanket disclosure when nothing under it folded at all", () => {
    config("export default { css: { preprocessorOptions: { scss: { additionalData: someGlobal } } } };");
    const data = readViteConfigData(root);
    expect(data.ignoredKeys).toContain("css.preprocessorOptions");
    expect(data.preprocessorOptions).toBeUndefined();
  });

  it("reports nothing for a config with no preprocessor options at all", () => {
    config(`export default { css: { modules: { localsConvention: 'camelCaseOnly' } } };`);
    const data = readViteConfigData(root);
    expect(data.preprocessorOptions).toBeUndefined();
    expect(data.ignoredKeys).not.toContain("css.preprocessorOptions");
  });
});
