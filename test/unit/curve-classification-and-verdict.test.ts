import { describe, it, expect } from "vitest";
import {
  computeScalingCurve,
  growthExponent,
  isSuperlinearGrowth,
  SUPERLINEAR_MIN_EXPONENT,
  SUPERLINEAR_RESIDUAL_SHARE,
} from "../../src/metrics.js";
import {
  buildCurveReport,
  computeCurveVerdict,
  evaluateCurve,
  formatCurveViolation,
  formatTable,
  CURVE_NOT_ACTIVATED_WARNING,
  type CalibrationResult,
  type Report,
  type ScalingCurve,
  type ScalingCurveReport,
  type ScalingPoint,
  type Thresholds,
} from "../../src/report.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";
import type { ExploreResult } from "../../src/explorer.js";

const THRESHOLDS: Thresholds = {
  mountMs: 50,
  interactionMs: 400,
  interactionStepMs: 67,
  relativeMount: 2,
  rerenderMs: 16,
};

function pts(pairs: [number, number][]): { n: number; metric: number }[] {
  return pairs.map(([n, metric]) => ({ n, metric }));
}

// Deterministic LCG: the production code must never see a random source, and
// the tests must reproduce byte-for-byte on any machine.
function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function jittered(
  f: (n: number) => number,
  amplitude: number,
  seed: number,
  scale = [1, 3, 5, 10, 20, 50],
): { n: number; metric: number }[] {
  const rand = lcg(seed);
  return scale.map((n) => ({ n, metric: f(n) * (1 + (rand() - 0.5) * 2 * amplitude) }));
}

// --- Contract 1: superlinear promotion needs evidence ---

describe("superlinear promotion requires a magnitude and a fit margin", () => {
  it("exports the two gate constants", () => {
    expect(SUPERLINEAR_RESIDUAL_SHARE).toBe(0.5);
    expect(SUPERLINEAR_MIN_EXPONENT).toBe(1);
  });

  it("growthExponent is the log-log slope of the sweep endpoints", () => {
    // 2500x cost for 50x data.
    expect(growthExponent(pts([[1, 1], [5, 25], [20, 400], [50, 2500]]))).toBeCloseTo(2, 6);
    // 50x for 50x.
    expect(growthExponent(pts([[1, 10], [50, 500]]))).toBeCloseTo(1, 6);
    // 2.62x for 50x.
    expect(growthExponent(pts([[1, 4.27], [50, 11.19]]))).toBeCloseTo(0.2461, 3);
  });

  it("growthExponent ignores non-positive and non-finite metrics", () => {
    expect(growthExponent(pts([[1, 0], [2, 10], [4, 90]]))).toBeCloseTo(
      Math.log(9) / Math.log(2),
      6,
    );
    expect(growthExponent(pts([[1, 1], [2, NaN], [3, 9]]))).toBeCloseTo(Math.log(9) / Math.log(3), 6);
    expect(growthExponent(pts([[1, 5]]))).toBe(0);
    expect(growthExponent([])).toBe(0);
    expect(growthExponent(pts([[0, 5], [0, 9]]))).toBe(0);
  });

  it("the observed mount flip (4.27 -> 11.19ms over N=1..50) is linear", () => {
    const curve = computeScalingCurve(
      pts([[1, 4.27], [3, 5.1], [5, 5.62], [10, 6.55], [20, 7.95], [50, 11.19]]),
    );
    expect(curve.growthClass).toBe("linear");
  });

  it("a convex series with the same endpoints is still linear: 2.6x for 50x is sub-linear", () => {
    const curve = computeScalingCurve(
      pts([[1, 4.27], [3, 4.35], [5, 4.5], [10, 5.0], [20, 6.4], [50, 11.19]]),
    );
    expect(curve.growthClass).toBe("linear");
  });

  it("3.7x rerender growth over a 50x N range is not exponential", () => {
    for (const series of [
      // concave
      pts([[1, 1.2], [3, 1.55], [5, 1.8], [10, 2.3], [20, 3.05], [50, 4.44]]),
      // convex, fitted from a real exponential with the same endpoints
      pts([[1, 1.2], [3, 1.22], [5, 1.28], [10, 1.45], [20, 2.0], [50, 4.44]]),
    ]) {
      const curve = computeScalingCurve(series);
      expect(curve.growthClass).not.toBe("exponential");
      expect(curve.growthClass).not.toBe("quadratic");
    }
  });

  it("a genuine quadratic is still caught", () => {
    expect(computeScalingCurve(pts([[1, 1], [5, 25], [20, 400], [50, 2500]])).growthClass).toBe(
      "quadratic",
    );
    expect(
      computeScalingCurve(
        pts([[1, 2.05], [3, 2.45], [5, 3.25], [10, 7.0], [20, 22.0], [50, 127.0]]),
      ).growthClass,
    ).toBe("quadratic");
  });

  it("a genuine exponential is still caught", () => {
    expect(computeScalingCurve(pts([[1, 2], [2, 4], [3, 8], [4, 16]])).growthClass).toBe(
      "exponential",
    );
    expect(
      computeScalingCurve(pts([[1, 2], [2, 4], [3, 8], [4, 16], [5, 32], [6, 64]])).growthClass,
    ).toBe("exponential");
  });

  it("keeps ranking by raw-y R² among admitted candidates", () => {
    // log y is near-perfect here, the back-transform is not: quadratic wins.
    expect(
      computeScalingCurve(pts([[1, 1], [2, 10], [3, 100], [4, 1000], [5, 3000]])).growthClass,
    ).toBe("quadratic");
  });

  it("a perfectly linear fit admits no candidate", () => {
    const curve = computeScalingCurve(pts([[1, 10], [5, 50], [20, 200], [50, 500]]));
    expect(curve.growthClass).toBe("linear");
    expect(curve.r2).toBeCloseTo(1, 9);
  });
});

// --- Contract 2: stability under noise ---

describe("classification is stable under noise", () => {
  const NEAR_LINEAR: [string, (n: number) => number][] = [
    ["0.2n + 4", (n) => 0.2 * n + 4],
    ["10n", (n) => 10 * n],
    ["4.27 + 2*log2(n)", (n) => 4.27 + 2 * Math.log2(n)],
    ["1.2 * e^(0.0267n): 3.7x over 50x", (n) => 1.2 * Math.exp((Math.log(3.7) / 49) * (n - 1))],
  ];

  for (const [label, f] of NEAR_LINEAR) {
    for (const amplitude of [0.05, 0.15]) {
      it(`${label} at ±${amplitude * 100}% never promotes across 200 seeds`, () => {
        const classes = new Set<string>();
        for (let seed = 1; seed <= 200; seed++) {
          classes.add(computeScalingCurve(jittered(f, amplitude, seed * 7919)).growthClass);
        }
        // `constant` is the pre-existing weak-fit gate, not a promotion.
        expect([...classes].sort().filter((c) => c !== "constant")).toEqual(["linear"]);
      });
    }
  }

  it("is a pure function of the points", () => {
    const series = jittered((n) => 0.05 * n * n + 2, 0.15, 4242);
    const first = computeScalingCurve(series);
    for (let i = 0; i < 5; i++) {
      expect(computeScalingCurve(series)).toEqual(first);
    }
  });

  it("a genuine quadratic survives the same jitter", () => {
    let quadratic = 0;
    for (let seed = 1; seed <= 200; seed++) {
      if (
        computeScalingCurve(jittered((n) => 0.05 * n * n + 2, 0.15, seed * 7919)).growthClass ===
        "quadratic"
      ) {
        quadratic++;
      }
    }
    expect(quadratic).toBeGreaterThanOrEqual(190);
  });
});

// --- Contract 3: --curve that does not activate says so ---

describe("an unactivated --curve is announced", () => {
  it("names the reason in the warning", () => {
    const warning = CURVE_NOT_ACTIVATED_WARNING(
      "no array or list prop was found in the extracted schema",
    );
    expect(warning).toContain("--curve");
    expect(warning).toContain("did not activate");
    expect(warning).toContain("no array or list prop was found in the extracted schema");
  });

  it("renders in the terminal warnings block", () => {
    const report = makeComboReport({
      warnings: [CURVE_NOT_ACTIVATED_WARNING("no array or list prop was found in the extracted schema")],
    });
    const out = formatTable(report);
    expect(out).toContain("Mode: prop combos");
    expect(out).toContain("did not activate");
  });
});

// --- Contract 4: a curve FAIL names what it violated ---

describe("curve FAIL names the budget and the crossing point", () => {
  const linear: ScalingCurve = { slope: 0.1, intercept: 1, r2: 0.99, growthClass: "linear" };
  const quadratic: ScalingCurve = { slope: 0.1, intercept: 1, r2: 0.99, growthClass: "quadratic" };

  it("evaluateCurve agrees with computeCurveVerdict", () => {
    const points = [makePoint(1, 2, 1), makePoint(20, 30, 4), makePoint(50, 62.1, 9)];
    expect(evaluateCurve(points, linear, THRESHOLDS).verdict).toBe(
      computeCurveVerdict(points, linear, THRESHOLDS),
    );
    expect(evaluateCurve(points, quadratic, THRESHOLDS).verdict).toBe(
      computeCurveVerdict(points, quadratic, THRESHOLDS),
    );
  });

  it("reports the crossing interval when an earlier N passed", () => {
    const points = [makePoint(1, 2, 1), makePoint(20, 30, 4), makePoint(50, 62.1, 9)];
    const { verdict, violation } = evaluateCurve(points, linear, THRESHOLDS);
    expect(verdict).toBe("fail");
    expect(violation).toEqual({
      kind: "budget",
      metric: "mount",
      budgetMs: 50,
      crossingN: 50,
      lastPassingN: 20,
      medianMs: 62.1,
    });
    const text = formatCurveViolation(violation!);
    expect(text).toContain("50.00ms");
    expect(text).toContain("between N=20 and N=50");
    expect(text).toContain("62.10ms");
  });

  it("reports the smallest N when it already exceeds the budget", () => {
    const points = [makePoint(1, 80, 1), makePoint(20, 90, 4)];
    const { violation } = evaluateCurve(points, linear, THRESHOLDS);
    expect(violation).toEqual({
      kind: "budget",
      metric: "mount",
      budgetMs: 50,
      crossingN: 1,
      medianMs: 80,
    });
    expect(formatCurveViolation(violation!)).toContain("at N=1");
  });

  it("names the rerender budget when rerender is what crossed", () => {
    const points = [makePoint(1, 2, 1), makePoint(20, 3, 4), makePoint(50, 4, 22.5)];
    const { violation } = evaluateCurve(points, linear, THRESHOLDS);
    expect(violation).toMatchObject({
      kind: "budget",
      metric: "rerender",
      budgetMs: 16,
      crossingN: 50,
      lastPassingN: 20,
    });
    expect(formatCurveViolation(violation!)).toContain("Rerender");
    expect(formatCurveViolation(violation!)).toContain("16.00ms");
  });

  it("reports superlinear growth as its own violation kind", () => {
    const points = [makePoint(1, 2, 1), makePoint(20, 3, 4)];
    const { verdict, violation } = evaluateCurve(points, quadratic, THRESHOLDS);
    expect(verdict).toBe("fail");
    expect(violation).toEqual({ kind: "growth", metric: "mount", growthClass: "quadratic" });
    expect(formatCurveViolation(violation!)).toContain("quadratic");
  });

  it("carries no violation on pass or warn", () => {
    expect(evaluateCurve([makePoint(1, 2, 1)], linear, THRESHOLDS).violation).toBeUndefined();
    expect(evaluateCurve([makePoint(1, 40, 1)], linear, THRESHOLDS).verdict).toBe("warn");
    expect(evaluateCurve([makePoint(1, 40, 1)], linear, THRESHOLDS).violation).toBeUndefined();
  });

  it("buildCurveReport stores the violation, and the terminal prints it under FAIL", () => {
    const built = buildBudgetBreachingCurve();
    expect(built.violation).toMatchObject({ kind: "budget", metric: "mount", crossingN: 20 });

    const report = makeCurveModeReport(built, false);
    const out = formatTable(report);
    expect(out).toContain("Result: FAIL");
    expect(out).toContain("between N=5 and N=20");
  });

  it("a passing curve stores no violation", () => {
    const built = buildPassingCurve();
    expect(built.violation).toBeUndefined();
    expect(formatTable(makeCurveModeReport(built, true))).toContain("Result: PASS");
  });
});

// --- Contract 5: one classification per screen ---

describe("growth column and superlinear hint share one classification", () => {
  it("isSuperlinearGrowth is the single predicate", () => {
    expect(isSuperlinearGrowth({ slope: 1, intercept: 0, r2: 1, growthClass: "quadratic" })).toBe(true);
    expect(isSuperlinearGrowth({ slope: 1, intercept: 0, r2: 1, growthClass: "exponential" })).toBe(true);
    expect(isSuperlinearGrowth({ slope: 1, intercept: 0, r2: 1, growthClass: "linear" })).toBe(false);
    expect(isSuperlinearGrowth({ slope: 1, intercept: 0, r2: 1, growthClass: "constant" })).toBe(false);
    expect(isSuperlinearGrowth({ slope: 1, intercept: 0, r2: 1, growthClass: "inconclusive" })).toBe(false);
    expect(isSuperlinearGrowth(null)).toBe(false);
    expect(isSuperlinearGrowth(undefined)).toBe(false);
  });
});

// --- helpers ---

function makeTiming(median: number) {
  return { samples: [median], median, p95: median, cv: 0, unstable: false };
}

function makePoint(n: number, mount: number, rerender: number): ScalingPoint {
  return {
    n,
    mount: makeTiming(mount),
    rerender: makeTiming(rerender),
    unmount: makeTiming(0.1),
    domNodeCount: n * 3,
    heapDelta: n * 100,
    interactions: [],
  };
}

const CALIBRATION: CalibrationResult = { totalDuration: 10, scriptDuration: 5 };

function makeMountResult(i: number, mount: number, dom: number): MountResult {
  return {
    comboIndex: i,
    props: {},
    mount: { samples: [mount], median: mount, p95: mount },
    unmount: { samples: [0.1], median: 0.1, p95: 0.1 },
    domNodeCount: dom,
    heapDelta: dom * 100,
    mountTraces: [],
  };
}

function makeRerenderResult(i: number, rerender: number): RerenderResult {
  return {
    comboIndex: i,
    props: {},
    stable: { samples: [rerender], median: rerender, p95: rerender },
  };
}

function makeExploreResult(i: number): ExploreResult {
  return {
    comboIndex: i,
    props: {},
    graph: { nodes: new Map(), edges: [], initialNodeId: "root", wallClockMs: 0 },
  };
}

function buildCurve(scalePoints: number[], mounts: number[], rerenders: number[]): ScalingCurveReport {
  return buildCurveReport({
    propName: "items",
    propKind: "array",
    reason: "array prop",
    scalePoints,
    mounts: mounts.map((m, i) => makeMountResult(i, m, scalePoints[i] * 3)),
    rerenders: rerenders.map((r, i) => makeRerenderResult(i, r)),
    explores: scalePoints.map((_, i) => makeExploreResult(i)),
    heapDeltas: scalePoints.map((n) => n * 100),
    calibration: CALIBRATION,
    thresholds: THRESHOLDS,
    skipAttribution: true,
  });
}

function buildPassingCurve(): ScalingCurveReport {
  return buildCurve([1, 5, 20], [1, 2, 5], [0.5, 1, 2]);
}

function buildBudgetBreachingCurve(): ScalingCurveReport {
  return buildCurve([1, 5, 20], [10, 30, 120], [0.5, 1, 2]);
}

function makeReportBase(): Report {
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
  };
}

function makeCurveModeReport(curve: ScalingCurveReport, pass: boolean): Report {
  return { ...makeReportBase(), pass, scalingCurveReport: curve };
}

function makeComboReport(overrides: Partial<Report>): Report {
  return {
    ...makeReportBase(),
    combos: [
      {
        comboIndex: 0,
        props: {},
        mount: makeTiming(2),
        rerender: makeTiming(1),
        unmount: makeTiming(0.5),
        domNodeCount: 10,
        heapDelta: 0,
        relativeMount: 0.2,
        interactions: [],
        tier: "T1",
        verdict: "pass",
        scalingCurve: null,
      },
    ],
    ...overrides,
  };
}
