import type { Page } from "playwright";
import { computeMedian } from "./measure.js";

export type NoiseLevel = "quiet" | "noisy" | "hostile";

export interface NoiseSignals {
  // Coefficient of variation, in percent, of a fixed busy loop run K times.
  probeCv: number;
  probeMedianMs: number;
  // Share of measured metrics the CV rule already flagged unstable.
  unstableFraction: number;
  // Page reloads survived mid-measurement (M30). A quiet machine has none.
  contextRetries: number;
}

export interface NoiseReport {
  level: NoiseLevel;
  signals: NoiseSignals;
}

// The same bar `buildTimingWithCV` uses to distrust a metric. A machine that
// cannot run a fixed busy loop more repeatably than the threshold at which we
// stop trusting a measurement is, by that same standard, not quiet.
export const NOISE_CV_PERCENT = 15;

// Twice the bar. At this dispersion the run is not measuring the component.
export const HOSTILE_CV_PERCENT = 30;

export const NOISY_UNSTABLE_FRACTION = 0.25;
export const HOSTILE_UNSTABLE_FRACTION = 0.5;

export const NOISE_PROBE_SAMPLES = 7;

export function classifyNoise(signals: NoiseSignals): NoiseLevel {
  if (
    signals.probeCv > HOSTILE_CV_PERCENT ||
    signals.unstableFraction >= HOSTILE_UNSTABLE_FRACTION
  ) {
    return "hostile";
  }
  if (
    signals.probeCv > NOISE_CV_PERCENT ||
    signals.unstableFraction >= NOISY_UNSTABLE_FRACTION ||
    signals.contextRetries > 0
  ) {
    return "noisy";
  }
  return "quiet";
}

export function computeCvPercent(samples: number[]): number {
  if (samples.length < 2) return 0;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  if (mean <= 0) return 0;
  const variance =
    samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / samples.length;
  return (Math.sqrt(variance) / mean) * 100;
}

// A fixed arithmetic loop, timed K times. Deliberately not calibration: that
// measures a DOM insert plus forced layout and feeds normalization, and one
// sample of it swings 20–40% (M39). This asks a narrower question — can this
// machine repeat identical work identically right now — and answers it with
// enough samples to mean something.
export async function probeMachineNoise(
  page: Page,
  samples: number = NOISE_PROBE_SAMPLES,
): Promise<number[]> {
  return page.evaluate((count: number) => {
    const timings: number[] = [];
    for (let s = 0; s < count; s++) {
      const start = performance.now();
      let acc = 0;
      for (let i = 0; i < 2_000_000; i++) acc += i % 7;
      // Consumed so the loop cannot be optimized away.
      if (acc === -1) timings.push(-1);
      timings.push(performance.now() - start);
    }
    return timings;
  }, samples);
}

export function buildNoiseReport(input: {
  probeSamples: number[];
  unstableCount: number;
  metricCount: number;
  contextRetries: number;
}): NoiseReport {
  const signals: NoiseSignals = {
    probeCv: computeCvPercent(input.probeSamples),
    probeMedianMs: computeMedian(input.probeSamples),
    unstableFraction: input.metricCount > 0 ? input.unstableCount / input.metricCount : 0,
    contextRetries: input.contextRetries,
  };
  return { level: classifyNoise(signals), signals };
}

export const NOISY_RUN_WARNING =
  "The machine was noisy while this ran; treat regressions as suspect and rerun to confirm. " +
  "Regressions against a baseline are reported but do not fail the run.";

export const HOSTILE_RUN_WARNING =
  "The machine was too busy to measure against. Baseline comparison was skipped; " +
  "budget verdicts still print, but treat every number as provisional.";
