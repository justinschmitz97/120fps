import { describe, it, expect, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetTsconfigReadCache, resolveGoverningTsconfig } from "../../src/project/index.js";

const created: string[] = [];

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetTsconfigReadCache();
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "generated-tsconfig-"));
  created.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return root;
}

const GENERATED_LAYOUT = {
  "tsconfig.json": JSON.stringify({
    files: [],
    references: [{ path: "./.nuxt/tsconfig.app.json" }, { path: "./.nuxt/tsconfig.server.json" }],
  }),
  ".nuxt/tsconfig.app.json": JSON.stringify({
    compilerOptions: { paths: { "~/*": ["../app/*"] } },
    include: ["./nuxt.d.ts", "../app/**/*"],
    exclude: ["../node_modules"],
  }),
  ".nuxt/tsconfig.server.json": JSON.stringify({
    compilerOptions: { paths: {} },
    include: ["../server/**/*"],
  }),
  ".nuxt/nuxt.d.ts": "export {}\n",
  "app/components/Greeting.vue": "<template><p>hi</p></template>\n",
  "app/plugin.ts": "export const a = 1\n",
};

describe("a referenced config that covers a single-file component", () => {
  it("takes its compiler options from the generated config", () => {
    const root = project(GENERATED_LAYOUT);
    const governing = resolveGoverningTsconfig(
      path.join(root, "app", "components", "Greeting.vue"),
      root,
    );
    expect(governing.viaReferences).toBe(true);
    expect(governing.configPath).toContain("tsconfig.app.json");
    expect(governing.options.paths).toBeDefined();
    expect(governing.warnings.join("\n")).not.toContain("no referenced config covers");
  });

  it("still covers a plain TypeScript file in the same directory tree", () => {
    const root = project(GENERATED_LAYOUT);
    const governing = resolveGoverningTsconfig(path.join(root, "app", "plugin.ts"), root);
    expect(governing.viaReferences).toBe(true);
    expect(governing.configPath).toContain("tsconfig.app.json");
  });

  it("still reports a target no referenced config includes", () => {
    const root = project(GENERATED_LAYOUT);
    const governing = resolveGoverningTsconfig(path.join(root, "other", "Away.vue"), root);
    expect(governing.viaReferences).toBe(false);
    expect(governing.warnings.join("\n")).toContain("no referenced config covers");
    expect(governing.warnings.join("\n")).toContain("tsconfig.app.json");
  });
});
