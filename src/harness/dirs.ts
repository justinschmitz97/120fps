import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toPosix } from "../shared/index.js";

// In the project root because Vite's root is the project root: aliases resolve as the app's.
export function HARNESS_DIR_UNWRITABLE(projectRoot: string, detail: string): string {
  return (
    `Cannot create the harness directory in ${projectRoot}: ${detail}. ` +
    "120fps writes its generated entry inside the project root so the project's own aliases and " +
    "node_modules resolve the way the app resolves them. Make that directory writable, or copy " +
    "the project to a writable location and measure it there."
  );
}

// What remains at process exit is exactly the leftover a crash produces.
const activeHarnessDirs = new Set<string>();

// On Windows a handle held by Chromium or esbuild makes removal throw, and is gone in ms.
export const HARNESS_DIR_REMOVAL_BUDGET_MS = 1000;
export const HARNESS_DIR_REMOVAL_MIN_ATTEMPTS = 5;
const HARNESS_DIR_REMOVAL_DELAY_MS = 200;
// A root full of locked leftovers must not push a signalled exit near the CLI's 8s watchdog.
export const HARNESS_SWEEP_BUDGET_MS = 1500;

// The codes a held handle produces; anything else would fail the same way next attempt.
const HARNESS_DIR_RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"]);

// Leads with EBUSY so the retry decision reads it as retryable.
export const HARNESS_DIR_PENDING_DELETE_REASON =
  "EBUSY (still on disk after a removal that reported success)";

// The `process.on("exit")` handler permits synchronous work only, so this cannot be a timer.
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// maxRetries covers a handle closing within milliseconds; the loop around it owns the budget.
function removeHarnessDirOnce(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
}

// A removal that returns without throwing has not necessarily removed anything on Windows.
function attemptHarnessDirRemoval(dir: string, remove: (dir: string) => void): string | undefined {
  try {
    remove(dir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? (err as Error).message;
  }
  // No error occurred here, so the reason names what the disk said, not a code the OS gave.
  return fs.existsSync(dir) ? HARNESS_DIR_PENDING_DELETE_REASON : undefined;
}

// The last failed attempt's code, or undefined once gone; never throws, callers are tearing down.
export function removeHarnessDirWithRetries(
  dir: string,
  remove: (dir: string) => void = removeHarnessDirOnce,
  deadline: number = Date.now() + HARNESS_SWEEP_BUDGET_MS,
): string | undefined {
  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    const reason = attemptHarnessDirRemoval(dir, remove);
    if (reason === undefined) return undefined;
    if (!HARNESS_DIR_RETRY_CODES.has(reason.split(" ")[0])) return reason;
    const spent = Date.now() - started;
    const budgetSpent =
      attempt >= HARNESS_DIR_REMOVAL_MIN_ATTEMPTS && spent >= HARNESS_DIR_REMOVAL_BUDGET_MS;
    if (budgetSpent || Date.now() >= deadline) return reason;
    sleepSync(Math.min(HARNESS_DIR_REMOVAL_DELAY_MS, deadline - Date.now()));
  }
}

// The path as the developer sees it: what `ls` from the run's own directory would print.
function harnessDirDisplayPath(dir: string, cwd: string): string {
  const rel = path.relative(cwd, dir);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? toPosix(rel) : dir;
}

export function HARNESS_DIR_REMOVAL_FAILED_WARNING(dir: string, reason: string): string {
  return (
    `Could not remove the harness directory ${dir} (${reason}). It is this run's own scratch ` +
    "directory, not part of your project; remove it by hand, or the next run in this project will."
  );
}

// A directory is forgotten once it is gone: on Windows rmSync returns with it still there.
export function forgetHarnessDirIfRemoved(dir: string): void {
  if (!fs.existsSync(dir)) activeHarnessDirs.delete(dir);
}

// A directory whose removal failed stays in the set, so a later pass can still see it.
export function removeActiveHarnessDirs(
  options: {
    retry?: boolean;
    // Injected so the failure path is testable without contriving a real Windows lock.
    remove?: (dir: string) => void;
    cwd?: string;
  } = {},
): Array<{ dir: string; reason: string }> {
  const remove = options.remove ?? removeHarnessDirOnce;
  const cwd = options.cwd ?? process.cwd();
  const deadline = Date.now() + HARNESS_SWEEP_BUDGET_MS;
  const failures: Array<{ dir: string; reason: string }> = [];
  for (const dir of activeHarnessDirs) {
    let reason: string | undefined;
    if (options.retry) {
      reason = removeHarnessDirWithRetries(dir, remove, deadline);
    } else {
      reason = attemptHarnessDirRemoval(dir, remove);
    }
    if (reason === undefined) activeHarnessDirs.delete(dir);
    else failures.push({ dir: harnessDirDisplayPath(dir, cwd), reason });
  }
  return failures;
}

// One attempt per directory: this pass runs while the handles are still open.
export function sweepActiveHarnessDirs(): void {
  removeActiveHarnessDirs();
}

// Latched rather than raced: a directory created after the sweep started is covered too.
let harnessDirTeardownStarted = false;

export function beginHarnessDirTeardown(): void {
  harnessDirTeardownStarted = true;
}

// The last exit any run can take, so this pass spends the budget and prints the same line.
export function sweepActiveHarnessDirsOnExit(): void {
  for (const failure of removeActiveHarnessDirs({ retry: true })) {
    process.stderr.write(HARNESS_DIR_REMOVAL_FAILED_WARNING(failure.dir, failure.reason) + "\n");
  }
}

let exitSweepRegistered = false;
function registerHarnessDirExitSweep(): void {
  if (exitSweepRegistered) return;
  exitSweepRegistered = true;
  // Node fires "exit" after an uncaught exception too, which bypasses every try/catch here.
  process.on("exit", sweepActiveHarnessDirsOnExit);
}
registerHarnessDirExitSweep();

// The directory was created and removed again, so there is no path to hand back.
export const HARNESS_DIR_TEARDOWN_IN_PROGRESS =
  "120fps is shutting down: the harness directory was removed by the teardown sweep.";

// accessSync answers POSIX bits only; mkdtempSync answers ACLs and read-only mounts too.
export function createHarnessDir(projectRoot: string): string {
  const fail = (err: unknown): never => {
    throw new Error(
      HARNESS_DIR_UNWRITABLE(projectRoot, err instanceof Error ? err.message : String(err)),
      { cause: err },
    );
  };
  try {
    fs.accessSync(projectRoot, fs.constants.W_OK);
  } catch (err) {
    return fail(err);
  }
  let dir: string;
  try {
    dir = fs.mkdtempSync(path.join(projectRoot, ".120fps-harness-"));
    // Tracked from the moment it exists: anything left at exit is for the exit sweep.
    activeHarnessDirs.add(dir);
    // Written before the teardown branch, so a directory surviving it carries its owner pid.
    try {
      fs.writeFileSync(path.join(dir, HARNESS_PID_FILE), `${process.pid}\n`);
    } catch {
      // Unwritable marker: sweepStaleHarnessDirs falls back to age alone.
    }
  } catch (err) {
    return fail(err);
  }
  // The signal arrived while this directory was being created, so no sweep could see it.
  if (harnessDirTeardownStarted) {
    const reason = removeHarnessDirWithRetries(dir);
    if (reason === undefined) activeHarnessDirs.delete(dir);
    else {
      process.stderr.write(
        HARNESS_DIR_REMOVAL_FAILED_WARNING(harnessDirDisplayPath(dir, process.cwd()), reason) + "\n",
      );
    }
    // Handing the path back would fail the build on an unrelated ENOENT for entry.tsx.
    throw new Error(HARNESS_DIR_TEARDOWN_IN_PROGRESS);
  }
  return dir;
}

// The owning process, so a later run can remove an abandoned directory without an age gate.
export const HARNESS_PID_FILE = ".pid";

function harnessDirOwnerPid(dir: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(dir, HARNESS_PID_FILE), "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

// mtime stops advancing once entry.tsx is written, so the marker is the heartbeat instead.
function harnessDirHeartbeatMs(dir: string): number | undefined {
  try {
    return fs.statSync(path.join(dir, HARNESS_PID_FILE)).mtimeMs;
  } catch {
    return undefined;
  }
}

export function refreshHarnessDirMarkers(): void {
  for (const dir of activeHarnessDirs) {
    try {
      const now = new Date();
      fs.utimesSync(path.join(dir, HARNESS_PID_FILE), now, now);
    } catch {
      // Best-effort: a directory already removed, or a marker never written.
    }
  }
}

// Signal 0 sends nothing; EPERM means the pid exists and belongs to someone else.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// With no pid marker nothing can tell whether a directory is in use, so the gate stays long.
export const STALE_HARNESS_MAX_AGE_MS = 60 * 60 * 1000;
// Past this, a live owner pid is more likely recycled than still measuring.
export const LIVE_PID_HARNESS_MAX_AGE_MS = 10 * 60 * 1000;

// The reason distinguishes an already-gone directory from one another process holds open.
export function HARNESS_DIR_UNREMOVABLE_WARNING(dir: string, reason: string): string {
  return (
    `${dir} is a leftover harness directory this run could not remove (${reason}). It belongs to a ` +
    "120fps process that is gone or idle; remove it by hand, or close whatever still holds a file " +
    "inside it open."
  );
}

// Evidence an earlier run left something behind, instead of it disappearing silently.
export function HARNESS_DIR_SWEPT_WARNING(dir: string, reason: string): string {
  return `Removed a stale harness directory from an earlier run: ${dir} (${reason}).`;
}

export function sweepStaleHarnessDirs(
  projectRoot: string,
  warningsOut?: string[],
  // Injected so the failure path is testable without contriving a real Windows lock.
  remove: (dir: string) => void = (dir) => fs.rmSync(dir, { recursive: true, force: true }),
): void {
  try {
    const now = Date.now();
    // Bounded across the whole sweep, so a root full of locked leftovers cannot delay a run.
    const deadline = now + HARNESS_SWEEP_BUDGET_MS;
    for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(".120fps-harness-")) continue;
      const full = path.join(projectRoot, entry.name);
      try {
        const owner = harnessDirOwnerPid(full);
        // Never this process's own directory, at any age: its exit paths already remove it.
        if (owner === process.pid) continue;
        const staleBecause =
          owner === undefined
            ? now - fs.statSync(full).mtimeMs > STALE_HARNESS_MAX_AGE_MS
              ? "unmarked and older than the age gate"
              : undefined
            : !isProcessAlive(owner)
              ? "its owner process is gone"
              : now - (harnessDirHeartbeatMs(full) ?? 0) > LIVE_PID_HARNESS_MAX_AGE_MS
                ? "its owner stopped heartbeating"
                : undefined;
        if (staleBecause === undefined) continue;
        const shown = toPosix(path.relative(projectRoot, full)) || entry.name;
        const failure = removeHarnessDirWithRetries(full, remove, deadline);
        warningsOut?.push(
          failure === undefined
            ? HARNESS_DIR_SWEPT_WARNING(shown, staleBecause)
            : HARNESS_DIR_UNREMOVABLE_WARNING(shown, failure),
        );
      } catch {
        // best-effort: the directory may have vanished between readdir and stat
      }
    }
  } catch {
    // best-effort: unreadable project root
  }
}

const TMP_SWEEP_PREFIX = /^\.?120fps-/;
const TMP_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Bounds worst-case sweep time; any remainder is picked up on the next sweep.
export const TMP_SWEEP_MAX_REMOVALS = 500;

// Prefix, location and age are a three-factor guard against deleting anything foreign.
export function sweepStaleTmpDirs(baseDir: string = os.tmpdir()): void {
  try {
    const cutoff = Date.now() - TMP_SWEEP_MAX_AGE_MS;
    let removed = 0;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (removed >= TMP_SWEEP_MAX_REMOVALS) break;
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (!TMP_SWEEP_PREFIX.test(entry.name)) continue;
      const full = path.join(baseDir, entry.name);
      try {
        // lstat, not stat: never follow a symlink out of the temp dir.
        const stat = fs.lstatSync(full);
        if (!stat.isDirectory() || stat.mtimeMs >= cutoff) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch {
        // best-effort: in use, permission-denied, or already gone
      }
    }
  } catch {
    // best-effort: unreadable or nonexistent temp dir
  }
}
