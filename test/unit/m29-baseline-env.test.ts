import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  buildEnvFingerprint,
  classifyEnv,
  describeEnvDiff,
  envAdvisory,
  compareBaseline,
  loadBaseline,
  saveBaseline,
  resolveTolerances,
  UNKNOWN_ENV_WARNING,
  type BaselineEntry,
  type ResolvedTolerance,
} from "../../src/budget.js";
import {
  formatTable,
  buildTimingWithCV,
  type BaselineComparison,
  type EnvFingerprint,
  type Report,
  type Thresholds,
} from "../../src/report.js";
import { parseArgs, KNOWN_FLAGS } from "../../src/cli.js";

const TOL: ResolvedTolerance = resolveTolerances(null);

function env(overrides: Partial<EnvFingerprint> = {}): EnvFingerprint {
  return {
    shape: 1,
    cpu: "TestCPU X1",
    cores: 8,
    os: "Linux 6.1",
    nodeVersion: "v20.11.0",
    chromiumVersion: "120.0.0",
    cpuThrottle: 4,
    samples: 10,
    calibrationTotalDuration: 10,
    calibrationScriptDuration: 4,
    mode: "combo",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    mount: 1.0,
    rerender: 0.5,
    unmount: 0.1,
    domNodeCount: 10,
    interactions: {},
    tier: "T1",
    ...overrides,
  };
}

// --- E1: fingerprint construction ---

describe("E1 buildEnvFingerprint", () => {
  const machine = {
    cpu: "TestCPU X1",
    cores: 8,
    ramMb: 16384,
    os: "Linux 6.1",
    nodeVersion: "v20.11.0",
    chromiumVersion: "120.0.0",
  };

  it("records shape 1 and the effective throttle/sample values", () => {
    const fp = buildEnvFingerprint({
      machine,
      calibration: { totalDuration: 12.5, scriptDuration: 4.25 },
      cpuThrottle: 6,
      samples: 3,
      mode: "combo",
    });
    expect(fp.shape).toBe(1);
    expect(fp.cpuThrottle).toBe(6);
    expect(fp.samples).toBe(3);
    expect(fp.calibrationTotalDuration).toBe(12.5);
    expect(fp.calibrationScriptDuration).toBe(4.25);
    expect(fp.mode).toBe("combo");
  });

  it("copies machine identity but not RAM", () => {
    const fp = buildEnvFingerprint({
      machine,
      calibration: { totalDuration: 10, scriptDuration: 4 },
      cpuThrottle: 4,
      samples: 10,
      mode: "combo",
    });
    expect(fp.cpu).toBe("TestCPU X1");
    expect(fp.cores).toBe(8);
    expect(fp.os).toBe("Linux 6.1");
    expect(fp.nodeVersion).toBe("v20.11.0");
    expect(fp.chromiumVersion).toBe("120.0.0");
    expect(fp as unknown as Record<string, unknown>).not.toHaveProperty("ramMb");
  });

  it("omits inactive feature fields", () => {
    const fp = buildEnvFingerprint({
      machine,
      calibration: { totalDuration: 10, scriptDuration: 4 },
      cpuThrottle: 4,
      samples: 10,
      mode: "combo",
    });
    expect(Object.keys(fp)).not.toContain("css");
    expect(Object.keys(fp)).not.toContain("wrapper");
    expect(Object.keys(fp)).not.toContain("reactCompiler");
  });

  it("records active feature fields", () => {
    const fp = buildEnvFingerprint({
      machine,
      calibration: { totalDuration: 10, scriptDuration: 4 },
      cpuThrottle: 4,
      samples: 10,
      mode: "combo",
      css: ["app/globals.css"],
      wrapper: "120fps.setup.tsx",
      reactCompiler: true,
    });
    expect(fp.css).toEqual(["app/globals.css"]);
    expect(fp.wrapper).toBe("120fps.setup.tsx");
    expect(fp.reactCompiler).toBe(true);
  });

  it("treats an empty css list as inactive", () => {
    const fp = buildEnvFingerprint({
      machine,
      calibration: { totalDuration: 10, scriptDuration: 4 },
      cpuThrottle: 4,
      samples: 10,
      mode: "combo",
      css: [],
    });
    expect(Object.keys(fp)).not.toContain("css");
  });
});

// --- E2: classification ---

describe("E2 classifyEnv", () => {
  it("unknown when the baseline has no fingerprint", () => {
    expect(classifyEnv(undefined, env())).toBe("unknown");
  });

  it("identical when everything matches", () => {
    expect(classifyEnv(env(), env())).toBe("identical");
  });

  it("identical when only nodeVersion differs", () => {
    expect(classifyEnv(env({ nodeVersion: "v22.0.0" }), env())).toBe("identical");
  });

  it("identical when calibration drifts within 10%", () => {
    expect(classifyEnv(env({ calibrationTotalDuration: 10 }), env({ calibrationTotalDuration: 10.9 }))).toBe("identical");
  });

  it("normalizable when calibration drifts beyond 10%", () => {
    expect(classifyEnv(env({ calibrationTotalDuration: 10 }), env({ calibrationTotalDuration: 12 }))).toBe("normalizable");
  });

  it("identical when calibrationScriptDuration alone differs", () => {
    expect(classifyEnv(env({ calibrationScriptDuration: 1 }), env({ calibrationScriptDuration: 9 }))).toBe("identical");
  });

  it("incompatible when mode differs", () => {
    expect(classifyEnv(env({ mode: "isolation" }), env({ mode: "combo" }))).toBe("incompatible");
  });

  it("incompatible when css presence differs", () => {
    expect(classifyEnv(env(), env({ css: ["app/globals.css"] }))).toBe("incompatible");
    expect(classifyEnv(env({ css: ["app/globals.css"] }), env())).toBe("incompatible");
  });

  it("incompatible when css order differs", () => {
    expect(classifyEnv(env({ css: ["a.css", "b.css"] }), env({ css: ["b.css", "a.css"] }))).toBe("incompatible");
  });

  it("identical when css lists match exactly", () => {
    expect(classifyEnv(env({ css: ["a.css", "b.css"] }), env({ css: ["a.css", "b.css"] }))).toBe("identical");
  });

  it("incompatible when wrapper differs", () => {
    expect(classifyEnv(env(), env({ wrapper: "120fps.setup.tsx" }))).toBe("incompatible");
    expect(classifyEnv(env({ wrapper: "a.tsx" }), env({ wrapper: "b.tsx" }))).toBe("incompatible");
  });

  it("incompatible when reactCompiler differs", () => {
    expect(classifyEnv(env(), env({ reactCompiler: true }))).toBe("incompatible");
  });

  it("incompatible wins over hardware drift", () => {
    expect(classifyEnv(env({ cpu: "Other" }), env({ mode: "isolation" }))).toBe("incompatible");
  });

  it("normalizable for each hardware/config field", () => {
    expect(classifyEnv(env({ cpu: "Other CPU" }), env())).toBe("normalizable");
    expect(classifyEnv(env({ cores: 16 }), env())).toBe("normalizable");
    expect(classifyEnv(env({ os: "Windows_NT 10.0" }), env())).toBe("normalizable");
    expect(classifyEnv(env({ chromiumVersion: "121.0.0" }), env())).toBe("normalizable");
    expect(classifyEnv(env({ cpuThrottle: 6 }), env())).toBe("normalizable");
    expect(classifyEnv(env({ samples: 3 }), env())).toBe("normalizable");
  });
});

describe("E2 describeEnvDiff", () => {
  it("is empty for an identical pair", () => {
    expect(describeEnvDiff(env(), env())).toEqual([]);
  });

  it("ignores nodeVersion", () => {
    expect(describeEnvDiff(env({ nodeVersion: "v22.0.0" }), env())).toEqual([]);
  });

  it("names the missing baseline record", () => {
    expect(describeEnvDiff(undefined, env())).toEqual(["baseline has no environment record"]);
  });

  it("names the specific mismatched field", () => {
    const diffs = describeEnvDiff(env(), env({ wrapper: "120fps.setup.tsx" }));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]).toContain("provider wrapper");
    expect(diffs[0]).toContain("120fps.setup.tsx");
  });

  it("lists several differences in a stable order", () => {
    const diffs = describeEnvDiff(env({ mode: "isolation", cpu: "A" }), env({ mode: "combo", cpu: "B" }));
    expect(diffs).toHaveLength(2);
    expect(diffs[0]).toContain("mode");
    expect(diffs[1]).toContain("CPU");
  });

  it("reports calibration drift", () => {
    const diffs = describeEnvDiff(env({ calibrationTotalDuration: 10 }), env({ calibrationTotalDuration: 20 }));
    expect(diffs.some((d) => d.startsWith("calibration"))).toBe(true);
  });
});

// --- E3: comparison strategy ---

describe("E3 compareBaseline without a current fingerprint", () => {
  it("classifies unknown and compares raw", () => {
    const entry = makeEntry({ mount: 1.0, env: env() });
    const result = compareBaseline(entry, { mount: 1.2, rerender: 0.5, unmount: 0.1, interactions: {} }, TOL);
    expect(result.envMatch).toBe("unknown");
    expect(result.envMismatches).toEqual([]);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].normalized).toBeUndefined();
  });
});

describe("E3 identical → raw comparison", () => {
  it("flags a raw regression", () => {
    const entry = makeEntry({ mount: 1.0, env: env() });
    const result = compareBaseline(entry, { mount: 1.2, rerender: 0.5, unmount: 0.1, interactions: {} }, TOL, undefined, env());
    expect(result.envMatch).toBe("identical");
    expect(result.envMismatches).toEqual([]);
    expect(result.regressions.map((r) => r.metric)).toEqual(["mount"]);
    expect(result.regressions[0].normalized).toBeUndefined();
  });
});

describe("E3 unknown → raw comparison", () => {
  it("compares raw against a pre-M29 entry", () => {
    const entry = makeEntry({ mount: 1.0 });
    const result = compareBaseline(entry, { mount: 1.5, rerender: 0.5, unmount: 0.1, interactions: {} }, TOL, undefined, env());
    expect(result.envMatch).toBe("unknown");
    expect(result.envMismatches).toEqual(["baseline has no environment record"]);
    expect(result.regressions).toHaveLength(1);
  });
});

describe("E3 normalizable → calibration-normalized comparison", () => {
  const baseEnv = env({ calibrationTotalDuration: 10, cpu: "Slow CPU" });
  const curEnv = env({ calibrationTotalDuration: 20 });

  it("does not flag a metric that scales exactly with calibration", () => {
    const entry = makeEntry({ mount: 10, rerender: 0, unmount: 0, env: baseEnv });
    const result = compareBaseline(entry, { mount: 20, rerender: 0, unmount: 0, interactions: {} }, TOL, undefined, curEnv);
    expect(result.envMatch).toBe("normalizable");
    expect(result.regressions).toHaveLength(0);
  });

  it("flags a metric that grows twice as fast as calibration", () => {
    const entry = makeEntry({ mount: 10, rerender: 0, unmount: 0, env: baseEnv });
    const result = compareBaseline(entry, { mount: 40, rerender: 0, unmount: 0, interactions: {} }, TOL, undefined, curEnv);
    expect(result.regressions).toHaveLength(1);
    const reg = result.regressions[0];
    expect(reg.metric).toBe("mount");
    expect(reg.baseline).toBe(10);
    expect(reg.current).toBe(40);
    expect(reg.normalized).toBeDefined();
    expect(reg.normalized!.baseline).toBeCloseTo(1, 6);
    expect(reg.normalized!.current).toBeCloseTo(2, 6);
    expect(reg.normalized!.deltaPercent).toBeCloseTo(100, 6);
  });

  it("records the normalized ratio on improvements too", () => {
    const entry = makeEntry({ mount: 10, rerender: 0, unmount: 0, env: baseEnv });
    const result = compareBaseline(entry, { mount: 10, rerender: 0, unmount: 0, interactions: {} }, TOL, undefined, curEnv);
    expect(result.improvements).toHaveLength(1);
    expect(result.improvements[0].normalized!.deltaPercent).toBeCloseTo(-50, 6);
  });

  it("suppresses a normalized regression whose raw delta is below 0.5ms", () => {
    const entry = makeEntry({ mount: 0.2, rerender: 0, unmount: 0, env: baseEnv });
    const result = compareBaseline(entry, { mount: 0.6, rerender: 0, unmount: 0, interactions: {} }, TOL, undefined, curEnv);
    expect(result.regressions).toHaveLength(0);
  });

  // Equal calibration with a different CPU: still normalizable, but the
  // normalization is 1:1, so the raw delta is the only thing being floored.
  const flatBaseEnv = env({ calibrationTotalDuration: 10, cpu: "Slow CPU" });
  const flatCurEnv = env({ calibrationTotalDuration: 10 });

  it("suppresses a normalized regression whose raw delta is exactly 0.5ms", () => {
    const entry = makeEntry({ mount: 1.0, rerender: 0, unmount: 0, env: flatBaseEnv });
    const result = compareBaseline(entry, { mount: 1.5, rerender: 0, unmount: 0, interactions: {} }, TOL, undefined, flatCurEnv);
    expect(result.envMatch).toBe("normalizable");
    expect(result.regressions).toHaveLength(0);
  });

  it("keeps a normalized regression whose raw delta exceeds 0.5ms", () => {
    const entry = makeEntry({ mount: 1.0, rerender: 0, unmount: 0, env: flatBaseEnv });
    const result = compareBaseline(entry, { mount: 1.6, rerender: 0, unmount: 0, interactions: {} }, TOL, undefined, flatCurEnv);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].normalized!.deltaPercent).toBeCloseTo(60, 6);
  });

  it("falls back to raw when a calibration value is unusable", () => {
    const entry = makeEntry({ mount: 1.0, rerender: 0, unmount: 0, env: env({ calibrationTotalDuration: 0, cpu: "Slow CPU" }) });
    const result = compareBaseline(entry, { mount: 1.2, rerender: 0, unmount: 0, interactions: {} }, TOL, undefined, curEnv);
    expect(result.envMatch).toBe("normalizable");
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].normalized).toBeUndefined();
    expect(result.envMismatches.some((m) => m.includes("calibration total duration missing"))).toBe(true);
  });

  it("normalizes interaction metrics too", () => {
    const entry = makeEntry({ mount: 0, rerender: 0, unmount: 0, interactions: { click: 100 }, env: baseEnv });
    const result = compareBaseline(entry, { mount: 0, rerender: 0, unmount: 0, interactions: { click: 400 } }, TOL, undefined, curEnv);
    expect(result.regressions.map((r) => r.metric)).toEqual(["interaction:click"]);
    expect(result.regressions[0].normalized!.deltaPercent).toBeCloseTo(100, 6);
  });
});

describe("E3 incompatible → no comparison", () => {
  it("returns empty results with mismatches and no failure signal", () => {
    const entry = makeEntry({ mount: 1.0, interactions: { click: 100 }, env: env() });
    const result = compareBaseline(
      entry,
      { mount: 99, rerender: 99, unmount: 99, interactions: {} },
      TOL,
      undefined,
      env({ wrapper: "120fps.setup.tsx" }),
    );
    expect(result.hasBaseline).toBe(true);
    expect(result.envMatch).toBe("incompatible");
    expect(result.regressions).toEqual([]);
    expect(result.improvements).toEqual([]);
    expect(result.missingInteractions).toEqual([]);
    expect(result.envMismatches).toHaveLength(1);
  });
});

// --- E4: policy ---

describe("E4 envAdvisory", () => {
  it("never fails or warns for identical", () => {
    for (const policy of ["strict", "normalize", "ignore"] as const) {
      expect(envAdvisory("identical", [], policy)).toEqual({ fail: false });
    }
  });

  it("warns but does not fail for unknown under normalize", () => {
    const a = envAdvisory("unknown", ["baseline has no environment record"], "normalize");
    expect(a.fail).toBe(false);
    expect(a.warning).toBe(UNKNOWN_ENV_WARNING);
  });

  it("warns but does not fail for incompatible under normalize", () => {
    const a = envAdvisory("incompatible", ["provider wrapper: baseline none, current 120fps.setup.tsx"], "normalize");
    expect(a.fail).toBe(false);
    expect(a.warning).toContain("incompatible");
    expect(a.warning).toContain("provider wrapper");
    expect(a.warning).toContain("--save-baseline");
  });

  it("does not warn for normalizable under normalize", () => {
    expect(envAdvisory("normalizable", ["CPU: baseline \"A\", current \"B\""], "normalize")).toEqual({ fail: false });
  });

  it("fails under strict for every non-identical classification", () => {
    for (const match of ["normalizable", "incompatible", "unknown"] as const) {
      const a = envAdvisory(match, ["cores: baseline 8, current 16"], "strict");
      expect(a.fail).toBe(true);
      expect(a.warning).toContain("--baseline-env strict");
      expect(a.warning).toContain(match);
      expect(a.warning).toContain("cores: baseline 8, current 16");
    }
  });

  it("never warns or fails under ignore", () => {
    for (const match of ["normalizable", "incompatible", "unknown"] as const) {
      expect(envAdvisory(match, ["anything"], "ignore")).toEqual({ fail: false });
    }
  });
});

describe("E4 --baseline-env flag", () => {
  it("is a known flag", () => {
    expect(KNOWN_FLAGS.has("--baseline-env")).toBe(true);
  });

  it("parses each valid value", () => {
    for (const v of ["strict", "normalize", "ignore"] as const) {
      const args = parseArgs(["./a.tsx", "--baseline-env", v]);
      expect(args.error).toBeUndefined();
      expect(args.baselineEnv).toBe(v);
    }
  });

  it("defaults to undefined when absent", () => {
    expect(parseArgs(["./a.tsx"]).baselineEnv).toBeUndefined();
  });

  it("rejects an invalid value", () => {
    const args = parseArgs(["./a.tsx", "--baseline-env", "loose"]);
    expect(args.error).toContain("--baseline-env");
    expect(args.error).toContain("loose");
  });

  it("rejects a missing value", () => {
    expect(parseArgs(["./a.tsx", "--baseline-env"]).error).toContain("--baseline-env");
  });

  it("appears in the help text", async () => {
    const { helpText } = await import("../../src/cli.js");
    expect(helpText()).toContain("--baseline-env");
  });
});

// --- E5: reporting ---

const THRESHOLDS: Thresholds = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
    componentPath: "./test.tsx",
    componentName: "Test",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [{
      comboIndex: 0,
      props: {},
      mount: buildTimingWithCV([1, 1, 1]),
      unmount: buildTimingWithCV([0.1, 0.1, 0.1]),
      rerender: buildTimingWithCV([0.5, 0.5, 0.5]),
      domNodeCount: 8,
      heapDelta: 0,
      interactions: [],
      scalingCurve: null,
      relativeMount: 0.1,
      verdict: "pass" as const,
    }],
    thresholds: THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

function comparison(overrides: Partial<BaselineComparison> = {}): BaselineComparison {
  return {
    hasBaseline: true,
    regressions: [],
    improvements: [],
    missingInteractions: [],
    ...overrides,
  };
}

describe("E5 formatBaselineSection environment line", () => {
  it("renders the identical line", () => {
    const out = formatTable(makeReport({ baseline: comparison({ envMatch: "identical", envMismatches: [] }) }));
    expect(out).toContain("Environment: identical");
    expect(out).toContain("raw timings");
  });

  it("renders the normalizable line with mismatches", () => {
    const out = formatTable(makeReport({
      baseline: comparison({ envMatch: "normalizable", envMismatches: ["CPU: baseline \"A\", current \"B\""] }),
    }));
    expect(out).toContain("Environment: normalizable");
    expect(out).toContain("calibration-normalized");
    expect(out).toContain("CPU: baseline");
  });

  it("renders the unknown line", () => {
    const out = formatTable(makeReport({ baseline: comparison({ envMatch: "unknown", envMismatches: [] }) }));
    expect(out).toContain("Environment: unknown");
  });

  it("replaces the table with the mismatch list when incompatible", () => {
    const out = formatTable(makeReport({
      baseline: comparison({
        envMatch: "incompatible",
        envMismatches: ["provider wrapper: baseline none, current 120fps.setup.tsx"],
      }),
    }));
    expect(out).toContain("Environment: incompatible");
    expect(out).toContain("provider wrapper: baseline none, current 120fps.setup.tsx");
    expect(out).not.toContain("All metrics within tolerance");
    expect(out).not.toContain("REGRESSED");
  });

  it("renders the normalized block for normalized regressions", () => {
    const out = formatTable(makeReport({
      baseline: comparison({
        envMatch: "normalizable",
        envMismatches: ["CPU: baseline \"A\", current \"B\""],
        regressions: [{
          metric: "mount",
          baseline: 10,
          current: 40,
          deltaPercent: 300,
          tolerance: 10,
          normalized: { baseline: 1, current: 2, deltaPercent: 100 },
        }],
      }),
    }));
    expect(out).toContain("REGRESSED");
    expect(out).toContain("Normalized");
    expect(out).toContain("+100.0%");
  });

  it("omits the environment line for comparisons without a classification", () => {
    const out = formatTable(makeReport({ baseline: { hasBaseline: true, regressions: [], improvements: [] } }));
    expect(out).toContain("Baseline comparison");
    expect(out).not.toContain("Environment:");
  });

  it("emits no environment line or warning for a run without a baseline comparison", () => {
    const out = formatTable(makeReport());
    expect(out).not.toContain("Environment:");
    expect(out).not.toContain("environment record");
  });
});

// --- E6: migration ---

describe("E6 baseline file migration", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m29-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips the fingerprint through saveBaseline/loadBaseline", () => {
    const file = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(file, makeEntry({ env: env({ samples: 3, cpuThrottle: 6, wrapper: "120fps.setup.tsx" }) }), "./Button.tsx");
    const loaded = loadBaseline(file);
    const stored = loaded!.entries["./Button.tsx"].env!;
    expect(stored.shape).toBe(1);
    expect(stored.samples).toBe(3);
    expect(stored.cpuThrottle).toBe(6);
    expect(stored.wrapper).toBe("120fps.setup.tsx");
    expect(stored.mode).toBe("combo");
  });

  it("keeps version 1 at the file level", () => {
    const file = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(file, makeEntry({ env: env() }), "./Button.tsx");
    expect(loadBaseline(file)!.version).toBe(1);
  });

  it("loads a pre-M29 file and leaves env undefined", () => {
    const file = path.join(tmpDir, "120fps-baseline.json");
    fs.writeFileSync(file, JSON.stringify({
      version: 1,
      timestamp: "2026-01-01T00:00:00Z",
      entries: { "./Button.tsx": makeEntry() },
    }));
    const loaded = loadBaseline(file);
    expect(loaded!.entries["./Button.tsx"].env).toBeUndefined();
    expect(classifyEnv(loaded!.entries["./Button.tsx"].env, env())).toBe("unknown");
  });

  it("classifies per entry when a file mixes shapes", () => {
    const file = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(file, makeEntry(), "./Old.tsx");
    saveBaseline(file, makeEntry({ env: env() }), "./New.tsx");
    const loaded = loadBaseline(file)!;
    expect(classifyEnv(loaded.entries["./Old.tsx"].env, env())).toBe("unknown");
    expect(classifyEnv(loaded.entries["./New.tsx"].env, env())).toBe("identical");
  });

  it("upgrades an entry on re-save", () => {
    const file = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(file, makeEntry(), "./Button.tsx");
    expect(loadBaseline(file)!.entries["./Button.tsx"].env).toBeUndefined();
    saveBaseline(file, makeEntry({ env: env() }), "./Button.tsx");
    expect(loadBaseline(file)!.entries["./Button.tsx"].env).toBeDefined();
  });
});
