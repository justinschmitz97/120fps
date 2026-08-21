import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps, formatAccumulatedWarnings, FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING } from "../../src/analyze.js";

// element-plus F1/F2 (verify/V4): `packages/components/tabs/src/tabs.tsx` is a
// pure-Vue render function in a repo that declares vue and no react-dom. The
// refusal is right; the reason printed was "react-dom is not a dependency of
// this project", which reads as an install problem and invites `npm i
// react-dom`, a remedy that cannot help. The same run printed a
// "Warnings recorded before this failure:" header with nothing under it, and
// `--framework vue` was a silent no-op in the dry run while the real run
// disclosed it.

describe("a React-extension file in a Vue project is refused for the reason that applies", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function project(manifest: Record<string, unknown>, files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-vue-gate-"));
    tmpDirs.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", ...manifest }));
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    return root;
  }

  const VUE_TSX = `import { defineComponent } from "vue";
export default defineComponent({ name: "Tabs", setup: () => () => null });
`;

  it("names the Vue mount path, not a missing react-dom install", async () => {
    const root = project({ devDependencies: { vue: "^3.4.0" } }, { "tabs.tsx": VUE_TSX });
    await expect(explainProps(path.join(root, "tabs.tsx"))).rejects.toThrow(
      /mounts Vue components from \.vue single-file components only/,
    );
    await expect(explainProps(path.join(root, "tabs.tsx"))).rejects.not.toThrow(
      /react-dom is not a dependency/,
    );
  });

  it("discloses that --framework vue cannot change the mount, in the dry run too", async () => {
    const root = project({ devDependencies: { vue: "^3.4.0" } }, { "tabs.tsx": VUE_TSX });
    const err = await explainProps(path.join(root, "tabs.tsx"), { framework: "vue" }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING("vue", "react"));
  });

  it("still discloses the flag no-op on a component that resolves fine", async () => {
    const root = project(
      { dependencies: { "react-dom": "^18.2.0" } },
      { "Card.tsx": "export function Card(props: { title: string }) { return null; }\n" },
    );
    const pkgDir = path.join(root, "node_modules", "react-dom");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "react-dom", version: "18.2.0", main: "index.js" }));
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
    fs.writeFileSync(path.join(pkgDir, "client.js"), "module.exports = {};\n");

    const explained = await explainProps(path.join(root, "Card.tsx"), { framework: "vue" });
    expect(explained.warnings).toContain(FRAMEWORK_FLAG_NO_MOUNT_EFFECT_WARNING("vue", "react"));
  });

  it("leaves a project that declares react-dom to the react-dom gate", async () => {
    const root = project(
      { devDependencies: { vue: "^3.4.0", "react-dom": "^17.0.2" } },
      { "tabs.tsx": VUE_TSX },
    );
    const pkgDir = path.join(root, "node_modules", "react-dom");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "react-dom", version: "17.0.2", main: "index.js" }));
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");

    const err = await explainProps(path.join(root, "tabs.tsx")).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/React 18\+ required/);
  });
});

describe("the accumulated-warnings block appears only when there are warnings", () => {
  it("contributes nothing for an empty list", () => {
    expect(formatAccumulatedWarnings([])).toBe("");
  });

  it("still names every warning it has", () => {
    const block = formatAccumulatedWarnings(["first thing", "second thing"]);
    expect(block).toContain("Warnings recorded before this failure:");
    expect(block).toContain("  first thing");
    expect(block).toContain("  second thing");
  });
});
