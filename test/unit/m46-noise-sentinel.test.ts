import { describe, it, expect } from "vitest";
import {
  classifyNoise,
  computeCvPercent,
  buildNoiseReport,
  NOISE_CV_PERCENT,
  HOSTILE_CV_PERCENT,
  NOISY_UNSTABLE_FRACTION,
  HOSTILE_UNSTABLE_FRACTION,
  NOISE_PROBE_SAMPLES,
  NOISY_RUN_WARNING,
  HOSTILE_RUN_WARNING,
  NOISY_BASELINE_NOTE,
  HOSTILE_BASELINE_NOTE,
  type NoiseSignals,
} from "../../src/noise.js";

function signals(overrides: Partial<NoiseSignals> = {}): NoiseSignals {
  return {
    probeCv: 2,
    probeMedianMs: 10,
    unstableFraction: 0,
    contextRetries: 0,
    ...overrides,
  };
}

// C1 — a quiet machine looks quiet.
describe("m46 C1 — classification", () => {
  it("is quiet when every signal is clean", () => {
    expect(classifyNoise(signals())).toBe("quiet");
  });

  it("is noisy when the probe disperses past the metric-trust bar", () => {
    expect(classifyNoise(signals({ probeCv: NOISE_CV_PERCENT + 1 }))).toBe("noisy");
  });

  it("is noisy when a quarter of the metrics were already untrusted", () => {
    expect(classifyNoise(signals({ unstableFraction: NOISY_UNSTABLE_FRACTION }))).toBe("noisy");
  });

  it("is noisy when the page had to be reloaded mid-measurement", () => {
    expect(classifyNoise(signals({ contextRetries: 1 }))).toBe("noisy");
  });

  it("is hostile past twice the bar", () => {
    expect(classifyNoise(signals({ probeCv: HOSTILE_CV_PERCENT + 1 }))).toBe("hostile");
  });

  it("is hostile when half the metrics were untrusted", () => {
    expect(classifyNoise(signals({ unstableFraction: HOSTILE_UNSTABLE_FRACTION }))).toBe("hostile");
  });

  it("uses the same bar the CV rule uses to distrust a metric", () => {
    expect(NOISE_CV_PERCENT).toBe(15);
    expect(HOSTILE_CV_PERCENT).toBe(2 * NOISE_CV_PERCENT);
  });

  it("takes more than one probe sample: one of anything says nothing", () => {
    expect(NOISE_PROBE_SAMPLES).toBeGreaterThanOrEqual(5);
  });
});

// C2 — dispersion maths.
describe("m46 C2 — dispersion", () => {
  it("is zero for identical samples", () => {
    expect(computeCvPercent([10, 10, 10])).toBe(0);
  });

  it("grows with spread", () => {
    expect(computeCvPercent([10, 20, 30])).toBeGreaterThan(computeCvPercent([19, 20, 21]));
  });

  it("is zero for a single sample: there is no dispersion to speak of", () => {
    expect(computeCvPercent([10])).toBe(0);
    expect(computeCvPercent([])).toBe(0);
  });

  it("does not divide by a zero mean", () => {
    expect(computeCvPercent([0, 0])).toBe(0);
  });
});

// C3 — assembly from signals the run already has.
describe("m46 C3 — report assembly", () => {
  it("derives the unstable fraction from the metric counts", () => {
    const report = buildNoiseReport({
      probeSamples: [10, 10, 10],
      unstableCount: 1,
      metricCount: 4,
      contextRetries: 0,
    });
    expect(report.signals.unstableFraction).toBe(0.25);
    expect(report.level).toBe("noisy");
  });

  it("treats a run with no metrics as unflagged rather than dividing by zero", () => {
    const report = buildNoiseReport({
      probeSamples: [10, 10, 10],
      unstableCount: 0,
      metricCount: 0,
      contextRetries: 0,
    });
    expect(report.signals.unstableFraction).toBe(0);
    expect(report.level).toBe("quiet");
  });

  it("records the probe median so a reader can see what the machine did", () => {
    const report = buildNoiseReport({
      probeSamples: [8, 10, 12],
      unstableCount: 0,
      metricCount: 3,
      contextRetries: 0,
    });
    expect(report.signals.probeMedianMs).toBe(10);
  });

  // M64: the baseline clauses moved out of the fixed sentences — a run that
  // never asked for a baseline was being told its comparison had been skipped.
  it("says what to do about it", () => {
    expect(NOISY_RUN_WARNING).toContain("rerun");
    expect(NOISY_BASELINE_NOTE).toContain("do not fail");
    expect(HOSTILE_BASELINE_NOTE).toContain("skipped");
    expect(HOSTILE_RUN_WARNING).toContain("provisional");
  });
});
