import { describe, it, expect } from "vitest";
import fs from "node:fs";
import {
  HINTS,
  hintsForReport,
  formatHints,
  MEASUREMENT_BASIS_LINE,
  type HintId,
} from "../../src/hints.js";
import { formatTable, DEFAULT_THRESHOLDS, type ComboReport, type Report } from "../../src/report.js";
import { helpText } from "../../src/cli.js";

function combo(overrides: Partial<ComboReport> = {}): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [4], median: 4, p95: 4, cv: 0, unstable: false },
    unmount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
    rerender: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
    domNodeCount: 6,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 0.4,
    verdict: "pass",
    tier: "T1",
    ...overrides,
  };
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: {
      cpu: "Test", cores: 4, ramMb: 16384,
      os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
    },
    componentPath: "./Button.tsx",
    componentName: "Button",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [combo()],
    thresholds: DEFAULT_THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

// C1: every finding class maps to a hint.
describe("hint derivation", () => {
  it("says nothing for a clean report", () => {
    expect(hintsForReport(report())).toEqual([]);
  });

  it("maps a memo bailout", () => {
    const r = report({ combos: [combo({ reactOptimizations: { memoBailout: true, contextFanOut: false } })] });
    expect(hintsForReport(r)).toContain("memoBailout");
  });

  it("maps context fan-out", () => {
    const r = report({ combos: [combo({ reactOptimizations: { memoBailout: false, contextFanOut: true } })] });
    expect(hintsForReport(r)).toContain("contextFanOut");
  });

  it("maps unstable callbacks", () => {
    const r = report({
      combos: [combo({
        reactOptimizations: {
          memoBailout: false,
          contextFanOut: false,
          callbackIdentityDeltas: [{ propName: "onClick", stableMs: 1, freshMs: 2, deltaMs: 1 }] as any,
        },
      })],
    });
    expect(hintsForReport(r)).toContain("callbackIdentity");
  });

  it("maps portal orphans", () => {
    const r = report({
      combos: [combo({ reactOptimizations: { memoBailout: false, contextFanOut: false, portalOrphans: 2 } })],
    });
    expect(hintsForReport(r)).toContain("portalOrphans");
  });

  it("maps a budget breach", () => {
    expect(hintsForReport(report({ combos: [combo({ verdict: "fail" })] }))).toContain("budgetBreach");
  });

  it("maps a non-settled measured state", () => {
    expect(hintsForReport(report({ combos: [combo({ measuredState: "pending-network" })] })))
      .toContain("measuredState");
  });

  it("maps superlinear growth, and only superlinear growth", () => {
    const quadratic = report({
      combos: [combo({ scalingCurve: { slope: 1, intercept: 0, r2: 1, growthClass: "quadratic" } })],
    });
    expect(hintsForReport(quadratic)).toContain("superlinearGrowth");

    const linear = report({
      combos: [combo({ scalingCurve: { slope: 1, intercept: 0, r2: 1, growthClass: "linear" } })],
    });
    expect(hintsForReport(linear)).not.toContain("superlinearGrowth");
  });

  it("maps a suspected leak and churn degradation from isolation", () => {
    const r = report({
      isolation: {
        memory: { leakSuspected: true } as any,
        rerender: { churnDegradation: 12 } as any,
      },
    });
    expect(hintsForReport(r)).toEqual(expect.arrayContaining(["leakSuspected", "churnDegradation"]));
  });

  it("emits each class once however many combos triggered it", () => {
    const r = report({
      combos: [
        combo({ comboIndex: 0, verdict: "fail" }),
        combo({ comboIndex: 1, verdict: "fail" }),
      ],
    });
    expect(hintsForReport(r).filter((id) => id === "budgetBreach")).toHaveLength(1);
  });

  it("orders hints stably rather than by discovery", () => {
    const r = report({
      combos: [combo({ verdict: "fail", measuredState: "late-mutation", reactOptimizations: { memoBailout: true, contextFanOut: false } })],
    });
    expect(hintsForReport(r)).toEqual(["memoBailout", "budgetBreach", "measuredState"]);
  });
});

// C2: a hint names an action, not a concept.
describe("hint copy", () => {
  const ids = Object.keys(HINTS) as HintId[];

  it("gives every class a title, body and README anchor", () => {
    for (const id of ids) {
      expect(HINTS[id].title.length).toBeGreaterThan(0);
      expect(HINTS[id].lines.length).toBeGreaterThan(0);
      expect(HINTS[id].anchor.startsWith("#")).toBe(true);
    }
  });

  it("names an action rather than restating the finding", () => {
    // Every hint body contains at least one imperative the reader can act on.
    const verbs = /\b(wrap|hoist|move|return|remove|split|check|look|abort|add|point|take|start)\b/i;
    for (const id of ids) {
      expect(HINTS[id].lines.join(" ")).toMatch(verbs);
    }
  });

  it("avoids the vague-advice phrasings that make hints useless", () => {
    for (const id of ids) {
      expect(HINTS[id].lines.join(" ")).not.toMatch(/consider memoi|think about|you may want to/i);
    }
  });

  it("anchors every hint at a heading that exists in the README", () => {
    const readme = fs.readFileSync("README.md", "utf-8");
    const headings = new Set(
      [...readme.matchAll(/^#{2,3} (.+)$/gm)].map(
        (m) => "#" + m[1].toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-"),
      ),
    );
    for (const id of ids) {
      expect(headings.has(HINTS[id].anchor)).toBe(true);
    }
  });
});

// C3: presentation.
describe("presentation", () => {
  it("prints nothing when there is nothing to say", () => {
    expect(formatHints([])).toBe("");
  });

  it("prints each hint once with its anchor", () => {
    const text = formatHints(["memoBailout"]);
    expect(text).toContain("memo() is not holding");
    expect(text).toContain("#memo-bailout");
  });

  it("states the measurement basis in the report header", () => {
    expect(formatTable(report())).toContain(MEASUREMENT_BASIS_LINE);
    expect(MEASUREMENT_BASIS_LINE).toContain("4x CPU throttle");
    expect(MEASUREMENT_BASIS_LINE).toContain("not production wall-clock");
  });

  it("puts the hints in the terminal output when findings exist", () => {
    const text = formatTable(report({ combos: [combo({ verdict: "fail" })], pass: false }));
    expect(text).toContain("What to do about it:");
    expect(text).toContain("#tier-budgets");
  });

  it("gives --help the mode table", () => {
    expect(helpText()).toContain("Which mode answers which question");
    expect(helpText()).toContain("--compare HEAD");
    expect(helpText()).toContain("4x CPU throttle");
  });
});
