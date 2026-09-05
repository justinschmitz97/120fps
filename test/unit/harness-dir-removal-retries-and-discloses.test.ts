import { describe, it, expect, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepHarnessDirsAfterClose } from "../../src/cli/index.js";
import {
  createHarnessDir,
  HARNESS_DIR_REMOVAL_MIN_ATTEMPTS,
  removeHarnessDirWithRetries,
  sweepStaleHarnessDirs,
} from "../../src/harness/index.js";

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

function mkRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-retry-"));
  roots.push(dir);
  return dir;
}

function busy(): NodeJS.ErrnoException {
  return Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
}

// base-ui left a directory in git status: one attempt isn't enough while Chromium holds it.
describe("removing a harness directory a handle still holds open", () => {
  it("attempts again until the handle is gone", () => {
    let attempts = 0;
    const reason = removeHarnessDirWithRetries("C:/nowhere/.120fps-harness-x", () => {
      attempts += 1;
      if (attempts <= 3) throw busy();
    });
    expect(reason).toBeUndefined();
    expect(attempts).toBe(4);
  });

  it("gives up with the error code after spending its budget", () => {
    let attempts = 0;
    const started = Date.now();
    const reason = removeHarnessDirWithRetries("C:/nowhere/.120fps-harness-x", () => {
      attempts += 1;
      throw busy();
    });
    const spent = Date.now() - started;
    expect(reason).toBe("EBUSY");
    expect(attempts).toBeGreaterThanOrEqual(HARNESS_DIR_REMOVAL_MIN_ATTEMPTS);
    expect(spent).toBeLessThan(2000);
  });

  it("does not retry an error that says the directory cannot be removed at all", () => {
    let attempts = 0;
    const reason = removeHarnessDirWithRetries("C:/nowhere/.120fps-harness-x", () => {
      attempts += 1;
      throw Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" });
    });
    expect(reason).toBe("ENOTDIR");
    expect(attempts).toBe(1);
  });

  it("removes the real directory once the open handle is closed", () => {
    const root = mkRoot();
    const dir = createHarnessDir(root);
    fs.writeFileSync(path.join(dir, "entry.tsx"), "export default null;");
    const handle = fs.openSync(path.join(dir, "entry.tsx"), "r");
    try {
      removeHarnessDirWithRetries(dir);
    } finally {
      fs.closeSync(handle);
    }
    expect(removeHarnessDirWithRetries(dir)).toBeUndefined();
    expect(fs.existsSync(dir)).toBe(false);
  });
});

describe("a harness directory that survives every attempt", () => {
  it("is named once on stderr with the reason, and nothing is thrown", () => {
    const root = mkRoot();
    const dir = createHarnessDir(root);
    const lines: string[] = [];
    expect(() =>
      sweepHarnessDirsAfterClose({
        remove: () => { throw busy(); },
        warn: (line) => lines.push(line),
        cwd: root,
      }),
    ).not.toThrow();
    const named = lines.filter((line) => line.includes(path.basename(dir)));
    expect(named).toHaveLength(1);
    expect(named[0]).toContain("EBUSY");
    expect(named[0]).not.toContain(root);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("says nothing when the disk is clean", () => {
    const lines: string[] = [];
    sweepHarnessDirsAfterClose({ warn: (line) => lines.push(line) });
    expect(lines).toEqual([]);
  });
});

describe("the next run's sweep of locked leftovers", () => {
  it("returns within its budget however many are locked", () => {
    const root = mkRoot();
    for (const name of ["a", "b", "c"]) {
      const dir = path.join(root, `.120fps-harness-${name}`);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, ".pid"), "4194303");
    }
    const warnings: string[] = [];
    const started = Date.now();
    sweepStaleHarnessDirs(root, warnings, () => { throw busy(); });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(warnings.filter((line) => line.includes("could not remove"))).toHaveLength(3);
  });
});
