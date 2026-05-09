import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";
import {
  parseIsolationPhases,
  computeChurnDegradation,
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

describe("H1: --isolate without value", () => {
  it("errors", () => {
    const args = parseArgs(["./Button.tsx", "--isolate"]);
    expect(args.error).toBeDefined();
    expect(args.error).toContain("--isolate");
  });
});

describe("H2: --isolate with invalid phase", () => {
  it("errors with phase name", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "bogus"]);
    expect(args.error).toContain("bogus");
  });

  it("errors on mixed valid/invalid", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "mount,invalid"]);
    expect(args.error).toContain("invalid");
  });
});

describe("H3: --isolate all", () => {
  it("expands to 5 phases", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "all"]);
    expect(args.isolate).toHaveLength(5);
    expect(args.isolate).toContain("mount");
    expect(args.isolate).toContain("strictmode");
  });
});

describe("H4: --isolate mount,mount", () => {
  it("deduplicates", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "mount,mount"]);
    expect(args.isolate).toEqual(["mount"]);
  });
});

describe("H5: --isolate + --curve", () => {
  it("errors", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "mount", "--curve"]);
    expect(args.error).toContain("--isolate");
    expect(args.error).toContain("--curve");
  });
});

describe("H6: --isolate + --matrix", () => {
  it("errors", () => {
    const args = parseArgs(["./Button.tsx", "--isolate", "mount", "--matrix"]);
    expect(args.error).toContain("--isolate");
    expect(args.error).toContain("--matrix");
  });
});

describe("H7: --no-isolate stored", () => {
  it("stores flag", () => {
    const args = parseArgs(["./Button.tsx", "--no-isolate"]);
    expect(args.noIsolate).toBe(true);
  });
});

describe("H8: churn degradation with 0 first3", () => {
  it("returns 1.0 (safe)", () => {
    expect(computeChurnDegradation([0, 0, 0, 1, 1, 1])).toBe(1.0);
  });
});

describe("H9: memory 0 cycles", () => {
  it("safe report", () => {
    const report = buildMemoryReport({ cycles: 0, heapBefore: 100, heapAfter: 100, gcPressure: 0 });
    expect(report.heapGrowthPerCycle).toBe(0);
    expect(report.leakSuspected).toBe(false);
  });
});

describe("H10: memory exactly 1024 bytes/cycle", () => {
  it("NOT a leak (must be >1024)", () => {
    const report = buildMemoryReport({ cycles: 1, heapBefore: 0, heapAfter: 1024, gcPressure: 0 });
    expect(report.heapGrowthPerCycle).toBe(1024);
    expect(report.leakSuspected).toBe(false);
  });
});

describe("H11: memory 1025 bytes/cycle", () => {
  it("IS a leak", () => {
    const report = buildMemoryReport({ cycles: 1, heapBefore: 0, heapAfter: 1025, gcPressure: 0 });
    expect(report.heapGrowthPerCycle).toBe(1025);
    expect(report.leakSuspected).toBe(true);
  });
});

describe("H12: StrictMode 0ms normal mount", () => {
  it("safe overhead calc (returns 0%)", () => {
    const report = buildStrictModeReport([0, 0, 0], [1, 1, 1]);
    expect(report.overhead).toBe(0);
    expect(report.doubleInvokeClean).toBe(true);
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

describe("H15: format with only mount phase", () => {
  it("only mount section, no others", () => {
    const isolation: IsolationReport = { mount: makeTiming(0.82) };
    const output = formatTable(makeReport({ isolation }));
    expect(output).toContain("Mount (isolated)");
    expect(output).not.toContain("Rerender (isolated)");
    expect(output).not.toContain("Memory");
    expect(output).not.toContain("StrictMode");
    expect(output).not.toContain("Unmount (isolated)");
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

describe("H17: isolation field JSON round-trip", () => {
  it("serializes and deserializes", () => {
    const isolation: IsolationReport = {
      mount: makeTiming(1.0),
      memory: { cycles: 20, heapBefore: 100, heapAfter: 200, heapGrowth: 100, heapGrowthPerCycle: 5, leakSuspected: false, gcPressure: 1 },
    };
    const report = makeReport({ isolation });
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json);
    expect(parsed.isolation.mount.median).toBe(1.0);
    expect(parsed.isolation.memory.cycles).toBe(20);
    expect(parsed.isolation.memory.leakSuspected).toBe(false);
  });
});

describe("H18: --memory-cycles requires positive integer", () => {
  it("rejects 0", () => {
    const args = parseArgs(["./Button.tsx", "--memory-cycles", "0"]);
    expect(args.error).toContain("--memory-cycles");
  });

  it("rejects negative", () => {
    const args = parseArgs(["./Button.tsx", "--memory-cycles", "-5"]);
    expect(args.error).toContain("--memory-cycles");
  });

  it("rejects float", () => {
    const args = parseArgs(["./Button.tsx", "--memory-cycles", "3.5"]);
    expect(args.error).toContain("--memory-cycles");
  });

  it("accepts valid integer", () => {
    const args = parseArgs(["./Button.tsx", "--memory-cycles", "50"]);
    expect(args.memoryCycles).toBe(50);
    expect(args.error).toBeUndefined();
  });
});
