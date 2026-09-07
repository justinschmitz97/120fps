import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { resolveReactCompilerState } from "../project/index.js";
import { findWorkspaceRoot } from "../project/index.js";
import { type BrowserPool } from "../browser/index.js";
import {
  loadBaseline,
  buildEnvFingerprint,
  parseBaselineKey,
  resolveBaselinePath,
  sameMachineIdentity,
  sanitizeStoredWarnings,
  BASELINE_FILE_NAME,
  type MachineInfo,
  type Report,
  type Thresholds,
  type CssReport,
} from "../report/index.js";
import { type AnalyzeOptions, writeReportJson } from "./analyze.js";
import { MEASURED_STATE_WARNING } from "./build-report.js";
import { detectComponentName } from "./modes/context.js";
import { toPosix } from "../shared/index.js";

function modeDisabledOrAbsent(mode: AnalyzeOptions["curveMode"]): boolean {
  return mode === undefined || mode === false;
}

// The option-only half of the gate; the rest needs the baseline, fingerprint and machine probe.
export function optionsAllowVerdictReuse(
  options: Pick<
    AnalyzeOptions,
    | "check"
    | "noCache"
    | "noBaseline"
    | "saveBaseline"
    | "isolation"
    | "curveMode"
    | "matrixMode"
    | "baselineEnv"
  >,
): boolean {
  return (
    !!options.check &&
    !options.noCache &&
    !options.noBaseline &&
    !options.saveBaseline &&
    !options.isolation &&
    // An explicit enable measures beyond what the fingerprint records; a disable resolves to combo.
    modeDisabledOrAbsent(options.curveMode) &&
    modeDisabledOrAbsent(options.matrixMode) &&
    // "ignore" requests a raw comparison and "strict" a hard verification: both must measure.
    (options.baselineEnv ?? "normalize") === "normalize"
  );
}

export async function collectMachineInfo(
  chromiumVersion: string,
): Promise<MachineInfo> {
  const cpus = os.cpus();
  return {
    cpu: cpus.length > 0 ? cpus[0].model : "unknown",
    cores: cpus.length,
    ramMb: Math.round(os.totalmem() / (1024 * 1024)),
    os: `${os.type()} ${os.release()}`,
    nodeVersion: process.version,
    chromiumVersion,
  };
}

// The mode the reuse probe can describe before any combo is extracted.
const REUSE_PROBE_MODE = "combo";

// EnvFingerprint.mode's own vocabulary; a baseline file is editable, so the value is checked.
const KNOWN_BASELINE_MODES: ReadonlySet<string> = new Set([
  "combo",
  "curve",
  "matrix",
  "isolation",
]);

export function describeStoredMode(mode: unknown): string {
  return typeof mode === "string" && KNOWN_BASELINE_MODES.has(mode)
    ? `${mode} mode`
    : "an unknown mode";
}

export const BASELINE_MODE_MISMATCH_NOTICE = (stored: unknown, current: string): string =>
  `no verdict was reused: the stored baseline entry was recorded in ${describeStoredMode(stored)} ` +
  `and this run's reuse check runs in ${current} mode, so the component is measured again.`;

// Safe because identical source in an identical environment redraws the same distribution.
export async function tryReuseStoredVerdict(args: {
  options: AnalyzeOptions;
  pool: BrowserPool;
  projectRoot: string;
  relativeComponent: string;
  componentPath: string;
  metadataPath: string;
  thresholds: Thresholds;
  samples: number;
  cpuThrottle: number;
  cssReport?: CssReport;
  wrapPath?: string;
  framework: "react" | "vue" | "vanilla";
  getSourceFingerprint: () => Promise<string>;
}): Promise<Report | undefined> {
  const { options, projectRoot } = args;
  if (!optionsAllowVerdictReuse(options)) return undefined;

  // Only this environment's own slot may short-circuit; a cross-machine slot is informational.
  const baselineFile = loadBaseline(resolveBaselinePath(projectRoot, options.baselineFile));
  const slots = Object.entries(baselineFile?.entries ?? {}).filter(
    ([key]) => parseBaselineKey(key).componentPath === args.relativeComponent,
  );
  const entry = slots.map(([, value]) => value).find((candidate) => candidate?.env);
  if (!entry?.sourceFingerprint || entry.pass === undefined || !entry.env) return undefined;

  const fingerprint = await args.getSourceFingerprint();
  if (fingerprint !== entry.sourceFingerprint) return undefined;

  // The probe below is built in combo mode because no combo has been extracted yet; an entry
  // recorded in another mode can never match it, and the reader is told so instead of guessing.
  if (entry.env.mode !== REUSE_PROBE_MODE) {
    process.stderr.write(
      `Warning: ${BASELINE_MODE_MISMATCH_NOTICE(entry.env.mode, REUSE_PROBE_MODE)}\n`,
    );
    return undefined;
  }

  // Identity only: one calibration sample swings 20-40%, and drift changes values, not verdicts.
  const browser = await args.pool.acquire(true);
  const machine = await collectMachineInfo(browser.version());
  const probeEnv = buildEnvFingerprint({
    machine,
    calibration: { totalDuration: 0, scriptDuration: 0 },
    cpuThrottle: args.cpuThrottle,
    // Requested, not effective: combos are unextracted, so a throttled entry fails the gate.
    samples: args.samples,
    mode: REUSE_PROBE_MODE,
    framework: args.framework,
    // cssReport exists even for "none"; gate on files.length to keep a no-CSS fingerprint stable.
    ...(args.cssReport && args.cssReport.files.length > 0 ? { css: args.cssReport.files } : {}),
    ...(args.wrapPath
      ? { wrapper: toPosix(path.relative(projectRoot, args.wrapPath)) }
      : {}),
    ...(resolveReactCompilerState(projectRoot, options.reactCompiler).active
      ? { reactCompiler: true }
      : {}),
  });
  if (!sameMachineIdentity(entry.env, probeEnv)) return undefined;

  const report: Report = {
    version: 1,
    timestamp: new Date().toISOString(),
    machine,
    componentPath: args.componentPath,
    componentName: detectComponentName(args.metadataPath, args.options.target),
    // The calibration of the run whose verdict is being reused.
    calibration: {
      totalDuration: entry.env.calibrationTotalDuration,
      scriptDuration: entry.env.calibrationScriptDuration,
    },
    combos: [],
    thresholds: args.thresholds,
    pass: entry.pass,
    cached: true,
    baseline: {
      hasBaseline: true,
      regressions: [],
      improvements: [],
      missingInteractions: [],
      envMatch: "identical",
      envMismatches: [],
    },
  };
  // A reused verdict repeats every disclosure that came with it, so caching loses none.
  // Baseline files are user-editable JSON: the stored list is capped and stripped of controls.
  const stored = sanitizeStoredWarnings(entry.warnings);
  if (stored.length > 0) {
    report.warnings = [...stored];
  } else if (entry.measuredState && entry.measuredState !== "settled") {
    // An entry saved before warnings were stored still discloses the scene it measured.
    report.warnings = [MEASURED_STATE_WARNING(entry.measuredState)];
  }
  writeReportJson(report, options.jsonPath);
  return report;
}

// Tooling configs and lockfiles belong to the identity of a cached verdict.
const PROJECT_CONFIG_FINGERPRINT_FILES = [
  "tailwind.config.js",
  "tailwind.config.ts",
  "tailwind.config.mjs",
  "postcss.config.js",
  "postcss.config.mjs",
  "postcss.config.cjs",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
];

export function projectConfigFingerprintFiles(
  memberRoot: string,
  workspaceRoot: string = findWorkspaceRoot(memberRoot),
): string[] {
  // Member root first: a root lockfile bump must not invalidate every member's baseline at once.
  const roots = [...new Set([memberRoot, workspaceRoot])];
  const found: string[] = [];
  for (const name of PROJECT_CONFIG_FINGERPRINT_FILES) {
    for (const root of roots) {
      const candidate = path.join(root, name);
      if (fs.existsSync(candidate)) {
        found.push(candidate);
        break;
      }
    }
  }
  return found;
}

export function legacyBaselineWarning(
  baselinePath: string,
  projectRoot: string,
  componentDir: string,
): string | undefined {
  if (componentDir === projectRoot) return undefined;
  if (!fs.existsSync(path.join(componentDir, BASELINE_FILE_NAME))) return undefined;
  return (
    `no baseline entry found at ${baselinePath}, ` +
    `but a legacy ${BASELINE_FILE_NAME} exists next to the component in ${componentDir}. ` +
    `Baselines now live at the package root: re-run with --save-baseline to migrate.`
  );
}
