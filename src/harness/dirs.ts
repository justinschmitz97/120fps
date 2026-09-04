import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toPosix } from "../shared/index.js";

// M73: the harness dir is created inside the project root by design (Vite's
// root is the project root, so the generated entry's root-absolute specifiers,
// the project's aliases, and its node_modules walk all resolve the way the app
// resolves them). A root that cannot be written to is therefore a refusal, and
// the raw EACCES that mkdtempSync throws says none of that.
export function HARNESS_DIR_UNWRITABLE(projectRoot: string, detail: string): string {
  return (
    `Cannot create the harness directory in ${projectRoot}: ${detail}. ` +
    "120fps writes its generated entry inside the project root so the project's own aliases and " +
    "node_modules resolve the way the app resolves them. Make that directory writable, or copy " +
    "the project to a writable location and measure it there."
  );
}

// M83 #7: harness directories created but not yet cleaned up. `cleanup`
// (the success path) and the bootServer catch's own rmSync (the common
// caught-and-rethrown failure path) both remove their entry as soon as they
// remove the directory. What is left in the set when the process actually
// exits is exactly the leftover a crash produces: `sweepStaleHarnessDirs`
// never removes a directory whose marker names a live process (and never one
// this process itself owns), so it cannot cover a directory the current run
// just abandoned, and a raw, unhandled exception (ant-design-F1's shape)
// bypasses every try/catch in this file entirely — the `process.on("exit")`
// handler below is the layer that still catches it, since Node's "exit"
// event fires after an uncaught exception terminates the process, not only
// on a graceful return.
const activeHarnessDirs = new Set<string>();

// M113 (base-ui-R1): on Windows a handle Chromium, the dev server or an
// esbuild worker still holds makes a removal throw EBUSY/EPERM/ENOTEMPTY, and
// that handle is gone milliseconds later. A single attempt turned a transient
// lock into a directory the developer found in `git status`.
export const HARNESS_DIR_REMOVAL_BUDGET_MS = 1000;
export const HARNESS_DIR_REMOVAL_MIN_ATTEMPTS = 5;
const HARNESS_DIR_REMOVAL_DELAY_MS = 200;
// Every outstanding directory together: a root full of locked leftovers must
// not push a signalled exit near the CLI's 8 s watchdog, so the per-directory
// budget above yields to this one.
export const HARNESS_SWEEP_BUDGET_MS = 1500;

// The codes a held handle produces. Anything else (ENOTDIR, a hostile
// injected remover) says the next attempt would fail the same way.
const HARNESS_DIR_RETRY_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY", "EMFILE", "ENFILE"]);

// The pending-delete shape: the removal reported success and the directory is
// still on disk. Leads with EBUSY so the retry decision reads it as retryable.
export const HARNESS_DIR_PENDING_DELETE_REASON =
  "EBUSY (still on disk after a removal that reported success)";

// The `process.on("exit")` handler permits synchronous work only, so the wait
// between attempts cannot be a timer.
function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// maxRetries covers the handle that closes within a few milliseconds without
// leaving this function; the loop around it owns the budget, the injection
// point and the disclosure.
function removeHarnessDirOnce(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
}

// M113 (final re-test): a removal that returns without throwing has not
// necessarily removed anything. On Windows a file another process opened with
// FILE_SHARE_DELETE unlinks into a pending-delete state and the directory
// survives the rmdir that reported success, so every caller crossed the
// directory off its list while it was still in `git status`. One attempt,
// answered by the disk: removal means gone.
function attemptHarnessDirRemoval(dir: string, remove: (dir: string) => void): string | undefined {
  try {
    remove(dir);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? (err as Error).message;
  }
  // A4 asks for the error code. No error occurred on this path, so the
  // reason says what the disk said instead of naming a code the OS never
  // produced; the retry decision below reads its leading code.
  return fs.existsSync(dir) ? HARNESS_DIR_PENDING_DELETE_REASON : undefined;
}

// Returns the error code of the last failed attempt, or undefined once the
// directory is gone. Never throws: every caller is on a teardown path.
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

// The path as the developer sees it: what `ls` in the directory they started
// the run from would print.
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

// M113 (final re-test): the run's own removal sites (`cleanup()` and the
// bootServer catch) crossed the directory off the moment their rmSync
// returned. On Windows that call returns on a directory that is still there,
// and the crossed-off directory became invisible to every later sweep,
// including the signal handler's. A directory is forgotten once it is gone.
export function forgetHarnessDirIfRemoved(dir: string): void {
  if (!fs.existsSync(dir)) activeHarnessDirs.delete(dir);
}

// The body the `process.on("exit")` handler below runs, and the pass the CLI
// runs after the pools have closed. A directory whose removal failed stays in
// the set: that is what makes the second pass — after Chromium and the dev
// server have let go — able to see it at all.
export function removeActiveHarnessDirs(
  options: {
    retry?: boolean;
    // Injected so the failure path is testable without contriving a real
    // Windows lock; every caller uses the default.
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

// Exported so the mechanism is testable without triggering a real process exit
// — a test can call this directly (or synthesize the event via
// `process.emit("exit")`, which Node runs its listeners for exactly as a real
// exit would, since listeners cannot tell the two apart). One attempt per
// directory: this is the pass that runs while the handles are still open, and
// the CLI's post-close pass is the one that spends the retry budget.
export function sweepActiveHarnessDirs(): void {
  removeActiveHarnessDirs();
}

// M113 (final re-test): the signal handler's last pass reads a set, and a
// harness directory the build creates a millisecond later is not in it. The
// pass latches this flag instead of racing: createHarnessDir below removes
// what it creates from that point on, under the same budget and with the same
// disclosure, so the handler covers every directory this process created,
// including the ones it created after the sweep started.
let harnessDirTeardownStarted = false;

export function beginHarnessDirTeardown(): void {
  harnessDirTeardownStarted = true;
}

// M113 (final re-test): the last exit any run can take, and until now the one
// that spent a single attempt and said nothing. `abortRun`'s deadline timer
// and `closePoolsBounded`'s own are both unref'd, so a signalled run whose
// `closeAll` never settles drains its loop and leaves through here, with the
// signal's code already recorded and the pass that retries never reached: exit
// 143, a silent EBUSY, and `.120fps-harness-FeVcEh/` in `git status`. This
// handler spends the same budget and prints the same line. The retries are
// synchronous (`sleepSync`), which is all this event permits, and a run that
// left nothing behind reads an empty set and costs nothing.
export function sweepActiveHarnessDirsOnExit(): void {
  for (const failure of removeActiveHarnessDirs({ retry: true })) {
    process.stderr.write(HARNESS_DIR_REMOVAL_FAILED_WARNING(failure.dir, failure.reason) + "\n");
  }
}

let exitSweepRegistered = false;
function registerHarnessDirExitSweep(): void {
  if (exitSweepRegistered) return;
  exitSweepRegistered = true;
  process.on("exit", sweepActiveHarnessDirsOnExit);
}
registerHarnessDirExitSweep();

// M113: what a build reads when it asked for a harness directory after the
// teardown sweep latched. The directory was created and removed again, so
// there is no path to hand back.
export const HARNESS_DIR_TEARDOWN_IN_PROGRESS =
  "120fps is shutting down: the harness directory was removed by the teardown sweep.";

// accessSync answers POSIX permission bits; the real mkdtempSync answers
// everything it cannot see (Windows ACLs, a read-only mount, a root that is a
// file or does not exist).
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
    // M83 #7: tracked from the moment it exists, regardless of what happens
    // next — `cleanup()` and the bootServer catch's own rmSync both remove
    // it as soon as they remove the directory; anything left when the
    // process exits is a leftover the exit sweep above still has to catch.
    activeHarnessDirs.add(dir);
    // M101: written before the teardown branch below, so a directory whose
    // retry budget runs out down there carries its owner pid, and the next
    // run's stale sweep removes it on the dead-pid path instead of waiting
    // out the one-hour age gate the line below promises it will not wait out.
    // Best-effort: a marker that cannot be written costs the directory only
    // the older, more conservative age gate, and must never fail the run that
    // was about to measure.
    try {
      fs.writeFileSync(path.join(dir, HARNESS_PID_FILE), `${process.pid}\n`);
    } catch {
      // Unwritable marker: sweepStaleHarnessDirs falls back to age alone.
    }
  } catch (err) {
    return fail(err);
  }
  // M113 (final re-test): the signal arrived while this directory was being
  // created, so the handler's sweep could not have seen it. The handler's
  // work happens here instead, on the same budget, rather than leaving the
  // directory for the next run to find.
  if (harnessDirTeardownStarted) {
    const reason = removeHarnessDirWithRetries(dir);
    if (reason === undefined) activeHarnessDirs.delete(dir);
    else {
      process.stderr.write(
        HARNESS_DIR_REMOVAL_FAILED_WARNING(harnessDirDisplayPath(dir, process.cwd()), reason) + "\n",
      );
    }
    // The directory is gone either way, so handing its path back would fail
    // the build on an unrelated ENOENT for entry.tsx after the abort
    // sentence. The build stops here instead, named.
    throw new Error(HARNESS_DIR_TEARDOWN_IN_PROGRESS);
  }
  return dir;
}

// M101 (V2 repro 5): the process that owns a harness directory, so a later run
// can remove an abandoned one immediately instead of waiting out an age gate
// that exists only because nothing knew whose directory it was.
export const HARNESS_PID_FILE = ".pid";

function harnessDirOwnerPid(dir: string): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(dir, HARNESS_PID_FILE), "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

// M101 (review A6): the directory's own mtime stops advancing the moment the
// build finishes writing entry.tsx, so a run longer than the gate looks
// abandoned while it is measuring. The marker is the heartbeat instead, and
// the run refreshes it at every phase (see the CLI's onPhase).
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

// Signal 0 sends nothing: it asks the OS whether the pid could be signalled.
// EPERM means the pid exists and belongs to someone else — alive, and not this
// run's directory to delete.
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A directory with no pid marker was created by a build that did not write one:
// nothing here can tell whether it is in use, so it keeps the original,
// conservative gate (M24 D8).
export const STALE_HARNESS_MAX_AGE_MS = 60 * 60 * 1000;
// M101: a marked directory whose process is alive is in use — until it has been
// sitting for this long, at which point the pid is more likely recycled than
// still measuring.
export const LIVE_PID_HARNESS_MAX_AGE_MS = 10 * 60 * 1000;

// Best-effort removal of .120fps-harness-* leftovers. M101: a directory whose
// marked owner is gone is removed at any age — that is exactly the leftover an
// external kill produces (V2 repro 5), and waiting an hour for it served no
// purpose once the owner is known.
// M101 (dub leftover): a removal that cannot succeed used to be swallowed with
// the same `catch` that covers "already gone", so a directory another process
// still holds open looked identical to one nothing was wrong with. The reason
// is now the run's own disclosure.
export function HARNESS_DIR_UNREMOVABLE_WARNING(dir: string, reason: string): string {
  return (
    `${dir} is a leftover harness directory this run could not remove (${reason}). It belongs to a ` +
    "120fps process that is gone or idle; remove it by hand, or close whatever still holds a file " +
    "inside it open."
  );
}

// M113 A5: the run that removed a leftover said nothing, so the developer had
// no evidence the previous run had left anything behind at all.
export function HARNESS_DIR_SWEPT_WARNING(dir: string, reason: string): string {
  return `Removed a stale harness directory from an earlier run: ${dir} (${reason}).`;
}

export function sweepStaleHarnessDirs(
  projectRoot: string,
  warningsOut?: string[],
  // Injected so the failure path is testable without contriving a real
  // Windows lock; every caller uses the default.
  remove: (dir: string) => void = (dir) => fs.rmSync(dir, { recursive: true, force: true }),
): void {
  try {
    const now = Date.now();
    // M113 A6: the retries are bounded across the whole sweep, so a root full
    // of locked leftovers cannot delay the start of a run.
    const deadline = now + HARNESS_SWEEP_BUDGET_MS;
    for (const entry of fs.readdirSync(projectRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(".120fps-harness-")) continue;
      const full = path.join(projectRoot, entry.name);
      try {
        const owner = harnessDirOwnerPid(full);
        // Never this process's own directory, at any age: this run knows it is
        // still using it, and its own exit paths already remove it.
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
// Bounds worst-case sweep time against a pathologically large temp dir; any
// remainder is picked up on the next sweep.
export const TMP_SWEEP_MAX_REMOVALS = 500;

// M56: best-effort removal of this tool's own OS-tmp leftovers (e.g.
// `120fps-ctx-*`, `120fps-memo-*`) older than 24h. A directory belonging to a
// live run is by construction younger than the cutoff, so no lockfile is
// needed: prefix + location + age is a three-factor guard against deleting
// anything foreign. Takes baseDir as a parameter for testability; real runs
// use the OS temp dir.
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
