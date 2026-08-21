import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps } from "../../src/analyze.js";

// M91 (preact-app-F2): --explain-props is the tool's cheapest, most
// recommended first probe, and it silently dropped the warning that matters
// most because assertReactDomClient threw before the alias check ever ran.
// This suite pins parity for the three pre-build warning classes the full
// run computes and the dry run previously did not: the bundler react-dom
// alias, a node-builtin soft preflight hit, and a wrapper resolved only from
// the workspace root.

describe("M91: --explain-props warning parity", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function isolatedProject(prefix: string, files: Record<string, string>): { root: string; entry: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    return { root, entry: path.join(root, "Card.tsx") };
  }

  function installReactDom(root: string, version: string, withClient: boolean): void {
    const pkgDir = path.join(root, "node_modules", "react-dom");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "react-dom", version, main: "index.js" }),
    );
    fs.writeFileSync(path.join(pkgDir, "index.js"), "module.exports = {};\n");
    if (withClient) {
      fs.writeFileSync(path.join(pkgDir, "client.js"), "module.exports = {};\n");
    }
  }

  // The exact preact-app-F2 repro: react-dom below 18 (version-gate throw)
  // AND a next.config.js aliasing react-dom to preact/compat. Before this
  // milestone the throw happened first and the alias note was never
  // computed at all.
  it("carries the preact/compat alias warning even though the version gate throws", async () => {
    const { root, entry } = isolatedProject("120fps-explain-parity-alias-", {
      "package.json": JSON.stringify({ dependencies: { react: "17.0.2", "react-dom": "17.0.2" } }),
      "next.config.js": [
        "module.exports = {",
        "  webpack(config) {",
        "    config.resolve.alias = { ...config.resolve.alias, 'react-dom': 'preact/compat' };",
        "    return config;",
        "  },",
        "};",
        "",
      ].join("\n"),
      "Card.tsx": "export default function Card() { return null; }\n",
    });
    installReactDom(root, "17.0.2", false);

    let thrown: Error | undefined;
    try {
      await explainProps(entry);
      expect.unreachable();
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown!.message).toMatch(/React 18\+ required/);
    expect(thrown!.message).toContain("preact/compat");
    expect(thrown!.message).toContain("this measurement runs the real react-dom");
  });

  it("carries a node-builtin soft hit in its warnings, matching the full run", async () => {
    const { root, entry } = isolatedProject("120fps-explain-parity-builtin-", {
      "package.json": JSON.stringify({ dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
      "Card.tsx": 'import "node:crypto";\nexport default function Card() { return null; }\n',
    });
    installReactDom(root, "18.3.1", true);

    const explained = await explainProps(entry);
    expect(explained.warnings.some((w) => w.includes("node:crypto"))).toBe(true);
  });

  it("carries the workspace-root wrapper warning, matching the full run", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-explain-parity-wrap-"));
    tmpDirs.push(root);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    );
    fs.writeFileSync(
      path.join(root, "120fps.setup.tsx"),
      "export function setup() {}\n",
    );
    const memberRoot = path.join(root, "packages", "app");
    fs.mkdirSync(memberRoot, { recursive: true });
    fs.writeFileSync(
      path.join(memberRoot, "package.json"),
      JSON.stringify({ name: "app", dependencies: { react: "18.3.1", "react-dom": "18.3.1" } }),
    );
    fs.mkdirSync(path.join(memberRoot, "node_modules"), { recursive: true });
    installReactDom(memberRoot, "18.3.1", true);
    const entry = path.join(memberRoot, "Card.tsx");
    fs.writeFileSync(entry, "export default function Card() { return null; }\n");

    const explained = await explainProps(entry);
    expect(explained.warnings.some((w) => w.includes("workspace root"))).toBe(true);
  });
});
