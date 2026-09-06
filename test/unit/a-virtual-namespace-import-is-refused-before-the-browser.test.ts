import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps } from "../../src/pipeline/index.js";
import { runPreflight, preflightFailureMessage } from "../../src/project/index.js";

// n8n's shape: `~icons/` was a soft warning, so the dry run exited 0 and the real run refused only
// after the full readiness bound. The namespace has no file behind it on either path.
const FIXTURES = path.resolve(import.meta.dirname, "..", "..", "fixtures");
const DECLARED_PRODUCER_FIXTURE = path.join(FIXTURES, "virtual-namespace-project");

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function isolatedProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-virtual-refusal-"));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  // The react-dom version gate runs before the later probes, so the project needs one it accepts.
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

function undeclaredProducerProject(): { root: string; entry: string } {
  const root = isolatedProject({
    "package.json": JSON.stringify({
      name: "icons-project",
      dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
    }),
    "src/Close.tsx": [
      'import CloseIcon from "~icons/mdi/close";',
      "export function Close() {",
      "  return <CloseIcon />;",
      "}",
    ].join("\n"),
  });
  return { root, entry: path.join(root, "src", "Close.tsx") };
}

describe("an import into a virtual namespace nothing here can serve", () => {
  it("is a hard preflight hit, not a warning the run walks past", () => {
    const { root, entry } = undeclaredProducerProject();

    const result = runPreflight({ projectRoot: root, entries: [entry], componentName: "Close" });

    expect(result.hard.map((hit) => hit.kind)).toContain("unloadable-virtual-module");
    expect(result.hard.find((hit) => hit.kind === "unloadable-virtual-module")!.specifier).toBe(
      "~icons/mdi/close",
    );
  });

  it("names the importing file, the specifier and the chain from the measured component", () => {
    const { root, entry } = undeclaredProducerProject();

    const message = preflightFailureMessage(
      runPreflight({ projectRoot: root, entries: [entry], componentName: "Close" }).hard,
    );

    expect(message).toContain("src/Close.tsx");
    expect(message).toContain("~icons/mdi/close");
    expect(message).toContain("~icons/");
    expect(message).toContain("→");
  });

  it("names the plugin the project declares for that namespace", () => {
    const message = preflightFailureMessage(
      runPreflight({
        projectRoot: DECLARED_PRODUCER_FIXTURE,
        entries: [path.join(DECLARED_PRODUCER_FIXTURE, "src", "Icon.tsx")],
        componentName: "Icon",
      }).hard,
    );

    expect(message).toContain("unplugin-icons");
    expect(message).toContain("~icons/lucide/eye");
  });

  it("says nothing about a producing plugin when the project declares none", () => {
    const { root, entry } = undeclaredProducerProject();

    const message = preflightFailureMessage(
      runPreflight({ projectRoot: root, entries: [entry], componentName: "Close" }).hard,
    );

    expect(message).not.toContain("unplugin-icons");
  });

  it("refuses the dry run with the text the real run's gate produces", async () => {
    const { root, entry } = undeclaredProducerProject();
    const expected = preflightFailureMessage(
      runPreflight({ projectRoot: root, entries: [entry], componentName: "Close" }).hard,
    );

    await expect(explainProps(entry, {})).rejects.toThrow(expected);
  });

  it("is bypassable with --no-preflight, like every other hard refusal", async () => {
    const { root, entry } = undeclaredProducerProject();

    const explained = await explainProps(entry, { noPreflight: true });

    expect(explained.warnings.some((w) => w.includes("~icons/mdi/close"))).toBe(true);
  });
});

describe("a specifier that only looks like a virtual namespace", () => {
  it("is not refused when an installed package answers for it", () => {
    const root = isolatedProject({
      "package.json": JSON.stringify({
        name: "p",
        dependencies: { react: "19.0.0", "react-dom": "19.0.0", "unplugin-icons": "^0.19.0" },
      }),
      "node_modules/unplugin-icons/package.json": JSON.stringify({ name: "unplugin-icons" }),
      "node_modules/unplugin-icons/runtime.js": "export const x = 1;\n",
      "node_modules/unplugin-icons/runtime.d.ts": "export declare const x: number;\n",
      "src/Icon.tsx": [
        'import { x } from "unplugin-icons/runtime";',
        "export function Icon() {",
        "  return <span>{x}</span>;",
        "}",
      ].join("\n"),
    });

    const result = runPreflight({
      projectRoot: root,
      entries: [path.join(root, "src", "Icon.tsx")],
      componentName: "Icon",
    });

    expect(result.hard.map((hit) => hit.kind)).not.toContain("unloadable-virtual-module");
  });
});
