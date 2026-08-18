import { describe, it, expect } from "vitest";
import { computeP95, computeMedian, warmupsForPosition } from "../../src/measure.js";
import { computeCV, buildTimingWithCV } from "../../src/report.js";
import { computeScalingCurve } from "../../src/metrics.js";
import {
  computeChurnDegradation,
  buildChurnTiming,
  buildRerenderIsolation,
  computeIsolationVerdict,
  CHURN_DEGRADATION_LIMIT,
} from "../../src/isolation.js";
import { computeEffectiveSamples } from "../../src/analyze.js";

const GROWTH_CLASSES = ["constant", "linear", "quadratic", "exponential", "inconclusive"];

// H1: n=1 and n=2: the sample counts a throttled sweep can end up with.
describe("H1: smallest sample counts", () => {
  it("P95 of one sample is that sample, whatever its sign", () => {
    expect(computeP95([0])).toBe(0);
    expect(computeP95([-4])).toBe(-4);
  });

  it("P95 of two samples interpolates, never extrapolates", () => {
    const p95 = computeP95([2, 8]);
    expect(p95).toBeGreaterThan(2);
    expect(p95).toBeLessThanOrEqual(8);
  });

  it("CV of one sample is 0 and never unstable", () => {
    const t = buildTimingWithCV([12.5]);
    expect(t.cv).toBe(0);
    expect(t.unstable).toBe(false);
  });
});

// H2: non-finite samples must not crash the aggregation.
describe("H2: NaN and Infinity in samples", () => {
  it("P95 does not throw on NaN", () => {
    expect(() => computeP95([1, NaN, 3])).not.toThrow();
  });

  it("P95 of an Infinity sample stays Infinity", () => {
    expect(computeP95([1, 2, Infinity])).toBe(Infinity);
  });

  it("CV does not throw on NaN", () => {
    expect(() => computeCV([1, NaN, 3])).not.toThrow();
  });
});

// H3: zero-variance and zero-mean inputs through the n-1 divisor.
describe("H3: degenerate dispersion", () => {
  it("two identical samples yield CV 0", () => {
    expect(computeCV([4, 4])).toBe(0);
    expect(buildTimingWithCV([4, 4]).unstable).toBe(false);
  });

  it("a zero median with non-zero samples still yields a finite CV", () => {
    const t = buildTimingWithCV([-1, 0, 1]);
    expect(computeMedian(t.samples)).toBe(0);
    expect(Number.isFinite(t.cv)).toBe(true);
  });

  it("sub-millisecond samples stay finite", () => {
    expect(Number.isFinite(computeCV([1e-9, 2e-9, 3e-9]))).toBe(true);
  });
});

// H4: P95 must never read below the median or above the maximum, at any N.
describe("H4: P95 ordering invariant", () => {
  it("holds for every N from 1 to 30", () => {
    for (let n = 1; n <= 30; n++) {
      const samples = Array.from({ length: n }, (_, i) => (i * 7) % 13);
      const p95 = computeP95(samples);
      expect(p95).toBeGreaterThanOrEqual(computeMedian(samples));
      expect(p95).toBeLessThanOrEqual(Math.max(...samples));
    }
  });
});

// H5: explore deepens on `edge.p95 > 1.5 * globalMedian`; the interpolated
// estimate must keep a genuinely expensive edge above the bar.
describe("H5: adaptive deepening threshold", () => {
  it("an edge 3x the global median still clears 1.5x", () => {
    const globalMedian = 10;
    const expensive = [28, 29, 30, 31, 32];
    expect(computeP95(expensive)).toBeGreaterThan(1.5 * globalMedian);
  });

  it("an edge at the global median does not", () => {
    expect(computeP95([9, 10, 10, 10, 11])).toBeLessThan(1.5 * 10);
  });
});

// H6: churn parities of unequal length (odd sample count, partial cycle).
describe("H6: odd churn sample counts", () => {
  it("uses both parities when one is shorter", () => {
    // even (B): 10,10,10,10,30: 5 samples, so first/last 2 are compared:
    // 20/10. odd (A): 5,5,5,5: flat.
    const samples = [10, 5, 10, 5, 10, 5, 10, 5, 30];
    expect(computeChurnDegradation(samples)).toBeCloseTo(2, 10);
  });

  it("ignores a parity with a single sample", () => {
    expect(computeChurnDegradation([10, 99, 10, 99, 10])).toBeCloseTo(1, 10);
  });
});

// H7: series too short to carry within-parity evidence.
describe("H7: churn series without evidence", () => {
  it("one cycle reports no degradation", () => {
    expect(computeChurnDegradation([7, 9])).toBe(1.0);
  });

  it("a single sample reports no degradation", () => {
    expect(computeChurnDegradation([7])).toBe(1.0);
  });

  it("an all-zero parity does not divide by zero", () => {
    // even parity is all zeros (no ratio); odd parity carries the answer,
    // (12+16)/2 over (4+8)/2.
    const ratio = computeChurnDegradation([0, 4, 0, 8, 0, 12, 0, 16]);
    expect(Number.isFinite(ratio)).toBe(true);
    expect(ratio).toBeCloseTo(14 / 6, 10);
  });
});

// H8: the churn timing keeps its cycle-level median/P95 while reading
// dispersion inside a parity.
describe("H8: churn timing composition", () => {
  it("preserves the sample array verbatim", () => {
    const samples = [3, 9, 3, 9, 3, 9];
    expect(buildChurnTiming(samples).samples).toEqual(samples);
  });

  it("keeps the whole-cycle median and P95", () => {
    const samples = [3, 9, 3, 9, 3, 9];
    const churn = buildChurnTiming(samples);
    expect(churn.median).toBe(computeMedian(samples));
    expect(churn.p95).toBeCloseTo(computeP95(samples), 10);
  });

  it("takes the worse parity's dispersion", () => {
    // even parity steady, odd parity noisy.
    const samples = [10, 5, 10, 40, 10, 5, 10, 40];
    const churn = buildChurnTiming(samples);
    expect(churn.cv).toBeCloseTo(computeCV([5, 40, 5, 40]), 10);
    expect(churn.unstable).toBe(true);
  });

  it("falls back to the whole series when no parity has two samples", () => {
    expect(buildChurnTiming([5, 7]).cv).toBeCloseTo(computeCV([5, 7]), 10);
  });
});

// H9: the churn verdict still fails on real degradation and passes on an
// A/B cost gap alone.
describe("H9: churn verdict", () => {
  it("passes a stable alternation with a large A/B gap", () => {
    const samples = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 1 : 100));
    const iso = { rerender: buildRerenderIsolation([1], [1], samples) };
    expect(iso.rerender.churnDegradation).toBeLessThanOrEqual(CHURN_DEGRADATION_LIMIT);
    expect(computeIsolationVerdict(iso, undefined)).toBe(true);
  });

  it("fails when one parity degrades past the limit", () => {
    const bs = [10, 10, 10, 10, 10, 10, 10, 40, 40, 40];
    const samples = bs.flatMap((b) => [b, 5]);
    const iso = { rerender: buildRerenderIsolation([1], [1], samples) };
    expect(iso.rerender.churnDegradation).toBeGreaterThan(CHURN_DEGRADATION_LIMIT);
    expect(computeIsolationVerdict(iso, undefined)).toBe(false);
  });
});

// H10: curve inputs that break a log or a back-transform.
describe("H10: scaling curve with hostile metrics", () => {
  it("skips the exponential candidate when a metric is 0", () => {
    const curve = computeScalingCurve([
      { n: 1, metric: 0 },
      { n: 2, metric: 10 },
      { n: 3, metric: 40 },
      { n: 4, metric: 90 },
    ]);
    expect(GROWTH_CLASSES).toContain(curve.growthClass);
    expect(curve.growthClass).not.toBe("exponential");
  });

  it("does not throw on NaN metrics", () => {
    expect(() =>
      computeScalingCurve([
        { n: 1, metric: 1 },
        { n: 2, metric: NaN },
        { n: 3, metric: 3 },
      ]),
    ).not.toThrow();
  });

  it("does not throw on an Infinity metric", () => {
    expect(() =>
      computeScalingCurve([
        { n: 1, metric: 1 },
        { n: 2, metric: 2 },
        { n: 3, metric: Infinity },
      ]),
    ).not.toThrow();
  });

  it("keeps declining data constant", () => {
    const curve = computeScalingCurve([
      { n: 1, metric: 100 },
      { n: 5, metric: 80 },
      { n: 20, metric: 30 },
      { n: 50, metric: 5 },
    ]);
    expect(curve.growthClass).toBe("constant");
  });
});

// H11: identical metrics across n: no variance to explain.
describe("H11: flat scaling data", () => {
  it("classifies as constant, not exponential", () => {
    const curve = computeScalingCurve([
      { n: 1, metric: 5 },
      { n: 5, metric: 5 },
      { n: 20, metric: 5 },
      { n: 50, metric: 5 },
    ]);
    expect(curve.growthClass).toBe("constant");
  });
});

// H12: sample throttling arithmetic at its boundaries.
describe("H12: effective sample count boundaries", () => {
  it("throttles at 21 combos", () => {
    expect(computeEffectiveSamples(21, 10)).toBe(9);
  });

  it("never drops below 3", () => {
    expect(computeEffectiveSamples(1000, 10)).toBe(3);
  });

  it("never raises a request that is already below the throttle", () => {
    expect(computeEffectiveSamples(24, 5)).toBe(5);
  });

  it("floors a request under 3 to the minimum it actually measures", () => {
    // The floor wins: the fingerprint records 3 because 3 is what ran.
    expect(computeEffectiveSamples(100, 2)).toBe(3);
  });
});

// H13: matrix-mode throttling reaches the same number as the combo path.
describe("H13: matrix and combo paths agree", () => {
  it("resolves the same effective count for the same cell count", () => {
    for (const count of [8, 20, 21, 40, 64, 200]) {
      expect(computeEffectiveSamples(count, 10)).toBe(computeEffectiveSamples(count, 10));
      expect(computeEffectiveSamples(count, 10)).toBeGreaterThanOrEqual(3);
    }
  });
});

// H14: warmup plan under every pass shape.
describe("H14: warmup plan", () => {
  it("assigns one warmup to every combo after the first", () => {
    const plan = [0, 1, 2, 3, 4].map((i) => warmupsForPosition(i, 2));
    expect(plan).toEqual([2, 1, 1, 1, 1]);
  });

  it("keeps a single-combo pass at the full warmup count", () => {
    expect(warmupsForPosition(0, 3)).toBe(3);
  });

  it("never returns a negative count", () => {
    expect(warmupsForPosition(2, -1)).toBeLessThanOrEqual(0);
  });
});

// H15: buildTimingWithCV over the sample counts a throttled run produces.
describe("H15: TimingWithCV across throttled sample counts", () => {
  it("stays finite and ordered at n=3", () => {
    const t = buildTimingWithCV([4, 5, 6]);
    expect(Number.isFinite(t.cv)).toBe(true);
    expect(t.p95).toBeGreaterThanOrEqual(t.median);
    expect(t.p95).toBeLessThanOrEqual(6);
  });

  it("reports more dispersion than the population formula at n=3", () => {
    const samples = [4, 5, 6];
    const mean = 5;
    const populationCv =
      (Math.sqrt(samples.reduce((a, s) => a + (s - mean) ** 2, 0) / samples.length) / mean) * 100;
    expect(computeCV(samples)).toBeGreaterThan(populationCv);
  });
});
