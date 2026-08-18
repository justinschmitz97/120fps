import { describe, it, expect } from "vitest";
import { formatMarkdown, formatJUnit } from "../../src/ci-report.js";
import { DEFAULT_THRESHOLDS, type Report, type ComboReport } from "../../src/report.js";
import { parseArgs } from "../../src/cli.js";

const machine = {
  cpu: "Test CPU", cores: 8, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};

function combo(overrides: Partial<ComboReport> = {}): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [4], median: 4, p95: 4, cv: 0, unstable: false },
    unmount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
    rerender: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
    domNodeCount: 6,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 0.4,
    verdict: "pass",
    tier: "T1",
    ...overrides,
  };
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine,
    componentPath: "./src/Button.tsx",
    componentName: "Button",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [combo()],
    thresholds: DEFAULT_THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

const REGRESSED = report({
  pass: false,
  componentPath: "./src/Table.tsx",
  combos: [combo({ verdict: "fail" })],
  baseline: {
    hasBaseline: true,
    regressions: [
      { metric: "mount", baseline: 4, current: 6, deltaPercent: 50, tolerance: 10 },
    ],
    improvements: [],
    missingInteractions: [],
    envMatch: "identical",
    envMismatches: [],
  },
});

// C1: the markdown a reviewer reads in the PR.
describe("formatMarkdown: PR summary", () => {
  it("leads with the verdict and the counts", () => {
    const text = formatMarkdown([report(), REGRESSED]);
    expect(text).toContain("**FAIL**");
    expect(text).toContain("2 components");
    expect(text).toContain("1 regression");
  });

  it("says PASS when nothing failed", () => {
    expect(formatMarkdown([report()])).toContain("**PASS**");
  });

  it("puts one row per component in a table", () => {
    const text = formatMarkdown([report(), REGRESSED]);
    expect(text).toContain("| component | mount | rerender | verdict | vs baseline |");
    expect(text).toContain("`./src/Button.tsx`");
    expect(text).toContain("`./src/Table.tsx`");
    expect(text).toContain("4.00ms");
  });

  it("expands regressions behind a fold so a sweep fits a comment", () => {
    const text = formatMarkdown([REGRESSED]);
    expect(text).toContain("<details><summary>Regressions</summary>");
    expect(text).toContain("4.00ms → 6.00ms");
    expect(text).toContain("+50.0%");
  });

  it("omits the fold entirely when nothing regressed", () => {
    expect(formatMarkdown([report()])).not.toContain("<details>");
  });

  it("marks a reused verdict as cached", () => {
    expect(formatMarkdown([report({ cached: true, combos: [] })])).toContain("_(cached)_");
  });

  it("names the machine and, when known, how noisy it was", () => {
    const text = formatMarkdown([
      report({ noise: { level: "noisy", signals: { probeCv: 20, probeMedianMs: 9, unstableFraction: 0, contextRetries: 0 } } }),
    ]);
    expect(text).toContain("Test CPU");
    expect(text).toContain("machine noisy");
  });

  it("says a comparison was skipped rather than inventing a delta", () => {
    const skipped = report({
      baseline: {
        hasBaseline: true, regressions: [], improvements: [],
        missingInteractions: [], envMatch: "unknown", envMismatches: [], skippedNoisy: true,
      },
    });
    expect(formatMarkdown([skipped])).toContain("skipped (noisy)");
  });

  it("marks a cross-environment comparison as another machine's", () => {
    const cross = report({
      baseline: {
        hasBaseline: true, regressions: [], improvements: [],
        missingInteractions: [], envMatch: "normalizable", envMismatches: [], crossEnvironment: true,
      },
    });
    expect(formatMarkdown([cross])).toContain("other machine");
  });
});

// C2: JUnit is the cheapest universal integration.
describe("formatJUnit: XML output", () => {
  it("emits one testcase per component with the run's totals", () => {
    const xml = formatJUnit([report(), REGRESSED]);
    expect(xml).toContain('<testsuites name="120fps" tests="2" failures="1">');
    expect(xml).toContain('name="./src/Button.tsx"');
    expect(xml).toContain('name="./src/Table.tsx"');
  });

  it("leaves a passing component without a failure body", () => {
    const xml = formatJUnit([report()]);
    expect(xml).toContain('<testcase name="./src/Button.tsx" classname="120fps" />');
    expect(xml).not.toContain("<failure");
  });

  it("puts the numbers in the failure body", () => {
    const xml = formatJUnit([REGRESSED]);
    expect(xml).toContain("<failure");
    expect(xml).toContain("mount: 4.00ms");
    expect(xml).toContain("6.00ms");
  });

  it("escapes XML so a path with a quote cannot break the document", () => {
    const xml = formatJUnit([report({ componentPath: './a"b&c<d>.tsx', pass: false })]);
    expect(xml).toContain("&quot;");
    expect(xml).toContain("&amp;");
    expect(xml).not.toMatch(/name="\.\/a"b/);
  });

  it("starts with an XML declaration", () => {
    expect(formatJUnit([report()]).startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });

  it("handles an empty sweep without malformed output", () => {
    const xml = formatJUnit([]);
    expect(xml).toContain('tests="0" failures="0"');
    expect(xml).toContain("</testsuites>");
  });
});

// C3: the flags.
describe("parseArgs: report-path flags", () => {
  it("takes a path for each format", () => {
    const args = parseArgs(["./Button.tsx", "--report-md", "out.md", "--report-junit", "out.xml"]);
    expect(args.reportMd).toBe("out.md");
    expect(args.reportJunit).toBe("out.xml");
    expect(args.error).toBeUndefined();
  });

  it("errors without a path", () => {
    expect(parseArgs(["./Button.tsx", "--report-md"]).error).toContain("path");
    expect(parseArgs(["./Button.tsx", "--report-junit"]).error).toContain("path");
  });
});
