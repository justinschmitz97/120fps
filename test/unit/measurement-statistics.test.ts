import { describe, it, expect } from "vitest";
import { computeP95, computeMedian, warmupsForPosition } from "../../src/measure.js";
import { computeCV, buildTimingWithCV } from "../../src/report.js";
import { computeScalingCurve } from "../../src/metrics.js";
import {
  computeChurnDegradation,
  churnParitySeries,
  buildRerenderIsolation,
} from "../../src/isolation.js";
import { computeEffectiveSamples, EFFECTIVE_SAMPLES_WARNING } from "../../src/analyze.js";
import { buildEnvFingerprint, classifyEnv } from "../../src/budget.js";

// Type-7 (R/numpy default) reference values, computed independently:
// h = (n-1)*0.95, value = x[floor(h)] + (h-floor(h)) * (x[ceil(h)] - x[floor(h)]).
describe("computeP95: interpolated quantile", () => {
  it("does not return the sample maximum at n=10", () => {
    const samples = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(computeP95(samples)).toBeCloseTo(9.55, 10);
    expect(computeP95(samples)).not.toBe(10);
  });

  it("matches type-7 for n=20", () => {
    expect(computeP95(Array.from({ length: 20 }, (_, i) => i + 1))).toBeCloseTo(19.05, 10);
  });

  it("matches type-7 for n=1000", () => {
    expect(computeP95(Array.from({ length: 1000 }, (_, i) => i + 1))).toBeCloseTo(950.05, 10);
  });

  it("returns the sample for n=1", () => {
    expect(computeP95([7])).toBe(7);
  });

  it("interpolates between the two samples at n=2", () => {
    expect(computeP95([10, 20])).toBeCloseTo(19.5, 10);
  });

  it("returns 0 for an empty array", () => {
    expect(computeP95([])).toBe(0);
  });

  it("returns the common value when all samples are identical", () => {
    expect(computeP95([5, 5, 5, 5])).toBe(5);
  });

  it("sorts unsorted input before interpolating", () => {
    expect(computeP95([10, 8, 6, 4, 2])).toBeCloseTo(9.6, 10);
    expect(computeP95([2, 4, 6, 8, 10])).toBeCloseTo(9.6, 10);
  });

  it("stays between median and maximum", () => {
    const samples = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3];
    const p95 = computeP95(samples);
    expect(p95).toBeGreaterThanOrEqual(computeMedian(samples));
    expect(p95).toBeLessThanOrEqual(Math.max(...samples));
  });
});

describe("computeCV: sample standard deviation", () => {
  it("uses the n-1 denominator", () => {
    // [2,4,4,4,5,5,7,9]: mean 5, sum of squared deviations 32.
    // population sd 2 (CV 40%), sample sd sqrt(32/7) = 2.1381 (CV 42.76%).
    expect(computeCV([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(42.7618, 3);
  });

  it("computes the sample CV at n=2", () => {
    // sample sd of [10,20] = sqrt(50) = 7.0711, mean 15.
    expect(computeCV([10, 20])).toBeCloseTo(47.1405, 3);
  });

  it("returns 0 for n=1 and for an empty array", () => {
    expect(computeCV([5])).toBe(0);
    expect(computeCV([])).toBe(0);
  });

  it("returns 0 for identical samples", () => {
    expect(computeCV([10, 10, 10, 10])).toBe(0);
  });

  it("returns 0 when the mean is 0", () => {
    expect(computeCV([0, 0, 0])).toBe(0);
  });

  it("feeds the same dispersion into TimingWithCV", () => {
    expect(buildTimingWithCV([10, 20]).cv).toBeCloseTo(47.1405, 3);
  });
});

describe("warmupsForPosition: per-combo warmup", () => {
  it("gives the first combo of a pass the full warmup count", () => {
    expect(warmupsForPosition(0, 2)).toBe(2);
  });

  it("gives every later combo one warmup", () => {
    expect(warmupsForPosition(1, 2)).toBe(1);
    expect(warmupsForPosition(7, 2)).toBe(1);
  });

  it("honours an explicit opt-out", () => {
    expect(warmupsForPosition(0, 0)).toBe(0);
    expect(warmupsForPosition(3, 0)).toBe(0);
  });

  it("never exceeds the configured count", () => {
    expect(warmupsForPosition(2, 1)).toBe(1);
  });
});

describe("effective sample count", () => {
  it("throttles above 20 combos", () => {
    expect(computeEffectiveSamples(24, 10)).toBe(8);
    expect(computeEffectiveSamples(100, 10)).toBe(3);
    expect(computeEffectiveSamples(20, 10)).toBe(10);
  });

  it("discloses both the effective and the requested count", () => {
    const warning = EFFECTIVE_SAMPLES_WARNING(3, 10, 100);
    expect(warning).toContain("3");
    expect(warning).toContain("10");
    expect(warning).toContain("100");
  });

  it("keeps runs measured at different real N out of an identical comparison", () => {
    const base = {
      machine: {
        cpu: "TestCPU",
        cores: 8,
        ramMb: 16000,
        os: "Linux",
        nodeVersion: "v20.11.0",
        chromiumVersion: "120.0.0",
      },
      calibration: { totalDuration: 10, scriptDuration: 4 },
      cpuThrottle: 4,
      mode: "combo" as const,
    };
    const at10 = buildEnvFingerprint({ ...base, samples: 10 });
    const at3 = buildEnvFingerprint({ ...base, samples: 3 });
    expect(classifyEnv(at10, at3)).toBe("normalizable");
    expect(classifyEnv(at3, at3)).toBe("identical");
  });
});

// measureChurn records B,A,B,A…: even indices rerender into propsB, odd into
// propsA. A first-vs-last comparison across the mix measures the A/B gap.
describe("churn: parity-aware aggregation", () => {
  const alternating = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 10 : 20));

  it("splits samples by alternation parity", () => {
    expect(churnParitySeries([1, 2, 3, 4, 5])).toEqual([[1, 3, 5], [2, 4]]);
  });

  it("reports no degradation for a stable alternating series", () => {
    expect(computeChurnDegradation(alternating)).toBeCloseTo(1.0, 10);
  });

  it("measures dispersion within a parity, not across the A/B mix", () => {
    const iso = buildRerenderIsolation([1], [1], alternating);
    expect(iso.churn.cv).toBe(0);
    expect(iso.churn.unstable).toBe(false);
  });

  it("keeps median, P95 and samples over the whole cycle", () => {
    const iso = buildRerenderIsolation([1], [1], alternating);
    expect(iso.churn.samples).toEqual(alternating);
    expect(iso.churn.median).toBe(15);
  });

  it("detects degradation inside one parity", () => {
    // even (B) samples climb 10 → 30, odd (A) samples stay at 5.
    const bs = [10, 10, 10, 10, 10, 20, 20, 20, 30, 30];
    const samples = bs.flatMap((b) => [b, 5]);
    expect(computeChurnDegradation(samples)).toBeCloseTo(80 / 3 / 10, 10);
  });

  it("reports the worse of the two parities", () => {
    const rising = [1, 1, 1, 1, 1, 1, 3, 3, 3, 3];
    const falling = [...rising].reverse();
    const samples = rising.flatMap((r, i) => [r, falling[i]]);
    const ratio = computeChurnDegradation(samples);
    expect(ratio).toBeCloseTo(3, 10);
  });

  it("returns 1.0 without a usable series", () => {
    expect(computeChurnDegradation([])).toBe(1.0);
    expect(computeChurnDegradation([0, 0, 0, 1, 1, 1])).toBe(1.0);
  });

  it("handles an odd sample count", () => {
    const samples = [10, 20, 10, 20, 10];
    expect(() => computeChurnDegradation(samples)).not.toThrow();
    expect(computeChurnDegradation(samples)).toBeCloseTo(1.0, 10);
  });
});

describe("computeScalingCurve: one response variable for every candidate", () => {
  it("does not pick a fit that explains raw y worse than its rivals", () => {
    // log y is near-perfectly linear (r² 0.987), but the back-transformed
    // exponential misses the largest point by ~1855 and explains only 46% of
    // raw variance, against 88% for the quadratic candidate.
    const points = [
      { n: 1, metric: 1 },
      { n: 2, metric: 10 },
      { n: 3, metric: 100 },
      { n: 4, metric: 1000 },
      { n: 5, metric: 3000 },
    ];
    expect(computeScalingCurve(points).growthClass).toBe("quadratic");
  });

  it("still classifies a genuine exponential as exponential", () => {
    const points = [
      { n: 1, metric: 2 },
      { n: 2, metric: 4 },
      { n: 3, metric: 8 },
      { n: 4, metric: 16 },
    ];
    expect(computeScalingCurve(points).growthClass).toBe("exponential");
  });

  it("keeps linear data linear", () => {
    const points = [
      { n: 1, metric: 10 },
      { n: 5, metric: 50 },
      { n: 20, metric: 200 },
      { n: 50, metric: 500 },
    ];
    expect(computeScalingCurve(points).growthClass).toBe("linear");
  });

  it("keeps quadratic data quadratic", () => {
    const points = [
      { n: 1, metric: 1 },
      { n: 5, metric: 25 },
      { n: 20, metric: 400 },
      { n: 50, metric: 2500 },
    ];
    expect(computeScalingCurve(points).growthClass).toBe("quadratic");
  });

  it("never lets a non-finite back-transform win", () => {
    // exp() of the fitted log-line overflows at these magnitudes; a candidate
    // that explains nothing must not be selected by an arithmetic accident.
    const points = [
      { n: 1, metric: 1 },
      { n: 400, metric: 1e60 },
      { n: 800, metric: 1e120 },
      { n: 1200, metric: 1e240 },
    ];
    const curve = computeScalingCurve(points);
    expect(["constant", "linear", "quadratic", "exponential", "inconclusive"]).toContain(
      curve.growthClass,
    );
  });
});
