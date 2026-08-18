import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadBaseline,
  saveBaseline,
  selectBaselineEntry,
  computeEnvKey,
  baselineKey,
  parseBaselineKey,
  buildEnvFingerprint,
  BASELINE_VERSION,
  BASELINE_SLOT_TTL_DAYS,
  LEGACY_ENV_KEY,
  NO_ENV_BASELINE_WARNING,
  PRUNED_SLOTS_NOTICE,
  type BaselineEntry,
  type EnvFingerprintInput,
} from "../../src/budget.js";

let tmpDir: string;
let file: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "m45-"));
  file = path.join(tmpDir, "120fps-baseline.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function env(overrides: Partial<EnvFingerprintInput> = {}) {
  return buildEnvFingerprint({
    machine: {
      cpu: "Test CPU", cores: 8, ramMb: 16384,
      os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.6099.109",
    },
    calibration: { totalDuration: 40, scriptDuration: 20 },
    cpuThrottle: 4,
    samples: 10,
    mode: "combo",
    ...overrides,
  });
}

function makeEntry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    mount: 1, rerender: 1, unmount: 1,
    domNodeCount: 4, interactions: {}, tier: "T1",
    ...overrides,
  };
}

// C1: one file, one slot per environment.
describe("environment slots", () => {
  it("keys an entry by component and environment", () => {
    saveBaseline(file, makeEntry({ env: env() }), "./Button.tsx");
    const keys = Object.keys(loadBaseline(file)!.entries);
    expect(keys).toEqual([baselineKey("./Button.tsx", computeEnvKey(env()))]);
  });

  it("keeps two machines' numbers side by side instead of overwriting", () => {
    saveBaseline(file, makeEntry({ mount: 1, env: env() }), "./Button.tsx");
    saveBaseline(
      file,
      makeEntry({ mount: 9, env: env({ machine: {
        cpu: "Other CPU", cores: 4, ramMb: 8192,
        os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.6099.109",
      } }) }),
      "./Button.tsx",
    );
    const loaded = loadBaseline(file)!;
    expect(Object.keys(loaded.entries)).toHaveLength(2);
    expect(selectBaselineEntry(loaded, "./Button.tsx", computeEnvKey(env()))!.entry.mount).toBe(1);
  });

  it("round-trips a key", () => {
    expect(parseBaselineKey(baselineKey("./a/b.tsx", "abc123")))
      .toEqual({ componentPath: "./a/b.tsx", envKey: "abc123" });
  });

  it("treats an entry with no environment as the legacy slot", () => {
    saveBaseline(file, makeEntry(), "./Button.tsx");
    expect(Object.keys(loadBaseline(file)!.entries))
      .toEqual([baselineKey("./Button.tsx", LEGACY_ENV_KEY)]);
  });
});

// C2: the digest keys machine identity, not measurement luck.
describe("envKey identity", () => {
  it("is stable across calibration drift", () => {
    expect(computeEnvKey(env({ calibration: { totalDuration: 41.7, scriptDuration: 20 } })))
      .toBe(computeEnvKey(env({ calibration: { totalDuration: 57.3, scriptDuration: 30 } })));
  });

  it("is stable across a Chromium patch bump", () => {
    const patched = env({ machine: {
      cpu: "Test CPU", cores: 8, ramMb: 16384,
      os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.7000.1",
    } });
    expect(computeEnvKey(patched)).toBe(computeEnvKey(env()));
  });

  it("changes on a Chromium major bump", () => {
    const next = env({ machine: {
      cpu: "Test CPU", cores: 8, ramMb: 16384,
      os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "121.0.0.0",
    } });
    expect(computeEnvKey(next)).not.toBe(computeEnvKey(env()));
  });

  it("changes when a feature that changes what is measured changes", () => {
    expect(computeEnvKey(env({ wrapper: "120fps.setup.tsx" }))).not.toBe(computeEnvKey(env()));
    expect(computeEnvKey(env({ reactCompiler: true }))).not.toBe(computeEnvKey(env()));
    expect(computeEnvKey(env({ cpuThrottle: 6 }))).not.toBe(computeEnvKey(env()));
  });
});

// C3: a missing slot informs, it does not fail.
describe("cross-environment fallback", () => {
  it("falls back to another slot and says so", () => {
    saveBaseline(file, makeEntry({ env: env() }), "./Button.tsx");
    const selection = selectBaselineEntry(loadBaseline(file), "./Button.tsx", "nomatch");
    expect(selection!.crossEnvironment).toBe(true);
  });

  it("reports an exact slot as its own", () => {
    saveBaseline(file, makeEntry({ env: env() }), "./Button.tsx");
    const selection = selectBaselineEntry(loadBaseline(file), "./Button.tsx", computeEnvKey(env()));
    expect(selection!.crossEnvironment).toBe(false);
  });

  it("returns nothing for a component with no slots at all", () => {
    saveBaseline(file, makeEntry({ env: env() }), "./Button.tsx");
    expect(selectBaselineEntry(loadBaseline(file), "./Other.tsx", "x")).toBeUndefined();
  });

  it("prefers the freshest slot when falling back", () => {
    const older = new Date("2026-01-01T00:00:00Z");
    const newer = new Date("2026-06-01T00:00:00Z");
    saveBaseline(file, makeEntry({ mount: 1, env: env({ cpuThrottle: 2 }) }), "./B.tsx", older);
    saveBaseline(file, makeEntry({ mount: 7, env: env({ cpuThrottle: 6 }) }), "./B.tsx", newer);
    expect(selectBaselineEntry(loadBaseline(file), "./B.tsx", "nomatch")!.entry.mount).toBe(7);
  });

  it("names the fix in the advisory", () => {
    expect(NO_ENV_BASELINE_WARNING("./Button.tsx")).toContain("--save-baseline");
    expect(NO_ENV_BASELINE_WARNING("./Button.tsx")).toContain("informational");
  });
});

// C4: a version-1 file keeps working.
describe("migration", () => {
  it("rekeys a version-1 entry into the slot its own env describes", () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      timestamp: "2026-01-01T00:00:00Z",
      entries: { "./Button.tsx": makeEntry({ mount: 4, env: env() }) },
    }));
    const loaded = loadBaseline(file)!;
    expect(Object.keys(loaded.entries)).toEqual([baselineKey("./Button.tsx", computeEnvKey(env()))]);
    expect(selectBaselineEntry(loaded, "./Button.tsx", computeEnvKey(env()))!.entry.mount).toBe(4);
  });

  it("puts a version-1 entry with no env in the legacy slot", () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      timestamp: "2026-01-01T00:00:00Z",
      entries: { "./Button.tsx": makeEntry() },
    }));
    expect(Object.keys(loadBaseline(file)!.entries))
      .toEqual([baselineKey("./Button.tsx", LEGACY_ENV_KEY)]);
  });

  it("writes the new version on first save", () => {
    saveBaseline(file, makeEntry({ env: env() }), "./Button.tsx");
    expect(JSON.parse(fs.readFileSync(file, "utf-8")).version).toBe(BASELINE_VERSION);
  });
});

// C5: slots must not accrete.
describe("slot hygiene", () => {
  it("prunes a slot untouched past the TTL", () => {
    const long_ago = new Date("2026-01-01T00:00:00Z");
    saveBaseline(file, makeEntry({ env: env({ cpuThrottle: 2 }) }), "./B.tsx", long_ago);
    const now = new Date(long_ago.getTime() + (BASELINE_SLOT_TTL_DAYS + 1) * 86_400_000);
    const { pruned } = saveBaseline(file, makeEntry({ env: env() }), "./B.tsx", now);
    expect(pruned).toHaveLength(1);
    expect(Object.keys(loadBaseline(file)!.entries)).toHaveLength(1);
  });

  it("keeps a slot inside the TTL", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    saveBaseline(file, makeEntry({ env: env({ cpuThrottle: 2 }) }), "./B.tsx", start);
    const now = new Date(start.getTime() + (BASELINE_SLOT_TTL_DAYS - 1) * 86_400_000);
    expect(saveBaseline(file, makeEntry({ env: env() }), "./B.tsx", now).pruned).toEqual([]);
  });

  it("never prunes the slot it just wrote", () => {
    const start = new Date("2026-01-01T00:00:00Z");
    saveBaseline(file, makeEntry({ env: env() }), "./B.tsx", start);
    const now = new Date(start.getTime() + 10 * 365 * 86_400_000);
    const { pruned, key } = saveBaseline(file, makeEntry({ env: env() }), "./B.tsx", now);
    expect(pruned).not.toContain(key);
    expect(Object.keys(loadBaseline(file)!.entries)).toContain(key);
  });

  it("keeps a pre-savedAt-field slot that has no timestamp: absence is not age", () => {
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      timestamp: "2026-01-01T00:00:00Z",
      entries: { "./Old.tsx": makeEntry({ env: env({ cpuThrottle: 2 }) }) },
    }));
    const now = new Date("2030-01-01T00:00:00Z");
    expect(saveBaseline(file, makeEntry({ env: env() }), "./New.tsx", now).pruned).toEqual([]);
  });

  it("names what it dropped", () => {
    expect(PRUNED_SLOTS_NOTICE(["./A.tsx#abc"])).toContain("./A.tsx#abc");
    expect(PRUNED_SLOTS_NOTICE(["./A.tsx#abc"])).toContain(String(BASELINE_SLOT_TTL_DAYS));
  });
});

// C6: concurrent branches must merge.
describe("file shape", () => {
  it("writes keys in sorted order", () => {
    saveBaseline(file, makeEntry({ env: env() }), "./z.tsx");
    saveBaseline(file, makeEntry({ env: env() }), "./a.tsx");
    saveBaseline(file, makeEntry({ env: env() }), "./m.tsx");
    const keys = Object.keys(JSON.parse(fs.readFileSync(file, "utf-8")).entries);
    expect(keys).toEqual([...keys].sort());
  });

  it("stamps each slot with its own save time", () => {
    const now = new Date("2026-03-04T05:06:07.000Z");
    saveBaseline(file, makeEntry({ env: env() }), "./a.tsx", now);
    const entry = selectBaselineEntry(loadBaseline(file), "./a.tsx", computeEnvKey(env()))!.entry;
    expect(entry.savedAt).toBe(now.toISOString());
  });
});
