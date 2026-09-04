import os from "node:os";
import path from "node:path";
import {
  type PropSchema,
  generateCombinations,
  generatePropMatrix,
  DEFAULT_MEASURED_COMBOS,
} from "../props/index.js";
import { loadBaseline, selectPhaseTimingEntry, type PhaseTimings } from "../report/index.js";
import { type PredictedMode, computeEffectiveSamples } from "./modes/context.js";

export interface RunCostEstimate {
  estimatedMs: number;
  // The counts the real run would measure: the same combo cap and the same
  // `computeEffectiveSamples` the dispatcher applies.
  combos: number;
  samples: number;
  // "baseline" means the per-phase numbers are this component's own, recorded
  // by a `--save-baseline` run on this machine. "defaults" means they are the
  // documented fleet medians and the line says so.
  source: "baseline" | "defaults";
}

// M115 C6: the fallback per-phase numbers, from the 283 logged runs of field
// test run 5 (`remediation/timing-profile.md`, section 4: a 4-combo x 5-sample
// combo run has a median of 39 s). `fixedMs` covers preflight, build,
// calibration and analysis; `perMountSampleMs` is one mount sample;
// `perComboMs` covers the rerender, explore and attribution work a combo
// carries beyond its mount samples.
export const DEFAULT_PHASE_ESTIMATE = {
  fixedMs: 15_000,
  perMountSampleMs: 700,
  perComboMs: 2_500,
};

// An estimate, never a measurement: it multiplies per-unit costs by the units
// the real run would measure. Nothing here starts a server, a browser or a
// measurement.
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
  const fixed = t.preflight + t.build + t.calibration + t.analysis;
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

// The units the mode this dry run predicts would actually measure. Curve mode
// measures one point per scale point and applies no sample throttle; matrix
// mode measures capped cells; the standard combo path measures the capped prop
// combos *plus* the scale anchors `runComboMode` always appends, and throttles
// samples against that larger count.
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

// The dry run's half of M115 C6: no server, no browser, no measurement. A
// fixture or an auto-composed scene supplies one combo; otherwise the real
// run's own combo generation, cap and sample throttle decide the units.
export function estimateExplainedRunCost(input: {
  schemas: PropSchema[];
  projectRoot: string;
  relativeComponent: string;
  usesFixture: boolean;
  mode: PredictedMode;
  scalePoints?: number[];
  samples?: number;
  maxCombos?: number;
}): RunCostEstimate {
  const cap = input.maxCombos ?? DEFAULT_MEASURED_COMBOS;
  const requested = input.samples ?? 10;
  const { combos, samples } = estimateMeasuredUnits(input, cap, requested);

  const cpus = os.cpus();
  // A truncated or hand-edited baseline file must not abort a dry run that
  // measures nothing: the estimate falls back to the documented defaults.
  const baseline = (() => {
    try {
      return loadBaseline(path.join(input.projectRoot, "120fps-baseline.json"));
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
