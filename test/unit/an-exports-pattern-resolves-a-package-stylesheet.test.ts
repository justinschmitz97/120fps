import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CSS_IMPORT_SKIPPED_WARNING,
  entryStylesheetImports,
  resolveExportsSubpath,
  resolveStylesheetImportTarget,
} from "../../src/harness/index.js";

const WILDCARD_PKG = path.resolve("fixtures/m131/wildcard-exports-pkg");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-exports-pattern-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// A package resolves from node_modules only, so the fixture package is copied in as installed.
function install(name: string, from: string): string {
  const target = path.join(tmpDir, "node_modules", ...name.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(from, target, { recursive: true });
  return target;
}

function installManifest(name: string, manifest: unknown, files: Record<string, string>): string {
  const target = path.join(tmpDir, "node_modules", ...name.split("/"));
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "package.json"), JSON.stringify({ name, ...(manifest as object) }));
  for (const [relative, body] of Object.entries(files)) {
    const full = path.join(target, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return target;
}

function entryImporting(specifier: string): string {
  const entry = path.join(tmpDir, "src", "main.tsx");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, `import ${JSON.stringify(specifier)};\n`);
  return entry;
}

describe("matching a subpath against an exports field", () => {
  it("prefers an exact key over any pattern", () => {
    const field = { "./400.css": "./exact.css", "./*": "./*" };
    expect(resolveExportsSubpath(field, "400.css")).toBe("./exact.css");
  });

  it("expands a bare star pattern", () => {
    expect(resolveExportsSubpath({ "./*": "./*" }, "dist/index.css")).toBe("./dist/index.css");
  });

  it("prefers the longer suffix when two patterns match", () => {
    const field = { "./*": "./*.css", "./*.css": "./files/*.css" };
    expect(resolveExportsSubpath(field, "400.css")).toBe("./files/400.css");
  });

  it("prefers the longer prefix when two patterns match", () => {
    const field = { "./*": "./generic/*", "./dist/*": "./built/*" };
    expect(resolveExportsSubpath(field, "dist/index.css")).toBe("./built/index.css");
  });

  it("reads the style, then the default, condition of a pattern target", () => {
    const field = { "./*": { sass: "./sass/*.css", default: "./dist/*.css" } };
    expect(resolveExportsSubpath(field, "400")).toBe("./dist/400.css");
  });

  it("uses a pattern target that names one static file for every subpath", () => {
    expect(resolveExportsSubpath({ "./*": "./dist/all.css" }, "400.css")).toBe("./dist/all.css");
  });

  it("returns nothing when no key and no pattern matches", () => {
    expect(resolveExportsSubpath({ ".": "./index.js", "./lib": "./lib.js" }, "400.css")).toBeUndefined();
  });

  it("never treats a null exports target as a match", () => {
    expect(resolveExportsSubpath({ "./*": null }, "400.css")).toBeUndefined();
  });
});

describe("a stylesheet a package exports through a pattern", () => {
  it("resolves the file the pattern names", () => {
    const dir = install("@fixture/wildcard-fontsource", WILDCARD_PKG);
    const entry = entryImporting("@fixture/wildcard-fontsource/400.css");
    expect(resolveStylesheetImportTarget(
      "@fixture/wildcard-fontsource/400.css",
      entry,
      tmpDir,
      [],
    )).toEqual({ file: path.join(dir, "400.css") });
  });

  it("keeps resolving a package that names the subpath exactly", () => {
    const dir = installManifest(
      "exact-exports",
      { exports: { "./dist/index.css": "./dist/index.css" } },
      { "dist/index.css": ".a{}" },
    );
    const entry = entryImporting("exact-exports/dist/index.css");
    expect(resolveStylesheetImportTarget("exact-exports/dist/index.css", entry, tmpDir, [])).toEqual({
      file: path.join(dir, "dist", "index.css"),
    });
  });

  it("falls through to the file on disk when the exports field matches no pattern", () => {
    const dir = installManifest(
      "partial-exports",
      { exports: { ".": "./index.js" } },
      { "dist/index.css": ".a{}" },
    );
    const entry = entryImporting("partial-exports/dist/index.css");
    expect(resolveStylesheetImportTarget("partial-exports/dist/index.css", entry, tmpDir, [])).toEqual({
      file: path.join(dir, "dist", "index.css"),
    });
  });

  it("still reports a specifier whose file exists nowhere, naming the specifier", () => {
    installManifest("unbuilt-exports", { exports: { "./*": "./*" } }, { "index.js": "" });
    const entry = entryImporting("unbuilt-exports/style.css");
    const warnings: string[] = [];
    expect(entryStylesheetImports(entry, tmpDir, [], warnings)).toEqual([]);
    expect(warnings).toEqual([CSS_IMPORT_SKIPPED_WARNING(["unbuilt-exports/style.css"])]);
  });

  it("injects the pattern-resolved sheet as an entry stylesheet", () => {
    const dir = install("@fixture/wildcard-fontsource", WILDCARD_PKG);
    const entry = entryImporting("@fixture/wildcard-fontsource/400.css");
    expect(entryStylesheetImports(entry, tmpDir, [])).toEqual([path.join(dir, "400.css")]);
  });
});
