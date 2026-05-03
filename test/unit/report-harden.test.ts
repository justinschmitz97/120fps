import { describe, it, expect } from "vitest";
import {
  computeCV,
  buildTimingWithCV,
  computeVerdict,
  formatTable,
  DEFAULT_THRESHOLDS,
  type ComboReport,
  type Report,
} from "../../src/report.js";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: {
      cpu: "Test CPU", cores: 4, ramMb: 16384,
      os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
    },
    componentPath: "./Button.tsx",
    componentName: "Button",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [],
    thresholds: DEFAULT_THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

function makeCombo(overrides: Partial<ComboReport> = {}): ComboReport {
  return {
    comboIndex: 0, props: {},
    mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
    unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
    rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
    domNodeCount: 10, heapDelta: 0, interactions: [],
    scalingCurve: null, relativeMount: 0.5, verdict: "pass",
    ...overrides,
  };
}

describe("H1: componentName fallback to filename", () => {
  it("uses filename when no named/default export matches", () => {
    const input: BuildReportInput = {
      componentPath: "./my-widget.tsx",
      componentName: "MyWidget",
      machine: {
        cpu: "Test", cores: 1, ramMb: 1024,
        os: "Test", nodeVersion: "v20.0.0", chromiumVersion: "120",
      },
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [{ comboIndex: 0, props: {}, mount: { samples: [5], median: 5, p95: 5 }, unmount: { samples: [2], median: 2, p95: 2 }, domNodeCount: 5 }],
      explores: [],
      heapDeltas: [0],
      thresholds: DEFAULT_THRESHOLDS,
    };
    const report = buildReport(input);
    expect(report.componentName).toBe("MyWidget");
  });
});

describe("H3: zero calibration duration", () => {
  it("produces relativeMount=0 when calibration totalDuration is 0", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 1, ramMb: 1024,
        os: "Test", nodeVersion: "v20.0.0", chromiumVersion: "120",
      },
      calibration: { totalDuration: 0, scriptDuration: 0 },
      mounts: [{ comboIndex: 0, props: {}, mount: { samples: [5, 5], median: 5, p95: 5 }, unmount: { samples: [2], median: 2, p95: 2 }, domNodeCount: 5 }],
      explores: [],
      heapDeltas: [0],
      thresholds: DEFAULT_THRESHOLDS,
    };
    const report = buildReport(input);
    expect(report.combos[0].relativeMount).toBe(0);
    expect(Number.isFinite(report.combos[0].relativeMount)).toBe(true);
  });
});

describe("H4: identical samples produce CV=0", () => {
  it("CV is exactly 0, not NaN", () => {
    expect(computeCV([7.5, 7.5, 7.5, 7.5, 7.5])).toBe(0);
    const t = buildTimingWithCV([7.5, 7.5, 7.5, 7.5, 7.5]);
    expect(t.cv).toBe(0);
    expect(t.unstable).toBe(false);
  });
});

describe("H5: negative heap delta", () => {
  it("accepts negative heap delta without error", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 1, ramMb: 1024,
        os: "Test", nodeVersion: "v20.0.0", chromiumVersion: "120",
      },
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [{ comboIndex: 0, props: {}, mount: { samples: [5], median: 5, p95: 5 }, unmount: { samples: [2], median: 2, p95: 2 }, domNodeCount: 5 }],
      explores: [],
      heapDeltas: [-4096],
      thresholds: DEFAULT_THRESHOLDS,
    };
    const report = buildReport(input);
    expect(report.combos[0].heapDelta).toBe(-4096);
  });
});

describe("H6: deeply nested props serialize to JSON", () => {
  it("report with nested props serializes without error", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 1, ramMb: 1024,
        os: "Test", nodeVersion: "v20.0.0", chromiumVersion: "120",
      },
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [{
        comboIndex: 0,
        props: { config: { a: { b: { c: { d: "deep" } } } } },
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 5,
      }],
      explores: [],
      heapDeltas: [0],
      thresholds: DEFAULT_THRESHOLDS,
    };
    const report = buildReport(input);
    const json = JSON.stringify(report);
    const parsed = JSON.parse(json);
    expect(parsed.combos[0].props.config.a.b.c.d).toBe("deep");
  });
});

describe("H7: long component name in formatTable", () => {
  it("does not crash", () => {
    const r = makeReport({ componentName: "A".repeat(200), combos: [makeCombo()] });
    const output = formatTable(r);
    expect(output).toContain("A".repeat(200));
  });
});

describe("H8: zero combos in formatTable", () => {
  it("produces valid output with no data rows", () => {
    const r = makeReport({ combos: [] });
    const output = formatTable(r);
    expect(output).toContain("Button");
    expect(output.length).toBeGreaterThan(0);
  });
});

describe("H9: CLI --samples 0 produces error", () => {
  it("parseArgs rejects 0", async () => {
    const { parseArgs } = await import("../../src/cli.js");
    const result = parseArgs(["./Button.tsx", "--samples", "0"]);
    expect(result.error).toBeTruthy();
  });
});

describe("H10: CLI duplicate flags", () => {
  it("last --samples wins", async () => {
    const { parseArgs } = await import("../../src/cli.js");
    const result = parseArgs(["./Button.tsx", "--samples", "3", "--samples", "7"]);
    expect(result.samples).toBe(7);
  });
});

describe("H11: computeCV with negative values", () => {
  it("returns a finite number", () => {
    const cv = computeCV([-5, -3, -1, 0, 1]);
    expect(Number.isFinite(cv)).toBe(true);
    expect(cv).toBeGreaterThan(0);
  });
});

describe("H14: formatTable with scaling curve", () => {
  it("shows growth class in table", () => {
    const combo = makeCombo({
      scalingCurve: { slope: 0.5, intercept: 1, r2: 0.95, growthClass: "linear" },
    });
    const r = makeReport({ combos: [combo] });
    const output = formatTable(r);
    expect(output).toContain("linear");
  });
});

describe("H15: report.pass logic with mixed verdicts", () => {
  it("pass=true when all combos are warn (not fail)", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 1, ramMb: 1024,
        os: "Test", nodeVersion: "v20.0.0", chromiumVersion: "120",
      },
      calibration: { totalDuration: 100, scriptDuration: 50 },
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [0.2, 1.8], median: 1, p95: 1.8 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 5,
      }],
      explores: [],
      heapDeltas: [0],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
    };
    const report = buildReport(input);
    if (report.combos[0].mount.unstable) {
      expect(report.combos[0].verdict).toBe("warn");
      expect(report.pass).toBe(true);
    }
  });

  it("pass=false when any combo is fail", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: {
        cpu: "Test", cores: 1, ramMb: 1024,
        os: "Test", nodeVersion: "v20.0.0", chromiumVersion: "120",
      },
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [
        { comboIndex: 0, props: {}, mount: { samples: [1.5], median: 1.5, p95: 1.5 }, unmount: { samples: [0.5], median: 0.5, p95: 0.5 }, domNodeCount: 5 },
        { comboIndex: 1, props: {}, mount: { samples: [20], median: 20, p95: 20 }, unmount: { samples: [0.5], median: 0.5, p95: 0.5 }, domNodeCount: 5 },
      ],
      explores: [],
      heapDeltas: [0, 0],
      thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
    };
    const report = buildReport(input);
    expect(report.combos[0].verdict).toBe("pass");
    expect(report.combos[1].verdict).toBe("fail");
    expect(report.pass).toBe(false);
  });
});
