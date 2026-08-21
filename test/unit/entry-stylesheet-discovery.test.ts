import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CSS_IMPORT_SKIPPED_WARNING,
  CSS_PREPROCESSOR_MISSING_WARNING,
  discoverGlobalCss,
  entryStylesheetImports,
  findProjectEntry,
} from "../../src/harness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-entry-css-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relative: string, body: string): string {
  const full = path.join(tmpDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

const FIXTURE_APP = path.resolve("fixtures/vite-app");

describe("locating the project's own entry module", () => {
  it("follows the module script of a root index.html", () => {
    const entry = write("src/main.tsx", "export {};");
    write("index.html", '<body><script type="module" src="/src/main.tsx"></script></body>');
    expect(findProjectEntry(tmpDir)).toBe(entry);
  });

  it("resolves a relative module script against the html file", () => {
    const entry = write("src/main.jsx", "export {};");
    write("index.html", '<body><script type="module" src="./src/main.jsx"></script></body>');
    expect(findProjectEntry(tmpDir)).toBe(entry);
  });

  it("reads the src when it is written before the type attribute", () => {
    const entry = write("src/main.ts", "export {};");
    write("index.html", '<script src="/src/main.ts" type="module"></script>');
    expect(findProjectEntry(tmpDir)).toBe(entry);
  });

  it("ignores a classic script tag", () => {
    write("legacy.js", "console.log(1);");
    write("index.html", '<script src="/legacy.js"></script>');
    expect(findProjectEntry(tmpDir)).toBeUndefined();
  });

  it("ignores a module script whose target does not exist", () => {
    write("index.html", '<script type="module" src="/src/gone.tsx"></script>');
    expect(findProjectEntry(tmpDir)).toBeUndefined();
  });

  it("falls back to the Next.js app router layout", () => {
    const layout = write("app/layout.tsx", "export default function L() {}");
    expect(findProjectEntry(tmpDir)).toBe(layout);
  });

  it("finds a src/app layout", () => {
    const layout = write("src/app/layout.jsx", "export default function L() {}");
    expect(findProjectEntry(tmpDir)).toBe(layout);
  });

  it("finds a pages router _app module", () => {
    const app = write("pages/_app.tsx", "export default function A() {}");
    expect(findProjectEntry(tmpDir)).toBe(app);
  });

  it("prefers index.html over a Next.js layout", () => {
    const entry = write("src/main.tsx", "export {};");
    write("app/layout.tsx", "export default function L() {}");
    write("index.html", '<script type="module" src="/src/main.tsx"></script>');
    expect(findProjectEntry(tmpDir)).toBe(entry);
  });

  it("returns undefined for a project with neither", () => {
    expect(findProjectEntry(tmpDir)).toBeUndefined();
  });
});

describe("collecting an entry's own stylesheet imports", () => {
  it("collects a relative side-effect stylesheet import", () => {
    const css = write("src/style.css", "body{}");
    const entry = write("src/main.tsx", 'import "./style.css";\nexport {};');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([css]);
  });

  it("keeps several stylesheets in import order", () => {
    const reset = write("src/reset.css", "*{}");
    const theme = write("src/theme.css", ":root{}");
    const entry = write("src/main.tsx", 'import "./reset.css";\nimport "./theme.css";');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([reset, theme]);
  });

  it("skips a CSS module side-effect import", () => {
    write("src/widget.module.css", ".w{}");
    const global = write("src/style.css", "body{}");
    const entry = write("src/main.tsx", 'import "./widget.module.css";\nimport "./style.css";');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([global]);
  });

  it("ignores a bound import of a stylesheet", () => {
    write("src/widget.module.css", ".w{}");
    const entry = write("src/main.tsx", 'import styles from "./widget.module.css";');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([]);
  });

  it("ignores non-stylesheet side-effect imports", () => {
    const entry = write("src/main.tsx", 'import "./polyfills";\nimport "react";');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([]);
  });

  it("ignores a stylesheet import inside a comment", () => {
    write("src/style.css", "body{}");
    const entry = write("src/main.tsx", '// import "./style.css";\nexport {};');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([]);
  });

  it("resolves an aliased stylesheet through the project's alias table", () => {
    const css = write("app/globals.css", "body{}");
    const entry = write("app/layout.tsx", 'import "@/app/globals.css";');
    const alias = [{ find: /^@\//, replacement: path.join(tmpDir, "/").replace(/\\/g, "/") }];
    expect(entryStylesheetImports(entry, tmpDir, alias)).toEqual([css]);
  });

  it("names an unresolvable stylesheet specifier instead of injecting it", () => {
    const entry = write("app/layout.tsx", 'import "@/app/globals.css";\nimport "normalize.css";');
    const warnings: string[] = [];
    expect(entryStylesheetImports(entry, tmpDir, [], warnings)).toEqual([]);
    expect(warnings).toEqual([CSS_IMPORT_SKIPPED_WARNING(["@/app/globals.css", "normalize.css"])]);
  });

  it("does not treat an extensionless package subpath as a stylesheet", () => {
    const entry = write("src/main.tsx", 'import "swiper/css";');
    const warnings: string[] = [];
    expect(entryStylesheetImports(entry, tmpDir, [], warnings)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("resolves a bare package subpath stylesheet through its exports map", () => {
    write(
      "node_modules/twenty-ui/package.json",
      JSON.stringify({
        name: "twenty-ui",
        exports: {
          "./style.css": "./dist/style.css",
          "./theme-light.css": "./dist/theme-light.css",
          "./theme-dark.css": "./dist/theme-dark.css",
        },
      }),
    );
    const light = write("node_modules/twenty-ui/dist/theme-light.css", ":root{}");
    const dark = write("node_modules/twenty-ui/dist/theme-dark.css", ":root{}");
    // dist/style.css is intentionally never written: genuinely missing.
    const entry = write(
      "src/main.tsx",
      'import "twenty-ui/style.css";\n' +
        'import "twenty-ui/theme-light.css";\n' +
        'import "twenty-ui/theme-dark.css";\n',
    );
    const warnings: string[] = [];
    expect(entryStylesheetImports(entry, tmpDir, [], warnings)).toEqual([light, dark]);
    expect(warnings).toEqual([CSS_IMPORT_SKIPPED_WARNING(["twenty-ui/style.css"])]);
  });

  it("resolves a scoped package subpath stylesheet with no exports map via a direct join", () => {
    write("node_modules/@fontsource/dm-mono/package.json", JSON.stringify({ name: "@fontsource/dm-mono" }));
    const css = write("node_modules/@fontsource/dm-mono/400.css", "@font-face{}");
    const entry = write("src/main.tsx", 'import "@fontsource/dm-mono/400.css";');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([css]);
  });

  it("names a relative stylesheet import whose file is missing", () => {
    const entry = write("src/main.tsx", 'import "./gone.css";');
    const warnings: string[] = [];
    expect(entryStylesheetImports(entry, tmpDir, [], warnings)).toEqual([]);
    expect(warnings).toEqual([CSS_IMPORT_SKIPPED_WARNING(["./gone.css"])]);
  });

  it("skips a preprocessor stylesheet when its compiler is not installed", () => {
    write("package.json", JSON.stringify({ name: "no-sass" }));
    write("src/theme.scss", "$a: 1;");
    const css = write("src/style.css", "body{}");
    const entry = write("src/main.tsx", 'import "./theme.scss";\nimport "./style.css";');
    const warnings: string[] = [];
    expect(entryStylesheetImports(entry, tmpDir, [], warnings)).toEqual([css]);
    expect(warnings).toEqual([
      CSS_PREPROCESSOR_MISSING_WARNING(path.join(tmpDir, "src", "theme.scss"), "sass"),
    ]);
  });

  it("keeps a preprocessor stylesheet when the project declares its compiler", () => {
    write("package.json", JSON.stringify({ name: "with-sass", devDependencies: { sass: "^1.83.0" } }));
    const scss = write("src/theme.scss", "$a: 1;");
    const entry = write("src/main.tsx", 'import "./theme.scss";');
    const warnings: string[] = [];
    expect(entryStylesheetImports(entry, tmpDir, [], warnings)).toEqual([scss]);
    expect(warnings).toEqual([]);
  });

  it("returns nothing for an unreadable entry file", () => {
    expect(entryStylesheetImports(path.join(tmpDir, "nope.tsx"), tmpDir, [])).toEqual([]);
  });
});

describe("discovery on a create-vite shaped project", () => {
  it("injects the entry's global stylesheets and skips its CSS module", () => {
    const result = discoverGlobalCss(FIXTURE_APP);
    expect(result.source).toBe("entry");
    expect(result.files).toEqual([
      path.join(FIXTURE_APP, "src", "style.css"),
      path.join(FIXTURE_APP, "src", "theme.scss"),
    ]);
  });

  it("reports no warning for a project whose imports all resolve", () => {
    const warnings: string[] = [];
    discoverGlobalCss(FIXTURE_APP, warnings);
    expect(warnings).toEqual([]);
  });

  it("prefers the entry graph over a conventional filename", () => {
    write("src/index.css", "body{}");
    const chosen = write("src/style.css", "body{}");
    write("index.html", '<script type="module" src="/src/main.tsx"></script>');
    write("src/main.tsx", 'import "./style.css";');
    const result = discoverGlobalCss(tmpDir);
    expect(result).toEqual({ files: [chosen], source: "entry" });
  });
});
