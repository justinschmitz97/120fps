import { describe, it, expect } from "vitest";
import {
  formatTable,
  buildTimingWithCV,
  type Report,
  type Thresholds,
} from "../../src/report.js";
import type { IsolationReport } from "../../src/isolation.js";

const THRESHOLDS: Thresholds = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

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
    thresholds: THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

describe("Report with isolation field", () => {
  it("isolation is optional", () => {
    const report = makeReport();
    expect(report.isolation).toBeUndefined();
  });

  it("accepts IsolationReport", () => {
    const isolation: IsolationReport = {
      mount: makeTiming(0.82),
    };
    const report = makeReport({ isolation });
    expect(report.isolation!.mount!.median).toBeCloseTo(0.82);
  });
});

describe("formatTable with isolation", () => {
  it("shows mount section when mount phase present", () => {
    const isolation: IsolationReport = {
      mount: makeTiming(0.82),
    };
    const output = formatTable(makeReport({ isolation }));
    expect(output).toContain("Mount (isolated)");
    expect(output).toContain("0.82ms");
  });

  it("shows rerender section with sub-modes", () => {
    const isolation: IsolationReport = {
      rerender: {
        stable: makeTiming(0.31),
        propChange: makeTiming(0.45),
        churn: makeTiming(0.52),
        churnDegradation: 1.15,
      },
    };
    const output = formatTable(makeReport({ isolation }));
    expect(output).toContain("Rerender (isolated)");
    expect(output).toContain("Stable");
    expect(output).toContain("Prop-change");
    expect(output).toContain("Churn");
  });

  it("shows memory section", () => {
    const isolation: IsolationReport = {
      memory: {
        cycles: 20,
        heapBefore: 148000,
        heapAfter: 152000,
        heapGrowth: 4000,
        heapGrowthPerCycle: 200,
        leakSuspected: false,
        gcPressure: 2.5,
      },
    };
    const output = formatTable(makeReport({ isolation }));
    expect(output).toContain("Memory");
    expect(output).toContain("20 cycles");
    expect(output).toContain("NO");
  });

  it("shows strictmode section", () => {
    const isolation: IsolationReport = {
      strictMode: {
        normalMount: makeTiming(0.82),
        strictMount: makeTiming(1.58),
        overhead: 92.7,
        doubleInvokeClean: true,
      },
    };
    const output = formatTable(makeReport({ isolation }));
    expect(output).toContain("StrictMode");
    expect(output).toContain("Normal mount");
    expect(output).toContain("Strict mount");
    expect(output).toContain("YES");
  });

  it("shows unmount section", () => {
    const isolation: IsolationReport = {
      unmount: makeTiming(0.15),
    };
    const output = formatTable(makeReport({ isolation }));
    expect(output).toContain("Unmount (isolated)");
    expect(output).toContain("0.15ms");
  });

  it("omits phases not measured", () => {
    const isolation: IsolationReport = {
      mount: makeTiming(0.82),
    };
    const output = formatTable(makeReport({ isolation }));
    expect(output).toContain("Mount (isolated)");
    expect(output).not.toContain("Rerender (isolated)");
    expect(output).not.toContain("Memory");
    expect(output).not.toContain("StrictMode");
  });

  it("does not show normal combo table when isolation is present", () => {
    const isolation: IsolationReport = {
      mount: makeTiming(0.82),
    };
    const output = formatTable(makeReport({ isolation }));
    expect(output).not.toContain("Interactions");
    expect(output).not.toContain("Scaling");
  });
});
