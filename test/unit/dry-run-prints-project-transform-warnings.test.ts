import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps, classifiedProjectTransformHits } from "../../src/analyze.js";
import { runPreflight, PROJECT_TRANSFORM_WARNING } from "../../src/preflight.js";

// logto-F3: `runPreflight` returns `transforms` on both paths, and only the
// real run read it -- the dry run stayed silent about the 13
// `[transform:css-preprocessor]` lines the real run printed one minute later
// from the same files on disk. One classifier now answers for both.

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function isolatedProject(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-transform-parity-"));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  // The version gate throws before any of this function's later probes run,
  // so the project needs a react-dom the gate accepts.
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

// What the run path pushes: the classifier's answer, in its own order, run
// through the one warning constant.
function runPathTransformWarnings(
  projectRoot: string,
  entry: string,
  opts: { noTransforms?: boolean } = {},
): string[] {
  const preflight = runPreflight({ projectRoot, entries: [entry], componentName: "Card" });
  return classifiedProjectTransformHits(projectRoot, preflight.transforms, opts).map(
    ({ hit, availability }) => PROJECT_TRANSFORM_WARNING(hit, availability),
  );
}

function transformLines(warnings: string[]): string[] {
  return warnings.filter((w) => w.startsWith("[transform:"));
}

describe("the transform decisions a dry run makes from the same files the real run reads", () => {
  function preprocessorProject(): { root: string; entry: string } {
    const root = isolatedProject({
      "package.json": JSON.stringify({
        name: "preprocessor-project",
        dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
      }),
      "Card.tsx": [
        "import './card.scss';",
        "export function Card({ label }: { label?: string }) {",
        "  return <div>{label}</div>;",
        "}",
      ].join("\n"),
      "card.scss": ".card { color: red; }\n",
    });
    return { root, entry: path.join(root, "Card.tsx") };
  }

  it("prints the same transform warnings the run path pushes, in the same order", async () => {
    const { root, entry } = preprocessorProject();
    const expected = runPathTransformWarnings(root, entry);
    expect(expected.length).toBeGreaterThan(0);
    const explained = await explainProps(entry, {});
    expect(transformLines(explained.warnings)).toEqual(expected);
  });

  it("empties both when --no-transforms was passed", async () => {
    const { root, entry } = preprocessorProject();
    expect(runPathTransformWarnings(root, entry, { noTransforms: true })).toEqual([]);
    const explained = await explainProps(entry, { noTransforms: true });
    expect(transformLines(explained.warnings)).toEqual([]);
  });

  it("says nothing about a transform the project declares and the harness can load", async () => {
    const project = path.resolve("fixtures/transform-project");
    const entry = path.join(project, "app/VeCard.tsx");
    expect(runPathTransformWarnings(project, entry)).toEqual([]);
    const explained = await explainProps(entry, {});
    expect(transformLines(explained.warnings)).toEqual([]);
  });
});
