import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCssFiles } from "../../src/analyze.js";
import { buildEnvFingerprint } from "../../src/budget.js";
import { DEFAULT_THRESHOLDS, formatTable, type CssReport, type Report } from "../../src/report.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-css-report-"));
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

function manifest(deps: Record<string, string>): void {
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "p", dependencies: deps }));
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: {
      cpu: "Test CPU",
      cores: 8,
      ramMb: 16384,
      os: "TestOS 1.0",
      nodeVersion: "v20.0.0",
      chromiumVersion: "120.0.0",
    },
    componentPath: "./Button.tsx",
    componentName: "Button",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [],
    thresholds: { ...DEFAULT_THRESHOLDS },
    pass: true,
    ...overrides,
  };
}

describe("resolveCssFiles names which layer decided", () => {
  it("entry-chain: the project entry's own imports", () => {
    const css = write("src/style.css", "body{}");
    write("index.html", '<script type="module" src="/src/main.tsx"></script>');
    write("src/main.tsx", 'import "./style.css";');
    expect(resolveCssFiles({}, tmpDir)).toEqual({
      files: [css],
      autoDetected: true,
      layer: "entry-chain",
    });
  });

  it("known-name: a conventional filename with no entry present", () => {
    const css = write("app/globals.css", "body{}");
    expect(resolveCssFiles({}, tmpDir)).toEqual({
      files: [css],
      autoDetected: true,
      layer: "known-name",
    });
  });

  it("largest-fallback: names onlyCandidate and noEntryInPackage", () => {
    const css = write("src/theme/tokens.css", ".a{color:red}");
    expect(resolveCssFiles({}, tmpDir)).toEqual({
      files: [css],
      autoDetected: true,
      layer: "largest-fallback",
      onlyCandidate: true,
      noEntryInPackage: true,
    });
  });

  it("runtime: nothing survives the fallback walk and a runtime engine is declared", () => {
    manifest({ "styled-components": "^6.0.0" });
    expect(resolveCssFiles({}, tmpDir)).toEqual({
      files: [],
      autoDetected: false,
      layer: "runtime",
      runtimeEngines: ["styled-components"],
    });
  });

  it("none: nothing is found and no runtime engine is declared", () => {
    expect(resolveCssFiles({}, tmpDir)).toEqual({
      files: [],
      autoDetected: false,
      layer: "none",
    });
  });

  it("disabled: --no-css", () => {
    write("app/globals.css", "body{}");
    expect(resolveCssFiles({ noCss: true }, tmpDir)).toEqual({
      files: [],
      autoDetected: false,
      layer: "disabled",
    });
  });

  it("explicit: a user-supplied --css", () => {
    const explicit = write("styles/a.css", ".x{}");
    expect(resolveCssFiles({ cssFiles: [explicit] }, tmpDir)).toEqual({
      files: [explicit],
      autoDetected: false,
      layer: "explicit",
    });
  });
});

describe("formatTable's Stylesheets line is always disclosed, keyed on layer", () => {
  it("entry-chain", () => {
    const css: CssReport = { files: ["src/style.css"], autoDetected: true, layer: "entry-chain" };
    expect(formatTable(makeReport({ css }))).toContain(
      "Stylesheets: src/style.css (found in the project entry's own imports)",
    );
  });

  it("known-name", () => {
    const css: CssReport = { files: ["app/globals.css"], autoDetected: true, layer: "known-name" };
    expect(formatTable(makeReport({ css }))).toContain(
      "Stylesheets: app/globals.css (matched a conventional filename)",
    );
  });

  it("largest-fallback carries the low-confidence note", () => {
    const css: CssReport = {
      files: ["src/theme/tokens.css"],
      autoDetected: true,
      layer: "largest-fallback",
    };
    const out = formatTable(makeReport({ css }));
    expect(out).toContain("Stylesheets: src/theme/tokens.css");
    expect(out).toContain("largest-stylesheet fallback, low confidence — verify with --css");
  });

  it("runtime states the engines instead of staying silent", () => {
    const css: CssReport = {
      files: [],
      autoDetected: false,
      layer: "runtime",
      runtimeEngines: ["@emotion/react", "@emotion/styled"],
    };
    const out = formatTable(makeReport({ css }));
    expect(out).toContain(
      "Stylesheets: none — styling is generated at runtime by @emotion/react, @emotion/styled; " +
        "no stylesheet was needed",
    );
  });

  it("disabled", () => {
    const css: CssReport = { files: [], autoDetected: false, layer: "disabled" };
    expect(formatTable(makeReport({ css }))).toContain("Stylesheets: none (--no-css)");
  });

  it("none states the negative outcome instead of staying silent", () => {
    const css: CssReport = { files: [], autoDetected: false, layer: "none" };
    const out = formatTable(makeReport({ css }));
    expect(out).toContain("Stylesheets: none found");
    expect(out).toContain("checked the project entry, conventional filenames");
  });

  it("explicit", () => {
    const css: CssReport = { files: ["a.css"], autoDetected: false, layer: "explicit" };
    expect(formatTable(makeReport({ css }))).toContain("Stylesheets: a.css (explicit --css)");
  });

  it("prints nothing when report.css itself is absent", () => {
    expect(formatTable(makeReport())).not.toContain("Stylesheets:");
  });
});

// Fingerprint-identity: M82 makes cssReport always-present (never undefined),
// even for a project with zero CSS. buildEnvFingerprint's css guard changed
// from a truthy check on cssReport to a files.length>0 check specifically so
// this stays true across that change: a no-CSS project's fingerprint bytes
// must be byte-identical to the pre-M82 shape, or every saved baseline for a
// no-CSS project would silently invalidate.
describe("no-CSS fingerprint identity survives cssReport becoming always-present", () => {
  const base = {
    machine: {
      cpu: "Test CPU",
      cores: 8,
      ramMb: 16384,
      os: "TestOS 1.0",
      nodeVersion: "v20.0.0",
      chromiumVersion: "120.0.0",
    },
    calibration: { totalDuration: 10, scriptDuration: 5 },
    cpuThrottle: 4,
    samples: 10,
    mode: "combo" as const,
  };

  it("an always-present, empty-files css list produces the identical fingerprint to omitting css entirely", () => {
    const withoutCssKey = buildEnvFingerprint(base);
    // This is exactly what ctx.cssReport.files.length > 0 ? {css: ...} : {}
    // degrades to for a no-CSS project: an empty array reaching the same
    // guarded call as before this milestone.
    const withEmptyCssReport = buildEnvFingerprint({ ...base, css: [] });
    expect(withEmptyCssReport).toEqual(withoutCssKey);
    expect(withEmptyCssReport.css).toBeUndefined();
  });

  it("a non-empty css list still reaches the fingerprint, unaffected by the guard change", () => {
    const env = buildEnvFingerprint({ ...base, css: ["app/globals.css"] });
    expect(env.css).toEqual(["app/globals.css"]);
  });
});
