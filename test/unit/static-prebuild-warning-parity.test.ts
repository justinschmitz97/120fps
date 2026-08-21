import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps, resolveWrapPath } from "../../src/analyze.js";
import { collectStaticPreBuildWarnings } from "../../src/harness.js";

// V6's whole finding in one assertion: every warning the real run's pre-build
// half produces is decidable from the filesystem, and the dry run used to
// print none of them because they lived inside the function that starts a
// server. dub's unbuilt-`dist/` substitution and nuxt-ui's stale `#build`
// alias are the two the corpus reported.

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

// A workspace member importing a sibling package whose package.json points at
// a `dist/` that does not exist, plus a tsconfig whose `extends` target is
// missing: two independent static facts the real run reports.
function workspace(): { root: string; component: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-prebuild-parity-"));
  tmpDirs.push(root);
  write(root, "package.json", JSON.stringify({ name: "ws-root", workspaces: ["packages/*"] }));
  write(root, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
  write(root, "packages/utils/package.json", JSON.stringify({ name: "@ws/utils", main: "./dist/index.mjs" }));
  write(root, "packages/utils/src/index.ts", "export const one = 1;\n");
  write(root, "packages/ui/package.json", JSON.stringify({ name: "@ws/ui", dependencies: { "@ws/utils": "workspace:*" } }));
  write(root, "packages/ui/tsconfig.json", JSON.stringify({ extends: "./.generated/tsconfig.json" }));
  write(root, "packages/ui/src/Badge.tsx",
    'import { one } from "@ws/utils";\nexport function Badge(props: { label: string }) { return null; }\n');
  fs.mkdirSync(path.join(root, "packages/ui/node_modules/react-dom"), { recursive: true });
  write(root, "packages/ui/node_modules/react-dom/package.json", JSON.stringify({ name: "react-dom", version: "18.2.0", main: "index.js" }));
  write(root, "packages/ui/node_modules/react-dom/index.js", "module.exports = {};\n");
  write(root, "packages/ui/node_modules/react-dom/client.js", "module.exports = {};\n");
  fs.mkdirSync(path.join(root, "packages/ui/node_modules/@ws"), { recursive: true });
  fs.symlinkSync(
    path.join(root, "packages/utils"),
    path.join(root, "packages/ui/node_modules/@ws/utils"),
    "junction",
  );
  return { root: path.join(root, "packages/ui"), component: path.join(root, "packages/ui/src/Badge.tsx") };
}

describe("the dry run prints the pre-build warnings the real run computes", () => {
  it("emits every warning the shared static probe produces", async () => {
    const { root, component } = workspace();
    const { wrapPath } = resolveWrapPath({}, root, "react", []);
    const probe = collectStaticPreBuildWarnings(root, {
      componentPath: component,
      ...(wrapPath ? { wrapPath } : {}),
    });
    const explained = await explainProps(component);

    expect(probe.warnings.length).toBeGreaterThan(0);
    const missing = probe.warnings.filter((w) => !explained.warnings.includes(w));
    expect(missing).toEqual([]);
  });

  it("names the unbuilt workspace dist substitution, the fact dub reported", async () => {
    const { component } = workspace();
    const explained = await explainProps(component);
    expect(explained.warnings.some((w) => w.includes("@ws/utils") && w.includes("dist/"))).toBe(true);
  });

  it("names the broken tsconfig extends chain once, not once per probe", async () => {
    const { component } = workspace();
    const explained = await explainProps(component);
    const broken = explained.warnings.filter((w) => w.includes(".generated/tsconfig.json"));
    expect(broken).toHaveLength(1);
  });

  it("still starts no server and writes no harness directory", async () => {
    const { root, component } = workspace();
    await explainProps(component);
    const entries = fs.readdirSync(root);
    expect(entries.filter((e) => e.startsWith(".120fps-harness-"))).toEqual([]);
    expect(entries).not.toContain("120fps-report.json");
  });
});
