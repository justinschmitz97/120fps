import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  classifyEnv,
  describeEnvDiff,
  envAdvisory,
  compareBaseline,
  buildEnvFingerprint,
  loadBaseline,
  saveBaseline,
  resolveTolerances,
  MISSING_CALIBRATION_NOTE,
  type BaselineEntry,
  type ResolvedTolerance,
  selectBaselineEntry,
} from "../../src/budget.js";
import { formatTable, buildTimingWithCV, type EnvFingerprint, type Report, type Thresholds } from "../../src/report.js";
import { parseArgs } from "../../src/cli.js";

// M45: entries are keyed by component x environment slot; selectBaselineEntry
// resolves the slot for us so these assertions stay about the entry, not the key.
function entryOf(baseline: any, componentPath: string) {
  return selectBaselineEntry(baseline, componentPath, "unused")!.entry;
}

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

function noArgs(v: unknown): EnvFingerprint {
  return v as EnvFingerprint;
}

// H1: baseline JSON with `env: null`
describe("H1 null fingerprint", () => {
  it("classifies as unknown without throwing", () => {
    expect(classifyEnv(noArgs(null), env())).toBe("unknown");
    expect(describeEnvDiff(noArgs(null), env())).toEqual(["baseline has no environment record"]);
  });

  it("compares raw through compareBaseline", () => {
    const entry = makeEntry({ mount: 1.0, env: noArgs(null) });
    const result = compareBaseline(entry, { mount: 1.5, rerender: 0.5, unmount: 0.1, interactions: {} }, TOL, undefined, env());
    expect(result.envMatch).toBe("unknown");
    expect(result.regressions).toHaveLength(1);
  });
});

// H2: a fingerprint written by a future shape
describe("H2 unknown fingerprint shape", () => {
  it("compares on the shared fields instead of invalidating the entry", () => {
    expect(classifyEnv(env({ shape: 2 as 1 }), env())).toBe("identical");
    expect(describeEnvDiff(env({ shape: 2 as 1 }), env())).toEqual([]);
  });
});

// H3: hand-edited partial fingerprint
describe("H3 partial fingerprint", () => {
  const partial = noArgs({ shape: 1, cpu: "TestCPU X1", mode: "combo" });

  it("classifies normalizable without throwing", () => {
    expect(classifyEnv(partial, env())).toBe("normalizable");
  });

  it("renders diffs for the missing fields without throwing", () => {
    const diffs = describeEnvDiff(partial, env());
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.join(" ")).toContain("undefined");
  });

  it("falls back to raw comparison because calibration is missing", () => {
    const result = compareBaseline(
      makeEntry({ mount: 1.0, env: partial }),
      { mount: 1.5, rerender: 0, unmount: 0, interactions: {} },
      TOL,
      undefined,
      env(),
    );
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].normalized).toBeUndefined();
    expect(result.envMismatches).toContain(MISSING_CALIBRATION_NOTE);
  });
});

// H4: zero calibration in the stored baseline
describe("H4 zero calibration", () => {
  it("never divides by zero", () => {
    const result = compareBaseline(
      makeEntry({ mount: 1.0, env: env({ calibrationTotalDuration: 0, cpu: "Other" }) }),
      { mount: 5.0, rerender: 0, unmount: 0, interactions: {} },
      TOL,
      undefined,
      env(),
    );
    expect(result.regressions[0].current).toBe(5);
    expect(result.regressions[0].normalized).toBeUndefined();
    expect(result.envMismatches).toContain(MISSING_CALIBRATION_NOTE);
  });

  it("treats two zero calibrations on the same machine as identical", () => {
    expect(classifyEnv(env({ calibrationTotalDuration: 0 }), env({ calibrationTotalDuration: 0 }))).toBe("identical");
  });
});

// H5: negative metrics
describe("H5 negative metrics", () => {
  it("skips a non-positive baseline metric under normalization", () => {
    const result = compareBaseline(
      makeEntry({ mount: -1, rerender: 0, unmount: 0, env: env({ cpu: "Other" }) }),
      { mount: 5, rerender: 0, unmount: 0, interactions: {} },
      TOL,
      undefined,
      env(),
    );
    expect(result.regressions).toHaveLength(0);
    expect(result.improvements).toHaveLength(0);
  });
});

// H6: NaN metrics
describe("H6 NaN metrics", () => {
  it("produces no regression or improvement and does not throw", () => {
    const result = compareBaseline(
      makeEntry({ mount: 1, rerender: 0, unmount: 0, env: env({ cpu: "Other" }) }),
      { mount: NaN, rerender: 0, unmount: 0, interactions: {} },
      TOL,
      undefined,
      env(),
    );
    expect(result.regressions).toHaveLength(0);
    expect(result.improvements).toHaveLength(0);
  });
});

// H7: non-finite calibration
describe("H7 non-finite calibration", () => {
  it("rejects NaN and Infinity as normalization scales", () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const result = compareBaseline(
        makeEntry({ mount: 1.0, env: env({ calibrationTotalDuration: bad, cpu: "Other" }) }),
        { mount: 2.0, rerender: 0, unmount: 0, interactions: {} },
        TOL,
        undefined,
        env(),
      );
      expect(result.regressions[0].normalized).toBeUndefined();
      expect(Number.isFinite(result.regressions[0].deltaPercent)).toBe(true);
    }
  });
});

// H8: css presence asymmetry
describe("H8 css presence", () => {
  it("is incompatible in both directions", () => {
    expect(classifyEnv(env({ css: ["a.css"] }), env())).toBe("incompatible");
    expect(classifyEnv(env(), env({ css: ["a.css"] }))).toBe("incompatible");
  });

  it("treats an explicit empty list as different from an omitted one", () => {
    expect(classifyEnv(env({ css: [] }), env())).toBe("incompatible");
    expect(describeEnvDiff(env({ css: [] }), env()).join(" ")).toContain("(empty)");
  });

  it("does not throw on a non-array css value", () => {
    expect(classifyEnv(noArgs({ ...env(), css: "app/globals.css" }), env())).toBe("incompatible");
    expect(describeEnvDiff(noArgs({ ...env(), css: "app/globals.css" }), env()).join(" ")).toContain("app/globals.css");
  });
});

// H9: css ordering
describe("H9 css ordering", () => {
  it("treats a reordered list as incompatible because order drives the cascade", () => {
    expect(classifyEnv(env({ css: ["reset.css", "tokens.css"] }), env({ css: ["tokens.css", "reset.css"] }))).toBe("incompatible");
  });

  it("treats a longer list as incompatible", () => {
    expect(classifyEnv(env({ css: ["a.css"] }), env({ css: ["a.css", "b.css"] }))).toBe("incompatible");
  });
});

// H10: mixed entries in one file
describe("H10 mixed baseline file", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-m29-harden-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("compares each entry by its own fingerprint", () => {
    const file = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(file, makeEntry({ mount: 1.0 }), "./Old.tsx");
    saveBaseline(file, makeEntry({ mount: 1.0, env: env() }), "./New.tsx");
    const loaded = loadBaseline(file)!;

    const current = { mount: 1.5, rerender: 0.5, unmount: 0.1, interactions: {} };
    expect(compareBaseline(entryOf(loaded, "./Old.tsx"), current, TOL, undefined, env()).envMatch).toBe("unknown");
    expect(compareBaseline(entryOf(loaded, "./New.tsx"), current, TOL, undefined, env()).envMatch).toBe("identical");
  });

  it("preserves an unrelated entry's fingerprint when another is re-saved", () => {
    const file = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(file, makeEntry({ env: env({ wrapper: "a.tsx" }) }), "./A.tsx");
    saveBaseline(file, makeEntry({ env: env({ wrapper: "b.tsx" }) }), "./B.tsx");
    const loaded = loadBaseline(file)!;
    expect(entryOf(loaded, "./A.tsx").env!.wrapper).toBe("a.tsx");
    expect(entryOf(loaded, "./B.tsx").env!.wrapper).toBe("b.tsx");
  });
});

// H11: flag edge cases
describe("H11 --baseline-env parsing edges", () => {
  it("rejects an empty value", () => {
    expect(parseArgs(["./a.tsx", "--baseline-env", ""]).error).toContain("--baseline-env");
  });

  it("rejects a following flag used as the value", () => {
    const args = parseArgs(["./a.tsx", "--baseline-env", "--ci"]);
    expect(args.error).toContain("--baseline-env");
    expect(args.baselineEnv).toBeUndefined();
  });

  it("is case-sensitive", () => {
    expect(parseArgs(["./a.tsx", "--baseline-env", "STRICT"]).error).toContain("STRICT");
  });

  it("takes the last value when repeated", () => {
    expect(parseArgs(["./a.tsx", "--baseline-env", "strict", "--baseline-env", "ignore"]).baselineEnv).toBe("ignore");
  });
});

// H12: strict against an unfingerprinted baseline
describe("H12 strict with no baseline fingerprint", () => {
  it("fails and names the missing record", () => {
    const result = compareBaseline(makeEntry(), { mount: 1, rerender: 0.5, unmount: 0.1, interactions: {} }, TOL, undefined, env());
    const advisory = envAdvisory(result.envMatch, result.envMismatches, "strict");
    expect(advisory.fail).toBe(true);
    expect(advisory.warning).toContain("unknown");
    expect(advisory.warning).toContain("baseline has no environment record");
  });
});

// H13: mode outside the declared union
describe("H13 unrecognized mode", () => {
  it("is incompatible rather than a crash", () => {
    const result = compareBaseline(
      makeEntry({ env: noArgs({ ...env(), mode: "weird" }) }),
      { mount: 99, rerender: 99, unmount: 99, interactions: {} },
      TOL,
      undefined,
      env(),
    );
    expect(result.envMatch).toBe("incompatible");
    expect(result.envMismatches.join(" ")).toContain("weird");
    expect(result.regressions).toEqual([]);
  });
});

// H14: effective sample/throttle overrides
describe("H14 effective run configuration", () => {
  it("records overridden samples and throttle, not defaults", () => {
    const fp = buildEnvFingerprint({
      machine: { cpu: "c", cores: 2, ramMb: 1, os: "o", nodeVersion: "n", chromiumVersion: "v" },
      calibration: { totalDuration: 7, scriptDuration: 2 },
      cpuThrottle: 1,
      samples: 25,
      mode: "combo",
    });
    expect(fp.samples).toBe(25);
    expect(fp.cpuThrottle).toBe(1);
    expect(classifyEnv(fp, { ...fp, samples: 10 })).toBe("normalizable");
  });
});

// H15: Infinity in the current run
describe("H15 infinite current metric", () => {
  it("reports a regression without throwing", () => {
    const result = compareBaseline(
      makeEntry({ mount: 1.0, rerender: 0, unmount: 0, env: env({ cpu: "Other" }) }),
      { mount: Infinity, rerender: 0, unmount: 0, interactions: {} },
      TOL,
      undefined,
      env(),
    );
    expect(result.regressions).toHaveLength(1);
    expect(() => formatTable(makeReport({ baseline: { ...result } }))).not.toThrow();
  });
});

// H16: no cross-call state
describe("H16 repeated comparisons", () => {
  it("does not accumulate mismatch notes across calls", () => {
    const entry = makeEntry({ mount: 1.0, env: env({ calibrationTotalDuration: 0, cpu: "Other" }) });
    const current = { mount: 2.0, rerender: 0, unmount: 0, interactions: {} };
    const first = compareBaseline(entry, current, TOL, undefined, env());
    const second = compareBaseline(entry, current, TOL, undefined, env());
    expect(first.envMismatches).toEqual(second.envMismatches);
    expect(second.envMismatches.filter((m) => m === MISSING_CALIBRATION_NOTE)).toHaveLength(1);
  });
});

// H17: interaction label collisions
describe("H17 interaction label collisions", () => {
  it("keeps an interaction labelled mount separate from the core metric", () => {
    const result = compareBaseline(
      makeEntry({ mount: 10, rerender: 0, unmount: 0, interactions: { mount: 100 }, env: env({ calibrationTotalDuration: 10, cpu: "Other" }) }),
      { mount: 10, rerender: 0, unmount: 0, interactions: { mount: 400 } },
      TOL,
      undefined,
      env({ calibrationTotalDuration: 20 }),
    );
    expect(result.regressions.map((r) => r.metric)).toEqual(["interaction:mount"]);
  });
});

// H18: unstable metrics under normalization
describe("H18 unstable metrics", () => {
  it("still skips unstable metrics when normalizing", () => {
    const result = compareBaseline(
      makeEntry({ mount: 10, rerender: 0, unmount: 0, env: env({ calibrationTotalDuration: 10, cpu: "Other" }) }),
      { mount: 400, rerender: 0, unmount: 0, interactions: {} },
      TOL,
      new Set(["mount"]),
      env({ calibrationTotalDuration: 20 }),
    );
    expect(result.regressions).toHaveLength(0);
  });
});

// H19: report rendering with a contradictory comparison
describe("H19 incompatible comparison carrying metrics", () => {
  it("suppresses the metric table entirely", () => {
    const out = formatTable(makeReport({
      baseline: {
        hasBaseline: true,
        envMatch: "incompatible",
        envMismatches: ["mode: baseline \"combo\", current \"isolation\""],
        regressions: [{ metric: "mount", baseline: 1, current: 2, deltaPercent: 100, tolerance: 10 }],
        improvements: [],
        missingInteractions: [],
      },
    }));
    expect(out).not.toContain("REGRESSED");
    expect(out).toContain("comparison skipped");
  });
});

// H20: feature mismatch beats hardware drift in reporting
describe("H20 mismatch ordering", () => {
  it("lists feature differences before hardware differences", () => {
    const diffs = describeEnvDiff(
      env({ css: ["a.css"], wrapper: "w.tsx", cpu: "A", cores: 2 }),
      env({ cpu: "B", cores: 4 }),
    );
    expect(diffs[0]).toContain("stylesheets");
    expect(diffs[1]).toContain("provider wrapper");
    expect(diffs[2]).toContain("CPU:");
    expect(diffs[3]).toContain("cores");
  });
});

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
