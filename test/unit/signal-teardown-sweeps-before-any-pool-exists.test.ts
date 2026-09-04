import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { abortRun } from "../../src/cli/index.js";
import {
  beginHarnessDirTeardown,
  createHarnessDir,
  HARNESS_DIR_PENDING_DELETE_REASON,
  HARNESS_DIR_REMOVAL_BUDGET_MS,
  HARNESS_DIR_TEARDOWN_IN_PROGRESS,
  HARNESS_PID_FILE,
  removeActiveHarnessDirs,
  sweepActiveHarnessDirsOnExit,
} from "../../src/harness/index.js";

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function mkRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-nopool-"));
  roots.push(dir);
  return dir;
}

function harnessDirsIn(root: string): string[] {
  return fs.readdirSync(root).filter((name) => name.startsWith(".120fps-harness-"));
}

// The final re-test killed a run 6 s in, before the pools that own Chromium
// and the dev server were published: exit 143, and the harness directory of
// the run still in `packages/react`, with no retry and no line about it. The
// teardown a signal reaches has to cover every directory this process created,
// whether or not there is a pool to close first.
//
// abortRun latches the process-wide, one-way teardown, so the cases that need
// an ordinary createHarnessDir stand ahead of it. The cases that need the
// latch call beginHarnessDirTeardown themselves.
describe("a signal that arrives before any browser pool exists", () => {
  it("counts a removal that left the directory on disk as a failure", () => {
    const root = mkRoot();
    const dir = createHarnessDir(root);

    // The Windows shape: the call returns, the directory is still there.
    const failures = removeActiveHarnessDirs({ remove: () => {}, cwd: root });

    expect(failures).toEqual([
      { dir: path.basename(dir), reason: HARNESS_DIR_PENDING_DELETE_REASON },
    ]);
    expect(fs.existsSync(dir)).toBe(true);
    expect(removeActiveHarnessDirs({ retry: true })).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("is the exit handler a run takes when its pool close never settles", () => {
    // abortRun's deadline timer and closePoolsBounded's own are both unref'd,
    // so a signalled run whose closeAll never settles drains its loop and
    // leaves through the exit event with the pass after the close never
    // reached. That event has to spend the same budget.
    expect(process.listeners("exit")).toContain(sweepActiveHarnessDirsOnExit);
  });

  it("spends the retry budget on that exit and names what it could not remove", () => {
    const root = mkRoot();
    const dir = createHarnessDir(root);
    fs.writeFileSync(path.join(dir, "entry.tsx"), "export default null;");
    // The Windows shape the retries exist for: the removal reports success
    // and the directory is still on disk.
    const rmSync = fs.rmSync;
    (fs as { rmSync: typeof fs.rmSync }).rmSync = (() => {}) as typeof fs.rmSync;
    const written: string[] = [];
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    const started = Date.now();
    try {
      sweepActiveHarnessDirsOnExit();
    } finally {
      process.stderr.write = stderr;
      (fs as { rmSync: typeof fs.rmSync }).rmSync = rmSync;
    }

    const named = written.filter((line) => line.includes(path.basename(dir)));
    expect(named).toHaveLength(1);
    expect(named[0]).toMatch(/Could not remove the harness directory .*\(EBUSY/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(HARNESS_DIR_REMOVAL_BUDGET_MS);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("removes the harness directory on the way out and says nothing when there is none", () => {
    const root = mkRoot();
    const dir = createHarnessDir(root);
    fs.writeFileSync(path.join(dir, "entry.tsx"), "export default null;\n");
    const written: string[] = [];
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      sweepActiveHarnessDirsOnExit();
      sweepActiveHarnessDirsOnExit();
    } finally {
      process.stderr.write = stderr;
    }

    expect(fs.existsSync(dir)).toBe(false);
    expect(written).toEqual([]);
  });

  it("spends the retry budget before the deadline exit when a pool never closes", async () => {
    const order: string[] = [];
    await abortRun(
      143,
      {
        pool: { closeAll: () => new Promise<void>(() => {}) },
        serverPool: { closeAll: () => new Promise<void>(() => {}) },
      },
      { sweep: () => order.push("dirs"), exit: () => order.push("exit"), timeoutMs: 20 },
    );
    expect(order).toEqual(["dirs", "dirs", "exit"]);
  });

  it("removes the harness directory of a run with no pools to close", async () => {
    const root = mkRoot();
    const dir = createHarnessDir(root);
    fs.writeFileSync(path.join(dir, "entry.tsx"), "export default null;\n");
    const codes: number[] = [];

    await abortRun(143, undefined, { exit: (code) => codes.push(code) });

    expect(codes).toEqual([143]);
    expect(fs.existsSync(dir)).toBe(false);
    expect(harnessDirsIn(root)).toEqual([]);
  });

  it("removes a harness directory created after the sweep started", () => {
    const root = mkRoot();
    beginHarnessDirTeardown();

    // The build does not stop because a signal arrived: this is the directory
    // the sweep above could not have seen. Its path is never handed back --
    // it no longer exists -- so the build stops here with the real cause.
    expect(() => createHarnessDir(root)).toThrow(HARNESS_DIR_TEARDOWN_IN_PROGRESS);

    expect(harnessDirsIn(root)).toEqual([]);
  });

  it("marks a late directory it could not remove, so the next run sweeps it by pid", () => {
    const root = mkRoot();
    beginHarnessDirTeardown();
    const markerSeen: boolean[] = [];
    const rmSync = fs.rmSync;
    // The pending-delete shape: the removal reports success and the directory
    // stays. What survives has to carry the owner marker already.
    (fs as { rmSync: typeof fs.rmSync }).rmSync = ((target: fs.PathLike) => {
      markerSeen.push(fs.existsSync(path.join(String(target), HARNESS_PID_FILE)));
    }) as typeof fs.rmSync;
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(() => createHarnessDir(root)).toThrow(HARNESS_DIR_TEARDOWN_IN_PROGRESS);
    } finally {
      process.stderr.write = stderr;
      (fs as { rmSync: typeof fs.rmSync }).rmSync = rmSync;
    }

    const [late] = harnessDirsIn(root);
    expect(late).toBeDefined();
    expect(fs.existsSync(path.join(root, late, HARNESS_PID_FILE))).toBe(true);
    expect(markerSeen[0]).toBe(true);
  });
});
