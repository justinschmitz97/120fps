import fs from "node:fs";
import path from "node:path";
import {
  TIER_BUDGETS,
  type CalibrationResult,
  type ComponentTier,
  type EnvFingerprint,
  type EnvMatch,
  type MachineInfo,
  type NormalizedDelta,
  type TierBudget,
} from "./report.js";

export interface ComponentBudget {
  tier?: ComponentTier;
  mount?: number;
  rerender?: number;
  interaction?: number;
  unmount?: number;
}

export interface BudgetConfig {
  defaults?: ComponentBudget;
  components?: Record<string, ComponentBudget>;
  tolerance?: {
    mount?: number;
    rerender?: number;
    interaction?: number;
    unmount?: number;
  };
}

export interface BaselineEntry {
  mount: number;
  rerender: number;
  unmount: number;
  domNodeCount: number;
  interactions: Record<string, number>;
  tier: ComponentTier;
  env?: EnvFingerprint;
}

export interface Baseline {
  version: 1;
  timestamp: string;
  entries: Record<string, BaselineEntry>;
}

// What a run contributes to a baseline: the recorded entry plus the metric
// names whose CV disqualifies them from a regression check.
export interface BaselineMetrics {
  mount: number;
  rerender: number;
  unmount: number;
  domNodeCount: number;
  interactions: Record<string, number>;
  unstable: Set<string>;
  tier: ComponentTier;
}

export interface ResolvedTolerance {
  mount: number;
  rerender: number;
  interaction: number;
  unmount: number;
}

export interface BaselineComparison {
  hasBaseline: boolean;
  regressions: Regression[];
  improvements: Improvement[];
  missingInteractions: string[];
  envMatch: EnvMatch;
  envMismatches: string[];
}

export interface Regression {
  metric: string;
  baseline: number;
  current: number;
  deltaPercent: number;
  tolerance: number;
  normalized?: NormalizedDelta;
}

export interface Improvement {
  metric: string;
  baseline: number;
  current: number;
  deltaPercent: number;
  normalized?: NormalizedDelta;
}

export type BaselineEnvPolicy = "strict" | "normalize" | "ignore";

export interface EnvFingerprintInput {
  machine: MachineInfo;
  calibration: CalibrationResult;
  cpuThrottle: number;
  samples: number;
  mode: EnvFingerprint["mode"];
  css?: string[];
  wrapper?: string;
  reactCompiler?: boolean;
}

export const UNKNOWN_ENV_WARNING =
  "Baseline has no environment record; comparing raw timings. Re-save with --save-baseline to enable environment checks.";

export const MISSING_CALIBRATION_NOTE =
  "calibration total duration missing; compared raw milliseconds";

// Normalization divides by a small number, so sub-resolution movement can cross
// a percentage tolerance. Below this raw delta nothing counts as a regression.
export const NORMALIZED_FLOOR_MS = 0.5;

const CALIBRATION_DRIFT_BAND = 0.1;

const DEFAULT_TOLERANCE: ResolvedTolerance = {
  mount: 10,
  rerender: 15,
  interaction: 15,
  unmount: 20,
};

export function loadBudgetConfig(projectRoot: string): BudgetConfig | null {
  const configPath = path.join(projectRoot, "120fps.config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    return JSON.parse(raw) as BudgetConfig;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw new Error(`Failed to load 120fps.config.json: ${err.message}`);
  }
}

export function loadBaseline(baselinePath: string): Baseline | null {
  try {
    const raw = fs.readFileSync(baselinePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1) {
      process.stderr.write(
        `Warning: ${baselinePath} has unsupported baseline version, ignoring (expected 1, got ${JSON.stringify(parsed.version)})\n`,
      );
      return null;
    }
    return parsed as Baseline;
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export function saveBaseline(
  baselinePath: string,
  entry: BaselineEntry,
  componentPath: string,
): void {
  let existing: Baseline | null = null;
  try {
    const raw = fs.readFileSync(baselinePath, "utf-8");
    existing = JSON.parse(raw) as Baseline;
  } catch {
    // file doesn't exist or is invalid — start fresh
  }

  const baseline: Baseline = {
    version: 1,
    timestamp: new Date().toISOString(),
    entries: existing?.entries ?? {},
  };
  baseline.entries[componentPath] = entry;

  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), "utf-8");
}

export function resolveTolerances(config: BudgetConfig | null): ResolvedTolerance {
  return {
    mount: config?.tolerance?.mount ?? DEFAULT_TOLERANCE.mount,
    rerender: config?.tolerance?.rerender ?? DEFAULT_TOLERANCE.rerender,
    interaction: config?.tolerance?.interaction ?? DEFAULT_TOLERANCE.interaction,
    unmount: config?.tolerance?.unmount ?? DEFAULT_TOLERANCE.unmount,
  };
}

export function resolveComponentBudget(
  config: BudgetConfig | null,
  componentPath: string,
  autoTier: ComponentTier,
): TierBudget {
  const perComponent = config?.components?.[componentPath];
  const defaults = config?.defaults;

  const tier = perComponent?.tier ?? defaults?.tier ?? autoTier;
  const tierBudget = TIER_BUDGETS[tier];

  return {
    mountMs: perComponent?.mount ?? defaults?.mount ?? tierBudget.mountMs,
    rerenderMs: perComponent?.rerender ?? defaults?.rerender ?? tierBudget.rerenderMs,
    interactionMs: perComponent?.interaction ?? defaults?.interaction ?? tierBudget.interactionMs,
  };
}

export function buildEnvFingerprint(input: EnvFingerprintInput): EnvFingerprint {
  return {
    shape: 1,
    cpu: input.machine.cpu,
    cores: input.machine.cores,
    os: input.machine.os,
    nodeVersion: input.machine.nodeVersion,
    chromiumVersion: input.machine.chromiumVersion,
    cpuThrottle: input.cpuThrottle,
    samples: input.samples,
    calibrationTotalDuration: input.calibration.totalDuration,
    calibrationScriptDuration: input.calibration.scriptDuration,
    mode: input.mode,
    ...(input.css && input.css.length > 0 ? { css: input.css } : {}),
    ...(input.wrapper ? { wrapper: input.wrapper } : {}),
    ...(input.reactCompiler !== undefined ? { reactCompiler: input.reactCompiler } : {}),
  };
}

// Baseline files are user-editable JSON, so every field is treated as untrusted.
function sameCssList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((file, i) => file === b[i]);
}

// Feature fields change what is measured; no arithmetic rescues a difference.
function featuresDiffer(a: EnvFingerprint, b: EnvFingerprint): boolean {
  return (
    a.mode !== b.mode ||
    !sameCssList(a.css, b.css) ||
    a.wrapper !== b.wrapper ||
    a.reactCompiler !== b.reactCompiler
  );
}

function calibrationClose(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return a === b;
  return Math.abs(a - b) <= CALIBRATION_DRIFT_BAND * Math.max(a, b);
}

export function classifyEnv(
  baseline: EnvFingerprint | undefined,
  current: EnvFingerprint,
): EnvMatch {
  if (!baseline) return "unknown";
  if (featuresDiffer(baseline, current)) return "incompatible";

  const sameMachine =
    baseline.cpu === current.cpu &&
    baseline.cores === current.cores &&
    baseline.os === current.os &&
    baseline.chromiumVersion === current.chromiumVersion &&
    baseline.cpuThrottle === current.cpuThrottle &&
    baseline.samples === current.samples;

  if (sameMachine && calibrationClose(baseline.calibrationTotalDuration, current.calibrationTotalDuration)) {
    return "identical";
  }
  return "normalizable";
}

function cssLabel(files: string[] | undefined): string {
  if (files === undefined) return "none";
  if (!Array.isArray(files)) return String(files);
  return files.length === 0 ? "(empty)" : files.join(", ");
}

function msLabel(value: number): string {
  return Number.isFinite(value) ? `${value.toFixed(2)}ms` : String(value);
}

// Field-level differences behind a classification. nodeVersion is excluded so an
// `identical` pair never produces mismatch text.
export function describeEnvDiff(
  baseline: EnvFingerprint | undefined,
  current: EnvFingerprint,
): string[] {
  if (!baseline) return ["baseline has no environment record"];

  const diffs: string[] = [];
  if (baseline.mode !== current.mode) {
    diffs.push(`mode: baseline "${baseline.mode}", current "${current.mode}"`);
  }
  if (!sameCssList(baseline.css, current.css)) {
    diffs.push(`stylesheets: baseline ${cssLabel(baseline.css)}, current ${cssLabel(current.css)}`);
  }
  if (baseline.wrapper !== current.wrapper) {
    diffs.push(`provider wrapper: baseline ${baseline.wrapper ?? "none"}, current ${current.wrapper ?? "none"}`);
  }
  if (baseline.reactCompiler !== current.reactCompiler) {
    diffs.push(
      `React Compiler: baseline ${baseline.reactCompiler ? "on" : "off"}, current ${current.reactCompiler ? "on" : "off"}`,
    );
  }
  if (baseline.cpu !== current.cpu) {
    diffs.push(`CPU: baseline "${baseline.cpu}", current "${current.cpu}"`);
  }
  if (baseline.cores !== current.cores) {
    diffs.push(`cores: baseline ${baseline.cores}, current ${current.cores}`);
  }
  if (baseline.os !== current.os) {
    diffs.push(`OS: baseline "${baseline.os}", current "${current.os}"`);
  }
  if (baseline.chromiumVersion !== current.chromiumVersion) {
    diffs.push(`Chromium: baseline ${baseline.chromiumVersion}, current ${current.chromiumVersion}`);
  }
  if (baseline.cpuThrottle !== current.cpuThrottle) {
    diffs.push(`CPU throttle: baseline ${baseline.cpuThrottle}x, current ${current.cpuThrottle}x`);
  }
  if (baseline.samples !== current.samples) {
    diffs.push(`samples: baseline ${baseline.samples}, current ${current.samples}`);
  }
  if (!calibrationClose(baseline.calibrationTotalDuration, current.calibrationTotalDuration)) {
    diffs.push(
      `calibration: baseline ${msLabel(baseline.calibrationTotalDuration)}, current ${msLabel(current.calibrationTotalDuration)}`,
    );
  }
  return diffs;
}

export function envAdvisory(
  match: EnvMatch,
  mismatches: string[],
  policy: BaselineEnvPolicy,
): { warning?: string; fail: boolean } {
  if (policy === "ignore" || match === "identical") return { fail: false };

  if (policy === "strict") {
    const detail = mismatches.length > 0 ? ` (${mismatches.join("; ")})` : "";
    return { fail: true, warning: `--baseline-env strict: baseline environment is ${match}${detail}.` };
  }

  if (match === "unknown") return { fail: false, warning: UNKNOWN_ENV_WARNING };
  if (match === "incompatible") {
    return {
      fail: false,
      warning:
        `Baseline environment is incompatible with this run (${mismatches.join("; ")}); ` +
        "comparison skipped. Re-save with --save-baseline.",
    };
  }
  return { fail: false };
}

function usableScale(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function compareBaseline(
  entry: BaselineEntry,
  current: { mount: number; rerender: number; unmount: number; interactions: Record<string, number> },
  tolerance: ResolvedTolerance,
  unstableMetrics?: Set<string>,
  currentEnv?: EnvFingerprint,
): BaselineComparison {
  const envMatch = currentEnv ? classifyEnv(entry.env, currentEnv) : "unknown";
  const envMismatches = currentEnv ? describeEnvDiff(entry.env, currentEnv) : [];

  if (envMatch === "incompatible") {
    return {
      hasBaseline: true,
      regressions: [],
      improvements: [],
      missingInteractions: [],
      envMatch,
      envMismatches,
    };
  }

  const baselineScale = usableScale(entry.env?.calibrationTotalDuration);
  const currentScale = usableScale(currentEnv?.calibrationTotalDuration);
  let normalize = false;
  if (envMatch === "normalizable") {
    normalize = baselineScale !== undefined && currentScale !== undefined;
    if (!normalize) envMismatches.push(MISSING_CALIBRATION_NOTE);
  }

  const regressions: Regression[] = [];
  const improvements: Improvement[] = [];

  const metrics: Array<{ name: string; baseline: number; current: number; tol: number }> = [
    { name: "mount", baseline: entry.mount, current: current.mount, tol: tolerance.mount },
    { name: "rerender", baseline: entry.rerender, current: current.rerender, tol: tolerance.rerender },
    { name: "unmount", baseline: entry.unmount, current: current.unmount, tol: tolerance.unmount },
  ];

  const missingInteractions: string[] = [];
  for (const [label, baselineMs] of Object.entries(entry.interactions)) {
    const currentMs = current.interactions[label];
    if (currentMs !== undefined) {
      metrics.push({ name: `interaction:${label}`, baseline: baselineMs, current: currentMs, tol: tolerance.interaction });
    } else {
      missingInteractions.push(label);
    }
  }

  for (const m of metrics) {
    if (m.baseline <= 0) continue;
    if (unstableMetrics?.has(m.name)) continue;

    const deltaPercent = ((m.current - m.baseline) / m.baseline) * 100;

    if (!normalize) {
      if (m.current > m.baseline * (1 + m.tol / 100)) {
        regressions.push({
          metric: m.name,
          baseline: m.baseline,
          current: m.current,
          deltaPercent,
          tolerance: m.tol,
        });
      } else if (deltaPercent < -5) {
        improvements.push({ metric: m.name, baseline: m.baseline, current: m.current, deltaPercent });
      }
      continue;
    }

    const normalized: NormalizedDelta = {
      baseline: m.baseline / baselineScale!,
      current: m.current / currentScale!,
      deltaPercent: 0,
    };
    normalized.deltaPercent = ((normalized.current - normalized.baseline) / normalized.baseline) * 100;

    const overTolerance = normalized.current > normalized.baseline * (1 + m.tol / 100);
    if (overTolerance && m.current - m.baseline > NORMALIZED_FLOOR_MS) {
      regressions.push({
        metric: m.name,
        baseline: m.baseline,
        current: m.current,
        deltaPercent,
        tolerance: m.tol,
        normalized,
      });
    } else if (normalized.deltaPercent < -5) {
      improvements.push({
        metric: m.name,
        baseline: m.baseline,
        current: m.current,
        deltaPercent,
        normalized,
      });
    }
  }

  return { hasBaseline: true, regressions, improvements, missingInteractions, envMatch, envMismatches };
}
