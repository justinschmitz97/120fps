import { describe, it, expect } from "vitest";
import {
  computeScalingCurve,
  growthExponent,
  isSuperlinearGrowth,
  type ScalingCurve,
} from "../../src/metrics.js";
import {
  evaluateCurve,
  formatCurveViolation,
  formatTable,
  type CalibrationResult,
  type Report,
  type ScalingCurveReport,
  type ScalingPoint,
  type Thresholds,
} from "../../src/report.js";
import { hintsForReport } from "../../src/hints.js";

const THRESHOLDS: Thresholds = {
  mountMs: 50,
  interactionMs: 400,
  interactionStepMs: 67,
  relativeMount: 2,
  rerenderMs: 16,
};

const GROWTH_CLASSES: ScalingCurve["growthClass"][] = [
  "constant",
  "linear",
  "quadratic",
  "exponential",
  "inconclusive",
];

function pts(pairs: [number, number][]): { n: number; metric: number }[] {
  return pairs.map(([n, metric]) => ({ n, metric }));
}

// H1: fewer than three distinct N cannot discriminate between models.
describe("H1: two-point and one-point series", () => {
  it("stays inconclusive", () => {
    expect(computeScalingCurve(pts([[1, 4], [50, 4000]])).growthClass).toBe("inconclusive");
    expect(computeScalingCurve(pts([[1, 4]])).growthClass).toBe("inconclusive");
    expect(computeScalingCurve([]).growthClass).toBe("inconclusive");
    // Three points, two distinct N.
    expect(computeScalingCurve(pts([[1, 4], [1, 5], [50, 4000]])).growthClass).toBe("inconclusive");
  });
});

// H2: a flat run with one late jump grew 12x while N grew 50x.
describe("H2: plateau then jump", () => {
  it("is not promoted to superlinear", () => {
    const curve = computeScalingCurve(
      pts([[1, 5], [3, 5.1], [5, 5.2], [10, 5.1], [20, 5.3], [50, 60]]),
    );
    expect(isSuperlinearGrowth(curve)).toBe(false);
  });
});

// H3: cost that falls as N rises.
describe("H3: negative slope", () => {
  it("classifies constant regardless of curvature", () => {
    expect(
      computeScalingCurve(pts([[1, 100], [5, 80], [20, 30], [50, 5]])).growthClass,
    ).toBe("constant");
    // Convex decline: a quadratic in n fits it well and must still not win.
    expect(
      computeScalingCurve(pts([[1, 100], [5, 60], [20, 20], [50, 18]])).growthClass,
    ).toBe("constant");
  });
});

// H4: no variance to explain.
describe("H4: all-equal metrics", () => {
  it("classifies constant", () => {
    expect(computeScalingCurve(pts([[1, 5], [5, 5], [20, 5], [50, 5]])).growthClass).toBe("constant");
    expect(computeScalingCurve(pts([[1, 0], [5, 0], [20, 0]])).growthClass).toBe("constant");
  });
});

// H5: sweeps far wider than the default scale points.
describe("H5: huge N range", () => {
  it("still catches a true quadratic and keeps r² finite", () => {
    const curve = computeScalingCurve(
      pts([[1, 1], [1e3, 1e6], [1e4, 1e8], [1e5, 1e10], [1e6, 1e12]]),
    );
    expect(curve.growthClass).toBe("quadratic");
    expect(Number.isFinite(curve.r2)).toBe(true);
    expect(growthExponent(pts([[1, 1], [1e6, 1e12]]))).toBeCloseTo(2, 6);
  });

  it("keeps a wide-range linear sweep linear", () => {
    const curve = computeScalingCurve(
      pts([[1, 2], [1e3, 2000], [1e4, 20000], [1e5, 200000], [1e6, 2000000]]),
    );
    expect(curve.growthClass).toBe("linear");
  });
});

// H6: two admitted candidates whose raw R² are within 1e-6 of each other.
describe("H6: near-tied candidates", () => {
  it("resolves deterministically and repeatably", () => {
    const series = pts([[1, 2], [2, 4.1], [3, 8.05], [4, 16.2], [5, 31.8]]);
    const first = computeScalingCurve(series);
    for (let i = 0; i < 10; i++) {
      expect(computeScalingCurve(series)).toEqual(first);
    }
    expect(GROWTH_CLASSES).toContain(first.growthClass);
  });
});

// H7: the case the milestone must not lose.
describe("H7: genuine quadratic on the default sweep", () => {
  it("is caught for a range of coefficients", () => {
    for (const a of [0.05, 0.2, 1, 5]) {
      const curve = computeScalingCurve(
        [1, 3, 5, 10, 20, 50].map((n) => ({ n, metric: a * n * n + 2 })),
      );
      expect(curve.growthClass).toBe("quadratic");
    }
  });
});

// H8: doubling per step.
describe("H8: exponential blowup", () => {
  it("is caught", () => {
    expect(
      computeScalingCurve([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ n, metric: 2 ** n }))).growthClass,
    ).toBe("exponential");
  });
});

// H9: metrics a trace can genuinely produce when something went wrong.
describe("H9: non-finite metrics", () => {
  it("never throws and never promotes", () => {
    for (const series of [
      pts([[1, 1], [2, NaN], [3, 9], [4, 16]]),
      pts([[1, 1], [2, 4], [3, Infinity], [4, 16]]),
      pts([[1, NaN], [2, NaN], [3, NaN]]),
      pts([[1, 1], [2, 4], [3, -Infinity]]),
    ]) {
      const curve = computeScalingCurve(series);
      expect(GROWTH_CLASSES).toContain(curve.growthClass);
      expect(isSuperlinearGrowth(curve)).toBe(false);
    }
  });

  it("survives magnitudes that overflow the back-transform", () => {
    const curve = computeScalingCurve(pts([[1, 1], [400, 1e60], [800, 1e120], [1200, 1e240]]));
    expect(GROWTH_CLASSES).toContain(curve.growthClass);
  });
});

// H10: a zero first point (nothing rendered at N=1).
describe("H10: zero and negative metrics", () => {
  it("drops unloggable points from the exponent", () => {
    expect(growthExponent(pts([[1, 0], [2, 10], [4, 90]]))).toBeCloseTo(Math.log(9) / Math.log(2), 6);
    expect(growthExponent(pts([[1, -5], [2, -10]]))).toBe(0);
  });

  it("never promotes a mostly-negative series (heap deltas)", () => {
    const curve = computeScalingCurve(pts([[1, -100], [5, -50], [20, 0], [50, 200]]));
    expect(isSuperlinearGrowth(curve)).toBe(false);
  });
});

// H11: the caller's ordering must not change the answer.
describe("H11: point order", () => {
  it("classifies unsorted input identically", () => {
    const sorted = pts([[1, 1], [5, 25], [20, 400], [50, 2500]]);
    const shuffled = pts([[20, 400], [1, 1], [50, 2500], [5, 25]]);
    expect(computeScalingCurve(shuffled)).toEqual(computeScalingCurve(sorted));
  });
});

// H12: a sweep that repeated scale points.
describe("H12: duplicate N values", () => {
  it("uses the widest N span for the exponent", () => {
    expect(growthExponent(pts([[1, 1], [1, 1.1], [20, 400], [20, 402]]))).toBeCloseTo(
      Math.log(402) / Math.log(20),
      6,
    );
    const curve = computeScalingCurve(
      pts([[1, 1], [1, 1.1], [5, 25], [5, 25.5], [20, 400], [20, 402]]),
    );
    expect(curve.growthClass).toBe("quadratic");
  });
});

// H13: the verdict walk's ordering guarantees.
describe("H13: violation ordering", () => {
  it("reports mount before rerender at the same point", () => {
    const points = [point(1, 2, 1), point(20, 90, 40)];
    expect(evaluateCurve(points, linearCurve(), THRESHOLDS).violation).toMatchObject({
      metric: "mount",
      crossingN: 20,
    });
  });

  it("reports growth before any budget", () => {
    const points = [point(1, 900, 900)];
    expect(evaluateCurve(points, curveOf("quadratic"), THRESHOLDS).violation).toEqual({
      kind: "growth",
      metric: "mount",
      growthClass: "quadratic",
    });
  });

  it("reports the earliest crossing, not the largest overage", () => {
    const points = [point(1, 2, 1), point(5, 60, 1), point(20, 400, 1)];
    expect(evaluateCurve(points, linearCurve(), THRESHOLDS).violation).toMatchObject({
      crossingN: 5,
      lastPassingN: 1,
      medianMs: 60,
    });
  });
});

// H14: violation presence must track the verdict exactly.
describe("H14: violation is present exactly on fail", () => {
  it("holds across a grid of curves and point sets", () => {
    const pointSets: ScalingPoint[][] = [
      [],
      [point(1, 2, 1)],
      [point(1, 40, 1)],
      [point(1, 2, 13)],
      [point(1, 2, 1), point(20, 51, 1)],
      [point(1, 2, 1), point(20, 2, 17)],
      [point(1, 51, 17)],
    ];
    for (const growthClass of GROWTH_CLASSES) {
      for (const points of pointSets) {
        const { verdict, violation } = evaluateCurve(points, curveOf(growthClass), THRESHOLDS);
        expect(violation !== undefined).toBe(verdict === "fail");
        if (violation) expect(formatCurveViolation(violation).length).toBeGreaterThan(0);
      }
    }
  });
});

// H15: the crossing wording depends on whether an earlier N passed.
describe("H15: crossing-point wording", () => {
  it("says 'at N=' only when the smallest measured N already exceeds", () => {
    const early = evaluateCurve([point(1, 80, 1), point(20, 90, 1)], linearCurve(), THRESHOLDS);
    expect(formatCurveViolation(early.violation!)).toContain("at N=1, the smallest measured N");
    expect(early.violation!.lastPassingN).toBeUndefined();

    const late = evaluateCurve([point(1, 2, 1), point(20, 90, 1)], linearCurve(), THRESHOLDS);
    expect(formatCurveViolation(late.violation!)).toContain("between N=1 and N=20");
  });
});

// H16: the growth line and the hint read one classification.
describe("H16: growth line and superlinear hint agree", () => {
  it("agrees across every mount/rerender class pair", () => {
    for (const mountClass of GROWTH_CLASSES) {
      for (const rerenderClass of GROWTH_CLASSES) {
        const curveReport = makeCurveReport(mountClass, rerenderClass);
        const report = makeReport(curveReport);
        const out = formatTable(report);
        const hinted = hintsForReport(report).includes("superlinearGrowth");

        expect(out).toContain(`Growth: mount ${mountClass}, rerender ${rerenderClass}`);
        expect(hinted).toBe(
          isSuperlinearGrowth(curveReport.mountCurve) ||
            isSuperlinearGrowth(curveReport.rerenderCurve),
        );
      }
    }
  });
});

// H17: superlinear-by-noise was the reported defect; the gates must hold on
// every near-linear shape a real component produces.
describe("H17: near-linear shapes never promote", () => {
  const SHAPES: [string, (n: number) => number][] = [
    ["constant + tiny slope", (n) => 4 + 0.001 * n],
    ["log", (n) => 4.27 + 2 * Math.log2(n)],
    ["sqrt", (n) => 4 + Math.sqrt(n)],
    ["linear with a big intercept", (n) => 40 + 0.2 * n],
    ["saturating", (n) => 20 * (1 - Math.exp(-n / 10)) + 4],
  ];
  for (const [label, f] of SHAPES) {
    it(`${label} stays non-superlinear`, () => {
      const curve = computeScalingCurve([1, 3, 5, 10, 20, 50].map((n) => ({ n, metric: f(n) })));
      expect(isSuperlinearGrowth(curve)).toBe(false);
    });
  }
});

// H18: the gates must not be reachable through an empty or degenerate sweep.
describe("H18: degenerate sweeps", () => {
  it("handles n=0 and negative n without promoting", () => {
    expect(growthExponent(pts([[0, 5], [0, 10]]))).toBe(0);
    expect(growthExponent(pts([[-5, 5], [-1, 10]]))).toBe(0);
    const curve = computeScalingCurve(pts([[0, 1], [0, 2], [0, 3]]));
    expect(GROWTH_CLASSES).toContain(curve.growthClass);
    expect(isSuperlinearGrowth(curve)).toBe(false);
  });
});

// --- helpers ---

function curveOf(growthClass: ScalingCurve["growthClass"]): ScalingCurve {
  return { slope: 0.1, intercept: 1, r2: 0.99, growthClass };
}

function linearCurve(): ScalingCurve {
  return curveOf("linear");
}

function timing(median: number) {
  return { samples: [median], median, p95: median, cv: 0, unstable: false };
}

function point(n: number, mount: number, rerender: number): ScalingPoint {
  return {
    n,
    mount: timing(mount),
    rerender: timing(rerender),
    unmount: timing(0.1),
    domNodeCount: n * 3,
    heapDelta: n * 100,
    interactions: [],
  };
}

function makeCurveReport(
  mountClass: ScalingCurve["growthClass"],
  rerenderClass: ScalingCurve["growthClass"],
): ScalingCurveReport {
  return {
    propName: "items",
    propKind: "array",
    reason: "array prop",
    points: [point(1, 2, 1), point(5, 3, 1.2)],
    mountCurve: curveOf(mountClass),
    rerenderCurve: curveOf(rerenderClass),
    unmountCurve: curveOf("linear"),
    interactionCurves: {},
    domGrowth: curveOf("linear"),
    heapGrowth: curveOf("linear"),
  };
}

const CALIBRATION: CalibrationResult = { totalDuration: 10, scriptDuration: 5 };

function makeReport(scalingCurveReport: ScalingCurveReport): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: {
      cpu: "test",
      cores: 4,
      ramMb: 16384,
      os: "test",
      nodeVersion: "v22.0.0",
      chromiumVersion: "120",
    },
    componentPath: "./test.tsx",
    componentName: "Test",
    calibration: CALIBRATION,
    combos: [],
    thresholds: THRESHOLDS,
    pass: true,
    scalingCurveReport,
  };
}
