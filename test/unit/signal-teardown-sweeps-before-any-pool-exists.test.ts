import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { abortRun } from "../../src/cli.js";
import {
  createHarnessDir,
  removeActiveHarnessDirs,
  sweepActiveHarnessDirsOnExit,
} from "../../src/harness.js";

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
// The order of the cases below is load-bearing: the teardown latch is
// process-wide and one-way, so the two cases that need an ordinary
// createHarnessDir run before the abort that latches it.
describe("a signal that arrives before any browser pool exists", () => {
  it("counts a removal that left the directory on disk as a failure", () => {
    const root = mkRoot();
    const dir = createHarnessDir(root);

    // The Windows shape: the call returns, the directory is still there.
    const failures = removeActiveHarnessDirs({ remove: () => {}, cwd: root });

    expect(failures).toEqual([{ dir: path.basename(dir), reason: "EBUSY" }]);
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

    // The build does not stop because a signal arrived: this is the directory
    // the sweep above could not have seen.
    const late = createHarnessDir(root);

    expect(fs.existsSync(late)).toBe(false);
    expect(harnessDirsIn(root)).toEqual([]);
  });
});
