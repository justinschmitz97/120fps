import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertRendererSupported } from "../../src/harness.js";

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function mkProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-vuegate-"));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

// element-plus/packages/components: vue in peerDependencies and
// devDependencies, no react and no react-dom anywhere, and a component
// authored as a Vue render function in a `.tsx`.
function vueProject(extraManifest: Record<string, unknown> = {}): string {
  return mkProject({
    "package.json": JSON.stringify({
      name: "components",
      peerDependencies: { vue: "^3.5.0" },
      devDependencies: { vue: "^3.5.0" },
      ...extraManifest,
    }),
    "tabs/src/tabs.tsx": "import { defineComponent } from 'vue';\nexport default defineComponent({});\n",
    "tabs/src/tab-bar.vue": "<template><div/></template>\n",
  });
}

describe("a React-extension file in a Vue project", () => {
  it("is refused for the reason that applies, not as a missing react-dom install", () => {
    const root = vueProject();
    let message = "";
    try {
      assertRendererSupported(path.join(root, "tabs/src/tabs.tsx"), root);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("tabs/src/tabs.tsx");
    expect(message).toContain(".vue");
    expect(message).toContain("--framework vue");
    expect(message).not.toContain("point 120fps at a project that declares it");
  });

  it("names the file's own extension", () => {
    const root = vueProject();
    fs.writeFileSync(path.join(root, "widget.jsx"), "export default () => null;\n");
    expect(() => assertRendererSupported(path.join(root, "widget.jsx"), root)).toThrow(/\.jsx file/);
  });

  it("leaves a .vue single-file component alone", () => {
    const root = vueProject();
    expect(() => assertRendererSupported(path.join(root, "tabs/src/tab-bar.vue"), root)).not.toThrow();
  });

  it("does not claim a project that declares react-dom", () => {
    const root = vueProject({ devDependencies: { vue: "^3.5.0", "react-dom": "^19.0.0" } });
    expect(() => assertRendererSupported(path.join(root, "tabs/src/tabs.tsx"), root)).not.toThrow();
  });

  it("does not claim a project that declares neither framework", () => {
    const root = mkProject({
      "package.json": JSON.stringify({ name: "plain" }),
      "widget.tsx": "export const W = () => null;\n",
    });
    expect(() => assertRendererSupported(path.join(root, "widget.tsx"), root)).not.toThrow();
  });

  it("leaves a workspace whose root declares react-dom to the react-dom gate", () => {
    const dir = mkProject({
      "repo/package.json": JSON.stringify({
        name: "root",
        workspaces: ["packages/*"],
        devDependencies: { "react-dom": "^19.0.0" },
      }),
      "repo/pnpm-workspace.yaml": "packages:\n  - packages/*\n",
      "repo/packages/ui/package.json": JSON.stringify({ name: "ui", devDependencies: { vue: "^3.5.0" } }),
      "repo/packages/ui/Widget.tsx": "export const W = () => null;\n",
    });
    const member = path.join(dir, "repo/packages/ui");
    expect(() => assertRendererSupported(path.join(member, "Widget.tsx"), member)).not.toThrow();
  });
});
