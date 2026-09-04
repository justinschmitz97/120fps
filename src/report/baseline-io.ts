import crypto from "node:crypto";
import fs from "node:fs";
import type { EnvFingerprint } from "./types.js";
import { metricsRevision, type Baseline, type BaselineEntry } from "./budget.js";

// One committed baseline meets many machines. Rather than classifying the
// resulting mismatch after the fact, entries get a slot per environment
// so the mismatch mostly stops happening.
//
// Composite keys rather than a nested object: the map stays
// `Record<string, BaselineEntry>`, sorted keys still group by component, and a
// text merge of two branches touching different components still succeeds.
export const BASELINE_VERSION = 2;
export const LEGACY_ENV_KEY = "legacy";
const BASELINE_KEY_SEPARATOR = "#";

// Slots are indexed by machine identity, not by measurement conditions.
// Calibration is excluded: a single sample swings 20–40%, so gating on it
// would fragment slots by thermal luck. Chromium is keyed by major
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
    // Appended only when it is not React, so every slot written before this
    // field existed keeps the key it was written under.
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
    // A slot with no timestamp predates this field and is kept: absence is not age.
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

