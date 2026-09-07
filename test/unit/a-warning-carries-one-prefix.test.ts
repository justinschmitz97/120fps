import { describe, it, expect } from "vitest";
import path from "node:path";
import { explainProps } from "../../src/pipeline/index.js";
import { extractPropsDetailed } from "../../src/props/index.js";
import {
  formatTable,
  formatMarkdown,
  buildTimingWithCV,
  type Report,
  type Thresholds,
} from "../../src/report/index.js";

const fixture = (rel: string): string => path.resolve("fixtures", rel);

const THRESHOLDS: Thresholds = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

function makeReport(warnings: string[]): Report {
  const timing = buildTimingWithCV([1, 1, 1]);
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
    componentPath: "./Toggle.tsx",
    componentName: "Toggle",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [{
      comboIndex: 0,
      props: {},
      mount: timing,
      unmount: timing,
      rerender: timing,
      domNodeCount: 8,
      heapDelta: 0,
      interactions: [],
      scalingCurve: null,
      relativeMount: 0.1,
      verdict: "pass" as const,
    }],
    thresholds: THRESHOLDS,
    pass: true,
    warnings,
  };
}

describe("a warning collected as data", () => {
  it("carries no prefix of its own", async () => {
    const collected: string[] = [];
    await extractPropsDetailed(fixture("m60/unsynthesizable.tsx"), {
      onWarning: (warning) => collected.push(warning),
    });
    const degenerate = collected.find((w) => w.includes("no representative value"));
    expect(degenerate).toBeDefined();
    expect(degenerate!.startsWith("Warning:")).toBe(false);
  });

  it("reaches the dry run's list without a prefix", async () => {
    const explained = await explainProps(fixture("m60/unsynthesizable.tsx"));
    const degenerate = explained.warnings.find((w) => w.includes("no representative value"));
    expect(degenerate).toBeDefined();
    expect(degenerate!.startsWith("Warning:")).toBe(false);
  });
});

describe("the terminal's warning prefix", () => {
  it("is the only prefix a line carries", async () => {
    const collected: string[] = [];
    await extractPropsDetailed(fixture("m60/unsynthesizable.tsx"), {
      onWarning: (warning) => collected.push(warning),
    });
    const output = formatTable(makeReport(collected));
    expect(output).not.toContain("⚠ Warning:");
    expect(output).toContain("⚠ no representative value");
  });

  it("is added to a text that has none", () => {
    const output = formatTable(makeReport(["measured 2 of 3 prop combos"]));
    expect(output).toContain("⚠ measured 2 of 3 prop combos");
  });

  it("is not added to a text that already leads with one", () => {
    const output = formatTable(makeReport(["⚠ already marked", "Warning: already worded"]));
    expect(output).toContain("⚠ already marked");
    expect(output).not.toContain("⚠ ⚠ already marked");
    expect(output).not.toContain("⚠ Warning: already worded");
    expect(output).toContain("Warning: already worded");
  });
});

describe("the markdown report's warning fold", () => {
  it("carries the unprefixed text", () => {
    const md = formatMarkdown([makeReport(["no representative value could be synthesized for onToggle"])]);
    expect(md).toContain("- no representative value could be synthesized for onToggle");
    expect(md).not.toContain("Warning: no representative value");
    expect(md).not.toContain("⚠");
  });
});
