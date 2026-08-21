#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyze, explainProps, formatExplainProps, resolveProjectPaths, formatAccumulatedWarnings } from "./analyze.js";
import { compareAgainstRef, formatCompare, validateCompareOptions } from "./compare.js";
import { formatMarkdown, formatJUnit } from "./ci-report.js";
import { createBrowserPool } from "./measure.js";
import { createServerPool, presentBundlerFailure, sweepActiveHarnessDirs } from "./harness.js";
import { scanExports } from "./prop-gen.js";
import { parseIsolationPhases, strictModeUnsupported, VUE_STRICTMODE_ERROR } from "./isolation.js";
import { setPreflightBypassed } from "./preflight.js";
import { formatTable, DEFAULT_THRESHOLDS } from "./report.js";

// M88: the taxonomy hang -- a fatal error printed in full, then the process
// stayed alive until an external `timeout` killed it (EXIT=124). Pool/server
// teardown (browser pool, dev-server pool) that never settles must never
// block the documented exit code from actually being delivered. Arms an
// unref'd timer that calls process.exit(exitCode) directly; unref'd so it
// never by itself keeps an otherwise-idle process alive, but a genuinely hung
// teardown leaves other handles open regardless, so the timer still fires.
export const FATAL_EXIT_WATCHDOG_MS = 8000;

export function armExitWatchdog(
  exitCode: number,
  timeoutMs: number = FATAL_EXIT_WATCHDOG_MS,
): NodeJS.Timeout {
  const timer = setTimeout(() => process.exit(exitCode), timeoutMs);
  timer.unref();
  return timer;
}

// Best-effort, bounded teardown of both pools: allSettled means one pool
// hanging or throwing never blocks awaiting the other, and this function's
// own promise resolves within timeoutMs regardless of whether either pool's
// closeAll() ever settles on its own. Never calls process.exit itself: the
// caller pairs this with armExitWatchdog (armed before, cleared after) so a
// still-hanging call site is caught by that outer, harder guarantee.
//
// M92 (1.5b, investigated, not implemented): a timed-out closeAll() is
// abandoned here, not force-killed. Fixing that requires reaching the
// underlying Chromium OS process, and Playwright's public API gives no way
// to do that from a `Browser` obtained via `chromium.launch()` (what
// createBrowserPool uses) -- `.process()`/`.kill()` exist only on
// `BrowserServer`, the return type of the unrelated `chromium.launchServer()`
// API (confirmed by reading playwright-core@1.59.1's own
// types/types.d.ts:9723-9840 vs :19194-19233), and the client-side `Browser`
// object (lib/client/browser.js) holds no process handle at all -- the
// actual spawn happens through playwright-core's private server-side
// internals, not reachable from here without importing a non-exported
// module path. Switching createBrowserPool to launchServer()+connect() would
// fix this properly but is a larger change to a path every measurement goes
// through, and this task's constraints (no `pnpm build`, no corpus runs)
// mean it could not be verified against a real hang. Left as a documented
// limitation rather than shipped as an unverified or fragile private-API
// reach-in.
export async function closePoolsBounded(
  pool: Pick<import("./measure.js").BrowserPool, "closeAll">,
  serverPool: Pick<import("./harness.js").ServerPool, "closeAll">,
  timeoutMs: number = FATAL_EXIT_WATCHDOG_MS,
): Promise<void> {
  // Promise.resolve().then(...) turns a hostile closeAll() that throws
  // synchronously (a contract violation of its own Promise<void> return type,
  // but not this function's to trust) into a rejection Promise.allSettled can
  // actually catch, instead of that throw escaping before allSettled is even
  // constructed.
  await Promise.race([
    Promise.allSettled([
      Promise.resolve().then(() => pool.closeAll()),
      Promise.resolve().then(() => serverPool.closeAll()),
    ]),
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();
    }),
  ]);
}

// M101 (V2). Node emits no "exit" event for a process a signal terminates, so
// the `process.on("exit")` sweep in src/harness.ts — the only last-resort
// removal site — is bypassed by every external kill, and the harness directory
// then waits out an age gate in a later run. These three signals are the ones a
// shell, a CI runner and a closing terminal actually send.
export const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

// The shell's own convention for a signalled process: 130 for SIGINT, 143 for
// SIGTERM, 129 for SIGHUP.
export function terminationExitCode(signal: NodeJS.Signals): number {
  return 128 + (os.constants.signals[signal as keyof typeof os.constants.signals] ?? 0);
}

type ClosablePools = {
  pool: Pick<import("./measure.js").BrowserPool, "closeAll">;
  serverPool: Pick<import("./harness.js").ServerPool, "closeAll">;
};

// The one teardown every abrupt exit path shares. Directories go first: that
// removal is synchronous and depends on nothing settling, so it survives a pool
// close that never returns. Closing the browser pool is what ends Chromium, and
// the dev-server pool takes its esbuild workers with it; when either hangs,
// armExitWatchdog still delivers the exit code, by which point nothing is left
// on disk.
export async function abortRun(
  exitCode: number,
  pools?: ClosablePools,
  hooks: {
    sweep?: () => void;
    exit?: (code: number) => void;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  (hooks.sweep ?? sweepActiveHarnessDirs)();
  const timeoutMs = hooks.timeoutMs ?? FATAL_EXIT_WATCHDOG_MS;
  const exit = hooks.exit ?? ((code: number) => process.exit(code));
  // The exit happens once, whether the bounded close finishes or the deadline
  // beats it. armExitWatchdog is not reused here because its exit is hardwired
  // to process.exit: the deadline has to leave through the same door as the
  // ordinary path, so a caller (and a test) sees exactly one exit.
  let exited = false;
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    exit(exitCode);
  };
  const deadline = setTimeout(exitOnce, timeoutMs);
  deadline.unref();
  if (pools) await closePoolsBounded(pools.pool, pools.serverPool, timeoutMs);
  clearTimeout(deadline);
  exitOnce();
}

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

// Re-armed by every phase line the run prints, so the budget bounds one phase
// making no progress rather than the run's total honest work. Unref'd: it never
// keeps an otherwise-finished process alive on its own.
export function createRunWatchdog(
  budgetMs: number,
  onExpire: () => void,
): { heartbeat: () => void; clear: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const arm = (): void => {
    timer = setTimeout(onExpire, budgetMs);
    timer.unref();
  };
  arm();
  return {
    heartbeat: () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      arm();
    },
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

let activePools: ClosablePools | undefined;

export function setActivePools(pools: ClosablePools | undefined): void {
  activePools = pools;
}

// Registered on the real CLI process only, never when cli.ts is imported by a
// test — the same reasoning the unhandledRejection/uncaughtException handlers
// below carry: a global handler that exits the process would take a whole test
// suite with it.
export function registerTerminationHandlers(): void {
  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, () => {
      void abortRun(terminationExitCode(signal), activePools);
    });
  }
}

export function RUN_WATCHDOG_ABORT_ERROR(componentPath: string, budgetMs: number): string {
  return (
    `Error: ${componentPath} made no progress for ${Math.round(budgetMs / 60_000)} minutes; ` +
    "aborting the run, removing its harness directory and closing its browser. Re-run with " +
    "--explore-budget to allow a longer exploration, or with --no-deltas / --max-combos to " +
    "measure less.\n"
  );
}

const ISOLATE_USAGE_ERROR =
  "--isolate requires a comma-separated list of phases (mount,rerender,unmount,memory,strictmode,all)";

const SKIP_DIRS = ["node_modules", "dist", "build", ".next", ".120fps-harness-"];
const SKIP_SUFFIX = [".test.", ".spec.", ".stories.", ".fixture."];


export interface CliArgs {
  componentPath?: string;
  // M65: export names from `<file>#Export`, keyed by the path as typed.
  targets?: Record<string, string>;
  explainProps?: boolean;
  fixturePath?: string;
  jsonPath: string;
  ci: boolean;
  samples?: number;
  maxCombos?: number;
  initFixture?: boolean;
  exploreBudgetSeconds?: number;
  thresholdMount?: number;
  thresholdInteraction?: number;
  thresholdRerender?: number;
  scale?: number[];
  noDeltas?: boolean;
  noAutoScale?: boolean;
  noAttribution?: boolean;
  noAutoCompose?: boolean;
  noReactAnalysis?: boolean;
  framework?: "react" | "vue" | "vanilla" | "auto";
  flatThresholds?: boolean;
  noShims?: boolean;
  curve?: boolean | string;
  noCurve?: boolean;
  matrix?: boolean;
  noMatrix?: boolean;
  saveBaseline?: boolean;
  check?: boolean;
  budget?: boolean;
  noBaseline?: boolean;
  noCache?: boolean;
  noPreflight?: boolean;
  noTransforms?: boolean;
  compare?: string;
  reportMd?: string;
  reportJunit?: string;
  baselineEnv?: "strict" | "normalize" | "ignore";
  componentPaths?: string[];
  jsonExplicit?: boolean;
  isolate?: string[];
  memoryCycles?: number;
  noIsolate?: boolean;
  wrapPath?: string;
  noWrap?: boolean;
  css?: string[];
  noCss?: boolean;
  reactCompiler?: boolean;
  noReactCompiler?: boolean;
  help: boolean;
  version: boolean;
  error?: string;
}

export const KNOWN_FLAGS = new Set([
  "--json",
  "--ci",
  "--samples",
  "--max-combos",
  "--init-fixture",
  "--explore-budget",
  "--threshold-mount",
  "--threshold-interaction",
  "--threshold-rerender",
  "--scale",
  "--fixture",
  "--no-deltas",
  "--no-auto-scale",
  "--no-attribution",
  "--no-auto-compose",
  "--no-react-analysis",
  "--framework",
  "--flat-thresholds",
  "--no-shims",
  "--curve",
  "--no-curve",
  "--matrix",
  "--no-matrix",
  "--save-baseline",
  "--check",
  "--budget",
  "--no-baseline",
  "--no-cache",
  "--baseline-env",
  "--isolate",
  "--memory-cycles",
  "--no-isolate",
  "--wrap",
  "--no-wrap",
  "--css",
  "--no-css",
  "--react-compiler",
  "--no-react-compiler",
  "--no-preflight",
  "--no-transforms",
  "--explain-props",
  "--compare",
  "--report-md",
  "--report-junit",
  "--help",
  "--version",
]);

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// M65: `<file>#Export`. Decided from the text alone, so a path containing `#`
// never depends on whether the file happens to exist yet. An export name is an
// identifier: it can hold neither `.` nor a separator: and the left side must
// already look like a component file, so `C:\p\c#1\B.tsx` and `C:\p\B#2.tsx`
// stay whole paths.
export function splitTargetSpec(arg: string): { path: string; target?: string } {
  const hash = arg.lastIndexOf("#");
  if (hash <= 0) return { path: arg };
  const left = arg.slice(0, hash);
  const right = arg.slice(hash + 1);
  if (!IDENTIFIER.test(right)) return { path: arg };
  if (!hasAcceptedComponentExtension(left)) return { path: arg };
  return { path: left, target: right };
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

export function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = {
    jsonPath: "120fps-report.json",
    ci: false,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];

    if (arg === "--help") {
      result.help = true;
      i++;
      continue;
    }
    if (arg === "--version") {
      result.version = true;
      i++;
      continue;
    }
    if (arg === "--ci") {
      result.ci = true;
      i++;
      continue;
    }
    if (arg === "--no-deltas") {
      result.noDeltas = true;
      i++;
      continue;
    }
    if (arg === "--no-auto-scale") {
      result.noAutoScale = true;
      i++;
      continue;
    }
    if (arg === "--no-attribution") {
      result.noAttribution = true;
      i++;
      continue;
    }
    if (arg === "--no-auto-compose") {
      result.noAutoCompose = true;
      i++;
      continue;
    }
    if (arg === "--no-react-analysis") {
      result.noReactAnalysis = true;
      i++;
      continue;
    }
    if (arg === "--framework") {
      if (i + 1 >= argv.length) {
        result.error = "--framework requires a value (react, vue, vanilla, or auto)";
        return result;
      }
      const val = argv[++i];
      if (val !== "react" && val !== "vue" && val !== "vanilla" && val !== "auto") {
        result.error = `--framework must be react, vue, vanilla, or auto, got "${val}"`;
        return result;
      }
      result.framework = val;
      i++;
      continue;
    }
    if (arg === "--flat-thresholds") {
      result.flatThresholds = true;
      i++;
      continue;
    }
    if (arg === "--no-shims") {
      result.noShims = true;
      i++;
      continue;
    }
    if (arg === "--curve") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--") && /^\w+:(array|number)$/.test(next)) {
        result.curve = next;
        i += 2;
      } else if (next && !next.startsWith("--") && /^\w+:\w+$/.test(next)) {
        result.error = `--curve prop:type must use type "array" or "number", got "${next}"`;
        return result;
      } else {
        result.curve = true;
        i++;
      }
      continue;
    }
    if (arg === "--no-curve") {
      result.noCurve = true;
      i++;
      continue;
    }
    if (arg === "--matrix") {
      result.matrix = true;
      i++;
      continue;
    }
    if (arg === "--no-matrix") {
      result.noMatrix = true;
      i++;
      continue;
    }
    if (arg === "--save-baseline") {
      result.saveBaseline = true;
      i++;
      continue;
    }
    if (arg === "--check") {
      result.check = true;
      i++;
      continue;
    }
    if (arg === "--budget") {
      result.budget = true;
      result.ci = true;
      result.check = true;
      i++;
      continue;
    }
    if (arg === "--no-cache") {
      result.noCache = true;
      i++;
      continue;
    }
    if (arg === "--no-baseline") {
      result.noBaseline = true;
      i++;
      continue;
    }
    if (arg === "--baseline-env") {
      if (i + 1 >= argv.length) {
        result.error = "--baseline-env requires a value (strict, normalize, or ignore)";
        return result;
      }
      const val = argv[++i];
      if (val !== "strict" && val !== "normalize" && val !== "ignore") {
        result.error = `--baseline-env must be strict, normalize, or ignore, got "${val}"`;
        return result;
      }
      result.baselineEnv = val;
      i++;
      continue;
    }
    if (arg === "--isolate") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        result.error = ISOLATE_USAGE_ERROR;
        return result;
      }
      let phases: string[];
      try {
        phases = parseIsolationPhases(argv[++i]);
      } catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
        return result;
      }
      if (phases.length === 0) {
        result.error = ISOLATE_USAGE_ERROR;
        return result;
      }
      result.isolate = phases;
      i++;
      continue;
    }
    if (arg === "--memory-cycles") {
      if (i + 1 >= argv.length) {
        result.error = "--memory-cycles requires a positive integer";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0 || !Number.isInteger(n)) {
        result.error = `--memory-cycles must be a positive integer, got "${argv[i]}"`;
        return result;
      }
      result.memoryCycles = n;
      i++;
      continue;
    }
    if (arg === "--no-isolate") {
      result.noIsolate = true;
      i++;
      continue;
    }
    if (arg === "--wrap") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        result.error = "--wrap requires a path argument";
        return result;
      }
      result.wrapPath = argv[++i];
      i++;
      continue;
    }
    if (arg === "--no-wrap") {
      result.noWrap = true;
      i++;
      continue;
    }
    if (arg === "--css") {
      if (i + 1 >= argv.length || argv[i + 1].startsWith("--")) {
        result.error = "--css requires a comma-separated list of stylesheet paths";
        return result;
      }
      const parts = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (parts.length === 0) {
        result.error = "--css requires at least one stylesheet path";
        return result;
      }
      result.css = parts;
      i++;
      continue;
    }
    if (arg === "--no-css") {
      result.noCss = true;
      i++;
      continue;
    }
    if (arg === "--react-compiler") {
      result.reactCompiler = true;
      i++;
      continue;
    }
    if (arg === "--no-react-compiler") {
      result.noReactCompiler = true;
      i++;
      continue;
    }
    if (arg === "--no-preflight") {
      result.noPreflight = true;
      i++;
      continue;
    }
    if (arg === "--explain-props") {
      result.explainProps = true;
      i++;
      continue;
    }
    if (arg === "--report-md") {
      if (i + 1 >= argv.length) {
        result.error = "--report-md requires a path argument";
        return result;
      }
      result.reportMd = argv[++i];
      i++;
      continue;
    }
    if (arg === "--report-junit") {
      if (i + 1 >= argv.length) {
        result.error = "--report-junit requires a path argument";
        return result;
      }
      result.reportJunit = argv[++i];
      i++;
      continue;
    }
    if (arg === "--no-transforms") {
      result.noTransforms = true;
      i++;
      continue;
    }
    if (arg === "--compare") {
      if (i + 1 >= argv.length) {
        result.error = "--compare requires a git ref argument";
        return result;
      }
      result.compare = argv[++i];
      i++;
      continue;
    }
    if (arg === "--json") {
      if (i + 1 >= argv.length) {
        result.error = "--json requires a path argument";
        return result;
      }
      result.jsonPath = argv[++i];
      result.jsonExplicit = true;
      i++;
      continue;
    }
    if (arg === "--fixture") {
      if (i + 1 >= argv.length) {
        result.error = "--fixture requires a path argument";
        return result;
      }
      result.fixturePath = argv[++i];
      i++;
      continue;
    }
    if (arg === "--samples") {
      if (i + 1 >= argv.length) {
        result.error = "--samples requires a number argument";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0 || !Number.isInteger(n)) {
        result.error = `--samples must be a positive integer, got "${argv[i]}"`;
        return result;
      }
      result.samples = n;
      i++;
      continue;
    }
    if (arg === "--init-fixture") {
      result.initFixture = true;
      i++;
      continue;
    }
    if (arg === "--explore-budget") {
      if (i + 1 >= argv.length) {
        result.error = "--explore-budget requires a number of seconds";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0) {
        result.error = `--explore-budget must be a positive number of seconds, got "${argv[i]}"`;
        return result;
      }
      result.exploreBudgetSeconds = n;
      i++;
      continue;
    }
    if (arg === "--max-combos") {
      if (i + 1 >= argv.length) {
        result.error = "--max-combos requires a number argument";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0 || !Number.isInteger(n)) {
        result.error = `--max-combos must be a positive integer, got "${argv[i]}"`;
        return result;
      }
      result.maxCombos = n;
      i++;
      continue;
    }
    if (arg === "--threshold-mount") {
      if (i + 1 >= argv.length) {
        result.error = "--threshold-mount requires a number argument";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0) {
        result.error = `--threshold-mount must be a positive number, got "${argv[i]}"`;
        return result;
      }
      result.thresholdMount = n;
      i++;
      continue;
    }
    if (arg === "--threshold-interaction") {
      if (i + 1 >= argv.length) {
        result.error = "--threshold-interaction requires a number argument";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0) {
        result.error = `--threshold-interaction must be a positive number, got "${argv[i]}"`;
        return result;
      }
      result.thresholdInteraction = n;
      i++;
      continue;
    }
    if (arg === "--threshold-rerender") {
      if (i + 1 >= argv.length) {
        result.error = "--threshold-rerender requires a number argument";
        return result;
      }
      const n = Number(argv[++i]);
      if (isNaN(n) || n <= 0) {
        result.error = `--threshold-rerender must be a positive number, got "${argv[i]}"`;
        return result;
      }
      result.thresholdRerender = n;
      i++;
      continue;
    }
    if (arg === "--scale") {
      if (i + 1 >= argv.length) {
        result.error = "--scale requires a comma-separated list of integers";
        return result;
      }
      const raw = argv[++i];
      const parts = raw.split(",");
      const nums: number[] = [];
      for (const p of parts) {
        const n = Number(p.trim());
        if (isNaN(n) || n <= 0 || !Number.isInteger(n)) {
          result.error = `--scale values must be positive integers, got "${raw}"`;
          return result;
        }
        nums.push(n);
      }
      if (new Set(nums).size < 2) {
        result.error = `--scale requires at least 2 distinct positive integers, got "${raw}"`;
        return result;
      }
      result.scale = nums;
      i++;
      continue;
    }
    if (arg.startsWith("--")) {
      result.error = `Unknown flag: ${arg}`;
      return result;
    }

    const spec = splitTargetSpec(arg);
    if (spec.target) {
      result.targets = { ...(result.targets ?? {}), [spec.path]: spec.target };
    }
    if (!result.componentPath) {
      result.componentPath = spec.path;
      result.componentPaths = [spec.path];
    } else {
      if (!result.componentPaths) result.componentPaths = [result.componentPath];
      result.componentPaths.push(spec.path);
    }
    i++;
  }

  if (!result.help && !result.version && !result.componentPath) {
    result.error = "Missing component path. Usage: 120fps <component.tsx> [more.tsx ...] [options]";
  }

  if (result.fixturePath && !result.componentPath) {
    result.error = "--fixture requires a component path";
  }

  if (!result.error && result.fixturePath && result.targets) {
    result.error =
      "--fixture cannot be combined with a named export target (<file>#Export): a fixture already decides what renders";
  }

  if (!result.error && result.componentPaths && result.componentPaths.length > 1) {
    if (result.fixturePath) {
      result.error = "--fixture supports a single component path";
    }
  }

  if (!result.error && result.isolate && result.curve) {
    result.error = "--isolate cannot be combined with --curve";
  }
  if (!result.error && result.isolate && result.matrix) {
    result.error = "--isolate cannot be combined with --matrix";
  }
  // Checked against the paths as typed: directory and glob expansion happens
  // later, and a phase that cannot mean anything for the target is a usage
  // error, not a measurement that quietly reports nothing.
  if (
    !result.error &&
    result.isolate &&
    strictModeUnsupported(result.isolate, result.componentPaths ?? [])
  ) {
    result.error = VUE_STRICTMODE_ERROR;
  }
  // Two whole-run modes: one sweeps scale points, the other a prop matrix, and
  // a run does one or the other. A disable wins over its own enable everywhere
  // else, so it resolves this too instead of erroring on a mode that is off.
  if (!result.error && result.curve && !result.noCurve && result.matrix && !result.noMatrix) {
    result.error = "--curve cannot be combined with --matrix";
  }

  return result;
}

function parseCurveArg(arg: string): { propName: string; propKind: "array" | "number" } {
  const [propName, propKind] = arg.split(":");
  return { propName, propKind: propKind as "array" | "number" };
}

// --no-curve / --no-matrix win over their enables, matching --no-isolate and
// --no-react-compiler. `false` is not `undefined`: a disable is fingerprinted
// as the combo mode it resolves to, so it stays eligible for verdict reuse
// (M54), while an absent flag leaves auto-activation free to run.
export function resolveCurveOption(
  args: Pick<CliArgs, "curve" | "noCurve">,
): boolean | { propName: string; propKind: "array" | "number" } | undefined {
  if (args.noCurve) return false;
  if (args.curve === true) return true;
  if (typeof args.curve === "string") return parseCurveArg(args.curve);
  return undefined;
}

export function resolveMatrixOption(
  args: Pick<CliArgs, "matrix" | "noMatrix">,
): boolean | undefined {
  if (args.noMatrix) return false;
  if (args.matrix) return true;
  return undefined;
}

// --no-react-compiler wins over --react-compiler; undefined means auto-detect.
export function resolveReactCompilerFlag(
  args: Pick<CliArgs, "reactCompiler" | "noReactCompiler">,
): boolean | undefined {
  if (args.noReactCompiler) return false;
  if (args.reactCompiler) return true;
  return undefined;
}

export function resolveIsolationOption(
  args: Pick<CliArgs, "isolate" | "noIsolate" | "memoryCycles">,
): { phases: string[]; memoryCycles?: number } | undefined {
  if (!args.isolate || args.noIsolate) return undefined;
  return { phases: args.isolate, memoryCycles: args.memoryCycles };
}

// Stack traces are opt-in: DEBUG must be one of the conventional "enable
// everything" values, or explicitly name 120fps.
const DEBUG_EXACT_VALUES = new Set(["1", "true", "*"]);

export function isDebugStackEnabled(debugEnv: string | undefined): boolean {
  if (debugEnv === undefined) return false;
  return DEBUG_EXACT_VALUES.has(debugEnv) || debugEnv.includes("120fps");
}

export function formatCliError(err: unknown, debugEnv: string | undefined): string {
  const message = err instanceof Error ? err.message : String(err);
  let out = `Error: ${message}\n`;
  if (/Executable doesn't exist|playwright install/i.test(message)) {
    out += "Hint: run `npx playwright install chromium`\n";
  }
  if (isDebugStackEnabled(debugEnv) && err instanceof Error && err.stack) {
    out += err.stack + "\n";
  }
  return out;
}

// M79 (behavior 2). No process.on("unhandledRejection"/"uncaughtException")
// handler exists anywhere in src/ today, so Vite's dependency-optimizer scan
// — fire-and-forget by design, so it must not block server.listen() — can
// reject after buildAndServe's own try/catch has already exited successfully;
// Node's default --unhandled-rejections=throw then converts that into a
// process-terminating uncaught exception with a raw esbuild stack, and exit
// code 1, which cli.ts:744-747's own table documents as "a verdict failed" —
// wrong for a setup/harness failure. This resolver is the pure decision the
// process.on handlers below apply: same formatCliError text every other
// error path already uses (a raw stack only under DEBUG), and the "harness or
// browser failure" exit bucket (2), not Node's default. Exported so the
// decision is unit-testable without touching real process.exit/process.on;
// only the thin wrapper below performs those.
let fatalProcessErrorFired = false;

// M92 (ant-design-F5/F7/F9): the project root of whichever component is
// currently being measured, so a truly detached async rejection (surface 3
// of the shared pipeline, src/harness.ts's presentBundlerFailure -- a
// fire-and-forget Vite dependency-optimizer scan that rejects after
// buildAndServe's own try/catch already exited successfully) can still be
// diagnosed. Set by main()'s loop before each runOne call; undefined before
// the first component starts or once none is in flight.
let currentRunProjectRoot: string | undefined;

export function setCurrentRunProjectRoot(root: string | undefined): void {
  currentRunProjectRoot = root;
}

// Item A (M90 follow-up): the same shape as currentRunProjectRoot above, for
// the same reason -- surface 3 (a detached async rejection reaching
// process.on("unhandledRejection") directly) runs on a call stack with no
// access to analyze()'s own `runWarnings`/`cssDecisionWarning` locals.
// analyze() cannot report back through an import of this module (cli.ts
// already imports analyze.ts; the reverse would be a cycle), so this is
// populated the same way onProgress already is: a callback threaded through
// AnalyzeOptions, wired to this accumulator at the one call site
// (runOne, below) and read here by ordinary closure, not by importing
// anything back. `pushCurrentRunWarning` is exported directly as the
// callback runOne passes, so nothing here needs re-wrapping.
let currentRunWarnings: string[] = [];

export function pushCurrentRunWarning(warning: string): void {
  if (!currentRunWarnings.includes(warning)) currentRunWarnings.push(warning);
}

export function resetCurrentRunWarnings(): void {
  currentRunWarnings = [];
}

// Rebuilds the error only when presentBundlerFailure actually changed the
// message, so the common case (an ordinary render/setup error, already
// diagnosed by surface 1 or 2, or simply not bundler-shaped) keeps the
// original object -- and its real .stack -- untouched.
function presentDiagnosedProcessError(err: unknown, projectRoot: string): unknown {
  if (!(err instanceof Error)) return err;
  const diagnosed = presentBundlerFailure(err.message, projectRoot);
  if (diagnosed === err.message) return err;
  return new Error(diagnosed, { cause: err });
}

// Item A (M90 follow-up): appends the identical "Warnings recorded before
// this failure:" block analyze()'s own local catch already builds for
// surfaces 1 and 2 (src/analyze.ts) -- this is the same information, made
// reachable here through currentRunWarnings instead of a closure this
// function has no access to. Applied after diagnosis, not before: a
// diagnosed message's own remedy text must stay the lead sentence.
function withAccumulatedWarnings(presented: unknown, warnings: readonly string[]): unknown {
  if (warnings.length === 0) return presented;
  const message = presented instanceof Error ? presented.message : String(presented);
  return new Error(message + formatAccumulatedWarnings([...warnings]), { cause: presented });
}

export function resolveFatalProcessError(
  err: unknown,
  debugEnv: string | undefined,
  projectRoot: string | undefined = currentRunProjectRoot,
  warnings: readonly string[] = currentRunWarnings,
): { output: string; exitCode: number } | undefined {
  // process.exit does not stop already-scheduled work synchronously, so a
  // second rejection arriving before the process actually exits must not
  // print or decide again.
  if (fatalProcessErrorFired) return undefined;
  fatalProcessErrorFired = true;
  // M92: surface 3 of the shared diagnosis pipeline -- see
  // currentRunProjectRoot's own comment above.
  const presented = projectRoot ? presentDiagnosedProcessError(err, projectRoot) : err;
  const withWarnings = withAccumulatedWarnings(presented, warnings);
  return { output: formatCliError(withWarnings, debugEnv), exitCode: 2 };
}

// Test-only escape hatch for the module-level guard above, matching this
// codebase's existing process-lifetime-cache reset convention
// (prop-gen.ts's resetExtractionCache).
export function resetFatalProcessErrorGuard(): void {
  fatalProcessErrorFired = false;
}

// Wording kept identical to analyze.ts's resolveWrapPath/resolveCssFiles
// re-checks (src/analyze.ts) so the CLI's early exit and the pipeline's
// later throw read as the same error either way a run reaches them.
export function wrapperNotFoundMessage(wrapPath: string): string {
  return `Wrapper module not found: ${wrapPath}`;
}

export function stylesheetNotFoundMessage(cssPath: string): string {
  return `Stylesheet not found: ${cssPath}`;
}

export function helpText(): string {
  return `Usage: 120fps <component.tsx>[#ExportName] [more.tsx ...] [options]

Options:
  --explain-props                Dry run: print the resolved component and prop schema, measure nothing
  --fixture <path>               Fixture file for composed component measurement
  --json <path>                  JSON output path (default: 120fps-report.json)
  --ci                           CI mode: JSON-only output, exit 1 on fail
  --samples <n>                  Sample count per measurement (default: 10)
  --max-combos <n>               Prop combos to measure (default: 8)
  --explore-budget <seconds>     Total interaction exploration budget (default: 300)
  --init-fixture                 Write a starter fixture when auto-composition is rolled back
  --scale <n,n,...>              Scale points, overriding both defaults: combo-mode scale probes
                                 (default: 1,5,20,50) and curve-mode points (default: 1,3,5,10,20,50)
  --no-deltas                    Skip pairwise prop delta analysis
  --no-auto-scale                Disable auto-scaling prop detection
  --no-attribution               Disable cost attribution analysis
  --no-auto-compose              Disable auto-composition inference
  --no-react-analysis            Disable React optimization detection
  --framework <react|vue|vanilla|auto>  Framework detection mode (default: auto)
  --flat-thresholds              Disable tiered budgets, use flat thresholds
  --curve [prop:type]             Enable curve mode (auto-detect or specify prop:array|number)
  --no-curve                     Disable auto-activation of curve mode
  --matrix                       Enable prop variation matrix mode
  --no-matrix                    Disable auto-activation of matrix mode
  --save-baseline                Save current measurements as baseline
  --check                        Compare against baseline, fail on regression
  --budget                       Shorthand for --ci --check
  --no-baseline                  Skip baseline comparison in CI mode
  --no-cache                     Measure even when an unchanged component could reuse its baseline verdict
  --baseline-env <mode>          Baseline environment handling: strict|normalize|ignore (default: normalize)
  --isolate <phases>             Isolated measurement: mount,rerender,unmount,memory,strictmode,all
  --memory-cycles <n>            Mount/unmount cycles for memory mode (default: 20)
  --no-isolate                   Disable isolation mode (overrides --isolate)
  --wrap <path>                  Provider wrapper module (auto: 120fps.setup.tsx at project root)
  --no-wrap                      Disable the provider wrapper, including auto-detection
  --css <path,...>               Global stylesheets to inject (auto: app/globals.css and friends)
  --no-css                       Disable stylesheet injection, including auto-detection
  --react-compiler               Force the React Compiler transform on (auto: babel-plugin-react-compiler in package.json)
  --no-react-compiler            Disable the React Compiler transform, including auto-detection
  --no-shims                     Disable Next.js module shims
  --no-preflight                 Attempt the run even when the component graph reaches a server boundary
  --no-transforms                Do not load the project's own Vite transforms (SVGR, vanilla-extract)
  --compare <gitref>             Measure the working tree against <gitref>, samples interleaved (informational)
  --report-md <path>             Write a markdown summary (GitHub step summary / PR comment body)
  --report-junit <path>          Write JUnit XML, one testcase per component
  --threshold-mount <ms>         Mount time threshold (default: ${DEFAULT_THRESHOLDS.mountMs})
  --threshold-interaction <ms>   Interaction time threshold (default: ${DEFAULT_THRESHOLDS.interactionMs})
  --threshold-rerender <ms>      Rerender time threshold (default: ${DEFAULT_THRESHOLDS.rerenderMs})
  --help                         Show this help
  --version                      Print version

Exit codes:
  0   every measured component passed
  1   a verdict failed: over budget, or a regression under --check/--budget
  2   setup error: bad flag, missing file, harness or browser failure

Multiple components:
  Passing several paths, a directory, or a glob measures each in turn. With more
  than one component, --json becomes a filename template: <path>.<stem>.json per
  component, and the path you named is never written. The run prints the files it
  wrote. Components are measured in sorted path order, not argument order.

Named exports:
  Append #ExportName to a component path to measure that export instead of the
  one the resolver picks: 120fps ./kbd.tsx#KbdCombo. The name must be exported by
  the file; the error lists the file's component exports when it is not. A path
  whose own name contains # is left alone: only a trailing #Identifier after a
  .tsx/.jsx/.vue path is read as a target.

Combo caps:
  --max-combos bounds both prop-combo mode and matrix mode (default: 8 cells
  either way). In matrix mode, the base/anchor cell is always kept, then
  single-axis deviations from it, before wider cells are dropped.

Environment variables:
  The harness page only ever sees process.env from .env / .env.local files at
  the measured project's own root and its workspace root (read, never
  written); the invoking shell's environment is not passed through. Only keys
  prefixed NEXT_PUBLIC_ or VITE_ are forwarded, matching what a real Next.js
  or Vite build exposes to the browser. A component reading an unprefixed or
  shell-only variable measures undefined, same as it would in production.

Which mode answers which question:
  is it fast?                    (default)
  does it scale with its data?   --curve
  which prop costs the most?     --matrix
  is it leaking?                 --isolate memory
  did I regress?                 --budget
  did my change help?            --compare HEAD

All numbers are measured under 4x CPU throttle: comparative, not production wall-clock.
`;
}

function printHelp(): void {
  process.stdout.write(helpText());
}

export function defaultJsonPathFor(componentPath: string): string {
  const normalized = componentPath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const stem = base.replace(/\.[^.]+$/, "");
  return `120fps-report.${stem}.json`;
}

// A single directory argument expands to many components, so --json can no
// longer be rejected as ambiguous: it names where the reports go, and the
// component stem is appended to it.
export function resolveReportPaths(
  componentPaths: string[],
  explicitJsonPath?: string,
): string[] {
  if (componentPaths.length === 1 && explicitJsonPath) return [explicitJsonPath];

  const prefix = explicitJsonPath?.replace(/\.json$/, "");
  const seen = new Map<string, number>();
  return componentPaths.map((p) => {
    const base = prefix ? `${prefix}.${componentStem(p)}.json` : defaultJsonPathFor(p);
    // Case-folded key: NTFS/APFS cannot tell 120fps-report.Card.json apart
    // from 120fps-report.card.json, so a same-case-insensitive collision must
    // take the suffix branch too, even though `base` itself differs by case.
    const key = base.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count === 0 ? base : base.replace(/\.json$/, `-${count + 1}.json`);
  });
}

const JSON_NOTICE_LIST_CAP = 8;

// M64: a CI step that passed `--json out.json` and got `out.badge.json` had no
// way to learn that from the run. One line naming what was actually written.
export function formatJsonSplitNotice(reportPaths: string[]): string {
  if (reportPaths.length < 2) return "";
  const shown = reportPaths.slice(0, JSON_NOTICE_LIST_CAP);
  const rest = reportPaths.length - shown.length;
  const suffix = rest > 0 ? `, +${rest} more` : "";
  return `JSON: ${reportPaths.length} per-component reports: ${shown.join(", ")}${suffix}`;
}

function componentStem(componentPath: string): string {
  const normalized = componentPath.replace(/\\/g, "/");
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  return base.replace(/\.[^.]+$/, "");
}

// M74 (E5): the tool writes 120fps-report*.json and 120fps-baseline.json
// straight into the user's repo with no gitignore awareness. This is a hint,
// never a file edit: nothing below ever writes to .gitignore.
export const GITIGNORE_SUGGESTED_PATTERNS = [
  "120fps-report*.json",
  "120fps-baseline.json",
  ".120fps-harness-*",
];

export const GITIGNORE_ADVISORY_HINT =
  "Tip: 120fps writes report/baseline files into this repo. Consider adding to .gitignore: " +
  GITIGNORE_SUGGESTED_PATTERNS.join(", ");

// Nearest ancestor of startDir containing a .git entry (directory or, for a
// worktree, file); undefined outside any repo. Independent of
// project-model.ts's findWorkspaceRoot, which walks looking for install
// artifacts (lockfiles, workspaces field), not a git repo specifically.
export function findGitRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

// Literal match or a single `*` wildcard (prefix/suffix around it) only: no
// gitignore glob engine (no `**`, character classes, negation, or
// directory-scoped rules). One wildcard is the level a user actually writes
// by hand, and it is also the shape of every pattern this file itself
// suggests (GITIGNORE_SUGGESTED_PATTERNS), so a user who already took the
// hint stops seeing it. A pattern this fails to recognize (two or more
// wildcards, a character class, a directory-scoped rule) produces an extra
// hint, never a suppressed one.
export function gitignoreCoversFile(gitignoreContent: string, filename: string): boolean {
  for (const rawLine of gitignoreContent.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const pattern = line.replace(/^\//, "").replace(/\/$/, "");
    if (pattern === filename) return true;
    const star = pattern.indexOf("*");
    if (star === -1 || pattern.indexOf("*", star + 1) !== -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (
      filename.length >= prefix.length + suffix.length &&
      filename.startsWith(prefix) &&
      filename.endsWith(suffix)
    ) {
      return true;
    }
  }
  return false;
}

// A missing .gitignore covers nothing, so every written filename is
// uncovered; never a reason to skip the check.
export function needsGitignoreAdvisory(gitRoot: string, writtenFilenames: string[]): boolean {
  const gitignorePath = path.join(gitRoot, ".gitignore");
  const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf-8") : "";
  return writtenFilenames.some((name) => !gitignoreCoversFile(content, name));
}

// M72: engines: >=22 in package.json (see package.json) is declarative only
// — npx only soft-warns below it. A hard gate at entry turns a confusing
// syntax/runtime crash deep inside a dependency into one clear message.
export const MIN_NODE_MAJOR = 22;

function nodeMajorVersion(version: string): number | undefined {
  const match = /^v?(\d+)\./.exec(version);
  return match ? Number(match[1]) : undefined;
}

export function nodeVersionError(version: string): string | undefined {
  const major = nodeMajorVersion(version);
  if (major === undefined || major >= MIN_NODE_MAJOR) return undefined;
  return `Node ${MIN_NODE_MAJOR}+ required, found ${version}`;
}

// I3a (element-plus-F2): every flag the dry run can honour, in one place a
// test can read. `--framework` used to stop here: the real run forwards it and
// discloses that it does not change how a file mounts, while the dry run
// dropped it and was a silent no-op instead of a disclosed one.
export function explainPropsOptions(
  args: CliArgs,
  componentPath: string,
): { target?: string; noPreflight?: boolean; framework?: "react" | "vue" | "vanilla" | "auto" } {
  return {
    ...(args.targets?.[componentPath] ? { target: args.targets[componentPath] } : {}),
    ...(args.noPreflight ? { noPreflight: true } : {}),
    ...(args.framework ? { framework: args.framework } : {}),
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
        path.resolve(import.meta.dirname ?? __dirname, "../package.json"),
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
  const ciReports: import("./report.js").Report[] = [];

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
    setCurrentRunProjectRoot(resolveProjectPaths(path.resolve(componentPath)).projectRoot);
    // Item A: same lifecycle as the project root above -- reset before this
    // component's own run() populates it via AnalyzeOptions.onWarning, so a
    // surface-3 rejection on component 2 of a multi-component sweep never
    // reports component 1's warnings.
    resetCurrentRunWarnings();
    // M101: armed before the run, re-armed by every phase line it prints, so a
    // phase that stops making progress cannot hold this directory and this
    // browser forever. Cleared in the same iteration's finally.
    const budgetMs = runWatchdogBudgetMs(args.exploreBudgetSeconds);
    const runWatchdog = createRunWatchdog(budgetMs, () => {
      process.stderr.write(RUN_WATCHDOG_ABORT_ERROR(componentPath, budgetMs));
      void abortRun(2, { pool, serverPool });
    });
    try {
      const report = await runOne(
        componentPath,
        reportPaths[idx],
        args,
        pool,
        serverPool,
        () => runWatchdog.heartbeat(),
      );
      if (!args.ci) {
        process.stdout.write(formatTable(report) + "\n");
        process.stdout.write(formatWallClock(Date.now() - started) + "\n");
      }
      if (!report.pass) anyFail = true;
    } catch (err: unknown) {
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
      const writtenFilenames = reportPaths.map((p) => path.basename(p));
      if (args.saveBaseline) writtenFilenames.push("120fps-baseline.json");
      if (needsGitignoreAdvisory(gitRoot, writtenFilenames)) {
        process.stdout.write(GITIGNORE_ADVISORY_HINT + "\n");
      }
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
  browserPool?: import("./measure.js").BrowserPool,
  serverPool?: import("./harness.js").ServerPool,
  // M101: every phase line doubles as a liveness heartbeat for the run
  // watchdog. Under --ci the progress reporter is a no-op by design, so there
  // the budget bounds the whole run instead of one phase of it.
  onPhase?: () => void,
): Promise<import("./report.js").Report> {
  return analyze(componentPath, {
      ...(onPhase
        ? {
            onProgress: (line: string) => {
              onPhase();
              process.stdout.write(line + "\n");
            },
          }
        : {}),
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

// --- M32 D1: directory and glob expansion ---

export interface PathReader {
  exists: (p: string) => boolean;
  isDirectory: (p: string) => boolean;
  walk: (root: string) => string[];
}

const ACCEPTED_COMPONENT_EXTENSIONS = [".tsx", ".jsx", ".vue", ".ts", ".js"];

// Extension only: directory/glob expansion additionally filters build dirs
// and test/story/fixture suffixes via isComponentFile below; a plain path
// the user named explicitly should only be rejected for its extension.
export function hasAcceptedComponentExtension(filePath: string): boolean {
  const posix = filePath.replace(/\\/g, "/");
  if (posix.endsWith(".d.ts")) return false;
  return /\.(tsx|jsx|vue|ts|js)$/.test(posix);
}

// M77: extension alone is not enough for `.ts`/`.js` — MUI's own .js-with-JSX
// convention and Ark-UI-wrapper .ts-with-no-JSX shapes are both legitimate
// components, but a `.js`/`.ts` utility file with only camelCase exports is
// not. `.tsx`/`.jsx`/`.vue` short-circuit true with no content read: zero
// behavior change for extensions already accepted before this milestone.
export function hasComponentShape(filePath: string): boolean {
  const posix = filePath.replace(/\\/g, "/");
  if (/\.(tsx|jsx|vue)$/.test(posix)) return true;
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return scanExports(content, filePath).length > 0;
  } catch {
    return false;
  }
}

export function NO_COMPONENT_EXPORT_ERROR(filePath: string): string {
  return `${filePath} has no PascalCase-named export: 120fps could not find a component to measure in this file`;
}

export function isComponentFile(filePath: string): boolean {
  const posix = filePath.replace(/\\/g, "/");
  if (!hasAcceptedComponentExtension(posix)) return false;
  for (const segment of posix.split("/")) {
    for (const skip of SKIP_DIRS) {
      if (segment === skip || segment.startsWith(skip)) return false;
    }
  }
  const base = posix.slice(posix.lastIndexOf("/") + 1);
  if (SKIP_SUFFIX.some((s) => base.includes(s))) return false;
  return hasComponentShape(filePath);
}

// `*` stops at a separator, `**` does not. Nothing else is special, so a path
// with regex characters cannot change the meaning of a pattern.
function globToRegExp(pattern: string): RegExp {
  const posix = pattern.replace(/\\/g, "/");
  let out = "";
  for (let i = 0; i < posix.length; i++) {
    const ch = posix[i];
    if (ch === "*") {
      if (posix[i + 1] === "*") {
        out += ".*";
        i++;
        if (posix[i + 1] === "/") i++;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += /[.+?^${}()|[\]\\]/.test(ch) ? "\\" + ch : ch;
  }
  return new RegExp(`^${out}$`);
}

function globRoot(pattern: string): string {
  const posix = pattern.replace(/\\/g, "/");
  const star = posix.indexOf("*");
  const cut = posix.lastIndexOf("/", star === -1 ? posix.length : star);
  return cut <= 0 ? "." : posix.slice(0, cut);
}

export function expandComponentPaths(
  args: string[],
  reader: PathReader,
): { paths: string[]; error?: string } {
  const found = new Set<string>();

  for (const arg of args) {
    // Counted per argument, not against the running set: overlapping arguments
    // are a convenience, not a mistake to report.
    const matches: string[] = [];

    if (arg.includes("*")) {
      const re = globToRegExp(arg);
      // An absolute pattern (`C:/repo/src/**/*.tsx`, `/repo/src/**/*.tsx`) is
      // already anchored to the same frame nodePathReader().walk returns
      // (path.resolve at cli.ts:1207), so it must be tested against the
      // walked file's absolute form. A relative pattern (`src/**/*.tsx`) is
      // written against cwd, so the walked file is relativized to cwd first —
      // a no-op for the relative-path test double, since path.relative
      // resolves a relative `to` against cwd too.
      const patternIsAbsolute = path.isAbsolute(arg.replace(/\\/g, "/"));
      for (const file of reader.walk(globRoot(arg))) {
        const target = patternIsAbsolute
          ? file.replace(/\\/g, "/")
          : path.relative(process.cwd(), file).replace(/\\/g, "/");
        if (re.test(target) && isComponentFile(target)) matches.push(file);
      }
    } else if (reader.exists(arg) && reader.isDirectory(arg)) {
      for (const file of reader.walk(arg)) {
        if (isComponentFile(file)) matches.push(file);
      }
    } else if (reader.exists(arg)) {
      if (!hasAcceptedComponentExtension(arg)) {
        return {
          paths: [],
          error: `${arg} is not a component file: 120fps only measures ${ACCEPTED_COMPONENT_EXTENSIONS.join(", ")} files`,
        };
      }
      if (!hasComponentShape(arg)) {
        return { paths: [], error: NO_COMPONENT_EXPORT_ERROR(arg) };
      }
      matches.push(arg);
    }

    if (matches.length === 0) {
      // A plain path that is simply absent deserves the specific message; the
      // generic one is for directories and globs that yielded nothing.
      const missingFile = !arg.includes("*") && !reader.exists(arg);
      return {
        paths: [],
        error: missingFile
          ? `File not found: ${arg}`
          : `no component files matched "${arg}"`,
      };
    }
    for (const m of matches) found.add(m);
  }

  return { paths: [...found].sort() };
}

// Real filesystem behind the injected reader `expandComponentPaths` takes.
export function nodePathReader(): PathReader {
  const walk = (root: string): string[] => {
    const out: string[] = [];
    const visit = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRS.some((s) => entry.name === s || entry.name.startsWith(s))) continue;
          visit(full);
        } else if (entry.isFile()) {
          out.push(full);
        }
      }
    };
    visit(path.resolve(root));
    return out;
  };

  return {
    exists: (p) => fs.existsSync(path.resolve(p)),
    isDirectory: (p) => {
      try {
        return fs.statSync(path.resolve(p)).isDirectory();
      } catch {
        return false;
      }
    },
    walk,
  };
}

// Invoked last: every module-level declaration above is initialized before
// main() can run, so the direct-run path can never hit a temporal dead zone.
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"));

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
