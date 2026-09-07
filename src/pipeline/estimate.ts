import os from "node:os";
import path from "node:path";
import {
  type PropSchema,
  generateCombinations,
  generatePropMatrix,
  DEFAULT_MEASURED_COMBOS,
} from "../props/index.js";
import { loadBaseline, resolveBaselinePath, selectPhaseTimingEntry, type PhaseTimings } from "../report/index.js";
import { type PredictedMode, computeEffectiveSamples } from "./modes/context.js";

export interface RunCostEstimate {
  estimatedMs: number;
  // The counts the real run would measure: same combo cap, same computeEffectiveSamples.
  combos: number;
  samples: number;
  // "baseline": this machine's --save-baseline numbers; "defaults": documented fleet medians.
  source: "baseline" | "defaults";
}

// fixedMs covers preflight, build, calibration, setup and analysis; perComboMs the non-mount combo work.
export const DEFAULT_PHASE_ESTIMATE = {
  fixedMs: 15_000,
  perMountSampleMs: 700,
  perComboMs: 2_500,
};

// An estimate, never a measurement: no server, no browser, no page.
export function estimateRunCost(input: {
  combos: number;
  samples: number;
  recorded?: { timings: PhaseTimings; units: { combos: number; samples: number } };
}): RunCostEstimate {
  const { combos, samples } = input;
  const recorded = input.recorded;
  const units = recorded?.units;
  const usable =
    recorded !== undefined && units !== undefined && units.combos > 0 && units.samples > 0;
  if (!usable) {
    return {
      estimatedMs:
        DEFAULT_PHASE_ESTIMATE.fixedMs +
        DEFAULT_PHASE_ESTIMATE.perMountSampleMs * combos * samples +
        DEFAULT_PHASE_ESTIMATE.perComboMs * combos,
      combos,
      samples,
      source: "defaults",
    };
  }
  const t = recorded!.timings;
  const recordedUnits = units!;
  // A baseline written before `setup` was a phase of its own carries the interval inside calibration.
  const fixed = t.preflight + t.build + t.calibration + (t.setup ?? 0) + t.analysis;
  const perMountSample = t.mount / (recordedUnits.combos * recordedUnits.samples);
  const perCombo =
    (t.rerender + t.explore + t.scale + t.deltas + t.attribution) / recordedUnits.combos;
  return {
    estimatedMs: Math.round(fixed + perMountSample * combos * samples + perCombo * combos),
    combos,
    samples,
    source: "baseline",
  };
}

// Curve mode applies no sample throttle; the combo path throttles against capped combos + anchors.
function estimateMeasuredUnits(
  input: {
    schemas: PropSchema[];
    usesFixture: boolean;
    mode: PredictedMode;
    scalePoints?: number[];
  },
  cap: number,
  requested: number,
): { combos: number; samples: number } {
  if (input.mode === "curve") {
    const points = input.scalePoints ?? [1, 3, 5, 10, 20, 50];
    return { combos: Math.max(1, points.length), samples: requested };
  }
  if (input.mode === "matrix") {
    const cells = generatePropMatrix(input.schemas).length;
    const combos = Math.max(1, Math.min(cells === 0 ? 1 : cells, cap));
    return { combos, samples: computeEffectiveSamples(combos, requested) };
  }
  const generated = input.usesFixture ? 1 : generateCombinations(input.schemas).length;
  const anchors = input.usesFixture ? 0 : (input.scalePoints ?? [1, 5, 20, 50]).length;
  const combos = Math.max(1, Math.min(generated === 0 ? 1 : generated, cap)) + anchors;
  return { combos, samples: computeEffectiveSamples(combos, requested) };
}

// A fixture supplies one combo; otherwise the real run's own cap and throttle decide the units.
export function estimateExplainedRunCost(input: {
  schemas: PropSchema[];
  projectRoot: string;
  relativeComponent: string;
  usesFixture: boolean;
  mode: PredictedMode;
  scalePoints?: number[];
  samples?: number;
  maxCombos?: number;
  // The same file --check would read, so the dry run estimates from the entry the run will use.
  baselineFile?: string;
}): RunCostEstimate {
  const cap = input.maxCombos ?? DEFAULT_MEASURED_COMBOS;
  const requested = input.samples ?? 10;
  const { combos, samples } = estimateMeasuredUnits(input, cap, requested);

  const cpus = os.cpus();
  // A truncated or hand-edited baseline must not abort a dry run; fall back to the defaults.
  const baseline = (() => {
    try {
      return loadBaseline(resolveBaselinePath(input.projectRoot, input.baselineFile));
    } catch {
      return null;
    }
  })();
  const entry = selectPhaseTimingEntry(
    baseline,
    input.relativeComponent,
    {
      cpu: cpus.length > 0 ? cpus[0].model : "unknown",
      cores: cpus.length,
      os: `${os.type()} ${os.release()}`,
    },
  );

  return estimateRunCost({
    combos,
    samples,
    ...(entry?.phaseTimings && entry.phaseUnits
      ? { recorded: { timings: entry.phaseTimings, units: entry.phaseUnits } }
      : {}),
  });
}
