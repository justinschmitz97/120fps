import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  abortRun,
  createRunWatchdog,
  runWatchdogBudgetMs,
  terminationExitCode,
} from "../../src/cli.js";
import {
  createHarnessDir,
  HARNESS_PID_FILE,
  LIVE_PID_HARNESS_MAX_AGE_MS,
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

  it("is removed after ten minutes even with a live process", () => {
    const root = mkRoot();
    const stuck = mkHarnessDir(root, ".120fps-harness-stuck", process.pid);
    ageDir(stuck, LIVE_PID_HARNESS_MAX_AGE_MS + 60_000);
    sweepStaleHarnessDirs(root);
    expect(fs.existsSync(stuck)).toBe(false);
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
