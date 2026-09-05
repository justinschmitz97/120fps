import type { Page } from "playwright";
import { computeCvPercent, computeMedian } from "../shared/index.js";

export type NoiseLevel = "quiet" | "noisy" | "hostile";

export interface NoiseSignals {
  // Coefficient of variation, in percent, of a fixed busy loop run K times.
  probeCv: number;
  probeMedianMs: number;
  // Share of measured metrics the CV rule already flagged unstable.
  unstableFraction: number;
  // Page reloads survived mid-measurement. A quiet machine has none.
  contextRetries: number;
}

export interface NoiseReport {
  level: NoiseLevel;
  signals: NoiseSignals;
}

// The same bar buildTimingWithCV uses to distrust a metric, applied to the machine itself.
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

// Deliberately not calibration: that measures a DOM insert plus forced layout and swings 20-40%.
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

// Says nothing about a baseline: a run that asked for none must not be told one was skipped.
export const NOISY_RUN_WARNING =
  "The machine was noisy while this ran; treat these numbers as suspect and rerun to confirm.";

export const HOSTILE_RUN_WARNING =
  "The machine was too busy to measure against. Budget verdicts still print, " +
  "but treat every number as provisional.";

// Appended only when a baseline comparison was actually applicable to the run.
export const NOISY_BASELINE_NOTE =
  "Regressions against the baseline are reported but do not fail the run.";

export const HOSTILE_BASELINE_NOTE = "Baseline comparison was skipped.";

// Names the signals report.noise carries, so terminal and JSON share one vocabulary.
export function formatNoiseWarning(noise: NoiseReport, baselineCompared: boolean): string {
  if (noise.level === "quiet") return "";
  const { probeCv, unstableFraction, contextRetries } = noise.signals;
  const signals = [
    `probe CV ${Math.round(probeCv)}%`,
    `${Math.round(unstableFraction * 100)}% of metrics unstable`,
  ];
  if (contextRetries > 0) {
    signals.push(`${contextRetries} context ${contextRetries === 1 ? "retry" : "retries"}`);
  }
  const sentence = noise.level === "hostile" ? HOSTILE_RUN_WARNING : NOISY_RUN_WARNING;
  const note = noise.level === "hostile" ? HOSTILE_BASELINE_NOTE : NOISY_BASELINE_NOTE;
  const baselineClause = baselineCompared ? ` ${note}` : "";
  return `machine: ${noise.level} (${signals.join(", ")}). ${sentence}${baselineClause}`;
}
