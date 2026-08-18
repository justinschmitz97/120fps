import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";
import {
  parseIsolationPhases,
  buildMemoryReport,
  buildStrictModeReport,
  buildRerenderIsolation,
  type IsolationPhase,
} from "../../src/isolation.js";
import {
  formatTable,
  buildTimingWithCV,
  type Report,
} from "../../src/report.js";
import type { IsolationReport } from "../../src/isolation.js";

function makeTiming(median: number) {
  return buildTimingWithCV([median, median, median]);
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
    componentPath: "./test.tsx",
    componentName: "Test",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [],
    thresholds: { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 },
    pass: true,
    ...overrides,
  };
}

describe("H2: --isolate with invalid phase", () => {
  it("errors on mixed valid/invalid", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "mount,invalid"]);
    expect(args.error).toContain("invalid");
  });
});

describe("H10: memory exactly 8192 bytes/cycle", () => {
  it("NOT a leak (must be >8192)", () => {
    const report = buildMemoryReport({ cycles: 1, heapBefore: 0, heapAfter: 8192, gcPressure: 0 });
    expect(report.heapGrowthPerCycle).toBe(8192);
    expect(report.leakSuspected).toBe(false);
  });
});

describe("H11: memory 8193 bytes/cycle", () => {
  it("IS a leak", () => {
    const report = buildMemoryReport({ cycles: 1, heapBefore: 0, heapAfter: 8193, gcPressure: 0 });
    expect(report.heapGrowthPerCycle).toBe(8193);
    expect(report.leakSuspected).toBe(true);
  });
});

describe("H13: StrictMode overhead at 109%", () => {
  it("doubleInvokeClean = true (<=110)", () => {
    const report = buildStrictModeReport([1, 1, 1], [2.09, 2.09, 2.09]);
    expect(report.overhead).toBeCloseTo(109);
    expect(report.doubleInvokeClean).toBe(true);
  });
});

describe("H14: StrictMode overhead 111%", () => {
  it("doubleInvokeClean = false (>110)", () => {
    const report = buildStrictModeReport([1, 1, 1], [2.11, 2.11, 2.11]);
    expect(report.overhead).toBeCloseTo(111);
    expect(report.doubleInvokeClean).toBe(false);
  });
});

describe("H16: format with all phases", () => {
  it("all sections present", () => {
    const isolation: IsolationReport = {
      mount: makeTiming(0.82),
      rerender: { stable: makeTiming(0.3), propChange: makeTiming(0.5), churn: makeTiming(0.6), churnDegradation: 1.1 },
      unmount: makeTiming(0.15),
      memory: { cycles: 20, heapBefore: 100000, heapAfter: 110000, heapGrowth: 10000, heapGrowthPerCycle: 500, leakSuspected: false, gcPressure: 2 },
      strictMode: { normalMount: makeTiming(0.82), strictMount: makeTiming(1.5), overhead: 83, doubleInvokeClean: true },
    };
    const output = formatTable(makeReport({ isolation }));
    expect(output).toContain("Mount (isolated)");
    expect(output).toContain("Rerender (isolated)");
    expect(output).toContain("Unmount (isolated)");
    expect(output).toContain("Memory");
    expect(output).toContain("StrictMode");
  });
});

describe("H18: --memory-cycles requires positive integer", () => {
  it("rejects negative", () => {
    const args = parseArgs(["./Button.tsx", "--memory-cycles", "-5"]);
    expect(args.error).toContain("--memory-cycles");
  });

  it("rejects float", () => {
    const args = parseArgs(["./Button.tsx", "--memory-cycles", "3.5"]);
    expect(args.error).toContain("--memory-cycles");
  });
});
