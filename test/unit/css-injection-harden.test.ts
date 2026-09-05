import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  cssImportSpecifier,
  generateEntry,
  loadTailwindVitePlugin,
} from "../../src/harness/index.js";
import { resolveCssFiles } from "../../src/pipeline/index.js";
import { parseArgs } from "../../src/cli/index.js";
import { withProductionResolution } from "../node-resolution.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-css-harden-"));
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

describe("H1: --css value shapes", () => {
  it("accepts a leading comma", () => {
    expect(parseArgs(["./A.tsx", "--css", ",a.css"]).css).toEqual(["a.css"]);
  });

  it("accepts interior empty segments", () => {
    expect(parseArgs(["./A.tsx", "--css", "a.css,,b.css"]).css).toEqual(["a.css", "b.css"]);
  });

  it("rejects a whitespace-only value", () => {
    expect(parseArgs(["./A.tsx", "--css", " , "]).error).toMatch(
      /--css requires at least one stylesheet path/,
    );
  });

  it("keeps a path containing spaces intact", () => {
    expect(parseArgs(["./A.tsx", "--css", "spaced dir/a.css"]).css).toEqual([
      "spaced dir/a.css",
    ]);
  });
});

describe("H2: duplicate stylesheet paths", () => {
  it("collapses two spellings of the same file", () => {
    const a = writeCss("styles/a.css");
    const viaDot = path.join(tmpDir, "styles", ".", "a.css");
    expect(resolveCssFiles({ cssFiles: [a, viaDot] }, tmpDir).files).toEqual([a]);
  });
});

describe("H3: non-file stylesheet paths", () => {
  it("rejects a directory that is named like a stylesheet", () => {
    const dir = path.join(tmpDir, "theme.css");
    fs.mkdirSync(dir, { recursive: true });
    expect(() => resolveCssFiles({ cssFiles: [dir] }, tmpDir)).toThrow(
      /Stylesheet is not a file/,
    );
  });

  it("names the path the user typed, not the resolved one", () => {
    expect(() => resolveCssFiles({ cssFiles: ["./a/../nope.css"] }, tmpDir)).toThrow(
      "Stylesheet not found: ./a/../nope.css",
    );
  });
});

const onWindows = path.sep === "\\";

describe.skipIf(!onWindows)("H4: out-of-root specifier form", () => {
  it("keeps the drive letter and uses forward slashes", () => {
    const root = "C:\\proj\\app";
    const outside = "C:\\other\\theme.css";
    expect(cssImportSpecifier(outside, root)).toBe("/@fs/C:/other/theme.css");
  });

  it("uses /@fs/ when the file is on another drive", () => {
    const spec = cssImportSpecifier("D:\\styles\\a.css", "C:\\proj");
    expect(spec).toBe("/@fs/D:/styles/a.css");
  });

  it("keeps spaces in the /@fs/ specifier", () => {
    expect(cssImportSpecifier("C:\\my dir\\a.css", "C:\\proj")).toBe(
      "/@fs/C:/my dir/a.css",
    );
  });

  it("keeps spaces in the root-absolute specifier", () => {
    expect(cssImportSpecifier("C:\\proj\\my dir\\a.css", "C:\\proj")).toBe(
      "/my dir/a.css",
    );
  });
});

describe("H5: --no-css wins", () => {
  it("drops explicit files and suppresses detection", () => {
    const explicit = writeCss("styles/a.css");
    writeCss("app/globals.css");
    expect(resolveCssFiles({ cssFiles: [explicit], noCss: true }, tmpDir)).toEqual({
      files: [],
      autoDetected: false,
      layer: "disabled",
    });
  });

  it("does not validate explicit paths that will not be used", () => {
    expect(() =>
      resolveCssFiles({ cssFiles: ["./nope.css"], noCss: true }, tmpDir),
    ).not.toThrow();
  });
});

describe("H6: several detection candidates", () => {
  it("returns exactly one file even when all eight exist", () => {
    const created: string[] = [];
    for (const candidate of [
      "app/globals.css",
      "app/global.css",
      "src/app/globals.css",
      "src/app/global.css",
      "src/styles/globals.css",
      "styles/globals.css",
      "src/index.css",
      "src/global.css",
    ]) {
      created.push(writeCss(candidate));
    }
    const resolved = resolveCssFiles({}, tmpDir);
    expect(resolved.files).toEqual([created[0]]);
    expect(resolved.autoDetected).toBe(true);
  });

  it("still auto-detects when an empty explicit list is passed", () => {
    const detected = writeCss("app/globals.css");
    expect(resolveCssFiles({ cssFiles: [] }, tmpDir).files).toEqual([detected]);
  });
});

describe("H11: @tailwindcss/vite not installed", () => {
  it("does not throw and returns no plugins", async () => {
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = () => true;
    try {
      // resolve() and its catch run before the first await; the sync window covers the failure.
      const loading = withProductionResolution(() => loadTailwindVitePlugin(tmpDir));
      await expect(loading).resolves.toEqual([]);
    } finally {
      (process.stderr as unknown as { write: unknown }).write = original;
    }
  });
});

describe("H19: injection with auto-scale rendering", () => {
  it("keeps the css block ahead of the scale-aware render body", () => {
    const entry = generateEntry({
      componentRelative: "src/Card.tsx",
      componentName: "Card",
      isDefaultExport: false,
      hasScale: true,
      cssImports: ["/app/globals.css"],
    });
    expect(entry.indexOf('import "/app/globals.css";')).toBe(1);
    expect(entry).toContain("__120fps_scale");
    // M106 A4: `scale` is read off the namespace instead of being imported.
    expect(entry).toContain("const __120fps_scale = (__120fps_mod as any).scale;");
  });
});

describe("H22: harness navigation wait", () => {
  const src = (name: string) => fs.readFileSync(path.resolve("src", name), "utf-8");

  // M59 routes navigation through gotoWithErrorContext; the wait option reads the same either way.
  it("never navigates with the default load wait", () => {
    for (const file of [
      "pipeline/analyze.ts",
      "analysis/explorer.ts",
      "browser/session.ts",
      "analysis/react-profiler.ts",
    ]) {
      const text = src(file);
      const gotos = text.match(/(?:page\.goto|gotoWithErrorContext)\([^)]*\)/g) ?? [];
      expect(gotos.length).toBeGreaterThan(0);
      for (const call of gotos) {
        expect(call).toContain("HARNESS_NAV_WAIT");
      }
    }
  });
});

describe("H21: settle gate runs before CPU throttling", () => {
  const src = (name: string) => fs.readFileSync(path.resolve("src", name), "utf-8");

  it("precedes setCPUThrottlingRate in every session", () => {
    // A throttle call may appear earlier for a page with nothing to settle (M39's blank probe).
    for (const file of ["pipeline/analyze.ts", "analysis/explorer.ts", "analysis/react-profiler.ts"]) {
      const text = src(file);
      const settleIdx = text.indexOf("settleStyles(page");
      expect(settleIdx).toBeGreaterThan(-1);
      expect(
        text.indexOf("Emulation.setCPUThrottlingRate", settleIdx),
      ).toBeGreaterThan(settleIdx);
    }
    // Scoped to the preamble: suspendThrottle (M34) is inter-sample bookkeeping, not this gate.
    const measure = src("browser/session.ts");
    const preamble = measure.slice(measure.indexOf("export async function enterHarness"));
    const firstGate = preamble.indexOf("await settleStyles(page");
    const firstThrottle = preamble.indexOf("Emulation.setCPUThrottlingRate");
    expect(firstGate).toBeGreaterThanOrEqual(0);
    expect(firstGate).toBeLessThan(firstThrottle);
  });
});
