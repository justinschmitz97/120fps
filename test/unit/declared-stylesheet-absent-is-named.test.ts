import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CSS_DECLARED_UNBUILT_WARNING,
  discoverGlobalCss,
  packageStylesheetCandidates,
} from "../../src/harness/index.js";
import { buildCssReport, resolveCssFiles } from "../../src/pipeline/index.js";
import { formatStylesheetsLine } from "../../src/report/index.js";

const FIXTURES = path.resolve(__dirname, "../../fixtures");
const DECLARED_ABSENT = path.join(FIXTURES, "declared-absent-style");

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-declared-absent-"));
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

describe("a package stylesheet that is declared and not built", () => {
  it("is returned as a declared target naming the manifest field that declared it", () => {
    expect(packageStylesheetCandidates(DECLARED_ABSENT)).toEqual([
      { declared: path.join(DECLARED_ABSENT, "styles.css"), field: "style" },
    ]);
  });

  it("names the field, the missing path and the package's own build command", () => {
    const warnings: string[] = [];
    discoverGlobalCss(DECLARED_ABSENT, warnings);
    const declared = warnings.filter((w) => w.includes("styles.css"));
    expect(declared).toHaveLength(1);
    expect(declared[0]).toContain('package.json "style" declares styles.css');
    expect(declared[0]).toContain("run `");
    expect(declared[0]).toContain("run build` in this package");
  });

  it("reports layer none with the declaration instead of the size-ranked fallback", () => {
    const warnings: string[] = [];
    const discovery = discoverGlobalCss(DECLARED_ABSENT, warnings);
    expect(discovery.files).toEqual([]);
    expect(discovery.source).toBe("none");
    expect(discovery.declaredMissing).toEqual([
      { field: "style", path: "styles.css", buildCommand: expect.stringContaining("run build") },
    ]);
  });

  it("does not inject the largest stylesheet under the project", () => {
    const discovery = discoverGlobalCss(DECLARED_ABSENT);
    expect(discovery.files.some((f) => f.endsWith("tokens.css"))).toBe(false);
  });

  it("emits no largest-stylesheet fallback warning for that package", () => {
    const warnings: string[] = [];
    discoverGlobalCss(DECLARED_ABSENT, warnings);
    expect(
      warnings.filter((w) => w.includes("no entry stylesheet import and no conventional global")),
    ).toEqual([]);
  });

  it("omits the build command when the package declares no build script", () => {
    write("package.json", JSON.stringify({ name: "no-build", style: "./dist/theme.css" }));
    write("src/big.css", ".a{color:red}");
    const warnings: string[] = [];
    const discovery = discoverGlobalCss(tmpDir, warnings);
    expect(discovery.source).toBe("none");
    expect(discovery.declaredMissing).toEqual([{ field: "style", path: "dist/theme.css" }]);
    expect(warnings.some((w) => w.includes("build this package, then re-run"))).toBe(true);
  });

  it("names an exports subpath declaration by the subpath that declared it", () => {
    write(
      "package.json",
      JSON.stringify({
        name: "subpath",
        exports: { "./styles": { style: "./dist/styles.css" } },
      }),
    );
    write("src/big.css", ".a{color:red}");
    const discovery = discoverGlobalCss(tmpDir);
    expect(discovery.declaredMissing).toEqual([
      { field: "exports[./styles]", path: "dist/styles.css" },
    ]);
  });

  it("prefers a declared stylesheet that is on disk over one that is not", () => {
    const built = write("dist/theme.css", ".a{color:red}");
    write(
      "package.json",
      JSON.stringify({
        name: "half-built",
        style: "./dist/theme.css",
        exports: { "./styles": "./dist/missing.css" },
      }),
    );
    const warnings: string[] = [];
    const discovery = discoverGlobalCss(tmpDir, warnings);
    expect(discovery.files).toEqual([built]);
    expect(discovery.source).toBe("package-declared");
    expect(discovery.declaredMissing).toBeUndefined();
  });

  it("leaves a project that declares no stylesheet on the fallback path", () => {
    write("package.json", JSON.stringify({ name: "plain" }));
    const big = write("src/big.css", ".a{color:red}");
    const warnings: string[] = [];
    const discovery = discoverGlobalCss(tmpDir, warnings);
    expect(discovery.files).toEqual([big]);
    expect(discovery.source).toBe("fallback");
    expect(discovery.declaredMissing).toBeUndefined();
    expect(
      warnings.some((w) => w.includes("no entry stylesheet import and no conventional global")),
    ).toBe(true);
  });
});

describe("the declared-but-unbuilt stylesheet warning", () => {
  it("names every declaration and the command that builds them", () => {
    expect(
      CSS_DECLARED_UNBUILT_WARNING(
        [
          { field: "style", path: "dist/theme.css" },
          { field: "exports[./styles]", path: "dist/styles.css" },
        ],
        "pnpm run build",
      ),
    ).toBe(
      'this package\'s package.json "style" declares dist/theme.css and "exports[./styles]" declares ' +
        "dist/styles.css, which are not on disk yet — most likely because a build this harness never " +
        "runs produces them. No stylesheet was injected and the component is measured unstyled; run " +
        "`pnpm run build` in this package, then re-run, or pass --css to name a stylesheet that exists.",
    );
  });

  it("says to build the package when no build script is declared", () => {
    expect(CSS_DECLARED_UNBUILT_WARNING([{ field: "style", path: "dist/theme.css" }])).toBe(
      "this package's package.json \"style\" declares dist/theme.css, which is not on disk yet — " +
        "most likely because a build this harness never runs produces it. No stylesheet was injected " +
        "and the component is measured unstyled; build this package, then re-run, or pass --css to " +
        "name a stylesheet that exists.",
    );
  });
});

// M112 review: the producer half was covered end to end and the report half
// was covered on a cast literal, so the forward through `resolveCssFiles` was
// the one seam nothing crossed.
describe("the declaration reaching the report", () => {
  it("carries the declared-but-unbuilt target from discovery into the Stylesheets line", () => {
    const resolved = resolveCssFiles({}, DECLARED_ABSENT, []);
    expect(resolved.declaredMissing).toEqual([
      { field: "style", path: "styles.css", buildCommand: expect.stringContaining("run build") },
    ]);
    const report = buildCssReport(resolved, DECLARED_ABSENT);
    expect(report.declaredMissing).toEqual(["styles.css"]);
    expect(formatStylesheetsLine(report)).toContain("styles.css");
    expect(formatStylesheetsLine(report)).not.toContain("none found");
  });
});

// M112 review: the early return sits above the runtime layer, so a package
// that declares an unbuilt stylesheet and styles at runtime used to lose M82's
// outcome and be told it was measured unstyled.
describe("a declared-but-unbuilt stylesheet in a package that styles at runtime", () => {
  it("keeps the runtime engines and drops the measured-unstyled claim", () => {
    write(
      "package.json",
      JSON.stringify({
        name: "runtime-and-declared",
        style: "./dist/theme.css",
        dependencies: { "@emotion/react": "^11.0.0" },
      }),
    );
    write("src/big.css", ".a{color:red}");
    const warnings: string[] = [];
    const discovery = discoverGlobalCss(tmpDir, warnings);
    expect(discovery.source).toBe("none");
    expect(discovery.files).toEqual([]);
    expect(discovery.declaredMissing).toEqual([{ field: "style", path: "dist/theme.css" }]);
    expect(discovery.runtimeEngines).toEqual(["@emotion/react"]);
    const declared = warnings.find((w) => w.includes("dist/theme.css"));
    expect(declared).toContain("styling is generated at runtime by @emotion/react");
    expect(declared).not.toContain("measured unstyled");
  });

  it("still claims the unstyled measurement when no runtime engine is present", () => {
    write("package.json", JSON.stringify({ name: "declared-only", style: "./dist/theme.css" }));
    const warnings: string[] = [];
    const discovery = discoverGlobalCss(tmpDir, warnings);
    expect(discovery.runtimeEngines).toBeUndefined();
    expect(warnings.some((w) => w.includes("measured unstyled"))).toBe(true);
  });
});
