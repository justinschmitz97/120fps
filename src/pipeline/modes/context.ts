import { detectComponentExport, type HarnessResult } from "../../harness/index.js";
import { type PropSchema, type CompositionTree, type PropCombination } from "../../props/index.js";
import { runReactAnalysis, type ReactOptimizations } from "../../analysis/index.js";
import { type BrowserPool, type MountResult } from "../../browser/index.js";
import {
  type CalibrationResult,
  type MachineInfo,
  type Report,
  type TierBudget,
  type Thresholds,
  type CssReport,
  type WrapperReport,
  type PhaseClock,
} from "../../report/index.js";
import { type AnalyzeOptions } from "../analyze.js";

// Shared by the plain-combo and forced-matrix paths so a large cell/combo
// count throttles samples identically in either mode.
export function computeEffectiveSamples(comboCount: number, samples: number): number {
  return comboCount > 20
    ? Math.max(3, Math.min(samples, Math.floor(200 / comboCount)))
    : samples;
}

export const EFFECTIVE_SAMPLES_WARNING = (
  effective: number,
  requested: number,
  comboCount: number,
): string =>
  // C-15: `comboCount` is every measured row, scale probes included, which is
  // the true input to the sample budget and a different number from the mode
  // line's prop-combo count. M104's one-count invariant is about "combos"; this
  // says "measurements" so the two numbers cannot be read as the same noun.
  `measured ${effective} samples per measurement instead of the requested ${requested}: ` +
  `${comboCount} measurements exceed the per-run sample budget. Dispersion (CV, P95) is ` +
  `estimated from ${effective} samples.`;

// Everything the mode branches (isolation, curve, matrix, standard combos)
// share once the harness is built, the session calibrated, and composition
// rollback settled. Built exactly once per run, right before mode dispatch.
export interface ModeContext {
  options: AnalyzeOptions;
  harness: HarnessResult;
  pool: BrowserPool;
  machine: MachineInfo;
  calibration: CalibrationResult;
  thresholds: Thresholds;
  explicitThresholds: Partial<Record<keyof TierBudget, boolean>>;
  samples: number;
  cpuThrottle: number;
  warmupRuns: number;
  seed: number;
  componentPath: string;
  resolvedPath: string;
  metadataPath: string;
  projectRoot: string;
  relativeComponent: string;
  inputIsFixture: boolean;
  useFixture: boolean;
  // M57: which renderer mounted the scene. Gates the React optimization pass
  // and travels into the baseline environment record.
  framework: "react" | "vue" | "vanilla";
  fixturePath?: string;
  fixtureAutoDetected: boolean;
  composed: boolean;
  compositionTree?: CompositionTree;
  // M80: see BuildReportInput.disclosureReason. Curve mode and isolation
  // mode compute their own pass/fail independently of buildReport and never
  // read this; only the combo/matrix path (both call buildReport) does.
  disclosureReason?: "uncomposed" | "propsExcluded";
  wrapper?: WrapperReport;
  cssReport?: CssReport;
  runWarnings: string[];
  onWarning: (warning: string) => void;
  // M65: one line per phase boundary, already silenced in CI mode.
  progress: (line: string) => void;
  // M115 C1: the clock the progress reporter charges, so every mode branch
  // puts the same run's breakdown on the report it returns.
  phaseClock: PhaseClock;
  getSchemas: () => Promise<PropSchema[]>;
  getSourceFingerprint: () => Promise<string>;
  attachHarnessContext: (report: Report) => void;
}

// M100 (element-plus-F4): the dry run printed "Curve mode: would activate" and
// "Matrix mode: would auto-activate" as two independent booleans, while the
// real dispatcher returns at curve before the matrix branch is ever reached —
// so a badge.vue dry run promised a matrix the real run never ran. One
// function, in the dispatcher's own precedence, read by both.
export type PredictedMode = "isolation" | "curve" | "matrix" | "combo";

// M100: M91's MUST NOT ("never a clean dry run where the real run refuses")
// restated for what a dry run can actually decide. Everything the real run
// reads from the filesystem now prints in both modes; three classes need the
// browser and can never move: a module that throws while it evaluates (an
// env-validation schema run against process.env), a provider or context that
// throws at render, and a synthesized value the component rejects at runtime
// while accepting it by type.
export const DRY_RUN_RUNTIME_ONLY_NOTE =
  "Every refusal decidable from the filesystem is printed above. Three classes are not: a module " +
  "that throws while it evaluates, a provider or context that throws at render, and a value this " +
  "tool synthesized that the component rejects only at runtime. A real run can still refuse where " +
  "this one was clean.";

export function predictMode(input: {
  isolation: boolean;
  curve: boolean;
  // `!matrixDisabled && !useFixture && !composed` (analyze.ts's matrix branch):
  // a fixture or a composed scene owns its own props, so no matrix applies.
  matrixEligible: boolean;
  matrixRequested: boolean;
  matrixAutoActivates: boolean;
}): PredictedMode {
  if (input.isolation) return "isolation";
  if (input.curve) return "curve";
  if (input.matrixEligible && (input.matrixRequested || input.matrixAutoActivates)) return "matrix";
  return "combo";
}

// M104 (commerce-F1): the pass runComboMode runs (analyze.ts:1823), gated by
// the same two conditions, so every mode that measured a React tree can
// disclose what the profiler saw. Warnings are written straight onto the
// already-built report for the same reason combo mode does it: the run's
// shared `runWarnings` array has already been flushed by this point.
export async function collectReactOptimizations(
  ctx: ModeContext,
  combos: PropCombination[],
  schemas: PropSchema[] | undefined,
  report: Report,
): Promise<Map<number, ReactOptimizations>> {
  if (ctx.options.skipReactAnalysis || ctx.framework !== "react") return new Map();
  ctx.progress("react analysis");
  const fnPropNames = schemas
    ? schemas.filter((s) => s.kind === "function").map((s) => s.name)
    : [];
  return await runReactAnalysis(ctx.harness, {
    combos,
    samples: Math.min(ctx.samples, 3),
    cpuThrottle: ctx.cpuThrottle,
    warmupRuns: 1,
    fnPropNames,
    pool: ctx.pool,
    onWarning: (warning) => {
      if (!(report.warnings ?? []).includes(warning)) {
        report.warnings = [...(report.warnings ?? []), warning];
      }
    },
  });
}

// M58: the report names the component the harness imports and renders, so both
// read the same resolver. The filename fallback lives inside it.
export function detectComponentName(componentPath: string, target?: string): string {
  return detectComponentExport(componentPath, target).name;
}

// M35: rerender passes inherit animation knowledge from the mount pass over
// the same combo list, so animated combos never measure under driven pacing.
export function animatedIndices(mounts: MountResult[]): number[] {
  return mounts.filter((m) => m?.hasAnimation).map((m) => m.comboIndex);
}
