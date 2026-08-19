import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHarnessDir, HARNESS_DIR_UNWRITABLE } from "../../src/harness.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-writable-"));
});

afterEach(() => {
  try {
    fs.chmodSync(tmpDir, 0o755);
  } catch {
    // Only the read-only case ever changed the mode.
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("harness directory creation in a writable project root", () => {
  it("creates a prefixed directory directly under the root", () => {
    const created = createHarnessDir(tmpDir);
    expect(fs.statSync(created).isDirectory()).toBe(true);
    expect(path.dirname(created)).toBe(tmpDir);
    expect(path.basename(created).startsWith(".120fps-harness-")).toBe(true);
  });

  it("creates a distinct directory per call", () => {
    expect(createHarnessDir(tmpDir)).not.toBe(createHarnessDir(tmpDir));
  });
});

describe("harness directory creation when the project root cannot be written", () => {
  it("names the directory and the in-root requirement instead of raising a raw errno", () => {
    const missing = path.join(tmpDir, "gone");
    let thrown: unknown;
    try {
      createHarnessDir(missing);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain(missing);
    expect(message).toContain("project root");
    expect(message).not.toMatch(/^ENOENT/);
  });

  it("keeps the underlying failure as the error cause", () => {
    const asFile = path.join(tmpDir, "root-is-a-file");
    fs.writeFileSync(asFile, "");
    let thrown: unknown;
    try {
      createHarnessDir(asFile);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).cause).toBeInstanceOf(Error);
  });

  // POSIX permission bits only: Windows ignores chmod on directories, and the
  // ACL equivalent is not something a test may set up.
  it.skipIf(process.platform === "win32")("rejects a read-only directory", () => {
    fs.chmodSync(tmpDir, 0o555);
    expect(() => createHarnessDir(tmpDir)).toThrow(/project root/);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});

describe("HARNESS_DIR_UNWRITABLE message", () => {
  it("names the root, the detail, and both ways out", () => {
    const message = HARNESS_DIR_UNWRITABLE("/srv/app", "EACCES: permission denied");
    expect(message).toContain("/srv/app");
    expect(message).toContain("EACCES: permission denied");
    expect(message).toContain("writable");
  });
});
