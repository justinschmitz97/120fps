import { describe, it, expect } from "vitest";
import { formatTable, dedupeWarnings, type Report, type Thresholds } from "../../src/report/index.js";
import { buildTimingWithCV } from "../../src/report/index.js";
import { formatMarkdown } from "../../src/report/index.js";

// specs/milestones/m117-output-that-respects-the-reader.md: a rebuild doubled one warning line.

const THRESHOLDS: Thresholds = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

function makeTiming(median: number) {
  return buildTimingWithCV([median, median, median]);
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
    componentPath: "./Dialog.tsx",
    componentName: "Dialog",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [{
      comboIndex: 0,
      props: {},
      mount: makeTiming(1.0),
      unmount: makeTiming(0.1),
      rerender: makeTiming(0.5),
      domNodeCount: 8,
      heapDelta: 0,
      interactions: [],
      scalingCurve: null,
      relativeMount: 0.1,
      verdict: "pass" as const,
    }],
    thresholds: THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

const REPEATED = "vite.config.ts declares plugins the harness cannot honor: react — the project's Vite config is never executed";
const OTHER_A = "Composition rolled back: Dialog rendered nothing.";
const OTHER_B = "Sibling parts were not composed: DialogTrigger.";

describe("a repeated warning text", () => {
  it("is recorded once by the collector", () => {
    expect(dedupeWarnings([OTHER_A, OTHER_A])).toEqual([`${OTHER_A} (×2)`]);
  });

  it("keeps first-occurrence order across distinct texts", () => {
    expect(dedupeWarnings([REPEATED, OTHER_A, REPEATED, OTHER_B])).toEqual([
      `${REPEATED} (×2)`,
      OTHER_A,
      OTHER_B,
    ]);
  });

  it("leaves a text that occurred once uncounted", () => {
    expect(dedupeWarnings([OTHER_A])).toEqual([OTHER_A]);
  });

  it("collapses two texts that differ by one character to neither", () => {
    expect(dedupeWarnings([OTHER_A, `${OTHER_A}.`])).toEqual([OTHER_A, `${OTHER_A}.`]);
  });

  it("prints one terminal line ending with the count", () => {
    const table = formatTable(makeReport({ warnings: [REPEATED, OTHER_A, REPEATED, OTHER_B, REPEATED] }));
    const printed = table.split("\n").filter((line) => line.startsWith("⚠ "));
    expect(printed).toEqual([`⚠ ${REPEATED} (×3)`, `⚠ ${OTHER_A}`, `⚠ ${OTHER_B}`]);
  });
});

describe("the markdown report's warnings", () => {
  it("folds one component's deduped texts with their counts", () => {
    const md = formatMarkdown([makeReport({ warnings: [REPEATED, OTHER_A, REPEATED, REPEATED] })]);
    expect(md).toContain("<details><summary>Warnings");
    expect(md).toContain(`- ${REPEATED} (×3)`);
    expect(md).toContain(`- ${OTHER_A}`);
    expect(md.split(`- ${REPEATED} (×3)`).length - 1).toBe(1);
  });

  it("names the component the fold belongs to", () => {
    const md = formatMarkdown([makeReport({ warnings: [OTHER_A] })]);
    expect(md).toContain("./Dialog.tsx");
    expect(md).toContain(`- ${OTHER_A}`);
  });

  it("adds one fold per component that has warnings", () => {
    const md = formatMarkdown([
      makeReport({ componentPath: "./A.tsx", warnings: [OTHER_A] }),
      makeReport({ componentPath: "./B.tsx", warnings: [OTHER_B] }),
    ]);
    expect(md.split("<details><summary>Warnings").length - 1).toBe(2);
  });

  it("adds no fold when no component has warnings", () => {
    const md = formatMarkdown([makeReport(), makeReport({ warnings: [] })]);
    expect(md).not.toContain("<details><summary>Warnings");
  });
});
