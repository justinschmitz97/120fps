import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildAndServe,
  VITE_START_FAILED,
  REACT_COMPILER_PACKAGE,
  resolveReactCompilerState,
  sweepStaleTmpDirs,
  TMP_SWEEP_MAX_REMOVALS,
  createServerPool,
  type ServerPool,
} from "../../src/harness.js";
import {
  withContextRetry,
  createRetryBudget,
  RETRY_BUDGET_EXHAUSTED_NOTE,
} from "../../src/measure.js";
import { withProductionResolution } from "../node-resolution.js";

const pkgJson = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf-8"),
);

// ====================================================================
// a) Vite dev-server startup failure names cause + harness dir
// ====================================================================

function poolThatThrows(err: unknown): ServerPool {
  return {
    async acquire(): Promise<never> {
      throw err;
    },
    stats: () => ({ booted: 0 }),
    async closeAll() {},
  };
}

function poolReturning(server: unknown): ServerPool {
  return {
    async acquire() {
      return { server: server as any, reused: false, include: new Set<string>() };
    },
    stats: () => ({ booted: 1 }),
    async closeAll() {},
  };
}

describe("a) Vite dev-server startup failure", () => {
  it("VITE_START_FAILED names the harness dir and the detail", () => {
    const msg = VITE_START_FAILED("/tmp/.120fps-harness-abc", "EADDRINUSE");
    expect(msg).toContain("/tmp/.120fps-harness-abc");
    expect(msg).toContain("EADDRINUSE");
  });

  it("wraps a real boot failure with the underlying message and the harness dir", async () => {
    await expect(
      buildAndServe("./fixtures/button.tsx", {
        serverPool: poolThatThrows(new Error("EADDRINUSE: port in use")),
      }),
    ).rejects.toThrow(/Failed to start Vite dev server in .*\.120fps-harness-.*: EADDRINUSE: port in use/);
  });

  it("stringifies a non-Error thrown value instead of dropping it", async () => {
    await expect(
      buildAndServe("./fixtures/button.tsx", { serverPool: poolThatThrows("boom") }),
    ).rejects.toThrow(/Failed to start Vite dev server in .*: boom/);
  });

  it("keeps the original error as .cause", async () => {
    const original = new Error("EADDRINUSE: port in use");
    try {
      await buildAndServe("./fixtures/button.tsx", { serverPool: poolThatThrows(original) });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).cause).toBe(original);
    }
  });

  it("names the harness dir when no listening address is returned", async () => {
    await expect(
      buildAndServe("./fixtures/button.tsx", {
        serverPool: poolReturning({ httpServer: undefined, close: async () => {} }),
      }),
    ).rejects.toThrow(/Failed to start Vite dev server in .*\.120fps-harness-.*: no listening address was returned/);
  });

  it("also fires when address() returns a non-object (unix socket)", async () => {
    await expect(
      buildAndServe("./fixtures/button.tsx", {
        serverPool: poolReturning({
          httpServer: { address: () => "/tmp/some.sock" },
          close: async () => {},
        }),
      }),
    ).rejects.toThrow(/no listening address was returned/);
  });
});

// ====================================================================
// b) --react-compiler requested-but-unresolved names the fix
// ====================================================================

describe("b) --react-compiler requested-but-unresolved names the fix", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m56-compiler-"));
    fs.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { react: "19" } }),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("names installing the package or dropping the flag", () => {
    let thrown: Error | undefined;
    try {
      withProductionResolution(() => resolveReactCompilerState(tmpDir, true));
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    // Preserves the existing spec message as a substring (other tests assert
    // on it) while adding the fix.
    expect(thrown!.message).toContain(`${REACT_COMPILER_PACKAGE} not found in ${tmpDir}`);
    expect(thrown!.message).toContain(`install ${REACT_COMPILER_PACKAGE}`);
    expect(thrown!.message).toContain("--react-compiler");
  });
});

// ====================================================================
// c) Retry-budget exhaustion states the environment, not the component
// ====================================================================

describe("c) retry-budget exhaustion", () => {
  it("states repeated dev-server reloads (environment) are the likely cause", async () => {
    const budget = createRetryBudget(0);
    await expect(
      withContextRetry(async () => {}, async () => {
        throw new Error("Execution context was destroyed");
      }, { budget }),
    ).rejects.toThrow(/repeated dev-server reloads \(environment\), not the component/);
  });

  it("keeps the original error's message in the enriched failure", async () => {
    const budget = createRetryBudget(0);
    await expect(
      withContextRetry(async () => {}, async () => {
        throw new Error("Execution context was destroyed");
      }, { budget }),
    ).rejects.toThrow(/Execution context was destroyed/);
  });

  it("keeps the original error as .cause", async () => {
    const budget = createRetryBudget(0);
    const original = new Error("Execution context was destroyed");
    try {
      await withContextRetry(async () => {}, async () => {
        throw original;
      }, { budget });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).cause).toBe(original);
    }
  });

  it("handles a non-Error thrown value at budget exhaustion", async () => {
    const budget = createRetryBudget(0);
    await expect(
      withContextRetry(async () => {}, async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "Execution context was destroyed";
      }, { budget }),
    ).rejects.toThrow(/repeated dev-server reloads \(environment\)/);
  });

  it("exports the note as user-facing text containing the exact contract phrase", () => {
    expect(RETRY_BUDGET_EXHAUSTED_NOTE).toContain(
      "repeated dev-server reloads (environment), not the component, are the likely cause",
    );
  });

  it("does not enrich the message when a retry is still available", async () => {
    const budget = createRetryBudget(1);
    let attempts = 0;
    await expect(
      withContextRetry(async () => {}, async () => {
        attempts++;
        throw new Error("Execution context was destroyed");
      }, { budget }),
    ).rejects.toThrow("Execution context was destroyed");
    expect(attempts).toBe(2);
  });
});

// ====================================================================
// d) Temp hygiene sweep
// ====================================================================

describe("d) sweepStaleTmpDirs", () => {
  const cleanupDirs: string[] = [];

  afterAll(() => {
    for (const dir of cleanupDirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  function mkRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m56-sweep-"));
    cleanupDirs.push(dir);
    return dir;
  }

  function age(fullPath: string, hoursAgo: number): void {
    const then = new Date(Date.now() - hoursAgo * 60 * 60 * 1000);
    fs.utimesSync(fullPath, then, then);
  }

  it("removes a 120fps-ctx-* dir older than 24h", () => {
    const root = mkRoot();
    const old = path.join(root, "120fps-ctx-abc");
    fs.mkdirSync(old);
    age(old, 25);

    sweepStaleTmpDirs(root);
    expect(fs.existsSync(old)).toBe(false);
  });

  it("removes a 120fps-memo-* dir older than 24h", () => {
    const root = mkRoot();
    const old = path.join(root, "120fps-memo-abc");
    fs.mkdirSync(old);
    age(old, 25);

    sweepStaleTmpDirs(root);
    expect(fs.existsSync(old)).toBe(false);
  });

  it("keeps a fresh 120fps-* dir (concurrent run)", () => {
    const root = mkRoot();
    const fresh = path.join(root, "120fps-ctx-fresh");
    fs.mkdirSync(fresh);

    sweepStaleTmpDirs(root);
    expect(fs.existsSync(fresh)).toBe(true);
  });

  it("keeps a dir just under the 24h cutoff", () => {
    const root = mkRoot();
    const almost = path.join(root, "120fps-ctx-almost");
    fs.mkdirSync(almost);
    age(almost, 23.98);

    sweepStaleTmpDirs(root);
    expect(fs.existsSync(almost)).toBe(true);
  });

  it("removes a dir just past the 24h cutoff", () => {
    const root = mkRoot();
    const past = path.join(root, "120fps-ctx-past");
    fs.mkdirSync(past);
    age(past, 24.02);

    sweepStaleTmpDirs(root);
    expect(fs.existsSync(past)).toBe(false);
  });

  it("removes recursively even when non-empty", () => {
    const root = mkRoot();
    const old = path.join(root, "120fps-ctx-full");
    fs.mkdirSync(path.join(old, "nested"), { recursive: true });
    fs.writeFileSync(path.join(old, "nested", "r.json"), "{}");
    age(old, 48);

    sweepStaleTmpDirs(root);
    expect(fs.existsSync(old)).toBe(false);
  });

  it("does not remove a file that merely shares the prefix", () => {
    const root = mkRoot();
    const file = path.join(root, "120fps-ctx-file");
    fs.writeFileSync(file, "not a dir");
    age(file, 48);

    sweepStaleTmpDirs(root);
    expect(fs.existsSync(file)).toBe(true);
  });

  it("does not remove an old dir with an unrelated name", () => {
    const root = mkRoot();
    const other = path.join(root, "some-other-tool-cache");
    fs.mkdirSync(other);
    age(other, 48);

    sweepStaleTmpDirs(root);
    expect(fs.existsSync(other)).toBe(true);
  });

  it("does not remove a prefix-similar foreign dir (120fpsx-ctx-, no dash after 120fps)", () => {
    const root = mkRoot();
    const foreign = path.join(root, "120fpsx-ctx-old");
    fs.mkdirSync(foreign);
    age(foreign, 48);

    sweepStaleTmpDirs(root);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it("is a no-op on an empty tmp dir", () => {
    const root = mkRoot();
    expect(() => sweepStaleTmpDirs(root)).not.toThrow();
  });

  it("swallows errors for a nonexistent base dir", () => {
    expect(() =>
      sweepStaleTmpDirs(path.join(os.tmpdir(), "120fps-m56-does-not-exist-xyz")),
    ).not.toThrow();
  });

  it("continues past a dir that fails to remove (permission/lock)", () => {
    const root = mkRoot();
    const stubborn = path.join(root, "120fps-ctx-stubborn");
    const removable = path.join(root, "120fps-ctx-removable");
    fs.mkdirSync(stubborn);
    fs.mkdirSync(removable);
    age(stubborn, 48);
    age(removable, 48);

    // Force one removal to fail regardless of what the underlying filesystem
    // actually enforces, so the per-entry try/catch is genuinely exercised.
    const originalRmSync = fs.rmSync.bind(fs);
    const spy = vi.spyOn(fs, "rmSync").mockImplementation((target: any, opts: any) => {
      if (String(target) === stubborn) {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
      }
      return originalRmSync(target, opts);
    });
    try {
      expect(() => sweepStaleTmpDirs(root)).not.toThrow();
      expect(fs.existsSync(stubborn)).toBe(true);
      expect(fs.existsSync(removable)).toBe(false);
    } finally {
      spy.mockRestore();
      fs.rmSync(stubborn, { recursive: true, force: true });
    }
  });

  it("never follows a symlink/junction out of the base dir", () => {
    const root = mkRoot();
    const outsideTarget = mkRoot();
    const decoyFile = path.join(outsideTarget, "must-survive.txt");
    fs.writeFileSync(decoyFile, "keep me");

    const link = path.join(root, "120fps-ctx-link");
    try {
      fs.symlinkSync(outsideTarget, link, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // Some environments refuse symlink creation even for junctions; the
      // guarantee under test (entry.isSymbolicLink() is skipped) still holds
      // by construction, so skip rather than fail the suite on that.
      return;
    }
    age(link, 48);

    sweepStaleTmpDirs(root);
    expect(fs.existsSync(decoyFile)).toBe(true);
  });

  it("takes baseDir as a parameter, defaulting to os.tmpdir()", () => {
    expect(() => sweepStaleTmpDirs()).not.toThrow();
  });

  it("caps removals per call so a huge population stays bounded", () => {
    const root = mkRoot();
    const total = TMP_SWEEP_MAX_REMOVALS + 5;
    for (let i = 0; i < total; i++) {
      const dir = path.join(root, `120fps-ctx-bulk-${i}`);
      fs.mkdirSync(dir);
      age(dir, 48);
    }

    sweepStaleTmpDirs(root);
    const remaining = fs.readdirSync(root).length;
    expect(remaining).toBe(5);
  }, 30000);

  it("createServerPool triggers the sweep once at startup without throwing", () => {
    expect(() => createServerPool()).not.toThrow();
  });
});

// ====================================================================
// e) package.json test scripts
// ====================================================================

describe("e) package.json test scripts", () => {
  it("test runs the unit suite (matches CI)", () => {
    expect(pkgJson.scripts.test).toBe("vitest run test/unit/");
  });

  it("test:unit runs the unit suite", () => {
    expect(pkgJson.scripts["test:unit"]).toBe("vitest run test/unit/");
  });

  it("test:e2e runs the e2e suite", () => {
    expect(pkgJson.scripts["test:e2e"]).toBe("vitest run test/e2e/");
  });

  it("test:all retains the full run", () => {
    expect(pkgJson.scripts["test:all"]).toBe("vitest run");
  });

  it("CLAUDE.md's documented commands keep working unchanged", () => {
    expect(pkgJson.scripts.test).toBe("vitest run test/unit/");
    expect(pkgJson.scripts["test:e2e"]).toBe("vitest run test/e2e/");
  });
});
