import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  beginHarnessDirTeardown,
  HARNESS_DIR_REMOVAL_FAILED_WARNING,
  removeActiveHarnessDirs,
  sweepActiveHarnessDirs,
} from "../harness/index.js";
import { formatTotalLine, resolvedRootsOutput } from "./main.js";

// Teardown that never settles must not block the documented exit code from being delivered.
export const FATAL_EXIT_WATCHDOG_MS = 8000;

export function armExitWatchdog(
  exitCode: number,
  timeoutMs: number = FATAL_EXIT_WATCHDOG_MS,
): NodeJS.Timeout {
  const timer = setTimeout(() => process.exit(exitCode), timeoutMs);
  // Unref'd: never keeps an idle process alive; a hung teardown holds other handles anyway.
  timer.unref();
  return timer;
}

// A timed-out closeAll is abandoned, not killed: chromium.launch() Browser exposes no process.
export async function closePoolsBounded(
  pool: Pick<import("../browser/index.js").BrowserPool, "closeAll">,
  serverPool: Pick<import("../harness/index.js").ServerPool, "closeAll">,
  timeoutMs: number = FATAL_EXIT_WATCHDOG_MS,
): Promise<void> {
  // Promise.resolve().then: a synchronous throw must reach allSettled as a rejection.
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

// Node emits no exit event for a signalled process, so the sweep in harness/dirs.ts never runs.
export const TERMINATION_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];

// Shell convention for a signalled process: 130 SIGINT, 143 SIGTERM, 129 SIGHUP.
export function terminationExitCode(signal: NodeJS.Signals): number {
  return 128 + (os.constants.signals[signal as keyof typeof os.constants.signals] ?? 0);
}

type ClosablePools = {
  pool: Pick<import("../browser/index.js").BrowserPool, "closeAll">;
  serverPool: Pick<import("../harness/index.js").ServerPool, "closeAll">;
};

// The retrying pass: the first removal can hit EBUSY on Windows while handles are still open.
export function sweepHarnessDirsAfterClose(
  hooks: {
    remove?: (dir: string) => void;
    warn?: (line: string) => void;
    cwd?: string;
  } = {},
): void {
  const warn = hooks.warn ?? ((line: string) => console.error(line));
  // Latched: every directory this process created, not every one that existed at sweep start.
  beginHarnessDirTeardown();
  for (const failure of removeActiveHarnessDirs({
    retry: true,
    remove: hooks.remove,
    cwd: hooks.cwd,
  })) {
    warn(HARNESS_DIR_REMOVAL_FAILED_WARNING(failure.dir, failure.reason));
  }
}

export async function abortRun(
  exitCode: number,
  pools?: ClosablePools,
  hooks: {
    sweep?: () => void;
    finalSweep?: () => void;
    exit?: (code: number) => void;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  (hooks.sweep ?? sweepActiveHarnessDirs)();
  const timeoutMs = hooks.timeoutMs ?? FATAL_EXIT_WATCHDOG_MS;
  const exit = hooks.exit ?? ((code: number) => process.exit(code));
  // Not armExitWatchdog: its exit is hardwired to process.exit, and both paths must exit once.
  let exited = false;
  // Both ways out sweep, at most once: pools that never settle still get a post-close attempt.
  let sweptAfterClose = false;
  const sweepAfterClose = (): void => {
    if (sweptAfterClose) return;
    sweptAfterClose = true;
    (hooks.finalSweep ?? hooks.sweep ?? (() => sweepHarnessDirsAfterClose()))();
  };
  const exitOnce = (): void => {
    if (exited) return;
    exited = true;
    sweepAfterClose();
    exit(exitCode);
  };
  // Unref'd timers let Node exit on its own; recording the code first keeps that exit non-zero.
  process.exitCode = exitCode;
  const deadline = setTimeout(exitOnce, timeoutMs);
  deadline.unref();
  if (pools) await closePoolsBounded(pools.pool, pools.serverPool, timeoutMs);
  clearTimeout(deadline);
  // Handles are gone by now, so a directory the first pass could not remove is retried here.
  sweepAfterClose();
  exitOnce();
}

// Re-armed per phase, so the budget bounds a stalled phase rather than a long, working run.
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

// Real CLI process only: a global handler that exits would take a whole test suite with it.
export function registerTerminationHandlers(): void {
  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, () => {
      void abortRun(terminationExitCode(signal), activePools);
    });
  }
}

// The total-budget wording is for a caller that reports no phase boundaries.
export function RUN_WATCHDOG_ABORT_ERROR(
  componentPath: string,
  budgetMs: number,
  bound: "stalled" | "total",
): string {
  const minutes = Math.round(budgetMs / 60_000);
  const lead =
    bound === "stalled"
      ? `${componentPath} made no progress for ${minutes} minutes`
      : `${componentPath} exceeded its total budget of ${minutes} minutes (no phase boundaries ` +
        "were reported, so the whole run is bounded rather than each phase)";
  return (
    `Error: ${lead}; aborting the run, removing its harness directory and closing its browser. ` +
    "Re-run with --explore-budget to allow a longer exploration, or with --no-deltas / " +
    "--max-combos to measure less.\n"
  );
}

export function watchdogAbortOutput(
  componentPath: string,
  budgetMs: number,
  bound: "stalled" | "total",
  elapsedMs: number,
  ci: boolean,
): { stderr: string; stdout: string } {
  let stdout = "";
  if (!ci) {
    // An exception here would escape the timer and skip the abortRun that closes the pools.
    try {
      stdout = resolvedRootsOutput(componentPath, false) + formatTotalLine(elapsedMs, undefined) + "\n";
    } catch {
      stdout = formatTotalLine(elapsedMs, undefined) + "\n";
    }
  }
  return {
    stderr: RUN_WATCHDOG_ABORT_ERROR(componentPath, budgetMs, bound),
    stdout,
  };
}

export function harnessLeftoverDirs(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(".120fps-harness-"))
    .map((entry) => path.join(dir, entry.name));
}
