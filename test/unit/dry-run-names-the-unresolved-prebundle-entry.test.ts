import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps } from "../../src/analyze.js";
import {
  collectStaticPreBuildWarnings,
  UNRESOLVED_PREBUNDLE_ENTRY_WARNING,
} from "../../src/harness.js";

// epic-stack-F2: the dry run promised a run the dev server killed at
// dep-optimization one minute later, because the scan walked past a specifier
// that resolved to nothing without a word. Both modes read one static
// pre-build, so the unresolved set and its wording belong to both of them.

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function isolatedProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-unresolved-parity-"));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  // The version gate throws before any of the later probes run, so the project
  // needs a react-dom the gate accepts.
  const reactDom = path.join(root, "node_modules", "react-dom");
  fs.mkdirSync(reactDom, { recursive: true });
  fs.writeFileSync(
    path.join(reactDom, "package.json"),
    JSON.stringify({ name: "react-dom", version: "19.0.0", main: "index.js" }),
  );
  fs.writeFileSync(path.join(reactDom, "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(reactDom, "client.js"), "module.exports = {};\n");
  return root;
}

const WIDGET = [
  'import { root } from "#app/root";',
  "",
  "export default function Widget({ label = 'Go' }: { label?: string }) {",
  "  return <button data-root={root}>{label}</button>;",
  "}",
].join("\n");

function unresolvedLines(warnings: string[]): string[] {
  return warnings.filter((w) => w.includes("resolves to no installed package"));
}

describe("the pre-bundle entries a dry run reports", () => {
  it("names the unresolved specifier in the same words the real run's pre-build uses", async () => {
    const root = isolatedProject({
      "package.json": JSON.stringify({
        name: "no-imports-field-project",
        dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
      }),
      "app/widget.tsx": WIDGET,
    });
    const entry = path.join(root, "app", "widget.tsx");

    const preBuild = collectStaticPreBuildWarnings(root, { componentPath: entry });
    expect(preBuild.unresolvedExternals).toContainEqual({
      specifier: "#app/root",
      importer: "app/widget.tsx",
    });

    const explained = await explainProps(entry, {});
    expect(unresolvedLines(explained.warnings)).toEqual(unresolvedLines(preBuild.warnings));
    expect(explained.warnings).toContain(
      UNRESOLVED_PREBUNDLE_ENTRY_WARNING("#app/root", "app/widget.tsx"),
    );
  });

  it("reports each unresolved entry once, in the order the scan met it", async () => {
    const root = isolatedProject({
      "package.json": JSON.stringify({
        name: "no-imports-field-project",
        dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
      }),
      "app/widget.tsx": WIDGET,
    });
    const entry = path.join(root, "app", "widget.tsx");
    const preBuild = collectStaticPreBuildWarnings(root, { componentPath: entry });

    const explained = await explainProps(entry, {});
    expect(unresolvedLines(explained.warnings)).toEqual(
      preBuild.unresolvedExternals.map((e) =>
        UNRESOLVED_PREBUNDLE_ENTRY_WARNING(e.specifier, e.importer),
      ),
    );
  });

  it("says nothing when the manifest's `imports` map resolves the specifier", async () => {
    const root = isolatedProject({
      "package.json": JSON.stringify({
        name: "imports-field-project",
        imports: { "#app/*": "./app/*" },
        dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
      }),
      "app/widget.tsx": WIDGET,
      "app/root.ts": "export const root = 'app';\n",
    });
    const entry = path.join(root, "app", "widget.tsx");

    const preBuild = collectStaticPreBuildWarnings(root, { componentPath: entry });
    expect(preBuild.unresolvedExternals).toEqual([]);

    const explained = await explainProps(entry, {});
    expect(unresolvedLines(explained.warnings)).toEqual([]);
  });
});
