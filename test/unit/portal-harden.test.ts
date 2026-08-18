import { describe, it, expect } from "vitest";
import {
  buildTimingWithCV,
  computeVerdict,
  formatTable,
  type ComboReport,
  type InteractionReport,
  type Report,
  DEFAULT_THRESHOLDS,
} from "../../src/report.js";

function makeCombo(interactions: InteractionReport[]): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: buildTimingWithCV([5]),
    unmount: buildTimingWithCV([2]),
    rerender: buildTimingWithCV([1]),
    domNodeCount: 10,
    heapDelta: 0,
    interactions,
    scalingCurve: null,
    relativeMount: 0.5,
    verdict: "pass",
  };
}

function makeReport(combos: ComboReport[]): Report {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    machine: { cpu: "test", cores: 4, ramMb: 8192, os: "test", nodeVersion: "v20", chromiumVersion: "120" },
    componentPath: "test.tsx",
    componentName: "Test",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos,
    thresholds: DEFAULT_THRESHOLDS,
    pass: true,
  };
}

describe("H11: portal flag does not exempt an interaction from verdict thresholds", () => {
  it("portal interaction exceeding threshold causes fail verdict", () => {
    const combo = makeCombo([
      { selector: "btn", type: "click", label: "Portal Close", timing: buildTimingWithCV([500]), relativeTiming: 20, portal: true },
    ]);
    const verdict = computeVerdict(combo, DEFAULT_THRESHOLDS);
    expect(verdict).toBe("fail");
  });

  it("portal interaction within threshold passes", () => {
    const combo = makeCombo([
      { selector: "btn", type: "click", label: "Portal Close", timing: buildTimingWithCV([5]), relativeTiming: 0.5, portal: true },
    ]);
    const verdict = computeVerdict(combo, DEFAULT_THRESHOLDS);
    expect(verdict).toBe("pass");
  });
});

describe("H12: formatTable with mix of portal and non-portal", () => {
  it("shows [portal] only for portal interactions", () => {
    const combo = makeCombo([
      { selector: "btn1", type: "click", label: "Root Button", timing: buildTimingWithCV([50]), relativeTiming: 5 },
      { selector: "btn2", type: "click", label: "Portal Button", timing: buildTimingWithCV([40]), relativeTiming: 4, portal: true },
    ]);
    const report = makeReport([combo]);
    const table = formatTable(report);

    const lines = table.split("\n");
    const rootLine = lines.find((l) => l.includes("Root Button"));
    const portalLine = lines.find((l) => l.includes("Portal Button"));

    expect(rootLine).toBeDefined();
    expect(rootLine).not.toContain("[portal]");
    expect(portalLine).toBeDefined();
    expect(portalLine).toContain("[portal]");
  });
});

describe("H15: portal flag does not exempt an interaction from the CV instability threshold", () => {
  it("warns when portal interaction CV > 15%", () => {
    const combo = makeCombo([
      { selector: "btn", type: "click", label: "Portal Close", timing: buildTimingWithCV([1, 1, 1, 100]), relativeTiming: 0.5, portal: true },
    ]);
    const verdict = computeVerdict(combo, DEFAULT_THRESHOLDS);
    expect(verdict).toBe("warn");
  });
});
