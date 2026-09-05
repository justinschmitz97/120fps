import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyProjectTransformHits, type PreflightHit } from "../../src/project/index.js";

// M110 (I3): one classifier serves the real run and --explain-props, so the two can't drift.
const FIXTURE = path.resolve(import.meta.dirname, "..", "..", "fixtures", "transform-project");

const hit = (transformCode: string, specifier: string): PreflightHit => ({
  kind: "project-transform",
  chain: ["app/Card.tsx"],
  specifier,
  transformCode,
  transformOwner: "a plugin",
});

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-classify-transforms-"));
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "p" }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function installPackage(name: string): void {
  const dir = path.join(tmpDir, "node_modules", ...name.split("/"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
  fs.writeFileSync(path.join(dir, "index.js"), "export default {};\n");
}

describe("the project-transform classifier", () => {
  it("keeps a hit whose plugin the project cannot load, in input order", () => {
    const hits = [hit("svgr", "./icon.svg?react"), hit("vanilla-extract", "./styles.css")];

    const classified = classifyProjectTransformHits(tmpDir, hits);

    expect(classified.map((c) => c.hit.transformCode)).toEqual(["svgr", "vanilla-extract"]);
  });

  it("drops a hit whose plugin the project declares", () => {
    const hits = [hit("svgr", "./icon.svg?react"), hit("vanilla-extract", "./styles.css")];

    expect(classifyProjectTransformHits(FIXTURE, hits)).toEqual([]);
  });

  it("drops a hit whose plugin is installed without being declared", () => {
    installPackage("vite-plugin-svgr");

    const classified = classifyProjectTransformHits(tmpDir, [hit("svgr", "./icon.svg?react")]);

    expect(classified).toEqual([]);
  });

  it("drops a preprocessor the project has installed and classifies the others", () => {
    installPackage("sass");
    const hits = [hit("css-preprocessor", "./a.scss"), hit("css-preprocessor", "./b.less")];

    const classified = classifyProjectTransformHits(tmpDir, hits);

    expect(classified).toHaveLength(1);
    expect(classified[0].hit.specifier).toBe("./b.less");
    expect(classified[0].availability).toBe("neither");
  });

  it("returns nothing when the run was asked for no transforms", () => {
    expect(
      classifyProjectTransformHits(tmpDir, [hit("svgr", "./icon.svg?react")], {
        noTransforms: true,
      }),
    ).toEqual([]);
  });
});
