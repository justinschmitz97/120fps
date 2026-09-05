import { describe, it, expect } from "vitest";
import { cssImportHoistPlugin, hoistStylesheetImports } from "../../src/harness/index.js";

// Statement order is the behaviour under test; blank lines are not.
function lines(css: string | undefined): string[] {
  return (css ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// The plugin's transform hook, called the way Vite calls it.
function transform(code: string, id: string): string | undefined {
  return cssImportHoistPlugin().transform(code, id)?.code;
}

describe("a late css import", () => {
  it("moves above the statement that would make the inliner drop it", () => {
    const code = [
      "@import 'tailwindcss';",
      "",
      "@custom-variant dark (&:is(.dark *));",
      "",
      "@import './theme.css';",
      "",
      "@layer base {",
      "  * { @apply border-border; }",
      "}",
      "",
    ].join("\n");

    expect(lines(hoistStylesheetImports(code))).toEqual([
      "@import 'tailwindcss';",
      "@import './theme.css';",
      "@custom-variant dark (&:is(.dark *));",
      "@layer base {",
      "* { @apply border-border; }",
      "}",
    ]);
  });

  it("keeps the relative order of the imports it moves", () => {
    const code = ".a { color: red; }\n@import './b.css';\n@import './c.css';\n";

    expect(lines(hoistStylesheetImports(code))).toEqual([
      "@import './b.css';",
      "@import './c.css';",
      ".a { color: red; }",
    ]);
  });

  it("leaves a sheet whose imports already come first untouched", () => {
    const code = "@import './a.css';\n@import './b.css';\n.a { color: red; }\n";

    expect(hoistStylesheetImports(code)).toBeUndefined();
  });

  it("keeps @charset and a layer-order statement ahead of the moved imports", () => {
    const code = [
      '@charset "utf-8";',
      "@layer theme, base, utilities;",
      "@custom-variant dark (&:is(.dark *));",
      "@import './theme.css';",
      "",
    ].join("\n");

    expect(lines(hoistStylesheetImports(code))).toEqual([
      '@charset "utf-8";',
      "@layer theme, base, utilities;",
      "@import './theme.css';",
      "@custom-variant dark (&:is(.dark *));",
    ]);
  });

  it("does not treat @import inside a comment or a string as a statement", () => {
    const code = [
      ".a { color: red; }",
      "/* @import './commented.css'; */",
      "b::after { content: \"@import './quoted.css';\"; }",
      "",
    ].join("\n");

    expect(hoistStylesheetImports(code)).toBeUndefined();
  });

  it("does not move an @import that sits inside a block", () => {
    const code = "@media print {\n  @import './print.css';\n}\n.a { color: red; }\n";

    expect(hoistStylesheetImports(code)).toBeUndefined();
  });

  it("leaves a sheet with no import at all alone", () => {
    expect(hoistStylesheetImports(".a { color: red; }\n")).toBeUndefined();
  });
});

describe("the hoisting plugin", () => {
  it("rewrites a stylesheet Vite would compile", () => {
    expect(lines(transform(".a { color: red; }\n@import './b.css';\n", "/repo/src/app.css"))).toEqual(
      ["@import './b.css';", ".a { color: red; }"],
    );
  });

  it("declines a request for the file's bytes", () => {
    const code = ".a { color: red; }\n@import './b.css';\n";

    expect(transform(code, "/repo/src/app.css?raw")).toBeUndefined();
    expect(transform(code, "/repo/src/app.css?url")).toBeUndefined();
    expect(transform(code, "/repo/src/app.css?inline")).toBeUndefined();
  });

  it("declines a preprocessed stylesheet, whose imports the preprocessor resolves", () => {
    expect(transform(".a { color: red; }\n@import './b';\n", "/repo/src/app.scss")).toBeUndefined();
  });

  it("declines a module that is not a stylesheet", () => {
    expect(transform("const a = 1;\n", "/repo/src/app.ts")).toBeUndefined();
  });
});
