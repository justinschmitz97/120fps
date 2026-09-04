#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { analyze, explainProps, formatExplainProps, resolveProjectPaths } from "../pipeline/index.js";
import { compareAgainstRef, formatCompare, validateCompareOptions } from "../analysis/index.js";
import { formatMarkdown, formatJUnit, formatTable, formatPhaseBreakdown } from "../report/index.js";
import type { PhaseTimings } from "../report/index.js";
import { createBrowserPool } from "../browser/index.js";
import { createServerPool, refreshHarnessDirMarkers } from "../harness/index.js";
import { formatResolvedRoots, resolveProjectModel, setPreflightBypassed } from "../project/index.js";
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
import { findGitRoot } from "../shared/index.js";
import { printHelp } from "./help.js";

// M101: the M88 watchdog bounds teardown *after* runOne returns; nothing
// bounded a hang inside analyze() itself, so an interrupted run kept its
// directory and its children alive indefinitely (V2: 11+ min, 20 s CPU).
// Budget: an exploration the user asked for, plus a fixed margin for everything
// around it, and never less than twenty minutes.
export const RUN_WATCHDOG_MARGIN_MS = 10 * 60_000;
export const RUN_WATCHDOG_MIN_MS = 20 * 60_000;
export const DEFAULT_EXPLORE_BUDGET_SECONDS = 300;

export function runWatchdogBudgetMs(exploreBudgetSeconds?: number): number {
  const explore = (exploreBudgetSeconds ?? DEFAULT_EXPLORE_BUDGET_SECONDS) * 1000;
  return Math.max(explore + RUN_WATCHDOG_MARGIN_MS, RUN_WATCHDOG_MIN_MS);
}

// M65: one line at the end of every terminal report, so a long run is a number
// rather than a memory.
// M104 (I11, commerce-F3/material-ui-F3): rounding the seconds *after*
// splitting them off the minutes printed `2m 60s` for anything from 119.5s up,
// a number no clock shows. Each branch rounds once, to the unit it prints, so
// a carry lands in the minutes instead of overflowing the seconds.
export function formatWallClock(elapsedMs: number): string {
  const tenthsOfSecond = Math.round(elapsedMs / 100);
  if (tenthsOfSecond < 600) return `Total: ${(tenthsOfSecond / 10).toFixed(1)}s`;
  const wholeSeconds = Math.round(elapsedMs / 1000);
  const minutes = Math.floor(wholeSeconds / 60);
  return `Total: ${minutes}m ${wholeSeconds - minutes * 60}s`;
}

// M115 A1: the wait and where it went, on one line. A run whose report carries
// no phase timings (a cached verdict, a report written before M115) prints the
// line it printed before, so the breakdown is an addition and never a rewrite.
export function formatTotalLine(
  elapsedMs: number,
  timings: PhaseTimings | undefined,
): string {
  return formatWallClock(elapsedMs) + formatPhaseBreakdown(timings);
}

// M111 A4: one line per component, from the component path the user gave,
// resolved the way every other stage resolves it. The paths are absolute, so
// the line reads the same from every shell directory.
export function resolvedRootsLine(componentPath: string): string {
  const model = resolveProjectModel(path.dirname(path.resolve(componentPath)));
  return formatResolvedRoots(model.memberRoot, model.workspaceRoot);
}

// M111 A4: --ci output is read by a machine, so the line is written for a
// reader or not at all. One place decides that, for the dry run and for the
// measured run.
export function resolvedRootsOutput(componentPath: string, ci: boolean): string {
  return ci ? "" : resolvedRootsLine(componentPath) + "\n";
}

// I3a (element-plus-F2): every flag the dry run can honour, in one place a
// test can read. `--framework` used to stop here: the real run forwards it and
// discloses that it does not change how a file mounts, while the dry run
// dropped it and was a silent no-op instead of a disclosed one.
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
} {
  // C-5: the four flags below decide which mode the real run takes, and the
  // dry run's whole job is to predict that mode. They are resolved with the
  // same functions runOne uses, so the two paths cannot disagree about what a
  // flag combination means.
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
    // M110 C1, C4 (review): the dry run read both of these all along; the call
    // site dropped them, so `--explain-props --no-auto-compose` predicted an
    // auto-composed scene the real run does not build and
    // `--explain-props --no-transforms` printed the transform lines the real
    // run suppresses. Same two lines the real run forwards below.
    ...(args.noAutoCompose ? { skipAutoCompose: true } : {}),
    ...(args.noTransforms ? { noTransforms: true } : {}),
    // M110 I2 (review): `noShims` changes the alias set the external-dependency
    // scan resolves against, so the shared static pre-build only reports the
    // same unresolved externals in both modes when the dry run gets it too.
    ...(args.noShims ? { noShims: true } : {}),
    // M115 A2, I12: the dry run prices the real run from the combo and sample
    // counts that run would measure, and both are flags. Same two names the
    // real run forwards to AnalyzeOptions, so the estimate is priced against
    // the command line the user typed rather than the defaults.
    ...(args.samples !== undefined ? { samples: args.samples } : {}),
    ...(args.maxCombos !== undefined ? { maxCombos: args.maxCombos } : {}),
  };
}

async function main(): Promise<void> {
  const versionError = nodeVersionError(process.version);
  if (versionError) {
    process.stderr.write(`Error: ${versionError}\n`);
    process.exit(2);
  }

  const args = parseArgs(process.argv.slice(2));
  // M105 (solid-ui-F1): a remedy must not advise the flag this run already
  // passed. Set once, before anything can fail.
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

  // M65: a dry run: resolution only. Before every check that exists to protect
  // a measurement, because it never starts one.
  if (args.explainProps) {
    let failed = false;
    for (let idx = 0; idx < componentPaths.length; idx++) {
      const componentPath = componentPaths[idx];
      if (componentPaths.length > 1) process.stdout.write(`\n=== ${componentPath} ===\n`);
      // M111 A4: the first line of this component's block, so a reader
      // comparing two shell directories sees the roots both runs resolved
      // before anything those runs could disagree about.
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

  // M49: its own mode: two sides, interleaved, no verdict. Budgets and
  // baselines keep owning CI, so compare never sets a non-zero exit.
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
  const reportPaths = multi
    ? resolveReportPaths(componentPaths, args.jsonExplicit ? args.jsonPath : undefined)
    : [args.jsonPath];
  let anyFail = false;
  // M50: collected across the sweep so both formats describe the whole run.
  const ciReports: import("../report/index.js").Report[] = [];
  // M117 A1: where this sweep's baselines and harness directories can be, one
  // entry per distinct project the components belong to.
  const projectRoots = new Set<string>();

  // M37: browsers are project-agnostic: one pool serves every component of
  // the sweep (two Chromium processes total instead of ~5 launches each).
  // M38: one dev server per project/config tuple serves every harness dir.
  const pool = createBrowserPool();
  const serverPool = createServerPool();
  // M101: what a signal handler outside this function has to close. Published
  // as soon as both pools exist, so a kill arriving one millisecond later still
  // reaches them.
  setActivePools({ pool, serverPool });
  // M88: a fatal error on a single-component run previously called
  // process.exit(2) synchronously right here, which never runs a pending
  // `finally` block -- pool/server teardown was skipped outright. It now
  // attempts that same teardown, bounded (closePoolsBounded, armExitWatchdog):
  // a hung Vite dev-server close can no longer keep either the teardown or
  // the process itself from finishing within the documented exit code's
  // 10-second budget.
  for (let idx = 0; idx < componentPaths.length; idx++) {
    const componentPath = componentPaths[idx];
    if (multi && !args.ci) {
      process.stdout.write(`\n=== ${componentPath} ===\n`);
    }
    const started = Date.now();
    // M92: set before the harness build a fire-and-forget dep-optimizer
    // rejection (surface 3) could still fail on, cleared once this component
    // is done -- see resolveFatalProcessError's own comment.
    const componentProjectRoot = resolveProjectPaths(path.resolve(componentPath)).projectRoot;
    projectRoots.add(componentProjectRoot);
    setCurrentRunProjectRoot(componentProjectRoot);
    // Item A: same lifecycle as the project root above -- reset before this
    // component's own run() populates it via AnalyzeOptions.onWarning, so a
    // surface-3 rejection on component 2 of a multi-component sweep never
    // reports component 1's warnings.
    resetCurrentRunWarnings();
    // M101: armed before the run, re-armed by every phase line it prints, so a
    // phase that stops making progress cannot hold this directory and this
    // browser forever. Cleared in the same iteration's finally.
    const budgetMs = runWatchdogBudgetMs(args.exploreBudgetSeconds);
    // Every run passes onPhase, so the timer is re-armed at each phase on
    // every path, --ci included. The total-budget wording stays for a caller
    // that omits it.
    const bound = "stalled" as const;
    // M116 end-game fix-up (midday-NEW1): the aborted run's own analyze() call
    // keeps running until the pools close under it, and whatever it throws on
    // the way down ("Cannot read properties of undefined (reading 'props')" on
    // midday) used to print as a second, unrelated Error after the abort
    // sentence -- two errors for one failure, the second of them noise. The
    // abort owns the exit from here on.
    let aborted = false;
    const runWatchdog = createRunWatchdog(budgetMs, () => {
      aborted = true;
      const out = watchdogAbortOutput(componentPath, budgetMs, bound, Date.now() - started, args.ci);
      process.stderr.write(out.stderr);
      if (out.stdout) process.stdout.write(out.stdout);
      void abortRun(2, { pool, serverPool });
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
          // M101 (review A6): the marker is what tells another process this
          // directory is still in use; the directory's own mtime stopped
          // advancing when the build finished writing into it.
          refreshHarnessDirMarkers();
        },
      );
      if (!args.ci) {
        // M111 A4: ahead of this component's table, once per component.
        process.stdout.write(resolvedRootsOutput(componentPath, false));
        process.stdout.write(formatTable(report) + "\n");
        // M115 A1: the breakdown rides on the line that already prints the
        // wait, under the same `!args.ci` guard -- `--ci` owns stdout for JSON
        // and reads `phaseTimings` from the report instead.
        process.stdout.write(
          formatTotalLine(Date.now() - started, report.phaseTimings) + "\n",
        );
      }
      if (!report.pass) anyFail = true;
    } catch (err: unknown) {
      // The abort already printed the one error this run failed on and owns
      // the teardown and the exit code (2); returning leaves it that one exit
      // and prints no second error for the same failure.
      if (aborted) return;
      if (!multi) {
        process.stderr.write(formatCliError(err, process.env.DEBUG));
        const watchdog = armExitWatchdog(2);
        await closePoolsBounded(pool, serverPool);
        clearTimeout(watchdog);
        process.exit(2);
      }
      anyFail = true;
      process.stderr.write(`[${componentPath}] ` + formatCliError(err, process.env.DEBUG));
    } finally {
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

  // M74 (E5): one repo-hygiene hint for the whole run, suppressed under --ci
  // like every other terminal-only notice.
  if (!args.ci) {
    const gitRoot = findGitRoot(process.cwd());
    if (gitRoot) {
      const writtenPaths = reportPaths.map((reportPath) => path.resolve(reportPath));
      for (const projectRoot of projectRoots) {
        if (args.saveBaseline) writtenPaths.push(path.join(projectRoot, "120fps-baseline.json"));
        writtenPaths.push(...harnessLeftoverDirs(projectRoot));
      }
      writtenPaths.push(...harnessLeftoverDirs(gitRoot));
      const tip = formatGitignoreTip(gitignoreTipPatterns(gitRoot, writtenPaths));
      if (tip) process.stdout.write(tip + "\n");
    }
  }

  // Written even when components failed: a CI summary that only appears on
  // success is the one nobody needed.
  if (args.reportMd) writeCiFile(args.reportMd, formatMarkdown(ciReports));
  if (args.reportJunit) writeCiFile(args.reportJunit, formatJUnit(ciReports));

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
  // M101: every phase boundary is a liveness heartbeat for the run watchdog.
  // Review A2 follow-up: it rides `onPhase`, which analyze fires before the
  // --ci gate that silences console progress, so a CI run is bounded per phase
  // like any other instead of by a bare total.
  onPhase?: () => void,
): Promise<import("../report/index.js").Report> {
  return analyze(componentPath, {
      ...(onPhase ? { onPhase } : {}),
      // Item A: threads this run's warnings out to the same accumulator
      // resolveFatalProcessError reads, so a surface-3 async rejection can
      // disclose them -- see currentRunWarnings's own comment.
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

// Invoked last: every module-level declaration above is initialized before
// main() can run, so the direct-run path can never hit a temporal dead zone.
const entryPath = (process.argv[1] ?? "").replace(/\\/g, "/");
const isDirectRun = entryPath.endsWith("cli/main.js") || entryPath.endsWith("cli/main.ts");

if (isDirectRun) {
  // M79 (behavior 2). Registered only on the real CLI process, never when
  // cli.ts is merely imported by a test: unit tests routinely trigger a real
  // unhandled rejection (the documented provider-wrapper.test.ts esbuild
  // temp-dir flake, per specs/overview/00-tdd.md), and a global handler that
  // called process.exit(2) on that would abort the whole suite rather than
  // let vitest's own reporting handle it.
  const handleFatalProcessError = (err: unknown): void => {
    const resolved = resolveFatalProcessError(err, process.env.DEBUG);
    if (!resolved) return;
    process.stderr.write(resolved.output);
    process.exit(resolved.exitCode);
  };
  process.on("unhandledRejection", handleFatalProcessError);
  process.on("uncaughtException", handleFatalProcessError);
  // M101: Node runs no "exit" listener for a signalled process, so without
  // these three the harness directory of every killed run stays on disk.
  registerTerminationHandlers();
  main();
}
