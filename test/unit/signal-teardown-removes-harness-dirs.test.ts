import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { abortRun } from "../../src/cli/index.js";
import { createHarnessDir, removeActiveHarnessDirs, sweepActiveHarnessDirs } from "../../src/harness/index.js";

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function mkRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-signal-"));
  roots.push(dir);
  return dir;
}

function busy(): NodeJS.ErrnoException {
  return Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
}

// base-ui-R1: the SIGTERM handler ran (exit 143) and the harness directory was
// still there afterwards, with the creation mtime on every file in it. The
// removal ran at the one moment Chromium, the dev server and its esbuild
// workers still held handles on it, and nothing tried again after they closed.
describe("teardown of a run stopped by a signal", () => {
  it("removes the harness directories again after both pools have closed", async () => {
    const order: string[] = [];
    await abortRun(
      143,
      {
        pool: { closeAll: async () => void order.push("browsers") },
        serverPool: { closeAll: async () => void order.push("servers") },
      },
      { sweep: () => order.push("dirs"), exit: () => order.push("exit") },
    );
    expect(order).toEqual(["dirs", "browsers", "servers", "dirs", "exit"]);
  });

  it("exits exactly once with the signal's code", async () => {
    const codes: number[] = [];
    await abortRun(
      130,
      { pool: { closeAll: async () => {} }, serverPool: { closeAll: async () => {} } },
      { sweep: () => {}, exit: (code) => codes.push(code) },
    );
    expect(codes).toEqual([130]);
  });

  it("still reaches the exit when a pool never finishes closing", async () => {
    const order: string[] = [];
    await abortRun(
      143,
      {
        pool: { closeAll: () => new Promise<void>(() => {}) },
        serverPool: { closeAll: async () => void order.push("servers") },
      },
      { sweep: () => order.push("dirs"), exit: () => order.push("exit"), timeoutMs: 20 },
    );
    // The deadline exit and the pass after the close race here only because
    // the injected exit returns; the real one never does.
    expect(order.filter((step) => step === "dirs")).toHaveLength(2);
    expect(order.filter((step) => step === "exit")).toHaveLength(1);
  });

  it("keeps a directory it could not remove for the pass after the close", () => {
    const root = mkRoot();
    const dir = createHarnessDir(root);

    const failures = removeActiveHarnessDirs({ remove: () => { throw busy(); }, cwd: root });
    expect(failures.map((failure) => failure.reason)).toEqual(["EBUSY"]);
    expect(fs.existsSync(dir)).toBe(true);

    expect(removeActiveHarnessDirs({ retry: true })).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("removes a directory created after the pass before the close", () => {
    const root = mkRoot();
    const first = createHarnessDir(root);
    sweepActiveHarnessDirs();
    expect(fs.existsSync(first)).toBe(false);

    const second = createHarnessDir(root);
    expect(removeActiveHarnessDirs({ retry: true })).toEqual([]);
    expect(fs.existsSync(second)).toBe(false);
    expect(fs.readdirSync(root).filter((name) => name.startsWith(".120fps-harness-"))).toEqual([]);
  });
});
