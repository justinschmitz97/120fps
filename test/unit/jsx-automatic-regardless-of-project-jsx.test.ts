import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { transformWithEsbuild } from "vite";
import { harnessEsbuildOptions, harnessServerCompileOptions } from "../../src/harness/index.js";

const JSX_PRESERVE = path.resolve("fixtures/tsconfig-shapes/jsx-preserve");
const BADGE = path.join(JSX_PRESERVE, "src", "badge.tsx");
const REFERENCES = path.resolve("fixtures/tsconfig-shapes/project-references");
const BUTTON = path.join(REFERENCES, "src", "components", "Button.tsx");

const cleanupDirs: string[] = [];

afterAll(() => {
  for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// ark's `"jsx": "preserve"` reached vite:esbuild, which then emitted classic
// `React.createElement` calls into files that import only named React exports:
// the first JSX evaluation threw `React is not defined` and the run ended
// before its first measurement. The harness compiles for the automatic runtime
// whatever the project's tsconfig says, as it already did for `.js` since M77.
describe("a tsx file compiles for the automatic runtime under jsx preserve", () => {
  it("emits a jsx-runtime import instead of a bare React.createElement call", async () => {
    const code = fs.readFileSync(BADGE, "utf8");

    const result = await transformWithEsbuild(code, BADGE, {
      ...harnessEsbuildOptions(JSX_PRESERVE),
      loader: "tsx",
    });

    expect(result.code).toContain("react/jsx-runtime");
    expect(result.code).not.toContain("React.createElement");
  });

  it("leaves the classic transform in place when only the project tsconfig is read", async () => {
    const code = fs.readFileSync(BADGE, "utf8");

    const result = await transformWithEsbuild(code, BADGE, { loader: "tsx" });

    expect(result.code).not.toContain("react/jsx-runtime");
  });

  it("names the automatic runtime and the project's own import source", () => {
    expect(harnessEsbuildOptions(JSX_PRESERVE)).toEqual({
      jsx: "automatic",
      jsxImportSource: "react",
    });
  });

  it("reads jsxImportSource through a references-only root", () => {
    expect(harnessEsbuildOptions(REFERENCES).jsxImportSource).toBe("react");
  });

  // A directory query matches whichever referenced config covers any file under
  // the root, so the first `references` entry answered it: create-vite lists
  // the app config first, which hid this. The component's own path decides.
  it("reads the config covering the component, not the first reference entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-jsx-refs-"));
    cleanupDirs.push(dir);
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "refs-order" }));
    fs.writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        files: [],
        references: [{ path: "./tsconfig.node.json" }, { path: "./tsconfig.app.json" }],
      }),
    );
    fs.writeFileSync(
      path.join(dir, "tsconfig.node.json"),
      JSON.stringify({ compilerOptions: { module: "ESNext" }, include: ["vite.config.ts"] }),
    );
    fs.writeFileSync(
      path.join(dir, "tsconfig.app.json"),
      JSON.stringify({ compilerOptions: { jsxImportSource: "preact" }, include: ["src"] }),
    );
    fs.writeFileSync(path.join(dir, "vite.config.ts"), "export default {};\n");
    fs.writeFileSync(path.join(dir, "src", "badge.tsx"), "export const Badge = () => <b />;\n");

    expect(
      harnessEsbuildOptions(dir, dir, path.join(dir, "src", "badge.tsx")).jsxImportSource,
    ).toBe("preact");
  });
});

// The spec's Verification words A3 and A5 as facts about the built server
// options, so the wiring itself is asserted: deleting either spread used to
// leave every test green.
describe("the server compile options carry the harness settings", () => {
  it("carries the esbuild block and the resolve conditions for a react project", () => {
    const compile = harnessServerCompileOptions("react", REFERENCES, REFERENCES, BUTTON, [
      "source",
    ]);

    expect(compile.esbuild).toEqual({ jsx: "automatic", jsxImportSource: "react" });
    expect(compile.conditions).toEqual(["source"]);
  });

  it("omits the esbuild key for a vue project, whose plugin compiles its blocks", () => {
    const compile = harnessServerCompileOptions("vue", REFERENCES, REFERENCES, BUTTON, []);

    expect(compile).not.toHaveProperty("esbuild");
    expect(compile).not.toHaveProperty("conditions");
  });
});
