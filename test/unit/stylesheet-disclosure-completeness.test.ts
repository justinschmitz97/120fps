import { describe, it, expect } from "vitest";
import { STYLESHEET_MATCHED_NOTHING_WARNING, buildCssReport } from "../../src/analyze.js";
import { formatStylesheetsLine, type CssReport } from "../../src/report.js";

// shadcn-ui-F3: a stylesheet dropped because it could not be read left
// `layer: "unreadable"` with an empty `details`, which a JSON reader cannot
// tell apart from a project that had no stylesheet at all.
// excalidraw-F2: `css/styles.scss` is scoped entirely under an `.excalidraw`
// ancestor the harness never renders, so every rule was injected and none
// applied — the report described a styled render that was measured unstyled.

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

describe("a stylesheet that matched nothing is named as such", () => {
  it("names the file, the rule count, and what the measurement therefore describes", () => {
    const warning = STYLESHEET_MATCHED_NOTHING_WARNING("css/styles.scss", 1183);
    expect(warning).toContain("css/styles.scss");
    expect(warning).toContain("1183 rules");
    expect(warning).toContain("unstyled render");
    expect(warning).toContain("--wrap");
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

// M102 / I7: the probe's own contract, isolated from a browser. The stats the
// generated entry returns are matched to `css.details` by file path (the entry
// reports the specifier it injected, the report holds the project-relative
// path), and only a sheet with rules of its own that matched none of them is
// worth a warning.
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

// heroui-F1: the pick resolves through the package's own
// `exports["./styles"]` -> `src/styles.css` -> `@import "@heroui/styles/index.css"`.
// "matched a conventional filename" would be false of it: nothing about the
// filename was consulted, the package declared it.
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
