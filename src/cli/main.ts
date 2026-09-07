#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { analyze, explainProps, formatExplainProps, resolveProjectPaths } from "../pipeline/index.js";
import { compareAgainstRef, formatCompare, validateCompareOptions } from "../analysis/index.js";
import { formatMarkdown, formatJUnit, formatTable, formatPhaseBreakdown, resolveBaselinePath, BASELINE_FILE_SPANS_PROJECTS_ERROR } from "../report/index.js";
import type { PhaseTimings } from "../report/index.js";
import { createBrowserPool } from "../browser/index.js";
import { createServerPool, refreshHarnessDirMarkers } from "../harness/index.js";
import { formatResolvedRoots, resolveProjectModel, setPreflightBypassed } from "../project/index.js";
import { filterProjectModuleTypeWarnings } from "./node-warnings.js";
import { captureThirdPartyErrors, thirdPartyOutputNotice } from "./third-party-output.js";
import {
  CliArgs,
  parseArgs,
  resolveCurveOption,
  resolveMatrixOption,
  resolveReactCompilerFlag,
  resolveIsolationOption,
} from "./args.js";
import {
  formatCliError,
  wrapperNotFoundMessage,
  stylesheetNotFoundMessage,
  pushCurrentRunWarning,
  currentRunWarningList,
  resolveFatalProcessError,
  nodeVersionError,
  setCurrentRunProjectRoot,
  resetCurrentRunWarnings,
} from "./errors.js";
import {
  armExitWatchdog,
  closePoolsBounded,
  createRunWatchdog,
  watchdogAbortOutput,
  abortRun,
  setActivePools,
  harnessLeftoverDirs,
  registerTerminationHandlers,
} from "./lifecycle.js";
import { expandComponentPaths, nodePathReader, resolveReportPaths, formatJsonSplitNotice } from "./paths.js";
import { gitignoreTipPatterns, formatGitignoreTip } from "./gitignore.js";
import { findGitRoot, toPosix } from "../shared/index.js";
import { printHelp } from "./help.js";

// Bounds a hang inside analyze() itself; the exit watchdog only bounds teardown after it.
export const RUN_WATCHDOG_MARGIN_MS = 10 * 60_000;
export const RUN_WATCHDOG_MIN_MS = 20 * 60_000;
export const DEFAULT_EXPLORE_BUDGET_SECONDS = 300;

export function runWatchdogBudgetMs(exploreBudgetSeconds?: number): number {
  const explore = (exploreBudgetSeconds ?? DEFAULT_EXPLORE_BUDGET_SECONDS) * 1000;
  return Math.max(explore + RUN_WATCHDOG_MARGIN_MS, RUN_WATCHDOG_MIN_MS);
}

// Each branch rounds once, to the unit it prints; rounding after the split can print 2m 60s.
export function formatWallClock(elapsedMs: number): string {
  const tenthsOfSecond = Math.round(elapsedMs / 100);
  if (tenthsOfSecond < 600) return `Total: ${(tenthsOfSecond / 10).toFixed(1)}s`;
  const wholeSeconds = Math.round(elapsedMs / 1000);
  const minutes = Math.floor(wholeSeconds / 60);
  return `Total: ${minutes}m ${wholeSeconds - minutes * 60}s`;
}

export function formatTotalLine(
  elapsedMs: number,
  timings: PhaseTimings | undefined,
): string {
  return formatWallClock(elapsedMs) + formatPhaseBreakdown(timings);
}

// Absolute roots, so the line reads the same from every shell directory.
export function resolvedRootsLine(componentPath: string): string {
  const model = resolveProjectModel(path.dirname(path.resolve(componentPath)));
  return formatResolvedRoots(model.memberRoot, model.workspaceRoot);
}

// --ci stdout is machine-read: this line is for a human reader or absent.
export function resolvedRootsOutput(componentPath: string, ci: boolean): string {
  return ci ? "" : resolvedRootsLine(componentPath) + "\n";
}

// The dry run predicts the real run, so a flag it drops silently would mispredict it.
export function explainPropsOptions(
  args: CliArgs,
  componentPath: string,
): {
  target?: string;
  noPreflight?: boolean;
  framework?: "react" | "vue" | "vanilla" | "auto";
  curveMode?: ReturnType<typeof resolveCurveOption>;
  matrixMode?: ReturnType<typeof resolveMatrixOption>;
  isolation?: ReturnType<typeof resolveIsolationOption>;
  fixturePath?: string;
  skipAutoCompose?: boolean;
  noTransforms?: boolean;
  noShims?: boolean;
  samples?: number;
  maxCombos?: number;
  cssFiles?: string[];
  noCss?: boolean;
  baselineFile?: string;
} {
  // Resolved with the functions runOne uses, so the two paths cannot disagree about a flag.
  const curveMode = resolveCurveOption(args);
  const matrixMode = resolveMatrixOption(args);
  const isolation = resolveIsolationOption(args);
  return {
    ...(args.targets?.[componentPath] ? { target: args.targets[componentPath] } : {}),
    ...(args.noPreflight ? { noPreflight: true } : {}),
    ...(args.framework ? { framework: args.framework } : {}),
    ...(curveMode !== undefined ? { curveMode } : {}),
    ...(matrixMode !== undefined ? { matrixMode } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(args.fixturePath ? { fixturePath: args.fixturePath } : {}),
    // Without these, the dry run predicts an auto-composed scene the real run does not build.
    ...(args.noAutoCompose ? { skipAutoCompose: true } : {}),
    ...(args.noTransforms ? { noTransforms: true } : {}),
    // noShims changes the alias set the external-dependency scan resolves against.
    ...(args.noShims ? { noShims: true } : {}),
    // The estimate is priced against the command line the user typed, not the defaults.
    ...(args.samples !== undefined ? { samples: args.samples } : {}),
    ...(args.maxCombos !== undefined ? { maxCombos: args.maxCombos } : {}),
    // The stylesheet the dry run reports is the one the real run would inject.
    ...(args.css ? { cssFiles: args.css } : {}),
    ...(args.noCss ? { noCss: true } : {}),
    // The estimate reads phase timings from the same file --check would read.
    ...(args.baselineFile ? { baselineFile: args.baselineFile } : {}),
  };
}

// Resolved from the running file, so a global install and a workspace checkout both answer it.
function ownInstallRoot(): string {
  return path.resolve(import.meta.dirname ?? __dirname, "../..");
}

async function main(): Promise<void> {
  // Before parseArgs, so every project file a later step imports is already covered.
  filterProjectModuleTypeWarnings(ownInstallRoot());
  const versionError = nodeVersionError(process.version);
  if (versionError) {
    process.stderr.write(`Error: ${versionError}\n`);
    process.exit(2);
  }

  const args = parseArgs(process.argv.slice(2));
  // A remedy must not advise the flag this run already passed; set before anything can fail.
  setPreflightBypassed(args.noPreflight === true);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.version) {
    const pkg = JSON.parse(
      fs.readFileSync(
        path.resolve(import.meta.dirname ?? __dirname, "../../package.json"),
        "utf-8",
      ),
    );
    process.stdout.write(pkg.version + "\n");
    process.exit(0);
  }

  if (args.error) {
    process.stderr.write(`Error: ${args.error}\n`);
    process.exit(2);
  }

  const requested = args.componentPaths ?? [args.componentPath!];
  const expanded = expandComponentPaths(requested, nodePathReader());
  if (expanded.error) {
    process.stderr.write(`Error: ${expanded.error}\n`);
    process.exit(2);
  }
  const componentPaths = expanded.paths;
  if (componentPaths.length > 1) {
    process.stdout.write(`Measuring ${componentPaths.length} components\n`);
  }

  // Resolution only, so it runs ahead of every check that exists to protect a measurement.
  if (args.explainProps) {
    let failed = false;
    for (let idx = 0; idx < componentPaths.length; idx++) {
      const componentPath = componentPaths[idx];
      if (componentPaths.length > 1) process.stdout.write(`\n=== ${componentPath} ===\n`);
      process.stdout.write(resolvedRootsOutput(componentPath, args.ci === true));
      try {
        const explained = await explainProps(componentPath, explainPropsOptions(args, componentPath));
        process.stdout.write(formatExplainProps(explained) + "\n");
      } catch (err: unknown) {
        failed = true;
        process.stderr.write(formatCliError(err, process.env.DEBUG));
      }
    }
    process.exit(failed ? 2 : 0);
  }

  if (args.fixturePath && !fs.existsSync(path.resolve(args.fixturePath))) {
    process.stderr.write(`Error: Fixture file not found: ${args.fixturePath}\n`);
    process.exit(2);
  }

  if (args.wrapPath && !args.noWrap && !fs.existsSync(path.resolve(args.wrapPath))) {
    process.stderr.write(`Error: ${wrapperNotFoundMessage(args.wrapPath)}\n`);
    process.exit(2);
  }

  if (args.css && !args.noCss) {
    for (const cssPath of args.css) {
      if (!fs.existsSync(path.resolve(cssPath))) {
        process.stderr.write(`Error: ${stylesheetNotFoundMessage(cssPath)}\n`);
        process.exit(2);
      }
    }
  }

  // Informational mode: compare never sets a non-zero exit; budgets and baselines own CI.
  if (args.compare) {
    const invalid = validateCompareOptions({
      compare: args.compare,
      check: args.check,
      saveBaseline: args.saveBaseline,
      isolation: args.isolate,
    });
    if (invalid) {
      process.stderr.write(`Error: ${invalid}\n`);
      process.exit(2);
    }
    for (const componentPath of componentPaths) {
      try {
        const report = await compareAgainstRef(componentPath, args.compare, {
          samples: args.samples,
        });
        process.stdout.write(formatCompare(report) + "\n");
      } catch (err: unknown) {
        process.stderr.write(formatCliError(err, process.env.DEBUG));
        process.exit(2);
      }
    }
    process.exit(0);
  }

  const multi = componentPaths.length > 1;
  // One named file holds one project's entries: its keys are paths relative to a project root,
  // so two roots would write the same key. Refused before anything is measured.
  if (args.baselineFile && multi) {
    const namedRoots = [
      ...new Set(
        componentPaths.map((candidate) => resolveProjectPaths(path.resolve(candidate)).projectRoot),
      ),
    ];
    if (namedRoots.length > 1) {
      process.stderr.write(`Error: ${BASELINE_FILE_SPANS_PROJECTS_ERROR(namedRoots)}\n`);
      process.exit(2);
    }
  }
  const reportPaths = multi
    ? resolveReportPaths(componentPaths, args.jsonExplicit ? args.jsonPath : undefined)
    : [args.jsonPath];
  let anyFail = false;
  // Collected across the sweep so both formats describe the whole run.
  const ciReports: import("../report/index.js").Report[] = [];
  // Baselines and harness dirs live per project, so the gitignore sweep needs each root once.
  const projectRoots = new Set<string>();

  // Browsers are project-agnostic: one pool serves the whole sweep instead of one launch each.
  const pool = createBrowserPool();
  const serverPool = createServerPool();
  // Published as soon as both pools exist, so a signal arriving right after still reaches them.
  setActivePools({ pool, serverPool });
  for (let idx = 0; idx < componentPaths.length; idx++) {
    const componentPath = componentPaths[idx];
    if (multi && !args.ci) {
      process.stdout.write(`\n=== ${componentPath} ===\n`);
    }
    const started = Date.now();
    const componentProjectRoot = resolveProjectPaths(path.resolve(componentPath)).projectRoot;
    projectRoots.add(componentProjectRoot);
    // Set before the build a detached dep-optimizer rejection could fail on.
    setCurrentRunProjectRoot(componentProjectRoot);
    // Per component: a detached rejection on component 2 must not report component 1's warnings.
    resetCurrentRunWarnings();
    const budgetMs = runWatchdogBudgetMs(args.exploreBudgetSeconds);
    // Every run passes onPhase, so every path is bounded per phase, --ci included.
    const bound = "stalled" as const;
    // The abort owns the exit; what the dying analyze() throws must not print as a second error.
    let aborted = false;
    const runWatchdog = createRunWatchdog(budgetMs, () => {
      aborted = true;
      const out = watchdogAbortOutput(componentPath, budgetMs, bound, Date.now() - started, args.ci);
      process.stderr.write(out.stderr);
      if (out.stdout) process.stdout.write(out.stdout);
      void abortRun(2, { pool, serverPool });
    });
    // A library the build loads writes to the console; 120fps decides whether it adds anything.
    const releaseThirdPartyOutput = captureThirdPartyErrors({
      ...(process.env.DEBUG ? { debug: true } : {}),
    });
    try {
      const report = await runOne(
        componentPath,
        reportPaths[idx],
        args,
        pool,
        serverPool,
        () => {
          runWatchdog.heartbeat();
          // The build stops advancing the directory mtime; the marker is the liveness signal.
          refreshHarnessDirMarkers();
        },
      );
      const uncovered = thirdPartyOutputNotice(releaseThirdPartyOutput(), report.warnings ?? []);
      if (uncovered) process.stderr.write(`${uncovered}
`);
      if (!args.ci) {
        process.stdout.write(resolvedRootsOutput(componentPath, false));
        process.stdout.write(formatTable(report) + "\n");
        // --ci owns stdout for JSON and reads phaseTimings from the report instead.
        process.stdout.write(
          formatTotalLine(Date.now() - started, report.phaseTimings) + "\n",
        );
      }
      // Every finished Report, --ci or not: the artifact describes the run, not the terminal.
      ciReports.push(report);
      if (!report.pass) anyFail = true;
    } catch (err: unknown) {
      // The abort already printed and owns the exit; returning avoids a second error.
      if (aborted) return;
      const uncovered = thirdPartyOutputNotice(releaseThirdPartyOutput(), currentRunWarningList());
      if (uncovered) process.stderr.write(`${uncovered}
`);
      if (!multi) {
        process.stderr.write(formatCliError(err, process.env.DEBUG));
        // Bounded teardown first: a bare process.exit(2) would skip every pending finally.
        const watchdog = armExitWatchdog(2);
        await closePoolsBounded(pool, serverPool);
        clearTimeout(watchdog);
        process.exit(2);
      }
      anyFail = true;
      process.stderr.write(`[${componentPath}] ` + formatCliError(err, process.env.DEBUG));
    } finally {
      releaseThirdPartyOutput();
      runWatchdog.clear();
      setCurrentRunProjectRoot(undefined);
      resetCurrentRunWarnings();
    }
  }
  {
    const watchdog = armExitWatchdog(anyFail ? 1 : 0);
    await closePoolsBounded(pool, serverPool);
    clearTimeout(watchdog);
  }

  const jsonNotice = formatJsonSplitNotice(reportPaths);
  if (jsonNotice) process.stdout.write(jsonNotice + "\n");

  // One hygiene hint for the whole run, suppressed under --ci like every terminal-only notice.
  if (!args.ci) {
    const gitRoot = findGitRoot(process.cwd());
    if (gitRoot) {
      const writtenPaths = reportPaths.map((reportPath) => path.resolve(reportPath));
      for (const projectRoot of projectRoots) {
        if (args.saveBaseline) writtenPaths.push(resolveBaselinePath(projectRoot, args.baselineFile));
        writtenPaths.push(...harnessLeftoverDirs(projectRoot));
      }
      writtenPaths.push(...harnessLeftoverDirs(gitRoot));
      const tip = formatGitignoreTip(gitignoreTipPatterns(gitRoot, writtenPaths));
      if (tip) process.stdout.write(tip + "\n");
    }
  }

  // Written even when components failed: a summary that appears only on success is useless.
  if (args.reportMd) writeCiFile(args.reportMd, formatMarkdown(ciReports, { failed: anyFail }));
  if (args.reportJunit) writeCiFile(args.reportJunit, formatJUnit(ciReports, { failed: anyFail }));

  process.exit(anyFail ? 1 : 0);
}

function writeCiFile(target: string, contents: string): void {
  const resolved = path.resolve(target);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, contents, "utf-8");
}

async function runOne(
  componentPath: string,
  jsonPath: string,
  args: CliArgs,
  browserPool?: import("../browser/index.js").BrowserPool,
  serverPool?: import("../harness/index.js").ServerPool,
  // Fired before the --ci gate that silences progress, so a CI run is bounded per phase too.
  onPhase?: () => void,
): Promise<import("../report/index.js").Report> {
  return analyze(componentPath, {
      ...(onPhase ? { onPhase } : {}),
      // Threads warnings to the accumulator resolveFatalProcessError reads.
      onWarning: pushCurrentRunWarning,
      browserPool,
      serverPool,
      ...(args.targets?.[componentPath] ? { target: args.targets[componentPath] } : {}),
      samples: args.samples,
      maxCombos: args.maxCombos,
      initFixture: args.initFixture,
      exploreBudgetMs: args.exploreBudgetSeconds !== undefined ? args.exploreBudgetSeconds * 1000 : undefined,
      jsonPath,
      ci: args.ci,
      fixturePath: args.fixturePath,
      scalePoints: args.scale,
      skipDeltas: args.noDeltas,
      skipAutoScale: args.noAutoScale,
      skipAttribution: args.noAttribution,
      skipAutoCompose: args.noAutoCompose,
      skipReactAnalysis: args.noReactAnalysis,
      framework: args.framework,
      flatThresholds: args.flatThresholds,
      noShims: args.noShims,
      curveMode: resolveCurveOption(args),
      matrixMode: resolveMatrixOption(args),
      saveBaseline: args.saveBaseline,
      check: args.check,
      noBaseline: args.noBaseline,
      baselineFile: args.baselineFile,
      noCache: args.noCache,
      noPreflight: args.noPreflight,
      noTransforms: args.noTransforms,
      baselineEnv: args.baselineEnv,
      isolation: resolveIsolationOption(args),
      wrapPath: args.wrapPath,
      noWrap: args.noWrap,
      cssFiles: args.css,
      noCss: args.noCss,
      reactCompiler: resolveReactCompilerFlag(args),
      thresholds: {
        ...(args.thresholdMount !== undefined
          ? { mountMs: args.thresholdMount }
          : {}),
        ...(args.thresholdInteraction !== undefined
          ? { interactionMs: args.thresholdInteraction }
          : {}),
        ...(args.thresholdRerender !== undefined
          ? { rerenderMs: args.thresholdRerender }
          : {}),
      },
    });
}

// Last in the file: every module-level declaration is initialized before main() can run.
const entryPath = toPosix(process.argv[1] ?? "");
const isDirectRun = entryPath.endsWith("cli/main.js") || entryPath.endsWith("cli/main.ts");

if (isDirectRun) {
  // Real CLI process only: an exit on a test's unhandled rejection would abort the whole suite.
  const handleFatalProcessError = (err: unknown): void => {
    const resolved = resolveFatalProcessError(err, process.env.DEBUG);
    if (!resolved) return;
    process.stderr.write(resolved.output);
    process.exit(resolved.exitCode);
  };
  process.on("unhandledRejection", handleFatalProcessError);
  process.on("uncaughtException", handleFatalProcessError);
  registerTerminationHandlers();
  main();
}
