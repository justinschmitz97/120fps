import { describe, it, expect } from "vitest";
import {
  DEFAULT_THRESHOLDS,
  formatJUnit,
  formatMarkdown,
  formatTable,
  type ComboReport,
  type Report,
} from "../../src/report/index.js";

const machine = {
  cpu: "Test CPU",
  cores: 8,
  ramMb: 16384,
  os: "Linux 6.0",
  nodeVersion: "v20.0.0",
  chromiumVersion: "120.0.0.0",
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

// The verdict the terminal prints for a component, as a reader reads it off the screen.
function terminalVerdict(subject: Report): "pass" | "fail" {
  const text = formatTable(subject);
  if (text.includes("Result: FAIL")) return "fail";
  if (text.includes("Result: PASS")) return "pass";
  throw new Error("the terminal printed no result line");
}

function markdownRow(text: string, componentPath: string): string {
  const row = text.split("\n").find((line) => line.includes(`\`${componentPath}\``));
  if (!row) throw new Error(`no markdown row for ${componentPath}`);
  return row;
}

describe("the CI artifact carries every component the run reported on", () => {
  const passing = report();
  const failing = report({
    componentPath: "./src/Table.tsx",
    pass: false,
    combos: [combo({ verdict: "fail" })],
  });
  const reusedFailing = report({
    componentPath: "./src/Cached.tsx",
    pass: false,
    cached: true,
    combos: [],
  });

  it("counts one component per report handed to the writers", () => {
    const text = formatMarkdown([passing, failing, reusedFailing]);
    expect(text).toContain("3 components");
    expect(formatJUnit([passing, failing, reusedFailing])).toContain('tests="3"');
  });

  it("gives each markdown row the verdict the terminal printed for that component", () => {
    const text = formatMarkdown([passing, failing, reusedFailing]);
    for (const subject of [passing, failing, reusedFailing]) {
      const row = markdownRow(text, subject.componentPath);
      const printed = terminalVerdict(subject);
      expect(row.includes("**FAIL**")).toBe(printed === "fail");
    }
  });

  it("marks a failing component as a JUnit failure", () => {
    const xml = formatJUnit([passing, failing]);
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('name="./src/Table.tsx"');
  });

  it("still writes the empty artifact when the run reported on nothing", () => {
    expect(formatMarkdown([])).toContain("0 components");
    expect(formatJUnit([])).toContain('tests="0"');
  });
});

describe("the CI artifact agrees with the process exit code", () => {
  it("does not headline PASS for a run that exits 1", () => {
    const text = formatMarkdown([report()], { failed: true });
    expect(text).toContain("**FAIL**");
    expect(text).not.toContain("**PASS**");
  });

  it("headlines PASS for a run that exits 0", () => {
    const text = formatMarkdown([report()], { failed: false });
    expect(text).toContain("**PASS**");
    expect(formatJUnit([report()])).toContain('failures="0"');
  });

  it("headlines a failure for a run that reported on nothing and still exited 1", () => {
    const text = formatMarkdown([], { failed: true });
    expect(text).toContain("**FAIL**: 0 components");
  });

  it("reports a failure whenever a measured component failed, told or not", () => {
    const failing = report({ pass: false, combos: [combo({ verdict: "fail" })] });
    expect(formatMarkdown([failing])).toContain("**FAIL**");
    expect(formatMarkdown([failing], { failed: true })).toContain("**FAIL**");
  });
});
