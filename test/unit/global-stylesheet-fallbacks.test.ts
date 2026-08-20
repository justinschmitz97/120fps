import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CSS_DROPPED_WARNING,
  CSS_FALLBACK_WARNING,
  GLOBAL_CSS_CANDIDATES,
  detectGlobalCss,
  discoverGlobalCss,
  largestStylesheet,
  validateCssFiles,
} from "../../src/harness.js";
import { resolveCssFiles } from "../../src/analyze.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-css-fallback-"));
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

describe("the conventional-filename candidate list", () => {
  it("keeps the original probe order at the front", () => {
    expect(GLOBAL_CSS_CANDIDATES.slice(0, 8)).toEqual([
      "app/globals.css",
      "app/global.css",
      "src/app/globals.css",
      "src/app/global.css",
      "src/styles/globals.css",
      "styles/globals.css",
      "src/index.css",
      "src/global.css",
    ]);
  });

  it("covers create-vite's own stylesheet name", () => {
    expect(GLOBAL_CSS_CANDIDATES).toContain("src/style.css");
  });

  it("covers the Sass spelling of every conventional name", () => {
    const sassNames = GLOBAL_CSS_CANDIDATES.filter((c) => c.endsWith(".scss"));
    expect(sassNames).toContain("app/globals.scss");
    expect(sassNames).toContain("src/styles/globals.scss");
    expect(sassNames).toContain("src/index.scss");
  });

  it("finds each candidate on its own", () => {
    for (const candidate of GLOBAL_CSS_CANDIDATES) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-css-one-"));
      const full = path.join(dir, candidate);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, ".x{}");
      expect(detectGlobalCss(dir)).toBe(full);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("falling back to a conventional filename", () => {
  it("injects the candidate when no entry module exists", () => {
    const css = write("app/globals.css", "body{}");
    expect(discoverGlobalCss(tmpDir)).toEqual({ files: [css], source: "candidate" });
  });

  it("injects the candidate when the entry imports no stylesheet", () => {
    const css = write("src/index.css", "body{}");
    write("index.html", '<script type="module" src="/src/main.tsx"></script>');
    write("src/main.tsx", 'import "./app";');
    expect(discoverGlobalCss(tmpDir)).toEqual({ files: [css], source: "candidate" });
  });

  it("skips a candidate whose compiler is not installed", () => {
    write("package.json", JSON.stringify({ name: "no-sass" }));
    write("app/globals.scss", "$a: 1;");
    const usable = write("src/index.css", "body{}");
    expect(discoverGlobalCss(tmpDir).files).toEqual([usable]);
  });
});

describe("the largest-stylesheet fallback", () => {
  it("picks the largest stylesheet under the project root", () => {
    write("src/small.css", ".a{}");
    const big = write("src/theme/tokens.css", ".b{}".padEnd(400, " "));
    expect(largestStylesheet(tmpDir)).toBe(big);
  });

  it("never picks a CSS module", () => {
    write("src/widget.module.css", ".w{}".padEnd(800, " "));
    const global = write("src/app.css", ".a{}");
    expect(largestStylesheet(tmpDir)).toBe(global);
  });

  it("ignores stylesheets in dependency and build directories", () => {
    write("node_modules/pkg/dist/style.css", ".p{}".padEnd(900, " "));
    write("dist/assets/index.css", ".d{}".padEnd(900, " "));
    write(".next/static/app.css", ".n{}".padEnd(900, " "));
    const own = write("src/app.css", ".a{}");
    expect(largestStylesheet(tmpDir)).toBe(own);
  });

  it("returns undefined when the project has no stylesheet at all", () => {
    write("src/main.tsx", "export {};");
    expect(largestStylesheet(tmpDir)).toBeUndefined();
  });

  it("injects the pick and says it guessed", () => {
    const only = write("src/theme/tokens.css", ".b{}");
    const warnings: string[] = [];
    expect(discoverGlobalCss(tmpDir, warnings)).toEqual({
      files: [only],
      source: "fallback",
      onlyCandidate: true,
      noEntryInPackage: true,
    });
    expect(warnings).toEqual([
      CSS_FALLBACK_WARNING("src/theme/tokens.css", { onlyCandidate: true, noEntryInPackage: true }),
    ]);
  });

  it("reports nothing found when the project has no stylesheet", () => {
    const warnings: string[] = [];
    expect(discoverGlobalCss(tmpDir, warnings)).toEqual({ files: [], source: "none" });
    expect(warnings).toEqual([]);
  });
});

describe("validating an auto-detected stylesheet before it is embedded", () => {
  it("keeps a file that exists", () => {
    const css = write("src/style.css", "body{}");
    expect(validateCssFiles([css])).toEqual([css]);
  });

  it("drops a path that no longer exists and names it", () => {
    const gone = path.join(tmpDir, "src", "gone.css");
    const warnings: string[] = [];
    expect(validateCssFiles([gone], warnings)).toEqual([]);
    expect(warnings).toEqual([CSS_DROPPED_WARNING(gone)]);
  });

  it("drops a path that is a directory", () => {
    fs.mkdirSync(path.join(tmpDir, "styles.css"), { recursive: true });
    expect(validateCssFiles([path.join(tmpDir, "styles.css")])).toEqual([]);
  });
});

describe("auto-detection through resolveCssFiles", () => {
  it("returns every stylesheet the entry imports", () => {
    const reset = write("src/reset.css", "*{}");
    const theme = write("src/theme.css", ":root{}");
    write("index.html", '<script type="module" src="/src/main.tsx"></script>');
    write("src/main.tsx", 'import "./reset.css";\nimport "./theme.css";');
    expect(resolveCssFiles({}, tmpDir)).toEqual({
      files: [reset, theme],
      autoDetected: true,
      layer: "entry-chain",
    });
  });

  it("forwards a discovery warning to the caller's sink", () => {
    const only = write("src/theme/tokens.css", ".b{}");
    const warnings: string[] = [];
    expect(resolveCssFiles({}, tmpDir, warnings).files).toEqual([only]);
    expect(warnings).toEqual([
      CSS_FALLBACK_WARNING("src/theme/tokens.css", { onlyCandidate: true, noEntryInPackage: true }),
    ]);
  });

  it("stays silent about discovery when --no-css was given", () => {
    write("src/theme/tokens.css", ".b{}");
    const warnings: string[] = [];
    expect(resolveCssFiles({ noCss: true }, tmpDir, warnings)).toEqual({
      files: [],
      autoDetected: false,
      layer: "disabled",
    });
    expect(warnings).toEqual([]);
  });

  it("stays silent about discovery when explicit stylesheets were given", () => {
    const explicit = write("styles/a.css", ".a{}");
    write("src/theme/tokens.css", ".b{}");
    const warnings: string[] = [];
    expect(resolveCssFiles({ cssFiles: [explicit] }, tmpDir, warnings)).toEqual({
      files: [explicit],
      autoDetected: false,
      layer: "explicit",
    });
    expect(warnings).toEqual([]);
  });
});
