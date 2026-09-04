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

// A fatal error can print in full and then the process stays alive until
// an external `timeout` kills it (EXIT=124). Pool/server
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
// A timed-out closeAll() is abandoned here, not force-killed. Fixing that
// requires reaching the underlying Chromium OS process, and Playwright's
// public API gives no way to do that from a `Browser` obtained via
// `chromium.launch()` (what createBrowserPool uses) --
// `.process()`/`.kill()` exist only on `BrowserServer`, the return type of
// the unrelated `chromium.launchServer()` API, and the client-side
// `Browser` object (lib/client/browser.js) holds no process handle at all
// -- the actual spawn happens through playwright-core's private
// server-side internals, not reachable from here without importing a
// non-exported module path. Switching createBrowserPool to
// launchServer()+connect() would fix this properly but is a larger change
// to a path every measurement goes through. Left as a documented
// limitation rather than shipped as an unverified or fragile private-API
// reach-in.
export async function closePoolsBounded(
  pool: Pick<import("../browser/index.js").BrowserPool, "closeAll">,
  serverPool: Pick<import("../harness/index.js").ServerPool, "closeAll">,
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

// Node emits no "exit" event for a process a signal terminates, so
// the `process.on("exit")` sweep in harness/dirs.ts — the only last-resort
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
  pool: Pick<import("../browser/index.js").BrowserPool, "closeAll">;
  serverPool: Pick<import("../harness/index.js").ServerPool, "closeAll">;
};

// The one teardown every abrupt exit path shares. Directories go first: that
// removal is synchronous and depends on nothing settling, so it survives a pool
// close that never returns. Closing the browser pool is what ends Chromium, and
// the dev-server pool takes its esbuild workers with it; when either hangs,
// armExitWatchdog still delivers the exit code, by which point nothing is left
// on disk.
//
// The first removal runs while Chromium, the dev server and its esbuild
// workers still hold handles on entry.tsx, index.html and the directory
// itself, so on Windows it can throw EBUSY and leave the directory behind.
// The second pass below runs once those handles are gone, retries a busy
// removal, and says so when a directory still survives.
export function sweepHarnessDirsAfterClose(
  hooks: {
    remove?: (dir: string) => void;
    warn?: (line: string) => void;
    cwd?: string;
  } = {},
): void {
  const warn = hooks.warn ?? ((line: string) => console.error(line));
  // From here on a harness directory the build is still
  // creating removes itself the moment it exists. The set this pass reads was
  // fixed when the pass started, and the build does not stop because a signal
  // arrived; latching is what makes "every directory this process created"
  // true rather than "every directory that existed when the sweep began".
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
  // The exit happens once, whether the bounded close finishes or the deadline
  // beats it. armExitWatchdog is not reused here because its exit is hardwired
  // to process.exit: the deadline has to leave through the same door as the
  // ordinary path, so a caller (and a test) sees exactly one exit.
  let exited = false;
  // The retrying, disclosing pass runs on both ways out, so a run whose
  // pools never settle still gets a post-close sweep attempt and a
  // disclosure if the directory survives it. One pass either way, at most
  // once.
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
  // Both this deadline and closePoolsBounded's own timer are
  // unref'd, so if every handle closes while a pool close is still pending the
  // loop drains and Node exits on its own. Recording the code first makes that
  // exit the documented one instead of 0.
  process.exitCode = exitCode;
  const deadline = setTimeout(exitOnce, timeoutMs);
  deadline.unref();
  if (pools) await closePoolsBounded(pools.pool, pools.serverPool, timeoutMs);
  clearTimeout(deadline);
  // The pass that actually leaves the working tree clean: the handles are gone
  // by now, and a directory the first pass could not remove is still tracked.
  sweepAfterClose();
  exitOnce();
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

// Registered on the real CLI process only, never when cli/main.ts is imported by a
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

// Under --ci the progress reporter is a no-op by design
// (`resolveProgressReporter`, pipeline/analyze.ts), so no phase line arrives and this
// timer bounds the whole run rather than one phase of it. Two different facts,
// two different sentences: "made no progress" is false of a --ci run that was
// working the entire time.
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

// What an aborted run says on its way out. The two lines a finished run
// prints around its table are the two an aborted run needs most: which
// roots it resolved, and how long it spent before it was stopped.
export function watchdogAbortOutput(
  componentPath: string,
  budgetMs: number,
  bound: "stalled" | "total",
  elapsedMs: number,
  ci: boolean,
): { stderr: string; stdout: string } {
  // The roots line resolves the project model, which reads the filesystem --
  // inside the watchdog's timer callback, on a machine already in the state
  // that caused the abort. An exception there would escape the timer and skip
  // the `abortRun` that closes the pools and sweeps the harness dirs, so the
  // roots line is the only part of this output that can be lost.
  let stdout = "";
  if (!ci) {
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

// A harness directory this run left behind is about to be tracked; one
// it cleaned up is not, and asks for no pattern.
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
