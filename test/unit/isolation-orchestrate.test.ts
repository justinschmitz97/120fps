import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseArgs } from "../../src/cli.js";
import { generateEntry, generateComposedEntry, renderTreeHelper } from "../../src/harness.js";
import { generateProbeEntry } from "../../src/react-profiler.js";
import { classifyEnv, compareBaseline, type BaselineEntry, type EnvFingerprintInput } from "../../src/budget.js";
import { buildEnvFingerprint } from "../../src/budget.js";
import {
  buildTimingWithCV,
  formatTable,
  type EnvFingerprint,
  type MatrixReport,
  type Report,
  type ScalingCurveReport,
  type Thresholds,
} from "../../src/report.js";
import type { CompositionTree } from "../../src/composition.js";
import type { HarnessResult } from "../../src/harness.js";
import type { MountResult, RerenderResult } from "../../src/measure.js";

// runHarnessSession is stubbed per label so the three browser runners resolve to
// canned samples; measureMount/measureRerender are spied to assert the options
// the orchestrator passes them.
const canned = {
  churn: [1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 4, 4],
  memory: { heapBefore: 100_000, heapAfter: 110_000, gcPressure: 2 },
  strict: { normal: [1, 1, 1], strict: [2, 2, 2] },
  memoryUnavailable: false,
};

const measureMountSpy = vi.fn();
const measureRerenderSpy = vi.fn();

vi.mock("../../src/measure.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/measure.js")>();
  return {
    ...actual,
    measureMount: (...args: unknown[]) => measureMountSpy(...args),
    measureRerender: (...args: unknown[]) => measureRerenderSpy(...args),
    runHarnessSession: async (
      _harness: unknown,
      options: { label: string },
    ) => {
      if (options.label.startsWith("churn")) return canned.churn;
      if (options.label.startsWith("memory")) {
        return canned.memoryUnavailable ? undefined : canned.memory;
      }
      if (options.label.startsWith("strictmode")) return canned.strict;
      throw new Error(`unexpected session label: ${options.label}`);
    },
  };
});

const {
  parseIsolationPhases,
  selectIsolationCombos,
  runIsolationPhases,
  computeIsolationVerdict,
  isolationBaselineMetrics,
  buildMemoryReport,
  CHURN_CYCLES,
  CHURN_DEGRADATION_LIMIT,
  ISOLATION_WARMUP_RUNS,
  MEMORY_WARMUP_CYCLES,
  LEAK_BYTES_PER_CYCLE,
  DEGENERATE_COMBO_WARNING,
  MEMORY_SKIPPED_WARNING,
} = await import("../../src/isolation.js");
type IsolationReport = import("../../src/isolation.js").IsolationReport;

const HARNESS = {} as HarnessResult;

function mountResult(overrides: Partial<MountResult> = {}): MountResult {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [4, 5, 6], median: 5, p95: 6 },
    unmount: { samples: [1, 2, 3], median: 2, p95: 3 },
    domNodeCount: 7,
    hasAnimation: false,
    ...overrides,
  };
}

function rerenderResult(overrides: Partial<RerenderResult> = {}): RerenderResult {
  return {
    comboIndex: 0,
    props: {},
    stable: { samples: [1, 1, 1], median: 1, p95: 1 },
    change: { samples: [3, 3, 3], median: 3, p95: 3 },
    ...overrides,
  };
}

function runOptions(overrides: Record<string, unknown> = {}) {
  return {
    phases: ["mount"] as import("../../src/isolation.js").IsolationPhase[],
    comboA: { variant: "primary" },
    comboB: { variant: "ghost" },
    degenerate: false,
    samples: 4,
    cpuThrottle: 4,
    memoryCycles: 20,
    ...overrides,
  };
}

beforeEach(() => {
  measureMountSpy.mockReset();
  measureRerenderSpy.mockReset();
  measureMountSpy.mockResolvedValue([mountResult()]);
  measureRerenderSpy.mockResolvedValue([rerenderResult()]);
  canned.memoryUnavailable = false;
});

// ====================================================================
// I7/design: parseIsolationPhases is the single validator
// ====================================================================

describe("I7: parseIsolationPhases expands `all` anywhere in the list", () => {
  it("expands a lone all", () => {
    expect(parseIsolationPhases("all")).toEqual([
      "mount", "rerender", "unmount", "memory", "strictmode",
    ]);
  });

  it("expands all when it trails other phases", () => {
    expect(parseIsolationPhases("mount,all")).toEqual([
      "mount", "rerender", "unmount", "memory", "strictmode",
    ]);
  });

  it("expands all when it leads other phases", () => {
    expect(parseIsolationPhases("all,mount")).toEqual([
      "mount", "rerender", "unmount", "memory", "strictmode",
    ]);
  });

  it("returns an empty list for an empty or comma-only value", () => {
    expect(parseIsolationPhases("")).toEqual([]);
    expect(parseIsolationPhases(",,,")).toEqual([]);
  });
});

describe("I7: the CLI routes --isolate through parseIsolationPhases", () => {
  it("reports the parser's own error text verbatim", () => {
    let thrown = "";
    try {
      parseIsolationPhases("bogus");
    } catch (err) {
      thrown = (err as Error).message;
    }
    expect(thrown).not.toBe("");
    expect(parseArgs(["./Button.tsx", "--isolate", "bogus"]).error).toBe(thrown);
  });

  it("expands `all` inside a list, which the removed inline validator could not", () => {
    expect(parseArgs(["./Button.tsx", "--isolate", "mount,all"]).isolate).toHaveLength(5);
    expect(parseArgs(["./Button.tsx", "--isolate", "all,mount"]).isolate).toHaveLength(5);
  });

  it("rejects an empty phase list as a usage error", () => {
    expect(parseArgs(["./Button.tsx", "--isolate", ""]).error).toContain("--isolate");
    expect(parseArgs(["./Button.tsx", "--isolate", ",,"]).error).toContain("--isolate");
  });
});

// ====================================================================
// I2: combo selection
// ====================================================================

describe("I2: combo selection", () => {
  it("uses combos[1] as the second combination when it exists", () => {
    const selection = selectIsolationCombos([{ a: 1 }, { a: 2 }, { a: 3 }]);
    expect(selection.comboA).toEqual({ a: 1 });
    expect(selection.comboB).toEqual({ a: 2 });
    expect(selection.degenerate).toBe(false);
  });

  it("degenerates both combinations to combos[0] when there is only one", () => {
    const selection = selectIsolationCombos([{ a: 1 }]);
    expect(selection.comboA).toEqual({ a: 1 });
    expect(selection.comboB).toEqual({ a: 1 });
    expect(selection.degenerate).toBe(true);
  });

  it("excludes __120fps_scaleN combos from selection", () => {
    const selection = selectIsolationCombos([
      { __120fps_scaleN: 1 },
      { a: 1 },
      { __120fps_scaleN: 5 },
      { a: 2 },
    ]);
    expect(selection.comboA).toEqual({ a: 1 });
    expect(selection.comboB).toEqual({ a: 2 });
    expect(selection.degenerate).toBe(false);
  });

  it("falls back to the empty combo when every combination is a scale combo", () => {
    const selection = selectIsolationCombos([{ __120fps_scaleN: 1 }, { __120fps_scaleN: 5 }]);
    expect(selection.comboA).toEqual({});
    expect(selection.comboB).toEqual({});
    expect(selection.degenerate).toBe(true);
  });

  it("falls back to the empty combo for an empty list", () => {
    const selection = selectIsolationCombos([]);
    expect(selection.comboA).toEqual({});
    expect(selection.degenerate).toBe(true);
  });
});

// ====================================================================
// I3: the mount/unmount pass reuses measureMount
// ====================================================================

describe("I3: mount/unmount pass", () => {
  it("calls measureMount with warmupRuns 3 and the single selected combo", async () => {
    await runIsolationPhases(HARNESS, runOptions({ phases: ["mount"] }));
    expect(measureMountSpy).toHaveBeenCalledTimes(1);
    expect(measureMountSpy.mock.calls[0][1]).toEqual({
      samples: 4,
      cpuThrottle: 4,
      warmupRuns: ISOLATION_WARMUP_RUNS,
      combos: [{ variant: "primary" }],
    });
    expect(ISOLATION_WARMUP_RUNS).toBe(3);
  });

  it("serves mount and unmount from one pass", async () => {
    const run = await runIsolationPhases(HARNESS, runOptions({ phases: ["mount", "unmount"] }));
    expect(measureMountSpy).toHaveBeenCalledTimes(1);
    expect(run.isolation.mount!.median).toBe(5);
    expect(run.isolation.unmount!.median).toBe(2);
  });

  it("reports only the requested half of the shared pass", async () => {
    const run = await runIsolationPhases(HARNESS, runOptions({ phases: ["unmount"] }));
    expect(run.isolation.mount).toBeUndefined();
    expect(run.isolation.unmount!.median).toBe(2);
  });

  it("carries domNodeCount and hasAnimation out for tier classification", async () => {
    measureMountSpy.mockResolvedValue([mountResult({ domNodeCount: 55, hasAnimation: true })]);
    const run = await runIsolationPhases(HARNESS, runOptions({ phases: ["mount"] }));
    expect(run.domNodeCount).toBe(55);
    expect(run.hasAnimation).toBe(true);
  });

  it("does not run the mount pass when neither mount nor unmount is requested", async () => {
    await runIsolationPhases(HARNESS, runOptions({ phases: ["memory"] }));
    expect(measureMountSpy).not.toHaveBeenCalled();
  });
});

// ====================================================================
// I3/I6: rerender, churn, memory, strictmode and the TimingWithCV bridge
// ====================================================================

describe("I3: rerender pass", () => {
  it("measures both selected combos and reads combo 0", async () => {
    const run = await runIsolationPhases(HARNESS, runOptions({ phases: ["rerender"] }));
    expect(measureRerenderSpy.mock.calls[0][1]).toEqual({
      samples: 4,
      cpuThrottle: 4,
      warmupRuns: ISOLATION_WARMUP_RUNS,
      combos: [{ variant: "primary" }, { variant: "ghost" }],
    });
    expect(run.isolation.rerender!.stable.median).toBe(1);
    expect(run.isolation.rerender!.propChange.median).toBe(3);
  });

  it("degenerates prop-change to the stable series and warns", async () => {
    measureRerenderSpy.mockResolvedValue([rerenderResult({ change: undefined })]);
    const run = await runIsolationPhases(
      HARNESS,
      runOptions({ phases: ["rerender"], comboB: { variant: "primary" }, degenerate: true }),
    );
    expect(measureRerenderSpy.mock.calls[0][1].combos).toEqual([{ variant: "primary" }]);
    expect(run.isolation.rerender!.propChange.samples).toEqual(
      run.isolation.rerender!.stable.samples,
    );
    expect(run.warnings).toContain(DEGENERATE_COMBO_WARNING);
  });

  it("does not emit the degenerate warning when the rerender phase is not requested", async () => {
    const run = await runIsolationPhases(
      HARNESS,
      runOptions({ phases: ["mount"], degenerate: true }),
    );
    expect(run.warnings).toEqual([]);
  });

  it("feeds churn samples through buildRerenderIsolation", async () => {
    const run = await runIsolationPhases(HARNESS, runOptions({ phases: ["rerender"] }));
    expect(run.isolation.rerender!.churn.samples).toEqual(canned.churn);
    expect(run.isolation.rerender!.churnDegradation).toBeGreaterThan(2);
  });

  it("fixes churn at 10 cycles, i.e. 20 samples", () => {
    expect(CHURN_CYCLES).toBe(10);
    expect(canned.churn).toHaveLength(CHURN_CYCLES * 2);
  });
});

describe("I5: memory pass", () => {
  it("builds a MemoryReport from the measured heap", async () => {
    const run = await runIsolationPhases(HARNESS, runOptions({ phases: ["memory"] }));
    expect(run.isolation.memory).toEqual({
      cycles: 20,
      heapBefore: 100_000,
      heapAfter: 110_000,
      heapGrowth: 10_000,
      heapGrowthPerCycle: 500,
      leakSuspected: false,
      gcPressure: 2,
    });
    expect(run.warnings).toEqual([]);
  });

  // Measured over 20 cycles at 4x throttle after 10 warmup cycles: non-leaking
  // components grow 2.2-2.4 KB/cycle, a component that retains every mount grows
  // ~200 KB/cycle. The threshold sits between them, not inside the floor.
  it("puts the leak threshold above the post-warmup noise floor", () => {
    expect(MEMORY_WARMUP_CYCLES).toBe(10);
    expect(LEAK_BYTES_PER_CYCLE).toBe(8192);
    const perCycle = (bytes: number) =>
      buildMemoryReport({ cycles: 20, heapBefore: 0, heapAfter: bytes * 20, gcPressure: 0 });
    expect(perCycle(2416).leakSuspected).toBe(false);
    expect(perCycle(202760).leakSuspected).toBe(true);
  });

  it("skips the phase with a warning when GC is unavailable", async () => {
    canned.memoryUnavailable = true;
    const run = await runIsolationPhases(HARNESS, runOptions({ phases: ["memory"] }));
    expect(run.isolation.memory).toBeUndefined();
    expect(run.warnings).toContain(MEMORY_SKIPPED_WARNING);
  });
});

describe("I4/I6: strictmode pass", () => {
  it("builds a StrictModeReport from the paired series", async () => {
    const run = await runIsolationPhases(HARNESS, runOptions({ phases: ["strictmode"] }));
    expect(run.isolation.strictMode!.normalMount.median).toBe(1);
    expect(run.isolation.strictMode!.strictMount.median).toBe(2);
    expect(run.isolation.strictMode!.overhead).toBeCloseTo(100);
  });
});

describe("I6: every phase array crosses the TimingWithCV bridge", () => {
  it("gives every timing a cv and an unstable flag", async () => {
    const run = await runIsolationPhases(
      HARNESS,
      runOptions({ phases: ["mount", "rerender", "unmount", "memory", "strictmode"] }),
    );
    const timings = [
      run.isolation.mount!,
      run.isolation.unmount!,
      run.isolation.rerender!.stable,
      run.isolation.rerender!.propChange,
      run.isolation.rerender!.churn,
      run.isolation.strictMode!.normalMount,
      run.isolation.strictMode!.strictMount,
    ];
    for (const timing of timings) {
      expect(typeof timing.cv).toBe("number");
      expect(typeof timing.unstable).toBe("boolean");
      expect(Array.isArray(timing.samples)).toBe(true);
    }
  });
});

// ====================================================================
// I4: entry generation
// ====================================================================

const ENTRY_BASE = {
  componentRelative: "fixtures/button.tsx",
  componentName: "Button",
  isDefaultExport: true,
  hasScale: false,
};

const STRICT_FLAG = `const __120fpsStrict = new URLSearchParams(location.search).get("strict") === "1";`;
const STRICT_WRAP = `const __120fpsInStrict = (el: any) => __120fpsStrict ? createElement(StrictMode, null, el) : el;`;

describe("I4: strict query support in the normal entry", () => {
  const entry = generateEntry(ENTRY_BASE);

  it("imports StrictMode from react", () => {
    expect(entry).toContain(`import { createElement, StrictMode } from "react";`);
  });

  it("reads the strict query parameter", () => {
    expect(entry).toContain(STRICT_FLAG);
    expect(entry).toContain(STRICT_WRAP);
  });

  it("applies it inside the single renderTree helper", () => {
    expect(entry).toContain("const renderTree = (el: any) => root.render(__120fpsInStrict(el));");
    expect(entry.match(/root\.render\(/g)).toHaveLength(1);
  });

  it("still never references the wrapper binding", () => {
    expect(entry).not.toContain("__120fpsWrap");
  });
});

describe("I4: StrictMode nests inside the provider wrapper", () => {
  const entry = generateEntry({ ...ENTRY_BASE, wrapRelative: "120fps.setup.tsx" });

  it("renders wrapper(StrictMode(component))", () => {
    expect(entry).toContain(
      "const renderTree = (el: any) => root.render(__120fpsWrap ? createElement(__120fpsWrap, null, __120fpsInStrict(el)) : __120fpsInStrict(el));",
    );
  });

  it("keeps a single render call site and a single wrapper application", () => {
    expect(entry.match(/root\.render\(/g)).toHaveLength(1);
    expect(entry.match(/createElement\(__120fpsWrap/g)).toHaveLength(1);
  });
});

describe("I4: strict query support in the composed entry", () => {
  const tree: CompositionTree = {
    root: "Accordion",
    structure: [{ component: "Accordion", props: {}, children: [] }],
    repeatCount: 1,
  };

  it("emits the strict bindings without a wrapper", () => {
    const entry = generateComposedEntry("fixtures/accordion-root.tsx", tree);
    expect(entry).toContain(`import { createElement, StrictMode } from "react";`);
    expect(entry).toContain(STRICT_FLAG);
    expect(entry).toContain("const renderTree = (el: any) => root.render(__120fpsInStrict(el));");
    expect(entry).not.toContain("__120fpsWrap");
  });

  it("nests StrictMode inside the wrapper", () => {
    const entry = generateComposedEntry("fixtures/accordion-root.tsx", tree, undefined, "120fps.setup.tsx");
    expect(entry).toContain(
      "const renderTree = (el: any) => root.render(__120fpsWrap ? createElement(__120fpsWrap, null, __120fpsInStrict(el)) : __120fpsInStrict(el));",
    );
  });
});

describe("I4: the React probe entry keeps the non-strict helper", () => {
  it("shares renderTreeHelper without the strict binding", () => {
    const probe = generateProbeEntry({
      componentRelative: "fixtures/button.tsx",
      componentName: "Button",
      isDefaultExport: true,
    });
    expect(probe).toContain("const renderTree = (el: any) => root.render(el);");
    expect(probe).not.toContain("__120fpsInStrict");
  });

  it("defaults renderTreeHelper to the non-strict form", () => {
    expect(renderTreeHelper()).toBe("const renderTree = (el: any) => root.render(el);");
    expect(renderTreeHelper(undefined, true)).toContain("__120fpsInStrict");
  });
});

// ====================================================================
// I8: verdict
// ====================================================================

function timing(median: number) {
  return buildTimingWithCV([median, median, median]);
}

function isolationWith(overrides: Partial<IsolationReport> = {}): IsolationReport {
  return {
    mount: timing(5),
    rerender: {
      stable: timing(1),
      propChange: timing(2),
      churn: timing(2),
      churnDegradation: 1.1,
    },
    unmount: timing(1),
    memory: {
      cycles: 20,
      heapBefore: 1000,
      heapAfter: 1000,
      heapGrowth: 0,
      heapGrowthPerCycle: 0,
      leakSuspected: false,
      gcPressure: 0,
    },
    strictMode: {
      normalMount: timing(5),
      strictMount: timing(10),
      overhead: 100,
      doubleInvokeClean: true,
    },
    ...overrides,
  };
}

describe("I8: isolation verdict", () => {
  it("passes a healthy report", () => {
    expect(computeIsolationVerdict(isolationWith(), 14)).toBe(true);
  });

  it("fails when the isolated mount median exceeds the budget", () => {
    expect(computeIsolationVerdict(isolationWith({ mount: timing(15) }), 14)).toBe(false);
    expect(computeIsolationVerdict(isolationWith({ mount: timing(14) }), 14)).toBe(true);
  });

  it("fails when a leak is suspected", () => {
    const leaking = isolationWith({
      memory: {
        cycles: 20,
        heapBefore: 1000,
        heapAfter: 100_000,
        heapGrowth: 99_000,
        heapGrowthPerCycle: 4950,
        leakSuspected: true,
        gcPressure: 4,
      },
    });
    expect(computeIsolationVerdict(leaking, 14)).toBe(false);
  });

  it("fails when churn degradation exceeds 2.0", () => {
    const churning = (degradation: number) =>
      isolationWith({
        rerender: { stable: timing(1), propChange: timing(2), churn: timing(2), churnDegradation: degradation },
      });
    expect(CHURN_DEGRADATION_LIMIT).toBe(2.0);
    expect(computeIsolationVerdict(churning(2.01), 14)).toBe(false);
    expect(computeIsolationVerdict(churning(2.0), 14)).toBe(true);
  });

  it("does not fail on doubleInvokeClean false", () => {
    const dirty = isolationWith({
      strictMode: {
        normalMount: timing(5),
        strictMount: timing(20),
        overhead: 300,
        doubleInvokeClean: false,
      },
    });
    expect(computeIsolationVerdict(dirty, 14)).toBe(true);
  });

  it("skips the mount check when no mount phase ran", () => {
    const memoryOnly: IsolationReport = {
      memory: {
        cycles: 20,
        heapBefore: 0,
        heapAfter: 0,
        heapGrowth: 0,
        heapGrowthPerCycle: 0,
        leakSuspected: false,
        gcPressure: 0,
      },
    };
    expect(computeIsolationVerdict(memoryOnly, undefined)).toBe(true);
  });
});

// ====================================================================
// I10: warnings reach the user in every output mode
// ====================================================================

const THRESHOLDS: Thresholds = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

function baseReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
    componentPath: "./test.tsx",
    componentName: "Test",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [],
    thresholds: THRESHOLDS,
    pass: true,
    warnings: ["a warning the user must see"],
    ...overrides,
  };
}

const FLAT_CURVE = { slope: 0, intercept: 1, r2: 1, growthClass: "constant" as const };

const CURVE_REPORT: ScalingCurveReport = {
  propName: "items",
  propKind: "array",
  reason: "test",
  points: [
    {
      n: 1,
      mount: timing(1),
      rerender: timing(1),
      unmount: timing(1),
      domNodeCount: 3,
      heapDelta: 0,
      interactions: [],
    },
  ],
  mountCurve: FLAT_CURVE,
  rerenderCurve: FLAT_CURVE,
  unmountCurve: FLAT_CURVE,
  interactionCurves: {},
  domGrowth: FLAT_CURVE,
  heapGrowth: FLAT_CURVE,
};

const MATRIX_REPORT: MatrixReport = {
  axes: [{ propName: "variant", values: ["primary", "ghost"] }],
  cells: [
    {
      comboIndex: 0,
      props: { variant: "primary" },
      mount: timing(1),
      rerender: timing(1),
      unmount: timing(1),
      domNodeCount: 3,
      tier: "T1",
      verdict: "pass",
      worstInteractionMs: null,
    },
  ],
  hotCells: [],
  coldCells: [],
  failingCells: [],
  compoundEffects: [],
};

describe("I10: formatTable renders warnings in all four output modes", () => {
  it("combo mode", () => {
    expect(formatTable(baseReport())).toContain("⚠ a warning the user must see");
  });

  it("isolation mode", () => {
    const report = baseReport({ isolation: { mount: timing(1) } });
    expect(formatTable(report)).toContain("⚠ a warning the user must see");
  });

  it("curve mode", () => {
    const report = baseReport({ scalingCurveReport: CURVE_REPORT });
    expect(formatTable(report)).toContain("⚠ a warning the user must see");
  });

  it("matrix mode", () => {
    const report = baseReport({ matrixReport: MATRIX_REPORT });
    expect(formatTable(report)).toContain("⚠ a warning the user must see");
  });

  it("emits nothing extra when there are no warnings", () => {
    const report = baseReport({ warnings: undefined, isolation: { mount: timing(1) } });
    expect(formatTable(report)).not.toContain("⚠");
  });
});

// ====================================================================
// I9: baselines
// ====================================================================

const ENV_INPUT: EnvFingerprintInput = {
  machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
  calibration: { totalDuration: 10, scriptDuration: 5 },
  cpuThrottle: 4,
  samples: 10,
  mode: "isolation",
};

describe("I9: isolation baseline metrics", () => {
  it("takes mount, stable rerender and unmount from the isolated phases with no interactions", () => {
    const metrics = isolationBaselineMetrics(isolationWith(), "T2", 21);
    expect(metrics).toEqual({
      mount: 5,
      rerender: 1,
      unmount: 1,
      domNodeCount: 21,
      interactions: {},
      unstable: new Set(),
      tier: "T2",
    });
  });

  it("records zero for phases that did not run", () => {
    const metrics = isolationBaselineMetrics({ mount: timing(5) }, "T1", 4);
    expect(metrics.mount).toBe(5);
    expect(metrics.rerender).toBe(0);
    expect(metrics.unmount).toBe(0);
  });

  it("marks unstable phases so compareBaseline skips them", () => {
    const unstableMount = buildTimingWithCV([1, 40, 1]);
    expect(unstableMount.unstable).toBe(true);
    const metrics = isolationBaselineMetrics({ mount: unstableMount }, "T1", 4);
    expect(metrics.unstable.has("mount")).toBe(true);
  });
});

describe("I9: isolation fingerprint and comparison", () => {
  it("records mode isolation", () => {
    expect(buildEnvFingerprint(ENV_INPUT).mode).toBe("isolation");
  });

  it("classifies an isolation baseline against a combo run as incompatible", () => {
    const isolationEnv = buildEnvFingerprint(ENV_INPUT);
    const comboEnv = buildEnvFingerprint({ ...ENV_INPUT, mode: "combo" });
    expect(classifyEnv(isolationEnv, comboEnv)).toBe("incompatible");
    expect(classifyEnv(comboEnv, isolationEnv)).toBe("incompatible");
  });

  it("treats an empty interactions map as inert and skips zero-valued metrics", () => {
    const env: EnvFingerprint = buildEnvFingerprint(ENV_INPUT);
    const entry: BaselineEntry = {
      mount: 5,
      rerender: 0,
      unmount: 0,
      domNodeCount: 7,
      interactions: {},
      tier: "T1",
      env,
    };
    const comparison = compareBaseline(
      entry,
      { mount: 5.1, rerender: 0, unmount: 0, interactions: {} },
      { mount: 10, rerender: 15, interaction: 15, unmount: 20 },
      new Set(),
      env,
    );
    expect(comparison.regressions).toEqual([]);
    expect(comparison.missingInteractions).toEqual([]);
    expect(comparison.envMatch).toBe("identical");
  });
});
