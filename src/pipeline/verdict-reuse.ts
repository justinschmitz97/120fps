import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { resolveReactCompilerState } from "../harness/index.js";
import { findWorkspaceRoot } from "../project/index.js";
import { type BrowserPool } from "../browser/index.js";
import {
  loadBaseline,
  buildEnvFingerprint,
  parseBaselineKey,
  sameMachineIdentity,
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

// M39/M54: the option-only half of the verdict-reuse gate. The rest of it needs
// the baseline file, the source fingerprint, and a machine probe.
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
    // An explicit *enable* changes what gets measured beyond anything the
    // fingerprint records, so it always measures. An explicit *disable* does
    // not: the mode it resolves to is `combo`, which the stored env already
    // carries, so the run reproduces exactly the distribution the slot holds.
    modeDisabledOrAbsent(options.curveMode) &&
    modeDisabledOrAbsent(options.matrixMode) &&
    // "ignore" explicitly requests a raw comparison and "strict" a hard
    // verification of a real run: both must measure.
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

// M39: identical source in an identical environment redraws the same
// distribution, so a check-mode run may reuse the stored verdict instead of
// measuring. Explicit mode enables always measure: auto-activation is a
// function of the fingerprinted source, flags are not. Returns the reused
// report, or undefined when the run must measure.
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

  // M45: only this environment's own slot can carry a reusable verdict.
  // A cross-machine slot is informational and must never short-circuit a run.
  const baselineFile = loadBaseline(path.join(projectRoot, "120fps-baseline.json"));
  const slots = Object.entries(baselineFile?.entries ?? {}).filter(
    ([key]) => parseBaselineKey(key).componentPath === args.relativeComponent,
  );
  const entry = slots.map(([, value]) => value).find((candidate) => candidate?.env);
  if (!entry?.sourceFingerprint || entry.pass === undefined || !entry.env) return undefined;

  const fingerprint = await args.getSourceFingerprint();
  if (fingerprint !== entry.sourceFingerprint) return undefined;

  // Machine identity only: no page, no calibration. A single calibration
  // sample swings 20–40% on a real machine, and thermal drift changes
  // measured values, never the verdict of unchanged code
  // (sameMachineIdentity). Features are the current run's real ones, so a
  // hand-edited or drifted env record breaks reuse.
  const browser = await args.pool.acquire(true);
  const machine = await collectMachineInfo(browser.version());
  const probeEnv = buildEnvFingerprint({
    machine,
    calibration: { totalDuration: 0, scriptDuration: 0 },
    cpuThrottle: args.cpuThrottle,
    // The requested count: combos are not extracted yet, so the effective one
    // is unknown here. A stored entry that was throttled therefore fails the
    // gate and the run measures: reuse errs towards measuring, never towards
    // a mismatched verdict.
    samples: args.samples,
    mode: "combo",
    framework: args.framework,
    // M82: cssReport is now always constructed, even for "none" — gate on
    // files.length so a no-CSS project's fingerprint bytes stay unchanged.
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
  // M40: a reused verdict repeats the disclosure that came with it.
  if (entry.measuredState && entry.measuredState !== "settled") {
    report.warnings = [MEASURED_STATE_WARNING(entry.measuredState)];
  }
  writeReportJson(report, options.jsonPath);
  return report;
}

// Tooling configs and lockfiles belong to the identity of a cached verdict. In
// a workspace they sit at the root the member never mentions, so a root
// lockfile bump used to leave every member's baseline valid. Member level
// first: a name found there is the one that applies.
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
  projectRoot: string,
  componentDir: string,
): string | undefined {
  if (componentDir === projectRoot) return undefined;
  if (!fs.existsSync(path.join(componentDir, "120fps-baseline.json"))) return undefined;
  return (
    `no baseline entry found at ${path.join(projectRoot, "120fps-baseline.json")}, ` +
    `but a legacy 120fps-baseline.json exists next to the component in ${componentDir}. ` +
    `Baselines now live at the package root: re-run with --save-baseline to migrate.`
  );
}
