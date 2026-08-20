import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  recognizeTransform,
  runPreflight,
  PROJECT_TRANSFORM_WARNING,
  transformFailureNote,
} from "../../src/preflight.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function projectWith(files: Record<string, string>): { root: string; entry: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-virtual-module-"));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  // M78: these fixtures test transform recognition, not install state; an
  // empty node_modules keeps them decoupled from the new not-installed check.
  fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
  return { root, entry: path.join(root, "Card.tsx") };
}

describe("WebAssembly module imports", () => {
  it("names the plugin that owns a bare .wasm import", () => {
    const hit = recognizeTransform("./crypto.wasm");
    expect(hit?.code).toBe("wasm");
    expect(hit?.owner).toContain("vite-plugin-wasm");
  });

  it("leaves the query forms Vite core already serves alone", () => {
    expect(recognizeTransform("./crypto.wasm?init")).toBeUndefined();
    expect(recognizeTransform("./crypto.wasm?url")).toBeUndefined();
  });
});

describe("shader module imports", () => {
  it.each(["./water.glsl", "./water.wgsl", "./water.vert", "./water.frag", "./water.geom", "./water.comp"])(
    "names a shader loader for %s",
    (specifier) => {
      const hit = recognizeTransform(specifier);
      expect(hit?.code).toBe("shader");
      expect(hit?.owner).toContain("vite-plugin-glsl");
    },
  );

  it("leaves a source file whose name merely contains a shader word alone", () => {
    expect(recognizeTransform("./fragment.tsx")).toBeUndefined();
    expect(recognizeTransform("./glsl-utils.ts")).toBeUndefined();
  });
});

describe("content module imports already recognized", () => {
  it("keeps naming the GraphQL and MDX owners", () => {
    expect(recognizeTransform("./query.gql")?.code).toBe("graphql");
    expect(recognizeTransform("./query.graphql")?.code).toBe("graphql");
    expect(recognizeTransform("./post.mdx")?.code).toBe("mdx");
  });
});

describe("preflight reporting of virtual modules", () => {
  it("reports a .wasm import as a non-fatal transform note", () => {
    const { root, entry } = projectWith({
      "Card.tsx": 'import init from "./crypto.wasm";\nexport function Card() { return init; }\n',
      "crypto.wasm": "",
    });
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(result.hard).toEqual([]);
    expect(result.transforms.map((h) => h.transformCode)).toEqual(["wasm"]);
    expect(result.transforms[0].specifier).toBe("./crypto.wasm");
  });

  it("reports a shader import and carries the owner into both messages", () => {
    const { root, entry } = projectWith({
      "Card.tsx": 'import src from "./water.frag";\nexport function Card() { return src; }\n',
      "water.frag": "",
    });
    const result = runPreflight({ projectRoot: root, entries: [entry] });
    expect(result.hard).toEqual([]);
    const hit = result.transforms.find((h) => h.transformCode === "shader");
    expect(hit).toBeDefined();
    expect(PROJECT_TRANSFORM_WARNING(hit!)).toContain("vite-plugin-glsl");
    expect(PROJECT_TRANSFORM_WARNING(hit!)).toContain("[transform:shader]");
    expect(transformFailureNote([hit!])).toContain("needs a shader loader plugin");
  });
});
