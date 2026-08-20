import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  GLOBAL_CSS_CANDIDATES,
  cssImportBlock,
  cssImportSpecifier,
  detectGlobalCss,
  detectTailwindVite,
  generateComposedEntry,
  generateEntry,
  loadTailwindVitePlugin,
  scanExternalDeps,
} from "../../src/harness.js";
import {
  FONT_SETTLE_TIMEOUT_MS,
  FONT_SETTLE_WARNING,
  needsStyleSettle,
  settleStyles,
} from "../../src/measure.js";
import { resolveCssFiles } from "../../src/analyze.js";
import { buildEnvFingerprint, classifyEnv } from "../../src/budget.js";
import {
  DEFAULT_THRESHOLDS,
  formatTable,
  type CssReport,
  type Report,
} from "../../src/report.js";
import { KNOWN_FLAGS, helpText, parseArgs } from "../../src/cli.js";
import { withProductionResolution } from "../node-resolution.js";
import type { CompositionTree } from "../../src/composition.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-css-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeCss(relative: string, body = ".x{color:red}"): string {
  const full = path.join(tmpDir, relative);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
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

const ENTRY_BASE = {
  componentRelative: "src/Button.tsx",
  componentName: "Button",
  isDefaultExport: true,
  hasScale: false,
};

const TREE: CompositionTree = {
  root: "Accordion",
  structure: [{ component: "Accordion", props: {}, children: [] }],
  repeatCount: 1,
};

// --- C1 resolution: detectGlobalCss ---

describe("detectGlobalCss", () => {
  // M71 appended the create-vite name and the Sass spellings; the entry-graph
  // layer that now runs before this one lives in
  // test/unit/global-stylesheet-fallbacks.test.ts.
  it("declares the probe order from the spec", () => {
    expect(GLOBAL_CSS_CANDIDATES).toEqual([
      "app/globals.css",
      "app/global.css",
      "src/app/globals.css",
      "src/app/global.css",
      "src/styles/globals.css",
      "styles/globals.css",
      "src/index.css",
      "src/global.css",
      "src/style.css",
      "app/globals.scss",
      "app/global.scss",
      "src/app/globals.scss",
      "src/app/global.scss",
      "src/styles/globals.scss",
      "styles/globals.scss",
      "src/index.scss",
      "src/global.scss",
      "src/style.scss",
    ]);
  });

  it("returns undefined when no candidate exists", () => {
    expect(detectGlobalCss(tmpDir)).toBeUndefined();
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

  it("returns the first hit when several candidates exist", () => {
    writeCss("src/index.css");
    writeCss("styles/globals.css");
    const first = writeCss("app/globals.css");
    expect(detectGlobalCss(tmpDir)).toBe(first);
  });

  it("prefers app/globals.css over app/global.css", () => {
    writeCss("app/global.css");
    const first = writeCss("app/globals.css");
    expect(detectGlobalCss(tmpDir)).toBe(first);
  });

  it("skips a candidate path that is a directory", () => {
    fs.mkdirSync(path.join(tmpDir, "app", "globals.css"), { recursive: true });
    const real = writeCss("src/index.css");
    expect(detectGlobalCss(tmpDir)).toBe(real);
  });

  it("returns undefined for an unreadable project root", () => {
    expect(detectGlobalCss(path.join(tmpDir, "does-not-exist"))).toBeUndefined();
  });
});

// --- C1 resolution: resolveCssFiles ---

describe("resolveCssFiles", () => {
  it("auto-detects a single file and flags it", () => {
    const detected = writeCss("app/globals.css");
    expect(resolveCssFiles({}, tmpDir)).toEqual({
      files: [detected],
      autoDetected: true,
      layer: "known-name",
    });
  });

  it("returns an empty list when nothing is detected", () => {
    expect(resolveCssFiles({}, tmpDir)).toEqual({ files: [], autoDetected: false, layer: "none" });
  });

  it("explicit files suppress detection and keep order", () => {
    writeCss("app/globals.css");
    const a = writeCss("styles/a.css");
    const b = writeCss("styles/b.css");
    expect(resolveCssFiles({ cssFiles: [b, a] }, tmpDir)).toEqual({
      files: [b, a],
      autoDetected: false,
      layer: "explicit",
    });
  });

  it("noCss suppresses detection", () => {
    writeCss("app/globals.css");
    expect(resolveCssFiles({ noCss: true }, tmpDir)).toEqual({
      files: [],
      autoDetected: false,
      layer: "disabled",
    });
  });

  it("noCss suppresses explicit files", () => {
    const a = writeCss("styles/a.css");
    expect(resolveCssFiles({ cssFiles: [a], noCss: true }, tmpDir)).toEqual({
      files: [],
      autoDetected: false,
      layer: "disabled",
    });
  });

  it("throws with the spec message when an explicit file is missing", () => {
    expect(() => resolveCssFiles({ cssFiles: ["./nope.css"] }, tmpDir)).toThrow(
      "Stylesheet not found: ./nope.css",
    );
  });

  it("throws when an explicit path is a directory", () => {
    const dir = path.join(tmpDir, "styles");
    fs.mkdirSync(dir, { recursive: true });
    expect(() => resolveCssFiles({ cssFiles: [dir] }, tmpDir)).toThrow(
      /Stylesheet is not a file/,
    );
  });

  it("resolves explicit relative paths against process.cwd()", () => {
    const rel = "./fixtures/with-css.css";
    expect(resolveCssFiles({ cssFiles: [rel] }, tmpDir).files).toEqual([
      path.resolve(rel),
    ]);
  });

  it("deduplicates repeated paths, keeping first position", () => {
    const a = writeCss("styles/a.css");
    const b = writeCss("styles/b.css");
    expect(resolveCssFiles({ cssFiles: [a, b, a] }, tmpDir).files).toEqual([a, b]);
  });
});

// --- C1 resolution: CLI ---

describe("--css / --no-css parsing", () => {
  it("registers both flags", () => {
    expect(KNOWN_FLAGS.has("--css")).toBe(true);
    expect(KNOWN_FLAGS.has("--no-css")).toBe(true);
  });

  it("splits on commas and trims", () => {
    const args = parseArgs(["./A.tsx", "--css", " a.css , b.css "]);
    expect(args.error).toBeUndefined();
    expect(args.css).toEqual(["a.css", "b.css"]);
  });

  it("drops empty segments from a trailing comma", () => {
    const args = parseArgs(["./A.tsx", "--css", "a.css,"]);
    expect(args.error).toBeUndefined();
    expect(args.css).toEqual(["a.css"]);
  });

  it("errors when the value is only commas", () => {
    const args = parseArgs(["./A.tsx", "--css", ",,,"]);
    expect(args.error).toMatch(/--css requires at least one stylesheet path/);
  });

  it("errors when --css has no value", () => {
    expect(parseArgs(["./A.tsx", "--css"]).error).toMatch(/--css requires/);
  });

  it("errors when --css is followed by another flag", () => {
    expect(parseArgs(["./A.tsx", "--css", "--ci"]).error).toMatch(/--css requires/);
  });

  it("parses --no-css", () => {
    const args = parseArgs(["./A.tsx", "--no-css"]);
    expect(args.error).toBeUndefined();
    expect(args.noCss).toBe(true);
  });

  it("accepts --css together with --no-css and lets --no-css win at resolution", () => {
    const args = parseArgs(["./A.tsx", "--css", "a.css", "--no-css"]);
    expect(args.error).toBeUndefined();
    expect(args.css).toEqual(["a.css"]);
    expect(args.noCss).toBe(true);
  });

  it("documents both flags in the help text", () => {
    const help = helpText();
    expect(help).toContain("--css");
    expect(help).toContain("--no-css");
  });
});

// --- C2 injection: specifiers ---

describe("cssImportSpecifier", () => {
  it("uses a root-absolute posix path for a file inside the project root", () => {
    const root = path.resolve("/tmp/proj");
    const file = path.join(root, "app", "globals.css");
    expect(cssImportSpecifier(file, root)).toBe("/app/globals.css");
  });

  it("normalizes Windows separators", () => {
    const root = path.resolve("/tmp/proj");
    const file = path.join(root, "src", "styles", "a.css");
    const spec = cssImportSpecifier(file, root);
    expect(spec).toBe("/src/styles/a.css");
    expect(spec).not.toContain("\\");
  });

  it("uses the /@fs/ form for a file outside the project root", () => {
    const root = path.resolve("/tmp/proj");
    const outside = path.resolve("/tmp/other/theme.css");
    const spec = cssImportSpecifier(outside, root);
    expect(spec.startsWith("/@fs/")).toBe(true);
    expect(spec).toBe("/@fs/" + outside.replace(/\\/g, "/"));
    expect(spec).not.toContain("\\");
  });

  it("keeps the drive letter in the /@fs/ form", () => {
    const outside = path.resolve("/tmp/other/theme.css");
    const spec = cssImportSpecifier(outside, path.resolve("/tmp/proj"));
    if (path.isAbsolute("C:/x")) {
      expect(spec).toMatch(/^\/@fs\/([A-Za-z]:)?\//);
    }
  });

  it("does not mistake a sibling directory prefix for containment", () => {
    const root = path.resolve("/tmp/proj");
    const sibling = path.resolve("/tmp/proj-other/a.css");
    expect(cssImportSpecifier(sibling, root).startsWith("/@fs/")).toBe(true);
  });
});

describe("cssImportBlock", () => {
  it("emits nothing for an empty list", () => {
    expect(cssImportBlock([])).toBe("");
    expect(cssImportBlock(undefined)).toBe("");
  });

  it("emits one side-effect import per file in order", () => {
    expect(cssImportBlock(["/a.css", "/b.css"])).toBe(
      'import "/a.css";\nimport "/b.css";\n',
    );
  });
});

// --- C2 injection: entry generation ---

describe("generateEntry css injection", () => {
  it("is byte-identical to the uninjected entry when no css is given", () => {
    expect(generateEntry({ ...ENTRY_BASE, cssImports: [] })).toBe(
      generateEntry(ENTRY_BASE),
    );
  });

  it("places css imports before the react imports", () => {
    const entry = generateEntry({ ...ENTRY_BASE, cssImports: ["/app/globals.css"] });
    expect(entry.indexOf('import "/app/globals.css";')).toBeLessThan(
      entry.indexOf('from "react"'),
    );
  });

  it("places css imports before the component import", () => {
    const entry = generateEntry({ ...ENTRY_BASE, cssImports: ["/app/globals.css"] });
    expect(entry.indexOf('import "/app/globals.css";')).toBeLessThan(
      entry.indexOf('from "/src/Button.tsx"'),
    );
  });

  it("places css imports before the wrapper import", () => {
    const entry = generateEntry({
      ...ENTRY_BASE,
      wrapRelative: "120fps.setup.tsx",
      cssImports: ["/app/globals.css"],
    });
    expect(entry.indexOf('import "/app/globals.css";')).toBeLessThan(
      entry.indexOf('from "/120fps.setup.tsx"'),
    );
  });

  it("preserves the given order", () => {
    const entry = generateEntry({
      ...ENTRY_BASE,
      cssImports: ["/reset.css", "/tokens.css", "/utilities.css"],
    });
    expect(entry.indexOf("/reset.css")).toBeLessThan(entry.indexOf("/tokens.css"));
    expect(entry.indexOf("/tokens.css")).toBeLessThan(entry.indexOf("/utilities.css"));
  });

  it("emits the /@fs/ specifier verbatim", () => {
    const entry = generateEntry({
      ...ENTRY_BASE,
      cssImports: ["/@fs/C:/other/theme.css"],
    });
    expect(entry).toContain('import "/@fs/C:/other/theme.css";');
  });
});

describe("generateComposedEntry css injection", () => {
  it("is byte-identical to the uninjected entry when no css is given", () => {
    expect(generateComposedEntry("src/Acc.tsx", TREE, undefined, undefined, [])).toBe(
      generateComposedEntry("src/Acc.tsx", TREE),
    );
  });

  it("places css imports before the react imports and the component import", () => {
    const entry = generateComposedEntry("src/Acc.tsx", TREE, undefined, undefined, [
      "/app/globals.css",
    ]);
    expect(entry.indexOf('import "/app/globals.css";')).toBeLessThan(
      entry.indexOf('from "react"'),
    );
    expect(entry.indexOf('import "/app/globals.css";')).toBeLessThan(
      entry.indexOf('from "/src/Acc.tsx"'),
    );
  });

  it("preserves the given order", () => {
    const entry = generateComposedEntry("src/Acc.tsx", TREE, undefined, undefined, [
      "/reset.css",
      "/tokens.css",
    ]);
    expect(entry.indexOf("/reset.css")).toBeLessThan(entry.indexOf("/tokens.css"));
  });
});

// --- C3 dependency scanning stays out of CSS ---

describe("scanExternalDeps is not extended to CSS", () => {
  it("does not treat @import in a stylesheet as a package dependency", () => {
    const comp = path.join(tmpDir, "C.tsx");
    fs.writeFileSync(comp, 'import "./a.css";\nexport const C = () => null;\n');
    writeCss("a.css", '@import "tailwindcss";\n@plugin "@tailwindcss/typography";\n');
    expect(scanExternalDeps(comp, tmpDir, [])).toEqual([]);
  });

  it("still collects real JS package imports from the component", () => {
    const comp = path.join(tmpDir, "C.tsx");
    fs.writeFileSync(comp, 'import "./a.css";\nimport clsx from "clsx";\n');
    writeCss("a.css", '@import "tailwindcss";\n');
    expect(scanExternalDeps(comp, tmpDir, [])).toEqual(["clsx"]);
  });
});

// --- C4 toolchain: @tailwindcss/vite ---

describe("detectTailwindVite", () => {
  it("is false when there is no package.json", () => {
    expect(detectTailwindVite(tmpDir)).toBe(false);
  });

  it("is false when the plugin is not listed", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "19" } }),
    );
    expect(detectTailwindVite(tmpDir)).toBe(false);
  });

  it("is true when listed in dependencies", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { "@tailwindcss/vite": "^4" } }),
    );
    expect(detectTailwindVite(tmpDir)).toBe(true);
  });

  it("is true when listed in devDependencies", () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ devDependencies: { "@tailwindcss/vite": "^4" } }),
    );
    expect(detectTailwindVite(tmpDir)).toBe(true);
  });

  it("is false for unreadable package.json", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{ not json");
    expect(detectTailwindVite(tmpDir)).toBe(false);
  });
});

describe("loadTailwindVitePlugin", () => {
  it("warns once and returns no plugins when the package is listed but not installed", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ devDependencies: { "@tailwindcss/vite": "^4" } }),
    );
    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      // The resolve() call and its catch both run before the first await, so
      // the sync window covers the whole failure path.
      const plugins = await withProductionResolution(() => loadTailwindVitePlugin(tmpDir));
      expect(plugins).toEqual([]);
    } finally {
      (process.stderr as unknown as { write: unknown }).write = original;
    }
    expect(written.length).toBe(1);
    expect(written[0]).toMatch(/@tailwindcss\/vite/);
  });
});

// --- C5 settle gate ---

describe("needsStyleSettle", () => {
  it("is false with neither stylesheets nor a wrapper", () => {
    expect(needsStyleSettle({})).toBe(false);
  });

  it("is false for an empty stylesheet list", () => {
    expect(needsStyleSettle({ cssFiles: [] })).toBe(false);
  });

  it("is true when stylesheets are injected", () => {
    expect(needsStyleSettle({ cssFiles: ["/a.css"] })).toBe(true);
  });

  it("is true for a wrapper with no stylesheets", () => {
    expect(needsStyleSettle({ wrapRelative: "120fps.setup.tsx" })).toBe(true);
  });
});

describe("settleStyles", () => {
  // M74 (B10): the page-side evaluate now resolves { settled, failedFamilies }
  // instead of a bare boolean; the mock stands in for that whole evaluate
  // call, so it returns the same shape the real browser-side code does.
  function fakePage(settled: boolean, failedFamilies: string[] = []) {
    const calls: unknown[] = [];
    return {
      calls,
      page: {
        evaluate: async (fn: unknown, arg: unknown) => {
          calls.push(arg);
          return { settled, failedFamilies };
        },
      },
    };
  }

  it("does nothing and reports settled when the gate is inactive", async () => {
    const { page, calls } = fakePage(false);
    await expect(settleStyles(page as never, {})).resolves.toEqual({
      settled: true,
      failedFamilies: [],
    });
    expect(calls.length).toBe(0);
  });

  it("runs in the page and reports settled when fonts resolve", async () => {
    const { page, calls } = fakePage(true);
    await expect(settleStyles(page as never, { cssFiles: ["/a.css"] })).resolves.toEqual({
      settled: true,
      failedFamilies: [],
    });
    expect(calls).toEqual([FONT_SETTLE_TIMEOUT_MS]);
  });

  it("reports not-settled when the page times out on fonts", async () => {
    const { page } = fakePage(false);
    await expect(
      settleStyles(page as never, { wrapRelative: "120fps.setup.tsx" }),
    ).resolves.toEqual({ settled: false, failedFamilies: [] });
  });

  it("threads failed font families through from the page", async () => {
    const { page } = fakePage(true, ["Inter"]);
    await expect(
      settleStyles(page as never, { cssFiles: ["/a.css"] }),
    ).resolves.toEqual({ settled: true, failedFamilies: ["Inter"] });
  });

  it("uses the 5s bound and the spec warning text", () => {
    expect(FONT_SETTLE_TIMEOUT_MS).toBe(5000);
    expect(FONT_SETTLE_WARNING).toBe("font loading did not settle within 5s");
  });
});

describe("settle gate wiring", () => {
  const src = (name: string) =>
    fs.readFileSync(path.resolve("src", name), "utf-8");

  it("is called from every browser session", () => {
    const measure = src("measure.ts");
    const callsIn = (text: string) => text.split("await settleStyles(").length - 1;
    // measureMount, measureRerender and every isolation phase pass enter the
    // harness through measure.ts's shared enterHarness preamble.
    expect(callsIn(measure)).toBe(1);
    expect(measure).toContain("export async function enterHarness(");
    expect(callsIn(src("analyze.ts"))).toBe(1);
    expect(callsIn(src("explorer.ts"))).toBe(1);
    expect(callsIn(src("react-profiler.ts"))).toBe(1);
  });

  it("has exactly one implementation", () => {
    expect(src("measure.ts")).toContain("export async function settleStyles(");
    for (const file of ["analyze.ts", "explorer.ts", "react-profiler.ts", "harness.ts"]) {
      expect(src(file)).not.toContain("function settleStyles(");
    }
  });
});

// --- C6 reporting ---

describe("Report.css", () => {
  it("renders the stylesheet line in the header block", () => {
    const css: CssReport = { files: ["app/globals.css"], autoDetected: true };
    const out = formatTable(makeReport({ css }));
    expect(out).toContain("Stylesheets: app/globals.css (auto-detected)");
  });

  it("renders explicit files without the auto-detected marker", () => {
    const css: CssReport = { files: ["a.css", "b.css"], autoDetected: false };
    const out = formatTable(makeReport({ css }));
    expect(out).toContain("Stylesheets: a.css, b.css");
    expect(out).not.toContain("(auto-detected)");
  });

  it("prints no stylesheet line when nothing was injected", () => {
    expect(formatTable(makeReport())).not.toContain("Stylesheets:");
  });

  it("keeps the stylesheet line above the combo table", () => {
    const out = formatTable(makeReport({ css: { files: ["a.css"], autoDetected: false } }));
    const header = out.indexOf("Stylesheets:");
    const machine = out.indexOf("Machine:");
    expect(header).toBeGreaterThan(machine);
    expect(header).toBeLessThan(out.indexOf("\n\n", machine) + out.length);
  });
});

describe("EnvFingerprint.css", () => {
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

  it("records the injected files in order", () => {
    const env = buildEnvFingerprint({ ...base, css: ["app/globals.css", "src/extra.css"] });
    expect(env.css).toEqual(["app/globals.css", "src/extra.css"]);
  });

  it("omits the field when nothing was injected", () => {
    expect(buildEnvFingerprint(base).css).toBeUndefined();
    expect(buildEnvFingerprint({ ...base, css: [] }).css).toBeUndefined();
  });

  it("makes a pre-injection baseline incompatible once css is injected", () => {
    const before = buildEnvFingerprint(base);
    const after = buildEnvFingerprint({ ...base, css: ["app/globals.css"] });
    expect(classifyEnv(before, after)).toBe("incompatible");
  });

  it("treats a reordered stylesheet list as incompatible", () => {
    const a = buildEnvFingerprint({ ...base, css: ["a.css", "b.css"] });
    const b = buildEnvFingerprint({ ...base, css: ["b.css", "a.css"] });
    expect(classifyEnv(a, b)).toBe("incompatible");
  });

  it("treats the identical stylesheet list as identical", () => {
    const a = buildEnvFingerprint({ ...base, css: ["a.css", "b.css"] });
    const b = buildEnvFingerprint({ ...base, css: ["a.css", "b.css"] });
    expect(classifyEnv(a, b)).toBe("identical");
  });
});
