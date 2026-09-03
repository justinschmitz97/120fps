import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { explainProps } from "../../src/analyze.js";
import {
  runPreflight,
  classifyProjectTransformHits,
  PROJECT_TRANSFORM_WARNING,
} from "../../src/preflight.js";

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

// The run path's half of the same parity: analyze() needs a browser, so what
// is pinned here is that it reads the shared classifier and forwards
// --no-transforms into it, instead of filtering the hits inline again.
describe("the run path's own transform warnings", () => {
  const analyzeSrc = fs.readFileSync(path.resolve("src/analyze.ts"), "utf-8");
  const block = analyzeSrc.slice(
    analyzeSrc.indexOf("const loadableTransforms = new Set("),
    analyzeSrc.indexOf("if (loadableTransforms.size > 0)"),
  );

  it("pushes exactly what the shared classifier returns", () => {
    expect(block).toContain("classifyProjectTransformHits(projectRoot, preflight.transforms, {");
    expect(block).toContain("for (const { hit, availability } of candidateTransformHits)");
    expect(block).toContain("runWarnings.push(PROJECT_TRANSFORM_WARNING(hit, availability));");
    // No second, independent filter: the dry run and the run path cannot
    // disagree about which hits are worth a warning.
    expect(block).not.toContain("preflight.transforms.filter");
  });

  it("forwards --no-transforms into the classifier, so the run stays silent too", () => {
    expect(block).toContain('...(options.noTransforms ? { noTransforms: true } : {})');
    expect(classifyProjectTransformHits(path.resolve("."), [], { noTransforms: true })).toEqual([]);
  });

  // I3: one exported classifier, no second copy anywhere. A duplicate is how
  // the two modes drifted apart in the first place. Which hits each mode
  // prints is pinned by the observable parity tests above, not here.
  it("declares no second classifier of its own", () => {
    expect(analyzeSrc).not.toContain("function classifiedProjectTransformHits");
  });
});
