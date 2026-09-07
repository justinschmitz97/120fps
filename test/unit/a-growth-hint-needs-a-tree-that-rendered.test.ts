import { describe, it, expect } from "vitest";
import { hintsForReport } from "../../src/report/index.js";
import type { Report, ComboReport } from "../../src/report/index.js";

const QUADRATIC = { slope: 1, intercept: 0, r2: 1, growthClass: "quadratic" as const };

function combo(overrides: Partial<ComboReport>): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    domNodeCount: 12,
    verdict: "pass",
    scalingCurve: null,
    ...overrides,
  } as unknown as ComboReport;
}

function report(combos: ComboReport[]): Report {
  return { combos } as unknown as Report;
}

describe("a growth hint over combos that never rendered", () => {
  it("is withheld when every combo reported a render error", () => {
    const combos = Array.from({ length: 6 }, (_, comboIndex) =>
      combo({ comboIndex, renderHealth: "error", domNodeCount: 0, scalingCurve: QUADRATIC }),
    );
    const ids = hintsForReport(report(combos));
    expect(ids).toContain("renderError");
    expect(ids).not.toContain("superlinearGrowth");
  });

  it("is withheld for a rerender curve on the same broken combos", () => {
    const combos = [
      combo({ renderHealth: "error", domNodeCount: 0, rerenderScalingCurve: QUADRATIC }),
    ];
    expect(hintsForReport(report(combos))).not.toContain("superlinearGrowth");
  });

  it("still fires for the same curve on a combo that rendered", () => {
    const combos = [combo({ scalingCurve: QUADRATIC })];
    const ids = hintsForReport(report(combos));
    expect(ids).toContain("superlinearGrowth");
    expect(ids).not.toContain("renderError");
  });

  it("fires from a healthy combo beside a broken one", () => {
    const combos = [
      combo({ comboIndex: 0, renderHealth: "error", domNodeCount: 0, scalingCurve: QUADRATIC }),
      combo({ comboIndex: 1, scalingCurve: QUADRATIC }),
    ];
    expect(hintsForReport(report(combos))).toContain("superlinearGrowth");
  });
});

describe("the budget hint the same guard protects", () => {
  it("is still withheld for a render error and still fires for a plain fail", () => {
    expect(
      hintsForReport(report([combo({ renderHealth: "error", domNodeCount: 0, verdict: "fail" })])),
    ).not.toContain("budgetBreach");
    expect(hintsForReport(report([combo({ verdict: "fail" })]))).toContain("budgetBreach");
  });
});
