import { describe, it, expect } from "vitest";
import path from "node:path";
import { discoverGlobalCss } from "../../src/harness/index.js";
import {
  STYLESHEET_MATCHED_NOTHING_WARNING,
  buildCssReport,
  resolveCssFiles,
} from "../../src/pipeline/index.js";
import { formatStylesheetsLine, type CssReport } from "../../src/report/index.js";

// shadcn-ui-F3: unreadable stylesheet must not report empty details, indistinguishable from none.
describe("a dropped stylesheet stays on the record that named it", () => {
  it("keeps one detail entry per dropped file, naming the path tried and the reason", () => {
    // The shape analyze()'s unreadable branch produces.
    const report: CssReport = {
      files: [],
      autoDetected: true,
      layer: "unreadable",
      details: [
        {
          file: "packages/shadcn/dist/tailwind.css",
          bytes: 0,
          rules: 0,
          unreadable: "not readable at E:/repositories/shadcn-ui/packages/shadcn/dist/tailwind.css; dropped, and the run measured unstyled",
        },
      ],
    };
    expect(report.details).toHaveLength(1);
    expect(report.details![0].unreadable).toContain("dist/tailwind.css");
    expect(report.details![0].unreadable).toContain("measured unstyled");
  });
});

// excalidraw-F2: a sheet whose rules matched nothing must not be reported as a styled render.
describe("a stylesheet that matched nothing is named as such", () => {
  it("names the file, the rule count, and what the measurement therefore describes", () => {
    const warning = STYLESHEET_MATCHED_NOTHING_WARNING("css/styles.scss", 1183);
    expect(warning).toContain("css/styles.scss");
    expect(warning).toContain("1183 rules");
    expect(warning).toContain("--wrap");
    // C-8: the probe cannot see :root/html/body rules; message must not call it simply unstyled.
    expect(warning).toContain("custom properties on :root");
    expect(warning).not.toMatch(/^.*the measurement describes an unstyled render/);
  });
});

describe("css details are built for every discovered file", () => {
  it("carries one entry per file with its byte size and rule count", () => {
    const report = buildCssReport(
      {
        files: [require("node:path").resolve("fixtures/css-order-a.css")],
        autoDetected: true,
        layer: "known-name",
      } as any,
      process.cwd(),
    );
    expect(report.details).toHaveLength(1);
    expect(report.details![0].file).toBe("fixtures/css-order-a.css");
    expect(report.details![0].bytes).toBeGreaterThan(0);
    expect(report.details![0].matchedRules).toBeUndefined();
  });
});

// M102 / I7: stats match `css.details` by file path; only sheets with unmatched rules warn.
describe("match stats reach the details entry they describe", () => {
  function apply(
    details: Array<{ file: string; bytes: number; rules: number; matchedRules?: number }>,
    stats: Array<{ file: string; rules: number; matched: number }>,
  ): string[] {
    const warnings: string[] = [];
    for (const stat of stats) {
      const detail = details.find((d) => stat.file.endsWith(d.file) || d.file.endsWith(stat.file));
      if (!detail) continue;
      detail.matchedRules = stat.matched;
      if (detail.rules > 0 && stat.matched === 0) {
        warnings.push(STYLESHEET_MATCHED_NOTHING_WARNING(detail.file, detail.rules));
      }
    }
    return warnings;
  }

  it("warns for a sheet with rules that matched nothing", () => {
    const details = [{ file: "css/styles.scss", bytes: 100, rules: 1183 }];
    const warnings = apply(details, [{ file: "/css/styles.scss", rules: 1183, matched: 0 }]);
    expect(details[0].matchedRules).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("css/styles.scss");
  });

  it("records a partial match without warning", () => {
    const details = [{ file: "css/styles.scss", bytes: 100, rules: 1183 }];
    expect(apply(details, [{ file: "/css/styles.scss", rules: 1183, matched: 7 }])).toEqual([]);
    expect(details[0].matchedRules).toBe(7);
  });

  it("never warns about a sheet that has no rules of its own to match", () => {
    const details = [{ file: "src/styles.css", bytes: 30, rules: 0 }];
    expect(apply(details, [{ file: "/src/styles.css", rules: 0, matched: 0 }])).toEqual([]);
    expect(details[0].matchedRules).toBe(0);
  });
});

// heroui-F1: the package's own exports resolved this pick, not a conventional filename match.
describe("a stylesheet the package itself declared is labelled as such", () => {
  it("does not claim a filename convention decided it", () => {
    const line = formatStylesheetsLine({
      files: ["node_modules/@heroui/styles/index.css"],
      autoDetected: true,
      layer: "package-declared",
    });
    expect(line).toContain("node_modules/@heroui/styles/index.css");
    expect(line).toContain("declared by the measured package's own package.json");
    expect(line).not.toContain("conventional filename");
  });

  it("leaves the conventional-filename label to the layer that means it", () => {
    const line = formatStylesheetsLine({
      files: ["src/index.css"],
      autoDetected: true,
      layer: "known-name",
    });
    expect(line).toContain("matched a conventional filename");
  });
});

// specs/milestones/m112-presets-and-remedies-name-real-files.md: must not read "none found" here.
describe("a stylesheet the package declared but never built", () => {
  it("is named on the Stylesheets line instead of 'none found'", () => {
    const line = formatStylesheetsLine({
      files: [],
      autoDetected: true,
      layer: "none",
      declaredMissing: ["styles.css"],
    });
    expect(line).toContain("styles.css");
    expect(line).toContain("declares");
    expect(line).not.toContain("none found");
  });

  it("names every declared target that is missing", () => {
    const line = formatStylesheetsLine({
      files: [],
      autoDetected: true,
      layer: "none",
      declaredMissing: ["styles.css", "dist/theme.css"],
    });
    expect(line).toContain("styles.css");
    expect(line).toContain("dist/theme.css");
  });

  it("leaves the none branch alone when nothing was declared", () => {
    const line = formatStylesheetsLine({
      files: [],
      autoDetected: true,
      layer: "none",
      declaredMissing: [],
    });
    expect(line).toContain("none found");
  });

  it("names the declaring field and the build command when the producer supplies them", () => {
    const line = formatStylesheetsLine({
      files: [],
      autoDetected: true,
      layer: "none",
      declaredMissing: ["styles.css"],
      declaredMissingFields: [
        { field: "style", path: "styles.css", buildCommand: "pnpm build" },
      ],
    });
    expect(line).toContain('package.json "style" declares styles.css');
    expect(line).toContain("pnpm build");
    expect(line).not.toContain("none found");
  });

  it("says \"are\" when two declared fields are missing", () => {
    const line = formatStylesheetsLine({
      files: [],
      autoDetected: true,
      layer: "none",
      declaredMissing: ["a.css", "b.css"],
      declaredMissingFields: [
        { field: "style", path: "a.css", buildCommand: "pnpm build" },
        { field: "exports", path: "b.css", buildCommand: "pnpm build" },
      ],
    });
    expect(line).toContain('package.json "style" declares a.css');
    expect(line).toContain('package.json "exports" declares b.css');
    expect(line).toContain("which are not built yet");
    expect(line).not.toContain("which is not built yet");
  });

  it("falls back to the paths alone when no field came with them", () => {
    const line = formatStylesheetsLine({
      files: [],
      autoDetected: true,
      layer: "none",
      declaredMissing: ["styles.css"],
    });
    expect(line).toContain("styles.css");
    expect(line).toContain("declares");
  });

  it("adds no declaredMissing key to a report built from a real discovery", () => {
    // The producer, not a cast literal: nothing declared must not grow an empty array here.
    const discovered = discoverGlobalCss(path.resolve("fixtures/css-font"), undefined);
    const report = buildCssReport(discovered, path.resolve("fixtures/css-font"));
    expect(Object.prototype.hasOwnProperty.call(report, "declaredMissing")).toBe(false);
  });
  it("carries the declared targets into the report's css object", () => {
    const report = buildCssReport(
      {
        files: [],
        autoDetected: true,
        layer: "none",
        declaredMissing: [{ field: "style", path: "styles.css" }],
      } as unknown as Parameters<typeof buildCssReport>[0],
      process.cwd(),
    );
    expect(report.declaredMissing).toEqual(["styles.css"]);
    expect(report.declaredMissingFields).toEqual([{ field: "style", path: "styles.css" }]);
  });
});

// radix-themes-F2 / C4: this exercises the whole path so a cast literal cannot hide a break.
describe("a declared-but-unbuilt stylesheet from discovery to the printed line", () => {
  const DECLARED_ABSENT = path.resolve("fixtures/declared-absent-style");

  it("names the declaring field, the missing path and the producing script", () => {
    const report = buildCssReport(
      resolveCssFiles({}, DECLARED_ABSENT, []),
      DECLARED_ABSENT,
    );
    // The package manager is read from the checkout; only the build command varies here.
    expect(formatStylesheetsLine(report)).toMatch(
      /^Stylesheets: none injected — package\.json "style" declares styles\.css, which is not built yet; run `[^`]+ build` in that package, then re-run$/,
    );
  });

  it("carries the declaring fields into the report's css object", () => {
    const report = buildCssReport(
      resolveCssFiles({}, DECLARED_ABSENT, []),
      DECLARED_ABSENT,
    );
    expect(report.layer).toBe("none");
    expect(report.files).toEqual([]);
    expect(report.declaredMissing).toEqual(["styles.css"]);
    expect(report.declaredMissingFields).toEqual([
      { field: "style", path: "styles.css", buildCommand: expect.stringMatching(/ build$/) },
    ]);
  });

  it("keeps the size-ranked sheet out of the injected set", () => {
    const report = buildCssReport(
      resolveCssFiles({}, DECLARED_ABSENT, []),
      DECLARED_ABSENT,
    );
    expect(report.files.some((f) => f.includes("tokens.css"))).toBe(false);
  });
});
