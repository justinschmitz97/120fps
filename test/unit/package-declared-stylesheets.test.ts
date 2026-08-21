import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverGlobalCss,
  packageStylesheetCandidates,
  resolveStylesheetImportTarget,
  stylesheetImportSpecifiers,
} from "../../src/harness.js";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-pkgcss-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, body: string): string {
  const full = path.join(root, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

const rel = (file: string): string => path.relative(root, file).replace(/\\/g, "/");

describe("a stylesheet's own import statements", () => {
  it("reads quoted, url() and layered forms in source order", () => {
    const file = write(
      "src/styles.css",
      `/* comment @import "./ignored.css"; */\n` +
        `@charset "utf-8";\n` +
        `@import "@heroui/styles";\n` +
        `@import url('./theme.css');\n` +
        `@import "./print.css" print;\n` +
        `@import "./layered.css" layer(base);\n` +
        `.a { color: red }\n`,
    );
    expect(stylesheetImportSpecifiers(file)).toEqual([
      "@heroui/styles",
      "./theme.css",
      "./print.css",
      "./layered.css",
    ]);
  });

  it("drops a query suffix and returns nothing for a file it cannot read", () => {
    const file = write("a.css", '@import "./theme.css?inline";');
    expect(stylesheetImportSpecifiers(file)).toEqual(["./theme.css"]);
    expect(stylesheetImportSpecifiers(path.join(root, "gone.css"))).toEqual([]);
  });
});

describe("resolving one stylesheet import the way a bundler would", () => {
  it("resolves a relative import to the file beside it", () => {
    const theme = write("src/theme.css", ".a{}");
    const entry = write("src/styles.css", '@import "./theme.css";');
    expect(resolveStylesheetImportTarget("./theme.css", entry, root, [])).toEqual({ file: theme });
  });

  it("names a relative import that does not exist as declared and absent", () => {
    const entry = write("src/styles.css", '@import "./gone.css";');
    expect(resolveStylesheetImportTarget("./gone.css", entry, root, [])).toEqual({
      declared: path.join(root, "src", "gone.css"),
    });
  });

  it("resolves a bare package root through the package's own style export", () => {
    const index = write("node_modules/@heroui/styles/index.css", ".button{}");
    write(
      "node_modules/@heroui/styles/package.json",
      JSON.stringify({ name: "@heroui/styles", exports: { ".": { style: "./index.css" } } }),
    );
    write("package.json", JSON.stringify({ name: "react" }));
    const entry = write("src/styles.css", '@import "@heroui/styles";');
    expect(resolveStylesheetImportTarget("@heroui/styles", entry, root, [])).toEqual({ file: index });
  });

  it("resolves a bare package root through a top-level style field", () => {
    const index = write("node_modules/pkg/theme.css", ".a{}");
    write("node_modules/pkg/package.json", JSON.stringify({ name: "pkg", style: "./theme.css" }));
    write("package.json", JSON.stringify({ name: "app" }));
    const entry = write("src/styles.css", '@import "pkg";');
    expect(resolveStylesheetImportTarget("pkg", entry, root, [])).toEqual({ file: index });
  });

  it("names the subpath a package's exports map declares but has not built", () => {
    write(
      "node_modules/shadcn/package.json",
      JSON.stringify({ name: "shadcn", exports: { "./tailwind.css": "./dist/tailwind.css" } }),
    );
    write("package.json", JSON.stringify({ name: "app" }));
    const entry = write("app/globals.css", '@import "shadcn/tailwind.css";');
    expect(resolveStylesheetImportTarget("shadcn/tailwind.css", entry, root, [])).toEqual({
      declared: path.join(root, "node_modules", "shadcn", "dist", "tailwind.css"),
    });
  });

  it("reports nothing for a package that is not installed at all", () => {
    write("package.json", JSON.stringify({ name: "app" }));
    const entry = write("app/globals.css", '@import "absent/x.css";');
    expect(resolveStylesheetImportTarget("absent/x.css", entry, root, [])).toBeUndefined();
  });
});

// ant-design (`@import "../variables"`) and primevue (`@import './_mixins'`)
// write the canonical Sass/Less partial form: no extension, an underscore the
// importer never spells, sometimes a directory with an `_index`. None of that
// is a missing file, and none of it may be reported as one.
describe("a preprocessor partial imported without its extension", () => {
  it("resolves an underscore-prefixed sibling", () => {
    const real = write("src/_variables.scss", "$a: 1;");
    const entry = write("src/styles.scss", '@import "./_variables";');
    expect(resolveStylesheetImportTarget("./_variables", entry, root, [])).toEqual({ file: real });
  });

  it("resolves a partial the importer spells without its underscore", () => {
    const real = write("theme/_mixins.scss", "@mixin a {}");
    const entry = write("theme/base/index.scss", '@import "../mixins";');
    expect(resolveStylesheetImportTarget("../mixins", entry, root, [])).toEqual({ file: real });
  });

  it("resolves a Less partial the same way", () => {
    const real = write("components/style/variables.less", "@a: 1;");
    const entry = write("components/button/style/index.less", '@import "../../style/variables";');
    expect(resolveStylesheetImportTarget("../../style/variables", entry, root, [])).toEqual({
      file: real,
    });
  });

  it("resolves a directory's own index partial", () => {
    const real = write("src/theme/_index.scss", "$a: 1;");
    const entry = write("src/styles.scss", '@import "./theme";');
    expect(resolveStylesheetImportTarget("./theme", entry, root, [])).toEqual({ file: real });
  });

  it("claims nothing about an extension-less import it cannot place", () => {
    const entry = write("src/styles.scss", '@import "./nowhere";');
    expect(resolveStylesheetImportTarget("./nowhere", entry, root, [])).toBeUndefined();
  });

  it("still names a missing file whose specifier carries an extension", () => {
    const entry = write("src/styles.css", '@import "./gone.css";');
    expect(resolveStylesheetImportTarget("./gone.css", entry, root, [])).toEqual({
      declared: path.join(root, "src", "gone.css"),
    });
  });

  it("keeps a stylesheet whose partials all resolve, and warns about none of them", () => {
    write("package.json", JSON.stringify({ name: "lib", devDependencies: { sass: "^1.83.0" } }));
    write("src/_variables.scss", "$a: 1;");
    const styles = write("src/styles.scss", '@import "./_variables"; .a { color: red }');
    const warnings: string[] = [];
    const result = discoverGlobalCss(root, warnings);
    expect(result.files).toEqual([styles]);
    expect(warnings.filter((w) => w.includes("_variables"))).toEqual([]);
  });
});

describe("stylesheets the measured package declares about itself", () => {
  it("collects style, the styles export, the style.css export and any subpath style condition", () => {
    const styleField = write("dist/theme.css", ".a{}");
    const stylesExport = write("src/styles.css", ".b{}");
    const styleCssExport = write("src/style.css", ".c{}");
    const subpathStyle = write("src/table.css", ".d{}");
    write(
      "package.json",
      JSON.stringify({
        name: "react",
        style: "./dist/theme.css",
        exports: {
          "./styles": { style: "./src/styles.css", default: "./src/styles.css" },
          "./style.css": "./src/style.css",
          "./table": { style: "./src/table.css", default: "./src/table.js" },
        },
      }),
    );
    expect(packageStylesheetCandidates(root)).toEqual([
      styleField,
      stylesExport,
      styleCssExport,
      subpathStyle,
    ]);
  });

  it("ignores declarations that name no file on disk and non-stylesheet targets", () => {
    write(
      "package.json",
      JSON.stringify({
        name: "react",
        style: "./dist/missing.css",
        exports: { "./styles": "./src/styles.js" },
      }),
    );
    expect(packageStylesheetCandidates(root)).toEqual([]);
  });

  it("is empty for a package with no manifest at all", () => {
    expect(packageStylesheetCandidates(root)).toEqual([]);
  });
});

// heroui: `exports["./styles"] -> src/styles.css`, one line long, importing the
// real ~600-line stylesheet from an installed sibling package.
describe("a package whose declared stylesheet is a passthrough", () => {
  function heroui(): string {
    const real = write("node_modules/@heroui/styles/index.css", ".button--primary{color:red}");
    write(
      "node_modules/@heroui/styles/package.json",
      JSON.stringify({ name: "@heroui/styles", exports: { ".": { style: "./index.css" } } }),
    );
    write(
      "package.json",
      JSON.stringify({ name: "@heroui/react", exports: { "./styles": { style: "./src/styles.css" } } }),
    );
    write("src/styles.css", '/* Placeholder file for build process */\n@import "@heroui/styles";\n');
    return real;
  }

  it("injects what the passthrough imports instead of reporting none found", () => {
    const real = heroui();
    const warnings: string[] = [];
    const result = discoverGlobalCss(root, warnings);
    expect(result.files).toEqual([real]);
    // Evidence the package published about itself, not a filename convention:
    // the report layer and its label key on this value.
    expect(result.source).toBe("package-declared");
  });

  it("says which passthrough was replaced and by what", () => {
    heroui();
    const warnings: string[] = [];
    discoverGlobalCss(root, warnings);
    const disclosure = warnings.find((w) => w.includes("src/styles.css"));
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain("no CSS rule of its own");
    expect(disclosure).toContain("index.css");
  });

  it("finds src/styles.css by conventional name as well", () => {
    const real = write("src/real.css", ".a{}");
    write("package.json", JSON.stringify({ name: "lib" }));
    write("src/styles.css", '@import "./real.css";');
    const result = discoverGlobalCss(root, []);
    expect(result.files).toEqual([real]);
    // Reached by name, not by declaration: the conventional layer, unchanged.
    expect(result.source).toBe("candidate");
  });

  it("skips the candidate when its imports resolve to nothing", () => {
    write("package.json", JSON.stringify({ name: "lib", style: "./src/styles.css" }));
    write("src/styles.css", '@import "@absent/styles";');
    write("other.css", ".real{}");
    const result = discoverGlobalCss(root, []);
    expect(result.files).toEqual([path.join(root, "other.css")]);
    expect(result.source).toBe("fallback");
  });
});

// shadcn-ui: apps/v4/app/globals.css is real and injectable, but its own
// `@import "shadcn/tailwind.css"` resolves to a dist/ the repo has not built,
// which used to fail inside the bundler — fatally for two of four components.
describe("a stylesheet whose own import names a file that was never built", () => {
  function shadcn(): void {
    write("package.json", JSON.stringify({ name: "v4" }));
    write(
      "node_modules/shadcn/package.json",
      JSON.stringify({ name: "shadcn", exports: { "./tailwind.css": "./dist/tailwind.css" } }),
    );
    write("app/globals.css", '@import "shadcn/tailwind.css";\n.body{margin:0}\n');
    write("index.html", '<script type="module" src="/app/layout.tsx"></script>');
    write("app/layout.tsx", 'import "./globals.css";\nexport default null;');
  }

  it("is dropped before it can reach the bundler", () => {
    shadcn();
    const result = discoverGlobalCss(root, []);
    expect(result.files).toEqual([]);
  });

  it("names the path the package's own exports map declares", () => {
    shadcn();
    const warnings: string[] = [];
    discoverGlobalCss(root, warnings);
    const disclosure = warnings.find((w) => w.includes("tailwind.css"));
    expect(disclosure).toBeDefined();
    expect(disclosure).toContain("node_modules/shadcn/dist/tailwind.css");
    // The old message pasted the specifier onto the repository root and named
    // a path that exists nowhere.
    expect(disclosure).not.toContain(`resolves to ${rel(path.join(root, "shadcn"))}/tailwind.css`);
  });

  it("does not re-pick the same file through a later layer", () => {
    shadcn();
    write("app/globals.scss", "");
    const result = discoverGlobalCss(root, []);
    expect(result.files).toEqual([]);
    expect(result.source).toBe("none");
  });

  it("keeps a stylesheet whose imports all resolve", () => {
    write("package.json", JSON.stringify({ name: "v4" }));
    write("app/tokens.css", ":root{--a:1}");
    const globals = write("app/globals.css", '@import "./tokens.css";\n.body{margin:0}\n');
    write("index.html", '<script type="module" src="/app/layout.tsx"></script>');
    write("app/layout.tsx", 'import "./globals.css";\nexport default null;');
    expect(discoverGlobalCss(root, []).files).toEqual([globals]);
  });
});
