import { describe, it, expect } from "vitest";
import { formatTable, type Report, type Thresholds, buildTimingWithCV } from "../../src/report.js";
import {
  formatNoiseWarning,
  HOSTILE_RUN_WARNING,
  NOISY_RUN_WARNING,
  HOSTILE_BASELINE_NOTE,
  type NoiseReport,
} from "../../src/noise.js";

// M117 C5, C6, C7 (dx-audit item 7): the terminal spent four sentences on a
// machine fact, listed both signals whether or not either crossed its
// threshold, and named no flag. One line, only the signals that fired, the one
// flag that helps; the long form stays in the JSON.

const THRESHOLDS: Thresholds = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

function makeTiming(median: number) {
  return buildTimingWithCV([median, median, median]);
}

function noise(level: NoiseReport["level"], overrides: Partial<NoiseReport["signals"]> = {}): NoiseReport {
  return {
    level,
    signals: { probeCv: 53, probeMedianMs: 12, unstableFraction: 1, contextRetries: 0, ...overrides },
  };
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

function warningLines(report: Report): string[] {
  return formatTable(report).split("\n").filter((line) => line.startsWith("⚠ "));
}

describe("the terminal line for a machine that was not quiet", () => {
  it("is one line naming both crossed signals and the flag that helps", () => {
    const lines = warningLines(makeReport({
      warnings: [HOSTILE_RUN_WARNING],
      noise: noise("hostile", { probeCv: 53, unstableFraction: 1 }),
    }));
    expect(lines).toEqual([
      "⚠ machine: hostile (probe CV 53%, 100% of metrics unstable); raise --samples to measure through it.",
    ]);
  });

  it("names only the signal that crossed its threshold", () => {
    const lines = warningLines(makeReport({
      warnings: [NOISY_RUN_WARNING],
      noise: noise("noisy", { probeCv: 15.4, unstableFraction: 0 }),
    }));
    expect(lines).toEqual([
      "⚠ machine: noisy (probe CV 15%); raise --samples to measure through it.",
    ]);
  });

  it("names a surviving context retry on its own", () => {
    const lines = warningLines(makeReport({
      warnings: [NOISY_RUN_WARNING],
      noise: noise("noisy", { probeCv: 5, unstableFraction: 0, contextRetries: 1 }),
    }));
    expect(lines).toEqual([
      "⚠ machine: noisy (1 context retry); raise --samples to measure through it.",
    ]);
  });

  it("carries no baseline sentence, whether or not a comparison happened", () => {
    const report = makeReport({
      warnings: [formatNoiseWarning(noise("hostile"), true)],
      noise: noise("hostile"),
      baseline: { hasBaseline: true, regressions: [], improvements: [], skippedNoisy: true },
    });
    const table = formatTable(report);
    expect(table).not.toContain(HOSTILE_BASELINE_NOTE);
    expect(table).toContain("⚠ machine: hostile (probe CV 53%, 100% of metrics unstable); raise --samples to measure through it.");
  });

  it("shortens the full JSON text the same way it shortens the bare constant", () => {
    const full = formatNoiseWarning(noise("hostile"), false);
    expect(warningLines(makeReport({ warnings: [full], noise: noise("hostile") }))).toEqual(
      warningLines(makeReport({ warnings: [HOSTILE_RUN_WARNING], noise: noise("hostile") })),
    );
  });
});

describe("the long form the JSON keeps", () => {
  it("carries the machine sentence, the provisional sentence and the baseline sentence", () => {
    const full = formatNoiseWarning(noise("hostile"), true);
    expect(full).toContain("machine: hostile");
    expect(full).toContain(HOSTILE_RUN_WARNING);
    expect(full).toContain(HOSTILE_BASELINE_NOTE);
  });

  it("keeps all four signals on report.noise untouched by the terminal line", () => {
    const report = makeReport({ warnings: [HOSTILE_RUN_WARNING], noise: noise("hostile") });
    formatTable(report);
    expect(report.noise!.signals).toEqual({
      probeCv: 53,
      probeMedianMs: 12,
      unstableFraction: 1,
      contextRetries: 0,
    });
  });
});

describe("the verdict wording a noisy run prints", () => {
  it("is byte-identical to the same report on a quiet machine", () => {
    const noisy = formatTable(makeReport({ warnings: [HOSTILE_RUN_WARNING], noise: noise("hostile") }));
    const quiet = formatTable(makeReport({ noise: noise("quiet") }));
    const verdictOf = (table: string): string[] =>
      table.split("\n").filter((line) => line.startsWith("Result:") || line.startsWith("Combo #"));
    expect(verdictOf(noisy)).toEqual(verdictOf(quiet));
  });
});
