import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  POSTCSS_PLUGIN_UNRESOLVED_WARNING,
  findPostcssConfigFile,
  loadPostcssConfigPipeline,
  resolveStyleTooling,
  unresolvedPostcssPlugins,
} from "../../src/harness/index.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-postcss-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(file: string, content: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

// A CommonJS plugin factory that reports its own name and the options it was called with.
function installPlugin(dir: string, name: string): void {
  const pkgDir = path.join(dir, "node_modules", ...name.split("/"));
  write(path.join(pkgDir, "package.json"), JSON.stringify({ name, main: "index.cjs" }));
  write(
    path.join(pkgDir, "index.cjs"),
    `module.exports = (options) => ({ postcssPlugin: ${JSON.stringify(name)}, options });\n`,
  );
}

function workspace(): { root: string; member: string } {
  const root = path.join(tmpDir, "repo");
  const member = path.join(root, "apps", "web");
  write(path.join(root, "package.json"), JSON.stringify({ name: "repo", private: true }));
  write(path.join(root, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
  write(path.join(member, "package.json"), JSON.stringify({ name: "web" }));
  return { root, member };
}

async function pipelineFor(
  member: string,
  root: string,
  warnings: string[] = [],
): Promise<{ plugins: unknown[] } | undefined> {
  const configFile = findPostcssConfigFile(member, root);
  expect(configFile).toBeDefined();
  return loadPostcssConfigPipeline(configFile!, member, root, (w) => warnings.push(w));
}

function pluginNames(pipeline: { plugins: unknown[] } | undefined): string[] {
  return (pipeline?.plugins ?? []).map((p) => (p as { postcssPlugin?: string }).postcssPlugin ?? "?");
}

describe("postcss config plugins", () => {
  it("loads a plugin declared as a bare string", async () => {
    const { root, member } = workspace();
    installPlugin(member, "fake-tailwind");
    write(path.join(member, "postcss.config.mjs"), 'export default { plugins: ["fake-tailwind"] };\n');

    const pipeline = await pipelineFor(member, root);

    expect(pluginNames(pipeline)).toEqual(["fake-tailwind"]);
  });

  it("passes the options of a [name, options] tuple to the plugin", async () => {
    const { root, member } = workspace();
    installPlugin(member, "fake-preset-env");
    write(
      path.join(member, "postcss.config.js"),
      'export default { plugins: [["fake-preset-env", { stage: 3 }]] };\n',
    );

    const pipeline = await pipelineFor(member, root);

    expect((pipeline?.plugins[0] as { options?: { stage?: number } }).options?.stage).toBe(3);
  });

  it("keeps an object-map entry disabled with false out of the pipeline", async () => {
    const { root, member } = workspace();
    installPlugin(member, "fake-tailwind");
    installPlugin(member, "fake-nesting");
    write(
      path.join(member, "postcss.config.js"),
      'module.exports = { plugins: { "fake-tailwind": {}, "fake-nesting": false } };\n',
    );

    const pipeline = await pipelineFor(member, root);

    expect(pluginNames(pipeline)).toEqual(["fake-tailwind"]);
  });

  it("resolves a plugin from the workspace package the config re-exports", async () => {
    const { root, member } = workspace();
    const owner = path.join(member, "node_modules", "@acme", "tw");
    write(
      path.join(owner, "package.json"),
      JSON.stringify({
        name: "@acme/tw",
        type: "module",
        exports: { "./postcss-config": "./postcss-config.js" },
      }),
    );
    write(path.join(owner, "postcss-config.js"), 'export default { plugins: ["fake-tailwind"] };\n');
    // The plugin is a dependency of the config's own package, not of the member.
    installPlugin(owner, "fake-tailwind");
    write(
      path.join(member, "postcss.config.mjs"),
      'export { default } from "@acme/tw/postcss-config";\n',
    );

    const pipeline = await pipelineFor(member, root);

    expect(pluginNames(pipeline)).toEqual(["fake-tailwind"]);
  });

  it("names an unresolvable plugin and keeps the plugins that do resolve", async () => {
    const { root, member } = workspace();
    installPlugin(member, "fake-tailwind");
    write(
      path.join(member, "postcss.config.js"),
      'module.exports = { plugins: ["fake-tailwind", "absent-plugin"] };\n',
    );
    const warnings: string[] = [];

    const pipeline = await pipelineFor(member, root, warnings);

    expect(pluginNames(pipeline)).toEqual(["fake-tailwind"]);
    expect(warnings).toEqual([
      POSTCSS_PLUGIN_UNRESOLVED_WARNING(path.join(member, "postcss.config.js"), "absent-plugin", [
        member,
        root,
      ]),
    ]);
  });

  it("reports the unresolvable plugin from the static style tooling too", () => {
    const { root, member } = workspace();
    write(path.join(member, "postcss.config.js"), 'module.exports = { plugins: ["absent-plugin"] };\n');

    const unresolved = unresolvedPostcssPlugins(
      path.join(member, "postcss.config.js"),
      member,
      root,
    );

    expect(unresolved.map((entry) => entry.name)).toEqual(["absent-plugin"]);
    expect(resolveStyleTooling(member, root).warnings).toContain(
      POSTCSS_PLUGIN_UNRESOLVED_WARNING(path.join(member, "postcss.config.js"), "absent-plugin", [
        member,
        root,
      ]),
    );
  });

  it("leaves a TypeScript config to Vite's own loader", async () => {
    const { root, member } = workspace();
    write(path.join(member, "postcss.config.ts"), "export default { plugins: {} };\n");

    const pipeline = await pipelineFor(member, root);

    expect(pipeline).toBeUndefined();
  });

  it("publishes the config file it would load", () => {
    const { root, member } = workspace();
    const configFile = write(
      path.join(member, "postcss.config.js"),
      "module.exports = { plugins: {} };\n",
    );

    expect(resolveStyleTooling(member, root).postcssConfigFile).toBe(configFile);
  });
});
