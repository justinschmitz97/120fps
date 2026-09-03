import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanExternalDeps } from "../../src/harness.js";

// gutenberg: `packages/element/src/serialize.ts` imports `@wordpress/escape-html`
// with the clause spread over three lines. The single-line-only pattern skipped
// that edge, so the sibling behind it was never reached and the run died on a
// Vite parse error instead of being rescued or reported.
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
});
