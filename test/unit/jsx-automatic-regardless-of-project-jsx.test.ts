import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { transformWithEsbuild } from "vite";
import { harnessEsbuildOptions } from "../../src/harness.js";

const JSX_PRESERVE = path.resolve("fixtures/tsconfig-shapes/jsx-preserve");
const BADGE = path.join(JSX_PRESERVE, "src", "badge.tsx");
const REFERENCES = path.resolve("fixtures/tsconfig-shapes/project-references");

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
});
