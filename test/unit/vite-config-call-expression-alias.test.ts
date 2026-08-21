import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readViteConfigData, VITE_CONFIG_WORKSPACE_ROOT_ALIAS_WARNING } from "../../src/harness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-vite-callexpr-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function mkdir(relative: string): string {
  const full = path.join(tmpDir, relative);
  fs.mkdirSync(full, { recursive: true });
  return full;
}

function write(relative: string, content: string): string {
  const full = path.join(tmpDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

// M93 (chakra-ui-F1): the root vite.config.ts alias that makes @chakra-ui/react
// resolvable is written as `resolve("packages/react/src")`, a call expression
// -- parseViteConfigFile previously recognized only a string-literal value and
// silently dropped this into "ignored", so the M76 workspace-root fallback
// layer, though itself correct, never even saw the alias.
describe("readViteConfigData: resolve.alias value written as a resolve(...) call expression (M93)", () => {
  it("resolves a single-argument resolve(path) call relative to the config's own directory", () => {
    mkdir("packages/react/src");
    write(
      "vite.config.ts",
      `import { resolve } from "node:path";\n` +
        `export default { resolve: { alias: { "@chakra-ui/react": resolve("packages/react/src") } } };\n`,
    );
    const member = mkdir("packages/react");

    const data = readViteConfigData(member, tmpDir);
    expect(data.aliases).toHaveLength(1);
    expect(data.aliases[0].find.test("@chakra-ui/react")).toBe(true);
    expect(data.aliases[0].replacement).toBe(
      path.join(tmpDir, "packages/react/src").replace(/\\/g, "/"),
    );
    expect(data.warnings).toEqual([
      VITE_CONFIG_WORKSPACE_ROOT_ALIAS_WARNING(
        "@chakra-ui/react",
        path.join(tmpDir, "packages/react/src").replace(/\\/g, "/"),
        path.join(tmpDir, "vite.config.ts").replace(/\\/g, "/"),
      ),
    ]);
  });

  it("resolves a resolve(__dirname, path) two-argument call, ignoring the non-literal first argument", () => {
    mkdir("packages/react/src");
    write(
      "vite.config.ts",
      `import { resolve } from "node:path";\n` +
        `export default { resolve: { alias: { "@chakra-ui/react": resolve(__dirname, "packages/react/src") } } };\n`,
    );
    const member = mkdir("packages/react");

    const data = readViteConfigData(member, tmpDir);
    expect(data.aliases).toHaveLength(1);
    expect(data.aliases[0].replacement).toBe(
      path.join(tmpDir, "packages/react/src").replace(/\\/g, "/"),
    );
  });

  it("resolves a path.resolve(...) member-expression call the same way", () => {
    mkdir("packages/react/src");
    write(
      "vite.config.ts",
      `import path from "node:path";\n` +
        `export default { resolve: { alias: { "@chakra-ui/react": path.resolve("packages/react/src") } } };\n`,
    );
    const member = mkdir("packages/react");

    const data = readViteConfigData(member, tmpDir);
    expect(data.aliases).toHaveLength(1);
    expect(data.aliases[0].replacement).toBe(
      path.join(tmpDir, "packages/react/src").replace(/\\/g, "/"),
    );
  });

  it("still ignores a call to a function that is neither resolve nor join", () => {
    write(
      "vite.config.ts",
      `export default { resolve: { alias: { "@x": someOtherHelper("packages/x/src") } } };\n`,
    );
    const member = mkdir("packages/react");
    const data = readViteConfigData(member, tmpDir);
    expect(data.aliases).toEqual([]);
  });

  it("still ignores a target that does not resolve to anything on disk", () => {
    write(
      "vite.config.ts",
      `import { resolve } from "node:path";\n` +
        `export default { resolve: { alias: { "@x": resolve("packages/does-not-exist") } } };\n`,
    );
    const member = mkdir("packages/react");
    const data = readViteConfigData(member, tmpDir);
    expect(data.aliases).toEqual([]);
  });
});
