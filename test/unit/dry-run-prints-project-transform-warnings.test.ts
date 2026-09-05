import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps } from "../../src/pipeline/index.js";
import {
  runPreflight,
  classifyProjectTransformHits,
  PROJECT_TRANSFORM_WARNING,
} from "../../src/project/index.js";

// logto-F3: dry run stayed silent on transform hits the real run printed later; one classifier now.

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
  // Version gate throws before later probes run, so the project needs a react-dom it accepts.
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

// Mirrors what the run path pushes: classifier's answer, same order, one warning constant.
function runPathTransformWarnings(
  projectRoot: string,
  entry: string,
  opts: { noTransforms?: boolean } = {},
): string[] {
  const preflight = runPreflight({ projectRoot, entries: [entry], componentName: "Card" });
  return classifyProjectTransformHits(projectRoot, preflight.transforms, opts).map(
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

// analyze() needs a browser; this pins that it reads the classifier and forwards --no-transforms.
describe("the run path's own transform warnings", () => {
  const analyzeSrc = fs.readFileSync(path.resolve("src/pipeline/phases.ts"), "utf-8");
  const block = analyzeSrc.slice(
    analyzeSrc.indexOf("const loadableTransforms = new Set("),
    analyzeSrc.indexOf("if (loadableTransforms.size > 0)"),
  );

  it("pushes exactly what the shared classifier returns", () => {
    expect(block).toContain("classifyProjectTransformHits(projectRoot, preflight.transforms, {");
    expect(block).toContain("for (const { hit, availability } of candidateTransformHits)");
    expect(block).toContain("runWarnings.push(PROJECT_TRANSFORM_WARNING(hit, availability));");
    // No second, independent filter: dry run and run path cannot disagree on which hits warn.
    expect(block).not.toContain("preflight.transforms.filter");
  });

  it("forwards --no-transforms into the classifier, so the run stays silent too", () => {
    expect(block).toContain('...(options.noTransforms ? { noTransforms: true } : {})');
    expect(classifyProjectTransformHits(path.resolve("."), [], { noTransforms: true })).toEqual([]);
  });

  // I3: one exported classifier; a duplicate is how the two modes drifted apart before.
  it("declares no second classifier of its own", () => {
    expect(analyzeSrc).not.toContain("function classifiedProjectTransformHits");
  });
});
