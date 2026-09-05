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

// Shared by the plain-combo and forced-matrix paths so a large count throttles identically.
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
  // Says "measurements", not "combos": comboCount includes scale probes the mode line excludes.
  `measured ${effective} samples per measurement instead of the requested ${requested}: ` +
  `${comboCount} measurements exceed the per-run sample budget. Dispersion (CV, P95) is ` +
  `estimated from ${effective} samples.`;

// Built once per run, after harness build, calibration and composition rollback, before dispatch.
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
  // Gates the React optimization pass and travels into the baseline environment record.
  framework: "react" | "vue" | "vanilla";
  fixturePath?: string;
  fixtureAutoDetected: boolean;
  composed: boolean;
  compositionTree?: CompositionTree;
  // See BuildReportInput.disclosureReason; only the combo/matrix path reaches buildReport.
  disclosureReason?: "uncomposed" | "propsExcluded";
  wrapper?: WrapperReport;
  cssReport?: CssReport;
  runWarnings: string[];
  onWarning: (warning: string) => void;
  // One line per phase boundary, already silenced in CI mode.
  progress: (line: string) => void;
  // The clock the progress reporter charges, so each branch reports the same run's breakdown.
  phaseClock: PhaseClock;
  getSchemas: () => Promise<PropSchema[]>;
  getSourceFingerprint: () => Promise<string>;
  attachHarnessContext: (report: Report) => void;
}

// The dry run must agree with the dispatcher's precedence: curve returns before matrix is reached.
export type PredictedMode = "isolation" | "curve" | "matrix" | "combo";

// The three classes listed here need a browser and can never move into the dry run.
export const DRY_RUN_RUNTIME_ONLY_NOTE =
  "Every refusal decidable from the filesystem is printed above. Three classes are not: a module " +
  "that throws while it evaluates, a provider or context that throws at render, and a value this " +
  "tool synthesized that the component rejects only at runtime. A real run can still refuse where " +
  "this one was clean.";

export function predictMode(input: {
  isolation: boolean;
  curve: boolean;
  // A fixture or a composed scene owns its own props, so no matrix applies (analyze.ts).
  matrixEligible: boolean;
  matrixRequested: boolean;
  matrixAutoActivates: boolean;
}): PredictedMode {
  if (input.isolation) return "isolation";
  if (input.curve) return "curve";
  if (input.matrixEligible && (input.matrixRequested || input.matrixAutoActivates)) return "matrix";
  return "combo";
}

// Gated as the combo-mode pass is, so every mode that measured a React tree discloses the same.
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
    // ctx.runWarnings is already flushed by this point, so warnings go onto the built report.
    onWarning: (warning) => {
      if (!(report.warnings ?? []).includes(warning)) {
        report.warnings = [...(report.warnings ?? []), warning];
      }
    },
  });
}

// The harness imports what this names, so both read the same resolver and its filename fallback.
export function detectComponentName(componentPath: string, target?: string): string {
  return detectComponentExport(componentPath, target).name;
}

// Rerenders inherit animation knowledge from mount, so animated combos avoid driven pacing.
export function animatedIndices(mounts: MountResult[]): number[] {
  return mounts.filter((m) => m?.hasAnimation).map((m) => m.comboIndex);
}
