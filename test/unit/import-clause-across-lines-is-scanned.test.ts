import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanExternalDeps } from "../../src/harness/index.js";

// gutenberg: a multi-line import clause skipped the single-line scan, killing the parse.
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-multiline-import-"));
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "p" }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function scan(source: string): string[] {
  const entry = path.join(tmpDir, "Widget.tsx");
  fs.writeFileSync(entry, source);
  return scanExternalDeps(entry, tmpDir, []);
}

describe("an import clause spread over several lines", () => {
  it("names its package the way the one-line form does", () => {
    expect(
      scan(`import {\n  escapeHTML,\n} from "@wordpress/escape-html";\nexport const W = escapeHTML;\n`),
    ).toContain("@wordpress/escape-html");
  });

  it("leaves a side-effect import above it readable", () => {
    const externals = scan(
      `import "normalize.css";\nimport {\n  escapeHTML,\n} from "@wordpress/escape-html";\nexport const W = escapeHTML;\n`,
    );

    expect(externals).toContain("normalize.css");
    expect(externals).toContain("@wordpress/escape-html");
  });

  it("leaves a side-effect import above it readable without a semicolon", () => {
    const externals = scan(
      `import "normalize.css"\nimport {\n  escapeHTML,\n} from "@wordpress/escape-html"\nexport const W = escapeHTML\n`,
    );

    expect(externals).toContain("normalize.css");
    expect(externals).toContain("@wordpress/escape-html");
  });

  it("still excludes a whole-clause type import written over several lines", () => {
    expect(
      scan(`import type {\n  Props,\n} from "type-only-pkg";\nexport const W = (p: Props) => p;\n`),
    ).not.toContain("type-only-pkg");
  });

  it("reads a multi-line re-export clause", () => {
    expect(
      scan(`export {\n  Button,\n} from "@wordpress/components";\n`),
    ).toContain("@wordpress/components");
  });

  // A comment, JSX text, or template literal after export can hold `from "x"` but isn't an import.
  it("stops at prose in a comment below an export keyword", () => {
    expect(scan('export function useX() {\n  // pulled from "the store"\n  return 1;\n}\n')).toEqual(
      [],
    );
  });

  it("stops at JSX text below an export keyword", () => {
    expect(scan('export const W = () => <p>copied from "the docs"</p>;\n')).toEqual([]);
  });

  it("does not read a data: URL body as an import clause", () => {
    expect(
      scan(
        "export const src = `data:text/javascript,export default {}`;\nexport const W = () => src;\n",
      ),
    ).toEqual([]);
  });
});
