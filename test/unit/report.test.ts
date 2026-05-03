import { describe, it, expect } from "vitest";
import {
  computeCV,
  buildTimingWithCV,
  computeVerdict,
  formatTable,
  type TimingWithCV,
  type ComboReport,
  type Report,
  type Thresholds,
  DEFAULT_THRESHOLDS,
} from "../../src/report.js";

describe("computeCV", () => {
  it("returns 0 for empty array", () => {
    expect(computeCV([])).toBe(0);
  });

  it("returns 0 for single sample", () => {
    expect(computeCV([5])).toBe(0);
  });

  it("returns 0 for identical samples", () => {
    expect(computeCV([10, 10, 10, 10])).toBe(0);
  });

  it("computes correct CV for known values", () => {
    // samples: [2, 4, 4, 4, 5, 5, 7, 9]
    // mean = 5, stddev = 2, CV = 40%
    const cv = computeCV([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(cv).toBeCloseTo(40, 0);
  });

  it("returns 0 when mean is 0", () => {
    expect(computeCV([0, 0, 0])).toBe(0);
  });
});

describe("buildTimingWithCV", () => {
  it("builds TimingWithCV from samples", () => {
    const t = buildTimingWithCV([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(t.samples).toHaveLength(10);
    expect(t.median).toBe(5.5);
    expect(t.p95).toBe(10);
    expect(typeof t.cv).toBe("number");
    expect(typeof t.unstable).toBe("boolean");
  });

  it("marks unstable when CV > 15", () => {
    // Wide spread: CV will be high
    const t = buildTimingWithCV([1, 1, 1, 1, 100]);
    expect(t.unstable).toBe(true);
  });

  it("marks stable when CV <= 15", () => {
    const t = buildTimingWithCV([10, 10, 10, 10, 10]);
    expect(t.unstable).toBe(false);
  });
});

describe("computeVerdict", () => {
  const thresholds: Thresholds = { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 };

  function makeCombo(overrides: Partial<ComboReport> = {}): ComboReport {
    return {
      comboIndex: 0,
      props: {},
      mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
      unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
      rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
      domNodeCount: 10,
      heapDelta: 0,
      interactions: [],
      scalingCurve: null,
      relativeMount: 0.5,
      verdict: "pass",
      ...overrides,
    };
  }

  it("returns pass for fast, stable combo", () => {
    expect(computeVerdict(makeCombo(), thresholds)).toBe("pass");
  });

  it("returns fail when mount exceeds threshold", () => {
    expect(computeVerdict(makeCombo({ mount: { samples: [20], median: 20, p95: 20, cv: 0, unstable: false } }), thresholds)).toBe("fail");
  });

  it("returns fail when interaction exceeds threshold", () => {
    const combo = makeCombo({
      interactions: [{
        selector: "button",
        type: "click",
        label: "btn",
        timing: { samples: [150], median: 150, p95: 150, cv: 0, unstable: false },
        relativeTiming: 1.5,
      }],
    });
    expect(computeVerdict(combo, thresholds)).toBe("fail");
  });

  it("returns fail when relativeMount exceeds threshold", () => {
    expect(computeVerdict(makeCombo({ relativeMount: 3.0 }), thresholds)).toBe("fail");
  });

  it("returns warn when timing is unstable but within thresholds", () => {
    const combo = makeCombo({
      mount: { samples: [5], median: 5, p95: 5, cv: 20, unstable: true },
    });
    expect(computeVerdict(combo, thresholds)).toBe("warn");
  });

  it("returns fail over warn when both conditions apply", () => {
    const combo = makeCombo({
      mount: { samples: [20], median: 20, p95: 20, cv: 20, unstable: true },
    });
    expect(computeVerdict(combo, thresholds)).toBe("fail");
  });
});

describe("DEFAULT_THRESHOLDS", () => {
  it("has expected defaults", () => {
    expect(DEFAULT_THRESHOLDS.mountMs).toBe(50);
    expect(DEFAULT_THRESHOLDS.interactionMs).toBe(400);
    expect(DEFAULT_THRESHOLDS.relativeMount).toBe(2.0);
    expect(DEFAULT_THRESHOLDS.rerenderMs).toBe(16);
  });
});

describe("formatTable", () => {
  function makeReport(overrides: Partial<Report> = {}): Report {
    return {
      version: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      machine: {
        cpu: "Test CPU",
        cores: 4,
        ramMb: 16384,
        os: "Linux 6.0",
        nodeVersion: "v20.0.0",
        chromiumVersion: "120.0.0.0",
      },
      componentPath: "./Button.tsx",
      componentName: "Button",
      calibration: { totalDuration: 10, scriptDuration: 5 },
      combos: [{
        comboIndex: 0,
        props: {},
        mount: { samples: [5], median: 5, p95: 6, cv: 3, unstable: false },
        unmount: { samples: [2], median: 2, p95: 3, cv: 2, unstable: false },
        rerender: { samples: [3], median: 3, p95: 3, cv: 2, unstable: false },
        domNodeCount: 10,
        heapDelta: 1024,
        interactions: [],
        scalingCurve: null,
        relativeMount: 0.5,
        verdict: "pass",
      }],
      thresholds: DEFAULT_THRESHOLDS,
      pass: true,
      ...overrides,
    };
  }

  it("returns a non-empty string", () => {
    const output = formatTable(makeReport());
    expect(output.length).toBeGreaterThan(0);
  });

  it("includes component name", () => {
    expect(formatTable(makeReport())).toContain("Button");
  });

  it("includes verdict PASS", () => {
    expect(formatTable(makeReport())).toContain("PASS");
  });

  it("includes FAIL verdict", () => {
    const r = makeReport({
      pass: false,
      combos: [{
        comboIndex: 0,
        props: {},
        mount: { samples: [20], median: 20, p95: 25, cv: 3, unstable: false },
        unmount: { samples: [2], median: 2, p95: 3, cv: 2, unstable: false },
        rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
        domNodeCount: 10,
        heapDelta: 0,
        interactions: [],
        scalingCurve: null,
        relativeMount: 2.0,
        verdict: "fail",
      }],
    });
    expect(formatTable(r)).toContain("FAIL");
  });

  it("includes unstable footnote when any timing is unstable", () => {
    const r = makeReport({
      combos: [{
        comboIndex: 0,
        props: {},
        mount: { samples: [5], median: 5, p95: 6, cv: 20, unstable: true },
        unmount: { samples: [2], median: 2, p95: 3, cv: 2, unstable: false },
        rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
        domNodeCount: 10,
        heapDelta: 0,
        interactions: [],
        scalingCurve: null,
        relativeMount: 0.5,
        verdict: "warn",
      }],
    });
    expect(formatTable(r)).toContain("CV>15%");
  });

  it("shows stress pattern name in parentheses for non-single-shot interactions", () => {
    const interactions = [
      {
        selector: "button",
        type: "click" as const,
        label: "Toggle",
        timing: { samples: [10], median: 10, p95: 12, cv: 0, unstable: false },
        relativeTiming: 1.0,
        stressPattern: "rapid-toggle-10",
      },
    ];
    const r = makeReport({
      combos: [{
        comboIndex: 0, props: {}, mount: { samples: [5], median: 5, p95: 6, cv: 0, unstable: false },
        unmount: { samples: [2], median: 2, p95: 3, cv: 0, unstable: false },
        rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
        domNodeCount: 10, heapDelta: 0, interactions, scalingCurve: null, relativeMount: 0.5, verdict: "pass",
      }],
    });
    const table = formatTable(r);
    expect(table).toContain("(rapid-toggle-10)");
  });

  it("does not show pattern name for single-shot interactions", () => {
    const interactions = [
      {
        selector: "button",
        type: "focus" as const,
        label: "Focus",
        timing: { samples: [10], median: 10, p95: 12, cv: 0, unstable: false },
        relativeTiming: 1.0,
        stressPattern: "single-shot",
      },
    ];
    const r = makeReport({
      combos: [{
        comboIndex: 0, props: {}, mount: { samples: [5], median: 5, p95: 6, cv: 0, unstable: false },
        unmount: { samples: [2], median: 2, p95: 3, cv: 0, unstable: false },
        rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
        domNodeCount: 10, heapDelta: 0, interactions, scalingCurve: null, relativeMount: 0.5, verdict: "pass",
      }],
    });
    const table = formatTable(r);
    expect(table).not.toContain("(single-shot)");
  });

  it("does not show pattern name when stressPattern is undefined", () => {
    const interactions = [
      {
        selector: "button",
        type: "click" as const,
        label: "Btn",
        timing: { samples: [10], median: 10, p95: 12, cv: 0, unstable: false },
        relativeTiming: 1.0,
      },
    ];
    const r = makeReport({
      combos: [{
        comboIndex: 0, props: {}, mount: { samples: [5], median: 5, p95: 6, cv: 0, unstable: false },
        unmount: { samples: [2], median: 2, p95: 3, cv: 0, unstable: false },
        rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
        domNodeCount: 10, heapDelta: 0, interactions, scalingCurve: null, relativeMount: 0.5, verdict: "pass",
      }],
    });
    const table = formatTable(r);
    // Should just show "(click)" not "(click) (some-pattern)"
    expect(table).toContain("(click)");
    expect(table).not.toMatch(/\(rapid-toggle/);
  });

  it("lists top 3 slowest interactions", () => {
    const interactions = [
      { selector: "a", type: "click" as const, label: "link1", timing: { samples: [10], median: 10, p95: 12, cv: 0, unstable: false }, relativeTiming: 1.0 },
      { selector: "b", type: "click" as const, label: "link2", timing: { samples: [20], median: 20, p95: 22, cv: 0, unstable: false }, relativeTiming: 2.0 },
      { selector: "c", type: "click" as const, label: "link3", timing: { samples: [30], median: 30, p95: 32, cv: 0, unstable: false }, relativeTiming: 3.0 },
      { selector: "d", type: "click" as const, label: "link4", timing: { samples: [40], median: 40, p95: 42, cv: 0, unstable: false }, relativeTiming: 4.0 },
    ];
    const r = makeReport({
      combos: [{
        comboIndex: 0, props: {}, mount: { samples: [5], median: 5, p95: 6, cv: 0, unstable: false },
        unmount: { samples: [2], median: 2, p95: 3, cv: 0, unstable: false },
        rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
        domNodeCount: 10, heapDelta: 0, interactions, scalingCurve: null, relativeMount: 0.5, verdict: "pass",
      }],
    });
    const table = formatTable(r);
    expect(table).toContain("link4");
    expect(table).toContain("link3");
    expect(table).toContain("link2");
    expect(table).not.toContain("link1");
  });
});
