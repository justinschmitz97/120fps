import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  abortRun,
  createRunWatchdog,
  registerTerminationHandlers,
  TERMINATION_SIGNALS,
  RUN_WATCHDOG_ABORT_ERROR,
  runWatchdogBudgetMs,
  terminationExitCode,
} from "../../src/cli.js";
import { resolveProgressReporter } from "../../src/analyze.js";
import {
  createHarnessDir,
  HARNESS_PID_FILE,
  LIVE_PID_HARNESS_MAX_AGE_MS,
  refreshHarnessDirMarkers,
  sweepStaleHarnessDirs,
} from "../../src/harness.js";

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function mkRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-killed-"));
  roots.push(dir);
  return dir;
}

function ageDir(dir: string, ms: number): void {
  const then = new Date(Date.now() - ms);
  fs.utimesSync(dir, then, then);
}

function mkHarnessDir(root: string, name: string, pid?: number): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  if (pid !== undefined) fs.writeFileSync(path.join(dir, HARNESS_PID_FILE), String(pid));
  return dir;
}

// A pid the OS will not have handed out again: 2^22 is above every default
// pid_max, and Windows pids are multiples of 4 well below it.
const DEAD_PID = 4_194_303;

const idlePools = {
  pool: { closeAll: async () => {} },
  serverPool: { closeAll: async () => {} },
};

describe("exit code for a signalled run", () => {
  it("is 128 plus the signal number", () => {
    expect(terminationExitCode("SIGINT")).toBe(130);
    expect(terminationExitCode("SIGTERM")).toBe(143);
    expect(terminationExitCode("SIGHUP")).toBe(129);
  });
});

// M101 Verification: "signal handler registered for all three signals".
// calcom-R1 reported a node process with the run's own argv still alive after
// a completed run. Nothing in this codebase starts one: a re-exec, a fork or a
// worker pool would be a child no exit path reaps, so the absence is the
// invariant worth pinning.
describe("processes a run is responsible for", () => {
  it("starts no second node process of its own", () => {
    const sources = fs
      .readdirSync(path.resolve("src"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => [name, fs.readFileSync(path.resolve("src", name), "utf-8")] as const);
    const spawners = sources.filter(
      ([, text]) =>
        /fork\s*\(/.test(text) ||
        /spawn(Sync)?\s*\(/.test(text) ||
        /process\.execPath/.test(text) ||
        /new\s+Worker\s*\(/.test(text),
    );
    expect(spawners.map(([name]) => name)).toEqual([]);
  });

  it("uses child_process only for the synchronous git calls of --compare", () => {
    const users = fs
      .readdirSync(path.resolve("src"))
      .filter((name) => name.endsWith(".ts"))
      .filter((name) => /node:child_process/.test(fs.readFileSync(path.resolve("src", name), "utf-8")));
    expect(users).toEqual(["compare.ts"]);
    expect(fs.readFileSync(path.resolve("src", "compare.ts"), "utf-8")).toContain("execFileSync");
  });
});

describe("the signals a run installs a handler for", () => {
  it("registers one handler per termination signal", () => {
    const before = new Map(
      TERMINATION_SIGNALS.map((signal) => [signal, process.listeners(signal).slice()]),
    );
    try {
      registerTerminationHandlers();
      for (const signal of TERMINATION_SIGNALS) {
        const added = process
          .listeners(signal)
          .filter((listener) => !before.get(signal)!.includes(listener));
        expect(added).toHaveLength(1);
      }
      expect(TERMINATION_SIGNALS).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    } finally {
      for (const signal of TERMINATION_SIGNALS) {
        for (const listener of process.listeners(signal)) {
          if (!before.get(signal)!.includes(listener)) process.off(signal, listener);
        }
      }
    }
  });
});

describe("tearing down a run that was told to stop", () => {
  it("removes the harness directories before closing the pools", async () => {
    const order: string[] = [];
    await abortRun(
      130,
      {
        pool: { closeAll: async () => void order.push("browsers") },
        serverPool: { closeAll: async () => void order.push("servers") },
      },
      { sweep: () => order.push("dirs"), exit: () => order.push("exit") },
    );
    expect(order[0]).toBe("dirs");
    expect(order).toContain("browsers");
    expect(order).toContain("servers");
    expect(order[order.length - 1]).toBe("exit");
  });

  it("exits with the code it was given", async () => {
    const codes: number[] = [];
    await abortRun(143, idlePools, { sweep: () => {}, exit: (code) => codes.push(code) });
    expect(codes).toEqual([143]);
  });

  it("still exits when a pool never finishes closing", async () => {
    const codes: number[] = [];
    await abortRun(
      130,
      { pool: { closeAll: () => new Promise<void>(() => {}) }, serverPool: { closeAll: async () => {} } },
      { sweep: () => {}, exit: (code) => codes.push(code), timeoutMs: 20 },
    );
    expect(codes).toEqual([130]);
  });

  // A killed run must not exit 0 because the event loop drained while a pool
  // close was still pending: the deadline timer is unref'd by design.
  it("records the exit code before it starts waiting on the pools", async () => {
    const before = process.exitCode;
    let observed: number | string | undefined;
    await abortRun(
      130,
      {
        pool: {
          closeAll: async () => {
            observed = process.exitCode;
          },
        },
        serverPool: { closeAll: async () => {} },
      },
      { sweep: () => {}, exit: () => {} },
    );
    process.exitCode = before;
    expect(observed).toBe(130);
  });

  it("sweeps even with no pools to close", async () => {
    const swept: string[] = [];
    await abortRun(129, undefined, { sweep: () => swept.push("dirs"), exit: () => {} });
    expect(swept).toEqual(["dirs"]);
  });
});

describe("the budget that bounds a whole run", () => {
  it("is twenty minutes at the CLI's own default explore budget", () => {
    expect(runWatchdogBudgetMs(undefined)).toBe(20 * 60_000);
    expect(runWatchdogBudgetMs(300)).toBe(20 * 60_000);
  });

  it("adds ten minutes to a longer explore budget", () => {
    expect(runWatchdogBudgetMs(1800)).toBe(1800_000 + 10 * 60_000);
  });

  it("never drops below twenty minutes for a short explore budget", () => {
    expect(runWatchdogBudgetMs(20)).toBe(20 * 60_000);
  });
});

describe("a phase that stops making progress", () => {
  it("aborts once the budget passes with no heartbeat", async () => {
    const fired: string[] = [];
    const watchdog = createRunWatchdog(15, () => fired.push("abort"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    watchdog.clear();
    expect(fired).toEqual(["abort"]);
  });

  it("does not abort while phases keep arriving", async () => {
    const fired: string[] = [];
    const watchdog = createRunWatchdog(50, () => fired.push("abort"));
    for (let i = 0; i < 4; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      watchdog.heartbeat();
    }
    watchdog.clear();
    expect(fired).toEqual([]);
  });

  it("stops bounding the run once cleared", async () => {
    const fired: string[] = [];
    const watchdog = createRunWatchdog(15, () => fired.push("abort"));
    watchdog.clear();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fired).toEqual([]);
  });
});

// Under --ci the progress reporter is a no-op by design, so no phase line
// arrives and the budget bounds the whole run instead of one phase of it. The
// abort text has to say which of the two it was.
describe("what the run watchdog says it bounded", () => {
  it("reports a stalled phase when phase lines were arriving", () => {
    const message = RUN_WATCHDOG_ABORT_ERROR("Button.tsx", 20 * 60_000, "stalled");
    expect(message).toContain("made no progress for 20 minutes");
    expect(message).toContain("Button.tsx");
  });

  it("reports a total budget when no phase line can arrive", () => {
    const message = RUN_WATCHDOG_ABORT_ERROR("Button.tsx", 20 * 60_000, "total");
    expect(message).not.toContain("made no progress");
    expect(message).toContain("total budget");
    expect(message).toContain("20 minutes");
  });
});

// Review A2 follow-up: --ci silences the console reporter, which used to be
// the only thing re-arming the watchdog, so a healthy CI run was aborted at the
// budget. The heartbeat now rides `onPhase`, which fires before that gate.
describe("what re-arms the watchdog under --ci", () => {
  it("delivers a phase boundary to onPhase even when the console is silent", () => {
    const beats: string[] = [];
    const report = resolveProgressReporter({ ci: true, onPhase: (line) => beats.push(line) }, () => {
      throw new Error("--ci must print no progress line");
    });
    report("harness: building");
    report("calibration");
    expect(beats).toEqual(["harness: building", "calibration"]);
  });

  it("keeps printing and beating when the console is not silent", () => {
    const beats: string[] = [];
    const printed: string[] = [];
    const report = resolveProgressReporter(
      { ci: false, onPhase: (line) => beats.push(line) },
      (chunk) => printed.push(chunk),
    );
    report("mount: 8 combos");
    expect(beats).toEqual(["mount: 8 combos"]);
    expect(printed.join("")).toContain("mount: 8 combos");
  });
});

describe("a harness directory whose owner is gone", () => {
  it("names the process that created it", () => {
    const root = mkRoot();
    const dir = createHarnessDir(root);
    expect(fs.readFileSync(path.join(dir, HARNESS_PID_FILE), "utf-8").trim()).toBe(
      String(process.pid),
    );
  });

  it("is removed at any age when its process is dead", () => {
    const root = mkRoot();
    const dead = mkHarnessDir(root, ".120fps-harness-dead", DEAD_PID);
    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(dead)).toBe(false);
  });

  it("survives while its process is alive and the dir is younger than the gate", () => {
    const root = mkRoot();
    const live = mkHarnessDir(root, ".120fps-harness-live", process.pid);
    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(live)).toBe(true);
  });

  it("is removed when a foreign live pid stopped refreshing its marker", () => {
    const root = mkRoot();
    // pid 4 is alive on every Windows and POSIX host and is not this process.
    const stuck = mkHarnessDir(root, ".120fps-harness-stuck", 4);
    const then = new Date(Date.now() - LIVE_PID_HARNESS_MAX_AGE_MS - 60_000);
    fs.utimesSync(path.join(stuck, HARNESS_PID_FILE), then, then);
    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(stuck)).toBe(false);
  });

  // The directory's own mtime stops advancing the moment the build finishes
  // writing entry.tsx, so a run longer than the gate looked abandoned while it
  // was measuring. Liveness is the marker's own timestamp, refreshed per phase.
  it("keeps a foreign live-pid directory whose marker is being refreshed", () => {
    const root = mkRoot();
    const dir = mkHarnessDir(root, ".120fps-harness-busy", 4);
    ageDir(dir, LIVE_PID_HARNESS_MAX_AGE_MS + 60_000);
    fs.writeFileSync(path.join(dir, HARNESS_PID_FILE), "4");
    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(dir)).toBe(true);
  });

  it("never sweeps a directory this very process owns", () => {
    const root = mkRoot();
    const own = mkHarnessDir(root, ".120fps-harness-own", process.pid);
    ageDir(own, 3 * 60 * 60_000);
    const marker = path.join(own, HARNESS_PID_FILE);
    const then = new Date(Date.now() - 3 * 60 * 60_000);
    fs.utimesSync(marker, then, then);
    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(own)).toBe(true);
  });

  it("refreshes the markers of the directories this run holds", () => {
    const root = mkRoot();
    const dir = createHarnessDir(root);
    const marker = path.join(dir, HARNESS_PID_FILE);
    const then = new Date(Date.now() - 30 * 60_000);
    fs.utimesSync(marker, then, then);
    refreshHarnessDirMarkers();
    expect(fs.statSync(marker).mtimeMs).toBeGreaterThan(Date.now() - 60_000);
  });

  it("keeps the one-hour gate for a directory with no marker", () => {
    const root = mkRoot();
    const unmarked = mkHarnessDir(root, ".120fps-harness-unmarked");
    ageDir(unmarked, LIVE_PID_HARNESS_MAX_AGE_MS + 60_000);
    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(unmarked)).toBe(true);
    ageDir(unmarked, 2 * 60 * 60_000);
    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(unmarked)).toBe(false);
  });

  it("touches nothing else in the project root", () => {
    const root = mkRoot();
    const other = path.join(root, ".pid-keeper");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, HARNESS_PID_FILE), String(DEAD_PID));
    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(other)).toBe(true);
  });
});
