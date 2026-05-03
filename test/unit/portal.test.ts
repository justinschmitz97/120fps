import { describe, it, expect } from "vitest";
import type { InteractionDescriptor } from "../../src/discovery.js";
import {
  formatTable,
  type InteractionReport,
  type ComboReport,
  type Report,
  DEFAULT_THRESHOLDS,
} from "../../src/report.js";
import { buildTimingWithCV } from "../../src/report.js";

describe("InteractionDescriptor portal fields", () => {
  it("supports optional portal flag", () => {
    const desc: InteractionDescriptor = {
      type: "click",
      selector: "button",
      tagName: "BUTTON",
      label: "Close",
      portal: true,
    };
    expect(desc.portal).toBe(true);
  });

  it("supports optional triggeredBy field", () => {
    const desc: InteractionDescriptor = {
      type: "click",
      selector: "[data-testid=\"modal-close\"]",
      tagName: "BUTTON",
      label: "Close",
      portal: true,
      triggeredBy: "[data-testid=\"open-modal\"]",
    };
    expect(desc.triggeredBy).toBe("[data-testid=\"open-modal\"]");
  });

  it("portal and triggeredBy are undefined when not set", () => {
    const desc: InteractionDescriptor = {
      type: "click",
      selector: "button",
      tagName: "BUTTON",
      label: "Submit",
    };
    expect(desc.portal).toBeUndefined();
    expect(desc.triggeredBy).toBeUndefined();
  });
});

describe("InteractionReport portal field", () => {
  it("supports optional portal flag", () => {
    const report: InteractionReport = {
      selector: "[data-testid=\"modal-close\"]",
      type: "click",
      label: "Close",
      timing: buildTimingWithCV([1, 2, 3]),
      relativeTiming: 0.5,
      portal: true,
    };
    expect(report.portal).toBe(true);
  });

  it("portal is undefined when not set", () => {
    const report: InteractionReport = {
      selector: "button",
      type: "click",
      label: "Submit",
      timing: buildTimingWithCV([1, 2, 3]),
      relativeTiming: 0.5,
    };
    expect(report.portal).toBeUndefined();
  });
});

describe("formatTable portal suffix", () => {
  function makeReport(interactions: InteractionReport[]): Report {
    const combo: ComboReport = {
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
    return {
      version: 1,
      timestamp: new Date().toISOString(),
      machine: { cpu: "test", cores: 4, ramMb: 8192, os: "test", nodeVersion: "v20", chromiumVersion: "120" },
      componentPath: "test.tsx",
      componentName: "Test",
      calibration: { totalDuration: 10, scriptDuration: 5 },
      combos: [combo],
      thresholds: DEFAULT_THRESHOLDS,
      pass: true,
    };
  }

  it("shows [portal] suffix for portal interactions in top 3", () => {
    const interactions: InteractionReport[] = [
      { selector: "[data-testid=\"modal-close\"]", type: "click", label: "Close", timing: buildTimingWithCV([50]), relativeTiming: 5, portal: true },
    ];
    const table = formatTable(makeReport(interactions));
    expect(table).toContain("[portal]");
    expect(table).toContain("Close");
  });

  it("does not show [portal] suffix for non-portal interactions", () => {
    const interactions: InteractionReport[] = [
      { selector: "button", type: "click", label: "Submit", timing: buildTimingWithCV([50]), relativeTiming: 5 },
    ];
    const table = formatTable(makeReport(interactions));
    expect(table).not.toContain("[portal]");
    expect(table).toContain("Submit");
  });
});
