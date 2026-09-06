import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findWorkspaceRoot } from "../project/index.js";
import {
  TIER_BUDGETS,
  type CalibrationResult,
  type ComponentTier,
  type EnvFingerprint,
  type EnvMatch,
  type MachineInfo,
  type MeasuredState,
  type NormalizedDelta,
  type TierBudget,
} from "./types.js";
import type { PhaseTimings } from "./phases.js";
import { parseBaselineKey } from "./baseline-io.js";
import { toPosix } from "../shared/index.js";

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
  // With pass, lets an unchanged component reuse this entry instead of re-measuring.
  sourceFingerprint?: string;
  pass?: boolean;
  // Absent when no scene was recorded: an unknown state is not a changed state.
  measuredState?: MeasuredState;
  // Pruning timestamp; a slot without one is kept, because absence is not age.
  savedAt?: string;
  // Replayed verbatim when the verdict is reused, so caching loses no disclosure.
  warnings?: string[];
  // Outside computeEnvKey and the baseline key: an entry differing only here is the same slot.
  phaseTimings?: PhaseTimings;
  phaseUnits?: { combos: number; samples: number };
}

// A dry run launches no browser, so chromiumVersion cannot be part of the match.
export function selectPhaseTimingEntry(
  baseline: Baseline | null,
  componentPath: string,
  machine: { cpu: string; cores: number; os: string },
): BaselineEntry | undefined {
  if (!baseline) return undefined;
  const candidates = Object.entries(baseline.entries)
    .filter(([key]) => parseBaselineKey(key).componentPath === componentPath)
    .map(([, value]) => value)
    .filter(
      (entry) =>
        entry?.phaseTimings !== undefined &&
        entry.phaseUnits !== undefined &&
        entry.env?.cpu === machine.cpu &&
        entry.env?.cores === machine.cores &&
        entry.env?.os === machine.os,
    );
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => (Date.parse(b.savedAt ?? "") || 0) - (Date.parse(a.savedAt ?? "") || 0));
  return candidates[0];
}

// A missing file hashes as "missing", so a deleted import invalidates the fingerprint.
export function computeSourceFingerprint(
  projectRoot: string,
  files: string[],
  config: string,
): string {
  const parts = files.map((file) => {
    const abs = path.resolve(file);
    const rel = toPosix(path.relative(projectRoot, abs));
    let contentHash: string;
    try {
      contentHash = crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex");
    } catch {
      contentHash = "missing";
    }
    return rel + "\0" + contentHash;
  });
  parts.sort();
  return crypto
    .createHash("sha1")
    .update(config + "\0" + parts.join("\n"))
    .digest("hex");
}

// entries is keyed `<componentPath>#<envKey>`; a version-1 file is rekeyed on load.
export interface Baseline {
  version: 1 | 2;
  timestamp: string;
  entries: Record<string, BaselineEntry>;
}

// unstable holds the metric names whose CV disqualifies them from a regression check.
export interface BaselineMetrics {
  mount: number;
  rerender: number;
  unmount: number;
  domNodeCount: number;
  interactions: Record<string, number>;
  unstable: Set<string>;
  tier: ComponentTier;
  measuredState?: MeasuredState;
}

export interface ResolvedTolerance {
  mount: number;
  rerender: number;
  interaction: number;
  unmount: number;
}

export interface BudgetComparison {
  hasBaseline: boolean;
  regressions: BudgetRegression[];
  improvements: BudgetImprovement[];
  missingInteractions: string[];
  envMatch: EnvMatch;
  envMismatches: string[];
  // Different scenes; comparison skipped, because a skeleton is not a regression.
  measuredStateMismatch?: { baseline: MeasuredState; current: MeasuredState };
  // Another environment's slot; such a comparison never fails a run.
  crossEnvironment?: boolean;
  // The machine was too busy to compare against. No verdicts were drawn.
  skippedNoisy?: boolean;
}

export interface BudgetRegression {
  metric: string;
  baseline: number;
  current: number;
  deltaPercent: number;
  tolerance: number;
  normalized?: NormalizedDelta;
}

export interface BudgetImprovement {
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
  framework?: "react" | "vue" | "vanilla";
}

export const UNKNOWN_ENV_WARNING =
  "Baseline has no environment record; comparing raw timings. Re-save with --save-baseline to enable environment checks.";

export const MISSING_CALIBRATION_NOTE =
  "calibration total duration missing; compared raw milliseconds";

// Normalizing divides by a small number, so sub-resolution movement can cross a tolerance.
export const NORMALIZED_FLOOR_MS = 0.5;

const CALIBRATION_DRIFT_BAND = 0.1;

const DEFAULT_TOLERANCE: ResolvedTolerance = {
  mount: 10,
  rerender: 15,
  interaction: 15,
  unmount: 20,
};

// The numeric fields shared by `defaults`, each `components[...]` entry, and `tolerance`.
const NUMERIC_BUDGET_FIELDS = ["mount", "rerender", "interaction", "unmount"] as const;

// Strings are quoted so "5" is distinguishable from 5 in the error message.
function describeConfigValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `${JSON.stringify(value)} (array)`;
  const kind = typeof value;
  if (kind === "string") return `${JSON.stringify(value)} (string)`;
  if (kind === "number" || kind === "boolean") return `${String(value)} (${kind})`;
  return `${JSON.stringify(value)} (object)`;
}

function checkBudgetNumber(configPath: string, keyPath: string, value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return;
  throw new Error(
    `Invalid ${configPath}: ${keyPath} must be a finite number >= 0, received ${describeConfigValue(value)}`,
  );
}

// Unknown keys pass: forward compatibility with fields a newer 120fps understands.
export function validateBudgetConfig(configPath: string, config: unknown): asserts config is BudgetConfig {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(
      `Invalid ${configPath}: config must be a JSON object, received ${describeConfigValue(config)}`,
    );
  }
  const parsed = config as BudgetConfig;

  if (parsed.defaults) {
    for (const field of NUMERIC_BUDGET_FIELDS) {
      checkBudgetNumber(configPath, `defaults.${field}`, (parsed.defaults as Record<string, unknown>)[field]);
    }
  }
  if (parsed.tolerance) {
    for (const field of NUMERIC_BUDGET_FIELDS) {
      checkBudgetNumber(configPath, `tolerance.${field}`, (parsed.tolerance as Record<string, unknown>)[field]);
    }
  }
  if (parsed.components) {
    for (const [key, budget] of Object.entries(parsed.components)) {
      if (!budget || typeof budget !== "object") continue;
      for (const field of NUMERIC_BUDGET_FIELDS) {
        checkBudgetNumber(configPath, `${JSON.stringify(key)}.${field}`, (budget as Record<string, unknown>)[field]);
      }
    }
  }
}

// The nearer config wins: a member's own file overrides the workspace root's.
export function loadBudgetConfig(projectRoot: string): BudgetConfig | null {
  for (const root of new Set([projectRoot, findWorkspaceRoot(projectRoot)])) {
    const configPath = path.join(root, "120fps.config.json");
    let config: unknown;
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      config = JSON.parse(raw);
    } catch (err: any) {
      if (err.code === "ENOENT") continue;
      throw new Error(`Failed to load 120fps.config.json: ${err.message}`);
    }
    validateBudgetConfig(configPath, config);
    return config as BudgetConfig;
  }
  return null;
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
    interactionStepMs: tierBudget.interactionStepMs,
  };
}

// Bumped whenever a measurement changes meaning, never when a value merely moves.
export const METRICS_REVISION = 4;

// Absent means an older baseline: domNodeCount counted the whole document.
export function metricsRevision(env: EnvFingerprint): number {
  return typeof env.metrics === "number" ? env.metrics : 1;
}

export function buildEnvFingerprint(input: EnvFingerprintInput): EnvFingerprint {
  return {
    shape: 1,
    metrics: METRICS_REVISION,
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
    // React is the absence of the field; writing it would make stored entries incomparable.
    ...(input.framework && input.framework !== "react" ? { framework: input.framework } : {}),
  };
}

function frameworkLabel(env: EnvFingerprint): string {
  return env.framework ?? "react";
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
    // A revision change moves tier boundaries; comparing across it reads as an improvement.
    metricsRevision(a) !== metricsRevision(b) ||
    a.mode !== b.mode ||
    !sameCssList(a.css, b.css) ||
    a.wrapper !== b.wrapper ||
    a.reactCompiler !== b.reactCompiler ||
    // A different renderer measured a different thing entirely.
    frameworkLabel(a) !== frameworkLabel(b)
  );
}

function calibrationClose(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return a === b;
  return Math.abs(a - b) <= CALIBRATION_DRIFT_BAND * Math.max(a, b);
}

// Excludes calibration: one sample swings 20–40%, which would make reuse a lottery.
export function sameMachineIdentity(
  baseline: EnvFingerprint | undefined,
  current: EnvFingerprint,
): boolean {
  if (!baseline) return false;
  if (featuresDiffer(baseline, current)) return false;
  return (
    baseline.cpu === current.cpu &&
    baseline.cores === current.cores &&
    baseline.os === current.os &&
    baseline.chromiumVersion === current.chromiumVersion &&
    baseline.cpuThrottle === current.cpuThrottle &&
    baseline.samples === current.samples
  );
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

// nodeVersion is excluded so an `identical` pair never produces mismatch text.
export function describeEnvDiff(
  baseline: EnvFingerprint | undefined,
  current: EnvFingerprint,
): string[] {
  if (!baseline) return ["baseline has no environment record"];

  const diffs: string[] = [];
  if (metricsRevision(baseline) !== metricsRevision(current)) {
    diffs.push(
      `measurement revision: baseline ${metricsRevision(baseline)}, current ${metricsRevision(current)} ` +
      `(re-save the baseline; DOM node counts and tiers changed meaning)`,
    );
  }
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
  if (frameworkLabel(baseline) !== frameworkLabel(current)) {
    diffs.push(`framework: baseline ${frameworkLabel(baseline)}, current ${frameworkLabel(current)}`);
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
  current: {
    mount: number;
    rerender: number;
    unmount: number;
    interactions: Record<string, number>;
    measuredState?: MeasuredState;
  },
  tolerance: ResolvedTolerance,
  unstableMetrics?: Set<string>,
  currentEnv?: EnvFingerprint,
): BudgetComparison {
  const envMatch = currentEnv ? classifyEnv(entry.env, currentEnv) : "unknown";
  const envMismatches = currentEnv ? describeEnvDiff(entry.env, currentEnv) : [];

  // Both sides must have recorded a scene for a change to be observable.
  if (
    entry.measuredState !== undefined &&
    current.measuredState !== undefined &&
    entry.measuredState !== current.measuredState
  ) {
    return {
      hasBaseline: true,
      regressions: [],
      improvements: [],
      missingInteractions: [],
      envMatch,
      envMismatches,
      measuredStateMismatch: { baseline: entry.measuredState, current: current.measuredState },
    };
  }

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

  const regressions: BudgetRegression[] = [];
  const improvements: BudgetImprovement[] = [];

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
