import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { findWorkspaceRoot } from "./project-model.js";
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
  // M39: identity of the sources this entry measured, and the verdict of the
  // run that saved it: together they let an unchanged component reuse the
  // entry instead of re-measuring.
  sourceFingerprint?: string;
  pass?: boolean;
  // M40: the scene the entry measured. Absent on pre-M40 baselines, which
  // recorded no scene at all: an unknown state is not a changed state.
  measuredState?: MeasuredState;
  // M45: when this slot was last written, for pruning. Absent means pre-M45,
  // which is kept: absence is not age.
  savedAt?: string;
}

// M39: order-independent identity over file contents plus a config string.
// Missing files hash as missing: absence is part of the identity, not an
// error, so a deleted import invalidates the fingerprint like an edit does.
export function computeSourceFingerprint(
  projectRoot: string,
  files: string[],
  config: string,
): string {
  const parts = files.map((file) => {
    const abs = path.resolve(file);
    const rel = path.relative(projectRoot, abs).replace(/\\/g, "/");
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

// Keys are `<componentPath>#<envKey>` (M45). A version-1 file's plain component
// keys are rekeyed on load, so readers only ever see slots.
export interface Baseline {
  version: 1 | 2;
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
  measuredState?: MeasuredState;
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
  // M40: set when baseline and current run measured different scenes. The
  // comparison is skipped: a skeleton against settled content is a different
  // component, not a regression.
  measuredStateMismatch?: { baseline: MeasuredState; current: MeasuredState };
  // M45: the entry came from another environment's slot. Informational: such a
  // comparison never fails a run.
  crossEnvironment?: boolean;
  // M46: the machine was too busy to compare against. No verdicts were drawn.
  skippedNoisy?: boolean;
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
  framework?: "react" | "vue" | "vanilla";
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

// Fields resolveComponentBudget/resolveTolerances read as budget numbers:
// shared by `defaults`, each `components[...]` entry, and `tolerance`.
const NUMERIC_BUDGET_FIELDS = ["mount", "rerender", "interaction", "unmount"] as const;

// Renders a parsed JSON value for an error message: quoted for strings so
// "5" is distinguishable from 5, typed for numbers/booleans, untyped for
// null since JSON null has no ambiguous typeof to report.
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

// Malformed-but-parseable values (mount: "fast", negative numbers, null)
// would otherwise silently reach resolveComponentBudget/resolveTolerances and
// produce nonsense budgets. Unknown keys are left untouched: forward compat
// for fields a newer version of 120fps understands.
function validateBudgetConfig(configPath: string, config: unknown): asserts config is BudgetConfig {
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

// M68. A monorepo keeps one committed policy at the workspace root; a member
// that has its own config still wins, because the nearer file is the more
// specific statement.
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

// M45. One committed baseline meets many machines. Rather than classifying the
// resulting mismatch after the fact (M29), entries get a slot per environment
// so the mismatch mostly stops happening.
//
// Composite keys rather than a nested object: the map stays
// `Record<string, BaselineEntry>`, sorted keys still group by component, and a
// text merge of two branches touching different components still succeeds.
export const BASELINE_VERSION = 2;
export const LEGACY_ENV_KEY = "legacy";
const BASELINE_KEY_SEPARATOR = "#";

// Slots are indexed by machine identity, not by measurement conditions.
// Calibration is excluded on M39's evidence: a single sample swings 20–40%, so
// gating on it would fragment slots by thermal luck. Chromium is keyed by major
// version only: patch bumps land weekly and have not been shown to move timing.
export function computeEnvKey(env: EnvFingerprint | undefined): string {
  if (!env) return LEGACY_ENV_KEY;
  const identity = [
    metricsRevision(env),
    env.cpu,
    env.cores,
    env.os,
    String(env.chromiumVersion ?? "").split(".")[0],
    env.cpuThrottle,
    env.samples,
    env.mode,
    (env.css ?? []).join(","),
    env.wrapper ?? "",
    env.reactCompiler ? "1" : "0",
    // Appended only when it is not React, so every slot written before M57
    // keeps the key it was written under.
    ...(env.framework ? [env.framework] : []),
  ].join("\0");
  return crypto.createHash("sha1").update(identity).digest("hex").slice(0, 8);
}

export function baselineKey(componentPath: string, envKey: string): string {
  return `${componentPath}${BASELINE_KEY_SEPARATOR}${envKey}`;
}

export function parseBaselineKey(key: string): { componentPath: string; envKey: string } {
  const at = key.lastIndexOf(BASELINE_KEY_SEPARATOR);
  if (at === -1) return { componentPath: key, envKey: LEGACY_ENV_KEY };
  return { componentPath: key.slice(0, at), envKey: key.slice(at + 1) };
}

// A version-1 file is rekeyed in memory, so every reader sees slots and only
// `saveBaseline` ever writes the new shape.
function migrateEntries(parsed: Baseline): Record<string, BaselineEntry> {
  const entries: Record<string, BaselineEntry> = {};
  for (const [key, entry] of Object.entries(parsed.entries ?? {})) {
    if (key.includes(BASELINE_KEY_SEPARATOR)) {
      entries[key] = entry;
      continue;
    }
    entries[baselineKey(key, computeEnvKey(entry?.env))] = entry;
  }
  return entries;
}

export function loadBaseline(baselinePath: string): Baseline | null {
  try {
    const raw = fs.readFileSync(baselinePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.version !== 1 && parsed.version !== BASELINE_VERSION) {
      process.stderr.write(
        `Warning: ${baselinePath} has unsupported baseline version, ignoring ` +
        `(expected 1 or ${BASELINE_VERSION}, got ${JSON.stringify(parsed.version)})\n`,
      );
      return null;
    }
    return {
      version: BASELINE_VERSION,
      timestamp: parsed.timestamp,
      entries: migrateEntries(parsed as Baseline),
    };
  } catch (err: any) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Machines get replaced; baselines must not accrete their ghosts forever.
export const BASELINE_SLOT_TTL_DAYS = 90;

export const PRUNED_SLOTS_NOTICE = (keys: string[]): string =>
  `Pruned ${keys.length} baseline ${keys.length === 1 ? "slot" : "slots"} not updated in ` +
  `${BASELINE_SLOT_TTL_DAYS} days: ${keys.join(", ")}.`;

export function saveBaseline(
  baselinePath: string,
  entry: BaselineEntry,
  componentPath: string,
  now: Date = new Date(),
): { key: string; pruned: string[] } {
  const existing = (() => {
    try {
      return loadBaseline(baselinePath);
    } catch {
      // Unreadable or unparseable: start fresh rather than lose the run.
      return null;
    }
  })();

  const entries: Record<string, BaselineEntry> = { ...(existing?.entries ?? {}) };
  const key = baselineKey(componentPath, computeEnvKey(entry.env));
  entries[key] = { ...entry, savedAt: now.toISOString() };

  const cutoff = now.getTime() - BASELINE_SLOT_TTL_DAYS * 24 * 60 * 60 * 1000;
  const pruned: string[] = [];
  for (const [candidate, value] of Object.entries(entries)) {
    if (candidate === key) continue;
    const savedAt = value?.savedAt ? Date.parse(value.savedAt) : NaN;
    // A slot with no timestamp predates M45 and is kept: absence is not age.
    if (Number.isFinite(savedAt) && savedAt < cutoff) {
      delete entries[candidate];
      pruned.push(candidate);
    }
  }

  // Key-sorted so two branches touching different components merge textually.
  const sorted: Record<string, BaselineEntry> = {};
  for (const name of Object.keys(entries).sort()) sorted[name] = entries[name];

  const baseline: Baseline = {
    version: BASELINE_VERSION,
    timestamp: now.toISOString(),
    entries: sorted,
  };

  fs.writeFileSync(baselinePath, JSON.stringify(baseline, null, 2), "utf-8");
  return { key, pruned };
}

export const NO_ENV_BASELINE_WARNING = (componentPath: string): string =>
  `No baseline for this environment. Run --save-baseline here to record one for ${componentPath}; ` +
  "the comparison below is against another machine's slot and is informational only.";

export interface BaselineSelection {
  entry: BaselineEntry;
  // True when no slot matched this environment and another machine's slot was
  // used instead. Such a comparison informs; it never fails a run.
  crossEnvironment: boolean;
}

// Exact slot first. Otherwise the most recently saved slot for the component,
// so the fallback is at least the freshest thing available.
export function selectBaselineEntry(
  baseline: Baseline | null,
  componentPath: string,
  envKey: string,
): BaselineSelection | undefined {
  if (!baseline) return undefined;

  const exact = baseline.entries[baselineKey(componentPath, envKey)];
  if (exact) return { entry: exact, crossEnvironment: false };

  const candidates = Object.entries(baseline.entries)
    .filter(([key]) => parseBaselineKey(key).componentPath === componentPath)
    .map(([, value]) => value);
  if (candidates.length === 0) return undefined;

  candidates.sort((a, b) => (Date.parse(b.savedAt ?? "") || 0) - (Date.parse(a.savedAt ?? "") || 0));
  return { entry: candidates[0], crossEnvironment: true };
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

// Bumped whenever a measurement changes meaning rather than value. Distinct
// from `shape`, which versions which fields exist and must stay comparable.
// 3: M34 removed ~30ms of throttled idle (GC, DOM reads) before each traced
// window; mount/unmount medians read up to ~6% higher than revision 2.
// 4: M35 drives frames instead of waiting for vsync; the narrower traced
// windows carry less ambient frame work (interleaved A/B: mount ×1.03,
// rerender ×1.00, unmount ×0.74).
export const METRICS_REVISION = 4;

// Absent means pre-M31: domNodeCount counted the whole document.
function metricsRevision(env: EnvFingerprint): number {
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
    // React is the absence of the field, which is what a pre-M57 baseline
    // records: writing it would make every stored entry incomparable.
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
    // M31 rescoped domNodeCount to component DOM, which moves tier boundaries.
    // Comparing across the change would read as a large improvement.
    metricsRevision(a) !== metricsRevision(b) ||
    a.mode !== b.mode ||
    !sameCssList(a.css, b.css) ||
    a.wrapper !== b.wrapper ||
    a.reactCompiler !== b.reactCompiler ||
    // M57: a different renderer measured a different thing entirely.
    frameworkLabel(a) !== frameworkLabel(b)
  );
}

function calibrationClose(a: number, b: number): boolean {
  if (!(a > 0) || !(b > 0)) return a === b;
  return Math.abs(a - b) <= CALIBRATION_DRIFT_BAND * Math.max(a, b);
}

// M39: the reuse gate needs machine identity, not thermal identity. A single
// calibration sample swings 20–40% on a real machine (measured 41.7 vs 57.3
// within one sweep), so requiring calibrationClose made reuse a lottery:
// and drift changes measured values, never the verdict of unchanged code.
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

// Field-level differences behind a classification. nodeVersion is excluded so an
// `identical` pair never produces mismatch text.
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
): BaselineComparison {
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
