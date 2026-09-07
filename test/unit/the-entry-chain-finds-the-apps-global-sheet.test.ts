import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverGlobalCss,
  entryModuleImports,
  entryStylesheetImports,
  findProjectEntry,
  nuxtConfigStylesheets,
} from "../../src/harness/index.js";
import { toPosix } from "../../src/shared/index.js";

const FIXTURES = path.resolve("fixtures/m131");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-entry-chain-"));
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

function relatives(root: string, files: string[]): string[] {
  return files.map((file) => toPosix(path.relative(root, file)));
}

describe("the shapes a typical app starts from", () => {
  it("treats a React Router 7 root module as the project entry", () => {
    const root = path.join(FIXTURES, "rr7-root-url");
    expect(findProjectEntry(root)).toBe(path.join(root, "app", "root.tsx"));
  });

  it("prefers a Next.js layout over a router root when a project has both", () => {
    const layout = write("app/layout.tsx", "export default function L() {}");
    write("app/root.tsx", "export default function R() {}");
    expect(findProjectEntry(tmpDir)).toBe(layout);
  });

  it("reads the literal css array of a nuxt config", () => {
    const root = path.join(FIXTURES, "nuxt-config-css");
    expect(relatives(root, nuxtConfigStylesheets(root))).toEqual(["app/assets/css/main.css"]);
  });

  it("reads no css array from a nuxt config that declares none", () => {
    write("nuxt.config.ts", "export default defineNuxtConfig({ devtools: { enabled: true } });");
    expect(nuxtConfigStylesheets(tmpDir)).toEqual([]);
  });

  it("ignores a computed css array instead of executing the config", () => {
    write("app/assets/css/main.css", ".a{}");
    write("nuxt.config.ts", "export default defineNuxtConfig({ css: cssFiles() });");
    expect(nuxtConfigStylesheets(tmpDir)).toEqual([]);
  });
});

describe("the stylesheets an entry module names", () => {
  it("keeps a stylesheet that is imported with a binding and a url query", () => {
    const root = path.join(FIXTURES, "rr7-root-url");
    const found = entryStylesheetImports(path.join(root, "app", "root.tsx"), root, []);
    expect(relatives(root, found)).toEqual(["app/app.css"]);
  });

  it("still ignores a bound css module, which exports class names rather than global rules", () => {
    write("src/card.module.css", ".card{}");
    const entry = write("src/main.tsx", 'import styles from "./card.module.css";');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([]);
  });

  it("resolves a side-effect import with no extension that names a package stylesheet", () => {
    const pkgDir = path.join(tmpDir, "node_modules", "palette-lib");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "palette-lib", exports: { "./css": "./dist/palette.css" } }),
    );
    fs.mkdirSync(path.join(pkgDir, "dist"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "dist", "palette.css"), ".p{}");
    const entry = write("src/main.tsx", 'import "palette-lib/css";');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([
      path.join(pkgDir, "dist", "palette.css"),
    ]);
  });

  it("says nothing about an extensionless import that names a module, not a stylesheet", () => {
    const warnings: string[] = [];
    const entry = write("src/main.tsx", 'import "react-dom/client";\nimport "./setup";');
    write("src/setup.ts", "export const setup = 1;");
    expect(entryStylesheetImports(entry, tmpDir, [], warnings)).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("lists the project-local modules the entry imports, in source order", () => {
    const root = path.join(FIXTURES, "one-hop-plugin");
    const found = entryModuleImports(path.join(root, "src", "main.ts"), root, []);
    expect(relatives(root, found)).toEqual(["src/plugins/assets.ts"]);
  });

  it("does not walk into an installed package for the hop", () => {
    const entry = write("src/main.tsx", 'import "react";\nimport { x } from "some-lib/deep";');
    expect(entryModuleImports(entry, tmpDir, [])).toEqual([]);
  });
});

describe("the sheet a typical app loads is found where the app loads it", () => {
  it("follows a React Router root's bound stylesheet import", () => {
    const root = path.join(FIXTURES, "rr7-root-url");
    const found = discoverGlobalCss(root);
    expect(found.source).toBe("entry");
    expect(relatives(root, found.files)).toEqual(["app/app.css"]);
  });

  it("follows an extensionless side-effect import through a directory index", () => {
    const root = path.join(FIXTURES, "side-effect-directory-index");
    const found = discoverGlobalCss(root);
    expect(found.source).toBe("entry");
    expect(relatives(root, found.files)).toEqual(["src/styles/global.css"]);
  });

  it("follows the entry's own imports one level down", () => {
    const root = path.join(FIXTURES, "one-hop-plugin");
    const found = discoverGlobalCss(root);
    expect(found.source).toBe("entry");
    expect(relatives(root, found.files)).toEqual(["src/styles/global.css"]);
  });

  it("stops one level down, so a sheet two hops from the entry is not the app's global sheet", () => {
    const root = path.join(FIXTURES, "one-hop-plugin");
    expect(relatives(root, discoverGlobalCss(root).files)).not.toContain(
      "src/deep/two-hops-down.css",
    );
  });

  it("reads the script block of a .vue root component reached from the entry", () => {
    const root = path.join(FIXTURES, "vue-entry-root");
    const found = discoverGlobalCss(root);
    expect(found.source).toBe("entry");
    expect(relatives(root, found.files)).toEqual(["src/app.scss"]);
  });

  it("does not turn an SFC style block into an injected stylesheet file", () => {
    const root = path.join(FIXTURES, "vue-entry-root");
    expect(relatives(root, discoverGlobalCss(root).files)).not.toContain("src/App.vue");
  });

  it("takes the css array of a nuxt config as the entry stylesheets", () => {
    const root = path.join(FIXTURES, "nuxt-config-css");
    const found = discoverGlobalCss(root);
    expect(found.source).toBe("entry");
    expect(relatives(root, found.files)).toEqual(["app/assets/css/main.css"]);
  });

  it("keeps the entry decision when a bigger sheet sits elsewhere in the project", () => {
    write("index.html", '<script type="module" src="/src/main.tsx"></script>');
    write("src/main.tsx", 'import "./index.css";');
    write("src/index.css", ".a{color:red}");
    write("vendor/huge.css", ".b{}".repeat(400));
    const found = discoverGlobalCss(tmpDir);
    expect(found.source).toBe("entry");
    expect(relatives(tmpDir, found.files)).toEqual(["src/index.css"]);
  });
});

describe("a candidate the harness cannot preprocess does not end the search", () => {
  it("skips it and keeps ranking the stylesheets below it", () => {
    // .styl needs stylus, which no fixture project installs; the .css below it still wins.
    write("src/theme/huge.styl", ".a { color: red; }\n".repeat(80));
    const usable = write("src/theme/tokens.css", ".b{color:blue}");
    const found = discoverGlobalCss(tmpDir);
    expect(found.source).toBe("fallback");
    expect(found.files).toEqual([usable]);
  });

  it("names the missing preprocessor as the reason it skipped that candidate", () => {
    write("src/theme/huge.styl", ".a { color: red; }\n".repeat(80));
    write("src/theme/tokens.css", ".b{color:blue}");
    const searchNotesOut: string[] = [];
    discoverGlobalCss(tmpDir, [], { searchNotesOut });
    expect(searchNotesOut.join("\n")).toContain("stylus");
    expect(searchNotesOut.join("\n")).toContain("src/theme/huge.styl");
  });

  it("still reports none when every ranked candidate needs a compiler that is absent", () => {
    write("src/theme/a.styl", ".a { color: red; }\n");
    write("src/theme/b.styl", ".b { color: blue; }\n");
    const searchNotesOut: string[] = [];
    expect(discoverGlobalCss(tmpDir, [], { searchNotesOut })).toEqual({ files: [], source: "none" });
    expect(searchNotesOut.join("\n")).toContain("stylus");
  });

  it("keeps at most four reasons, so the line stays a diagnosis", () => {
    for (const name of ["a", "b", "c", "d", "e", "f"]) {
      write(`src/theme/${name}.styl`, ".x { color: red; }\n");
    }
    const searchNotesOut: string[] = [];
    discoverGlobalCss(tmpDir, [], { searchNotesOut });
    expect(searchNotesOut.length).toBeLessThanOrEqual(4);
  });
});

describe("what the size-ranked fallback refuses to pick", () => {
  it("skips a Sass partial, which the compiler never emits on its own", () => {
    write("src/scss/_tokens.scss", ":root { --a: 1; }\n".repeat(40));
    const own = write("src/scss/app.scss", ".app { color: red; }");
    const found = discoverGlobalCss(tmpDir);
    expect(found.source).toBe("fallback");
    expect(found.files).toEqual([own]);
  });

  it("names the partial as the reason it was skipped", () => {
    write("src/scss/_tokens.scss", ":root { --a: 1; }\n".repeat(40));
    const searchNotesOut: string[] = [];
    expect(discoverGlobalCss(tmpDir, [], { searchNotesOut })).toEqual({ files: [], source: "none" });
    expect(searchNotesOut.join("\n")).toContain("src/scss/_tokens.scss");
    expect(searchNotesOut.join("\n")).toContain("Sass partial");
  });

  it("keeps a plain .css file whose name starts with an underscore", () => {
    const underscored = write("src/_theme.css", ".t { color: red; }");
    expect(discoverGlobalCss(tmpDir).files).toEqual([underscored]);
  });
});

describe("a stylesheet the project cannot compile itself", () => {
  it("is still injected when 120fps's own Sass can compile it", () => {
    write("index.html", '<script type="module" src="/src/main.tsx"></script>');
    write("src/main.tsx", 'import "./app.scss";');
    const sheet = write("src/app.scss", ".a { color: red; }");
    const warnings: string[] = [];
    const found = discoverGlobalCss(tmpDir, warnings);
    expect(found.files).toEqual([sheet]);
    expect(warnings.join("\n")).not.toContain("does not have installed");
  });

  it("is still refused when no implementation exists at all", () => {
    write("index.html", '<script type="module" src="/src/main.tsx"></script>');
    write("src/main.tsx", 'import "./app.styl";');
    write("src/app.styl", ".a { color: red; }");
    const warnings: string[] = [];
    expect(discoverGlobalCss(tmpDir, warnings).files).toEqual([]);
    expect(warnings.join("\n")).toContain("stylus");
  });
});

describe("a stylesheet import whose query says it is not a loaded sheet", () => {
  it("keeps a bound import that only asks for the url", () => {
    write("src/app.css", ".a { color: red; }");
    const entry = write("src/main.tsx", 'import href from "./app.css?url";');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([path.join(tmpDir, "src", "app.css")]);
  });

  it("drops a bound import asking for the source text", () => {
    write("src/app.css", ".a { color: red; }");
    const entry = write("src/main.tsx", 'import text from "./app.css?raw";');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([]);
  });

  it("drops an import asking for the compiled string instead of a loaded sheet", () => {
    write("src/app.css", ".a { color: red; }");
    const entry = write("src/main.tsx", 'import css from "./app.css?inline";');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([]);
  });

  it("drops a side-effect import with the same query", () => {
    write("src/app.css", ".a { color: red; }");
    const entry = write("src/main.tsx", 'import "./app.css?inline";');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([]);
  });

  it("keeps a plain side-effect import that carries an unrelated query", () => {
    write("src/app.css", ".a { color: red; }");
    const entry = write("src/main.tsx", 'import "./app.css?used";');
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([path.join(tmpDir, "src", "app.css")]);
  });

  it("does not follow a module imported for its source text", () => {
    write("src/worker.ts", "export const w = 1;");
    const entry = write("src/main.tsx", 'import W from "./worker?worker";');
    expect(entryModuleImports(entry, tmpDir, [])).toEqual([]);
  });

  it("never injects a raw-imported sheet as the app's global stylesheet", () => {
    write("index.html", '<script type="module" src="/src/main.tsx"></script>');
    write("src/main.tsx", 'import text from "./app.css?raw";');
    write("src/app.css", ".a { color: red; }");
    expect(discoverGlobalCss(tmpDir).source).not.toBe("entry");
  });
});

describe("a nuxt config that names a package stylesheet", () => {
  it("resolves it through the installed package", () => {
    const pkgDir = path.join(tmpDir, "node_modules", "element-plus", "dist");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "node_modules", "element-plus", "package.json"),
      JSON.stringify({ name: "element-plus", exports: { "./*": "./*" } }),
    );
    fs.writeFileSync(path.join(pkgDir, "index.css"), ".el { color: red; }");
    write("nuxt.config.ts", 'export default defineNuxtConfig({ css: ["element-plus/dist/index.css"] });');
    expect(nuxtConfigStylesheets(tmpDir)).toEqual([path.join(pkgDir, "index.css")]);
  });

  it("resolves an extensionless package entry the package exports as a stylesheet", () => {
    const pkgDir = path.join(tmpDir, "node_modules", "vuetify");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "vuetify", exports: { "./styles": "./lib/styles/main.css" } }),
    );
    fs.mkdirSync(path.join(pkgDir, "lib", "styles"), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "lib", "styles", "main.css"), ".v { color: red; }");
    write("nuxt.config.ts", 'export default defineNuxtConfig({ css: ["vuetify/styles"] });');
    expect(nuxtConfigStylesheets(tmpDir)).toEqual([path.join(pkgDir, "lib", "styles", "main.css")]);
  });

  it("collects the entries that resolve to nothing instead of dropping them silently", () => {
    write("nuxt.config.ts", 'export default defineNuxtConfig({ css: ["@unocss/reset/tailwind.css"] });');
    const unresolved: string[] = [];
    expect(nuxtConfigStylesheets(tmpDir, [], unresolved)).toEqual([]);
    expect(unresolved).toEqual(["@unocss/reset/tailwind.css"]);
  });

  it("says on the discovery line that a config entry resolved to no file", () => {
    write("nuxt.config.ts", 'export default defineNuxtConfig({ css: ["@unocss/reset/tailwind.css"] });');
    const searchNotesOut: string[] = [];
    discoverGlobalCss(tmpDir, [], { searchNotesOut });
    expect(searchNotesOut.join("\n")).toContain("@unocss/reset/tailwind.css");
    expect(searchNotesOut.join("\n")).toContain("resolved to no file");
  });
});

describe("a conventional filename whose sheet has no bodied rule", () => {
  it("reports none found and names that sheet as the reason", () => {
    write("app/globals.css", "@layer base;\n@import 'tailwindcss';\n");
    const searchNotesOut: string[] = [];
    const found = discoverGlobalCss(tmpDir, [], { searchNotesOut });
    expect(found).toEqual({ files: [], source: "none" });
    expect(searchNotesOut.join("\n")).toContain("app/globals.css");
    expect(searchNotesOut.join("\n")).toContain("no CSS rule with a body of its own");
    expect(searchNotesOut.join("\n")).toContain("Tailwind");
  });

  it("states the reason once, not once per layer that saw it", () => {
    write("app/globals.css", "@layer base;\n@import 'tailwindcss';\n");
    const searchNotesOut: string[] = [];
    discoverGlobalCss(tmpDir, [], { searchNotesOut });
    const named = searchNotesOut.filter((note) => note.startsWith("app/globals.css"));
    expect(named).toHaveLength(1);
  });
});
