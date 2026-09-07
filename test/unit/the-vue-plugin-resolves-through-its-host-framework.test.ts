import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  detectProjectTransforms,
  HOISTED_TRANSFORM_WARNING,
  loadProjectTransformPlugins,
} from "../../src/project/index.js";

const PLUGIN = "@vitejs/plugin-vue";
const created: string[] = [];

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

function manifest(name: string, dependencies: Record<string, string> = {}): string {
  return JSON.stringify({ name, version: "0.0.0", dependencies }, null, 2);
}

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vue-plugin-host-"));
  created.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

function detect(root: string): { codes: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const codes = detectProjectTransforms(root, root, (w) => warnings.push(w)).map((t) => t.code);
  return { codes, warnings };
}

describe("resolving the Vue plugin a project never declares", () => {
  it("reaches it through the framework package the project does declare", () => {
    const root = project({
      "package.json": manifest("app", { nuxt: "^4.5.0" }),
      "node_modules/nuxt/package.json": manifest("nuxt", { "@nuxt/vite-builder": "4.5.0" }),
      "node_modules/nuxt/node_modules/@nuxt/vite-builder/package.json": manifest(
        "@nuxt/vite-builder",
        { [PLUGIN]: "^6.0.0" },
      ),
      [`node_modules/nuxt/node_modules/@nuxt/vite-builder/node_modules/${PLUGIN}/package.json`]:
        manifest(PLUGIN),
    });
    const { codes, warnings } = detect(root);
    expect(codes).toContain("vue");
    expect(warnings).toEqual([]);
  });

  it("loads that plugin from the framework's own resolution chain", () => {
    const root = project({
      "package.json": manifest("app", { nuxt: "^4.5.0" }),
      "node_modules/nuxt/package.json": manifest("nuxt", { "@nuxt/vite-builder": "4.5.0" }),
      "node_modules/nuxt/node_modules/@nuxt/vite-builder/package.json": manifest(
        "@nuxt/vite-builder",
        { [PLUGIN]: "^6.0.0" },
      ),
      [`node_modules/nuxt/node_modules/@nuxt/vite-builder/node_modules/${PLUGIN}/package.json`]:
        manifest(PLUGIN),
    });
    const entry = detectProjectTransforms(root, root).find((t) => t.code === "vue");
    expect(entry?.hostPackage).toBe("nuxt");
    expect(entry?.resolveFrom).toBeDefined();
    expect(fs.existsSync(path.join(entry!.resolveFrom!, "package.json"))).toBe(true);
  });

  it("loads the plugin the framework's chain leads to", async () => {
    const root = project({
      "package.json": manifest("app", { nuxt: "^4.5.0" }),
      "node_modules/nuxt/package.json": manifest("nuxt", { "@nuxt/vite-builder": "4.5.0" }),
      "node_modules/nuxt/node_modules/@nuxt/vite-builder/package.json": manifest(
        "@nuxt/vite-builder",
        { [PLUGIN]: "^6.0.0" },
      ),
      [`node_modules/nuxt/node_modules/@nuxt/vite-builder/node_modules/${PLUGIN}/package.json`]:
        JSON.stringify({ name: PLUGIN, version: "6.0.0", main: "index.js" }),
      [`node_modules/nuxt/node_modules/@nuxt/vite-builder/node_modules/${PLUGIN}/index.js`]:
        'module.exports = () => ({ name: "vite:vue-stub" });',
    });
    const entries = detectProjectTransforms(root, root);
    const warnings: string[] = [];
    const loaded = await loadProjectTransformPlugins(root, entries, (w) => warnings.push(w));
    expect(warnings).toEqual([]);
    expect(loaded.map((plugin) => (plugin as { name: string }).name)).toEqual(["vite:vue-stub"]);
  });

  it("keeps the direct declaration unchanged and free of a host", () => {
    const root = project({
      "package.json": manifest("app", { [PLUGIN]: "^5.2.0" }),
    });
    const entry = detectProjectTransforms(root, root).find((t) => t.code === "vue");
    expect(entry).toBeDefined();
    expect(entry?.hostPackage).toBeUndefined();
    expect(entry?.resolveFrom).toBeUndefined();
  });

  it("still warns when the only copy came from hoisting", () => {
    const root = project({
      "package.json": manifest("app"),
      [`node_modules/${PLUGIN}/package.json`]: manifest(PLUGIN),
    });
    const { codes, warnings } = detect(root);
    expect(codes).toContain("vue");
    expect(warnings).toEqual([HOISTED_TRANSFORM_WARNING(PLUGIN)]);
  });

  it("warns when a declared framework does not lead to the plugin either", () => {
    const root = project({
      "package.json": manifest("app", { vite: "^6.3.0" }),
      "node_modules/vite/package.json": manifest("vite"),
      [`node_modules/${PLUGIN}/package.json`]: manifest(PLUGIN),
    });
    expect(detect(root).warnings).toEqual([HOISTED_TRANSFORM_WARNING(PLUGIN)]);
  });

  it("finds nothing when no copy exists anywhere", () => {
    const root = project({
      "package.json": manifest("app", { nuxt: "^4.5.0" }),
      "node_modules/nuxt/package.json": manifest("nuxt"),
    });
    const { codes, warnings } = detect(root);
    expect(codes).not.toContain("vue");
    expect(warnings).toEqual([]);
  });
});
