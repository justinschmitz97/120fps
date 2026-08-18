import { describe, it, expect } from "vitest";
import {
  classifyTier,
  deriveReportMode,
  describeMode,
  formatTable,
  DEFAULT_THRESHOLDS,
  type ComboReport,
  type MatrixCell,
  type MatrixReport,
  type Report,
  type ScalingCurveReport,
} from "../../src/report.js";
import {
  NOISY_RUN_WARNING,
  HOSTILE_RUN_WARNING,
  NOISY_BASELINE_NOTE,
  HOSTILE_BASELINE_NOTE,
  formatNoiseWarning,
  type NoiseReport,
} from "../../src/noise.js";
import { OBSERVED_ANIMATION_EXPRESSION } from "../../src/measure.js";
import { FIBER_TYPE_NAME_SOURCE, PROFILER_HOOK_SCRIPT } from "../../src/react-profiler.js";
import { helpText, formatJsonSplitNotice } from "../../src/cli.js";
import { formatMarkdown } from "../../src/ci-report.js";

// --- shared fixtures ---

const baseMachine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v22.0.0", chromiumVersion: "120.0.0.0",
};

function timing(median: number, unstable = false) {
  return { samples: [median], median, p95: median, cv: 0, unstable };
}

function makeCombo(overrides: Partial<ComboReport> = {}): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: timing(5),
    unmount: timing(2),
    rerender: timing(3),
    domNodeCount: 10,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 0.5,
    verdict: "pass",
    ...overrides,
  };
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: baseMachine,
    componentPath: "./Button.tsx",
    componentName: "Button",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [makeCombo()],
    thresholds: DEFAULT_THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

function makeCell(overrides: Partial<MatrixCell> = {}): MatrixCell {
  return {
    comboIndex: 0,
    props: { open: true, size: "lg" },
    mount: timing(5),
    rerender: timing(3),
    unmount: timing(2),
    domNodeCount: 12,
    tier: "T2",
    verdict: "pass",
    worstInteractionMs: null,
    ...overrides,
  };
}

function makeMatrix(overrides: Partial<MatrixReport> = {}): MatrixReport {
  const cell = makeCell();
  return {
    axes: [
      { propName: "open", values: [false, true] },
      { propName: "size", values: ["sm", "lg"] },
    ],
    cells: [cell],
    hotCells: [cell],
    coldCells: [cell],
    failingCells: [],
    compoundEffects: [],
    ...overrides,
  };
}

function makeCurve(): ScalingCurveReport {
  const curve = { growthClass: "linear" as const, r2: 0.99, coefficient: 1, intercept: 0 };
  return {
    propName: "items",
    propKind: "array",
    reason: "array prop",
    points: [
      { n: 1, mount: timing(5), rerender: timing(2), unmount: timing(1), domNodeCount: 5, heapDelta: 0, interactions: [] },
      { n: 5, mount: timing(9), rerender: timing(3), unmount: timing(1), domNodeCount: 25, heapDelta: 0, interactions: [] },
    ],
    mountCurve: curve,
    rerenderCurve: curve,
    unmountCurve: curve,
    interactionCurves: {},
    domGrowth: curve,
    heapGrowth: curve,
  };
}

// ====================================================================
// 1 — compound-effect sign
// ====================================================================

describe("M64.1 compound-effect sign", () => {
  it("reads 'below additive expectation' for a negative delta", () => {
    const report = makeReport({
      combos: [],
      matrixReport: makeMatrix({
        compoundEffects: [{
          props: { open: true, size: "lg" },
          expectedMount: 200,
          actualMount: 144.6,
          compoundDelta: -55.4,
          significance: "low",
        }],
      }),
    });
    const table = formatTable(report);
    expect(table).toContain("-55.4ms below additive expectation (low)");
    expect(table).not.toContain("above additive expectation");
  });

  it("keeps 'above additive expectation' for a positive delta", () => {
    const report = makeReport({
      combos: [],
      matrixReport: makeMatrix({
        compoundEffects: [{
          props: { open: true, size: "lg" },
          expectedMount: 100,
          actualMount: 155.4,
          compoundDelta: 55.4,
          significance: "high",
        }],
      }),
    });
    expect(formatTable(report)).toContain("+55.4ms above additive expectation (high)");
  });

  it("treats an exactly-zero delta as 'above' (no unexpected compounding)", () => {
    const report = makeReport({
      combos: [],
      matrixReport: makeMatrix({
        compoundEffects: [{
          props: { open: true, size: "lg" },
          expectedMount: 100,
          actualMount: 100,
          compoundDelta: 0,
          significance: "low",
        }],
      }),
    });
    expect(formatTable(report)).toContain("+0.0ms above additive expectation (low)");
  });
});

// ====================================================================
// 2 — WARN rollup note
// ====================================================================

describe("M64.2 WARN rollup note", () => {
  it("explains WARN rows sitting under Result: PASS", () => {
    const report = makeReport({
      combos: [
        makeCombo({ comboIndex: 0, verdict: "pass" }),
        makeCombo({ comboIndex: 1, verdict: "warn" }),
        makeCombo({ comboIndex: 2, verdict: "warn" }),
      ],
    });
    const table = formatTable(report);
    expect(table).toContain("Result: PASS");
    expect(table).toContain("2 of 3 combos warned; warnings do not fail the run.");
  });

  it("says nothing when no combo warned", () => {
    const table = formatTable(makeReport());
    expect(table).not.toContain("warned;");
  });

  it("says nothing on a failing run", () => {
    const report = makeReport({
      pass: false,
      combos: [makeCombo({ verdict: "warn" }), makeCombo({ comboIndex: 1, verdict: "fail" })],
    });
    const table = formatTable(report);
    expect(table).toContain("Result: FAIL");
    expect(table).not.toContain("warned;");
  });

  it("counts matrix cells in matrix mode", () => {
    const cells = [
      makeCell({ comboIndex: 0, verdict: "pass" }),
      makeCell({ comboIndex: 1, verdict: "warn" }),
    ];
    const report = makeReport({
      combos: [],
      matrixReport: makeMatrix({ cells, hotCells: cells, coldCells: cells }),
    });
    const table = formatTable(report);
    expect(table).toContain("Result: PASS");
    expect(table).toContain("1 of 2 cells warned; warnings do not fail the run.");
  });
});

// ====================================================================
// 3 — noise warning wording
// ====================================================================

function noise(level: NoiseReport["level"], overrides: Partial<NoiseReport["signals"]> = {}): NoiseReport {
  return {
    level,
    signals: {
      probeCv: 34.8,
      probeMedianMs: 12,
      unstableFraction: 0.4286,
      contextRetries: 0,
      ...overrides,
    },
  };
}

describe("M64.3 noise warning wording", () => {
  it("keeps the baseline claim out of the fixed strings", () => {
    expect(HOSTILE_RUN_WARNING).not.toMatch(/baseline/i);
    expect(NOISY_RUN_WARNING).not.toMatch(/baseline/i);
    expect(HOSTILE_BASELINE_NOTE).toMatch(/baseline/i);
    expect(NOISY_BASELINE_NOTE).toMatch(/baseline/i);
  });

  it("names the level and the probe signals", () => {
    const text = formatNoiseWarning(noise("hostile"), false);
    expect(text).toContain("machine: hostile");
    expect(text).toContain("probe CV 35%");
    expect(text).toContain("43% of metrics unstable");
    expect(text).toContain(HOSTILE_RUN_WARNING);
  });

  it("omits the baseline clause when no comparison was applicable", () => {
    expect(formatNoiseWarning(noise("hostile"), false)).not.toContain(HOSTILE_BASELINE_NOTE);
    expect(formatNoiseWarning(noise("noisy"), false)).not.toContain(NOISY_BASELINE_NOTE);
  });

  it("adds the baseline clause when a comparison was applicable", () => {
    expect(formatNoiseWarning(noise("hostile"), true)).toContain(HOSTILE_BASELINE_NOTE);
    expect(formatNoiseWarning(noise("noisy"), true)).toContain(NOISY_BASELINE_NOTE);
  });

  it("reports context retries only when there were any", () => {
    expect(formatNoiseWarning(noise("noisy"), false)).not.toContain("context retr");
    expect(formatNoiseWarning(noise("noisy", { contextRetries: 2 }), false))
      .toContain("2 context retries");
  });

  it("returns the plain sentence for a quiet machine", () => {
    expect(formatNoiseWarning(noise("quiet"), true)).toBe("");
  });

  it("is what the terminal prints in place of the bare constant", () => {
    const report = makeReport({
      warnings: [HOSTILE_RUN_WARNING],
      noise: noise("hostile"),
    });
    const table = formatTable(report);
    expect(table).toContain("machine: hostile");
    expect(table).toContain("probe CV 35%");
    expect(table).not.toContain(HOSTILE_BASELINE_NOTE);
  });

  it("adds the baseline clause in the terminal when a baseline was compared", () => {
    const report = makeReport({
      warnings: [HOSTILE_RUN_WARNING],
      noise: noise("hostile"),
      baseline: {
        hasBaseline: true,
        regressions: [],
        improvements: [],
        skippedNoisy: true,
      },
    });
    expect(formatTable(report)).toContain(HOSTILE_BASELINE_NOTE);
  });

  it("leaves unrelated warnings untouched", () => {
    const report = makeReport({ warnings: ["something else entirely"] });
    expect(formatTable(report)).toContain("⚠ something else entirely");
  });
});

// ====================================================================
// 4 — report.mode discriminator
// ====================================================================

describe("M64.4 report.mode", () => {
  it("derives combo mode", () => {
    expect(deriveReportMode(makeReport())).toBe("combo");
  });

  it("derives curve mode", () => {
    expect(deriveReportMode(makeReport({ combos: [], scalingCurveReport: makeCurve() }))).toBe("curve");
  });

  it("derives matrix mode", () => {
    expect(deriveReportMode(makeReport({ matrixReport: makeMatrix() }))).toBe("matrix");
  });

  it("derives isolation mode", () => {
    const report = makeReport({
      combos: [],
      isolation: { mount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false } } as Report["isolation"],
    });
    expect(deriveReportMode(report)).toBe("isolation");
  });

  it("accepts an explicit mode on the report and prefers it", () => {
    const report = makeReport({ mode: "matrix", matrixReport: makeMatrix(), combos: [] });
    expect(report.mode).toBe("matrix");
    expect(deriveReportMode(report)).toBe("matrix");
  });

  it("keeps describeMode routed through the same decision", () => {
    expect(describeMode(makeReport({ matrixReport: makeMatrix() }))).toBe("Mode: prop matrix");
    expect(describeMode(makeReport({ combos: [], scalingCurveReport: makeCurve() })))
      .toContain("Mode: curve");
  });

  it("lets the CI serializer render a curve report carrying an explicit mode", () => {
    const report = makeReport({ mode: "curve", combos: [], scalingCurveReport: makeCurve() });
    expect(formatMarkdown([report])).toContain("linear");
  });
});

// ====================================================================
// 5 — empty React Optimizations sections
// ====================================================================

describe("M64.5 empty React Optimizations sections", () => {
  it("omits the header when every combo detected nothing", () => {
    const report = makeReport({
      combos: [
        makeCombo({ comboIndex: 0, reactOptimizations: { memoBailout: false, contextFanOut: false } }),
        makeCombo({ comboIndex: 1, reactOptimizations: { memoBailout: false, contextFanOut: false } }),
      ],
    });
    const table = formatTable(report);
    expect(table).not.toContain("React Optimizations");
    expect(table).not.toContain("Combo #");
  });

  it("prints only the combos that have findings", () => {
    const report = makeReport({
      combos: [
        makeCombo({ comboIndex: 0, reactOptimizations: { memoBailout: false, contextFanOut: false } }),
        makeCombo({
          comboIndex: 1,
          reactOptimizations: {
            memoBailout: true, contextFanOut: false, memoBailoutComponents: ["Row"],
          },
        }),
      ],
    });
    const table = formatTable(report);
    expect(table).toContain("React Optimizations");
    expect(table).toContain("Memo bailout: Row");
    expect(table).not.toContain("Combo #0");
  });

  it("drops the combo heading when only one combo has findings", () => {
    const report = makeReport({
      combos: [
        makeCombo({ comboIndex: 0, reactOptimizations: { memoBailout: false, contextFanOut: false } }),
        makeCombo({
          comboIndex: 1,
          reactOptimizations: {
            memoBailout: true, contextFanOut: false, memoBailoutComponents: ["Row"],
          },
        }),
      ],
    });
    expect(formatTable(report)).not.toContain("Combo #1:");
  });

  it("treats memoBailout without component names as no finding", () => {
    const report = makeReport({
      combos: [makeCombo({ reactOptimizations: { memoBailout: true, contextFanOut: false } })],
    });
    expect(formatTable(report)).not.toContain("React Optimizations");
  });

  it("treats the durations-unavailable note as a finding", () => {
    const report = makeReport({
      combos: [makeCombo({
        reactOptimizations: { memoBailout: false, contextFanOut: false, durationsUnavailable: true },
      })],
    });
    expect(formatTable(report)).toContain("React Optimizations");
  });
});

// ====================================================================
// 6 — observed animation + tier floor
// ====================================================================

interface FakeAnimation {
  playState: string;
  effect: { target: unknown } | null;
}

function runAnimationRule(animations: FakeAnimation[], hasRoot = true): boolean {
  const root = { contains: (node: any) => node?.inRoot === true };
  const doc = {
    getElementById: (id: string) => (hasRoot && id === "root" ? root : null),
    getAnimations: () => animations,
  };
  return new Function("document", `return ${OBSERVED_ANIMATION_EXPRESSION};`)(doc) as boolean;
}

const inRoot = { nodeType: 1, inRoot: true };
const outsideRoot = { nodeType: 1, inRoot: false };

describe("M64.6a observed animation only", () => {
  it("is false when nothing is animating (declared transition-all produces no Animation)", () => {
    expect(runAnimationRule([])).toBe(false);
  });

  it("is true for a running animation inside #root", () => {
    expect(runAnimationRule([{ playState: "running", effect: { target: inRoot } }])).toBe(true);
  });

  it("is true for a finished fill-forwards animation inside #root", () => {
    expect(runAnimationRule([{ playState: "finished", effect: { target: inRoot } }])).toBe(true);
  });

  it("ignores an idle (cancelled) animation", () => {
    expect(runAnimationRule([{ playState: "idle", effect: { target: inRoot } }])).toBe(false);
  });

  it("ignores an animation outside #root", () => {
    expect(runAnimationRule([{ playState: "running", effect: { target: outsideRoot } }])).toBe(false);
  });

  it("ignores an animation with no effect target", () => {
    expect(runAnimationRule([{ playState: "running", effect: null }])).toBe(false);
  });

  it("ignores a pseudo-element target that is not a node", () => {
    expect(runAnimationRule([{ playState: "running", effect: { target: { inRoot: true } } }])).toBe(false);
  });

  it("is false when #root is missing", () => {
    expect(runAnimationRule([{ playState: "running", effect: { target: inRoot } }], false)).toBe(false);
  });

  it("never reads computed style", () => {
    expect(OBSERVED_ANIMATION_EXPRESSION).not.toContain("getComputedStyle");
    expect(OBSERVED_ANIMATION_EXPRESSION).not.toContain("transitionProperty");
    expect(OBSERVED_ANIMATION_EXPRESSION).not.toContain("animationName");
  });
});

describe("M64.6b portal/animation is a tier floor", () => {
  it("keeps a large animated component at T4", () => {
    expect(classifyTier({ domNodeCount: 2000, hasPortal: false, hasAnimation: true })).toBe("T4");
  });

  it("keeps a large portalled component at T4", () => {
    expect(classifyTier({ domNodeCount: 200, hasPortal: true, hasAnimation: false })).toBe("T4");
  });

  it("raises a small animated component to T3", () => {
    expect(classifyTier({ domNodeCount: 6, hasPortal: false, hasAnimation: true })).toBe("T3");
  });

  it("raises a medium animated component to T3", () => {
    expect(classifyTier({ domNodeCount: 30, hasPortal: false, hasAnimation: true })).toBe("T3");
  });

  it("leaves a small static component at T1", () => {
    expect(classifyTier({ domNodeCount: 6, hasPortal: false, hasAnimation: false })).toBe("T1");
  });

  it("floors exactly at the T2/T4 boundary", () => {
    expect(classifyTier({ domNodeCount: 40, hasPortal: true, hasAnimation: false })).toBe("T3");
    expect(classifyTier({ domNodeCount: 41, hasPortal: true, hasAnimation: false })).toBe("T4");
  });
});

// ====================================================================
// 7 — render attribution unwrapping
// ====================================================================

type TypeNameFn = (type: unknown, depth: number) => string | null;

function typeNameResolver(): TypeNameFn {
  return new Function(`${FIBER_TYPE_NAME_SOURCE}; return resolveTypeName;`)() as TypeNameFn;
}

describe("M64.7 memo/forwardRef name unwrapping", () => {
  const resolve = typeNameResolver();
  const MEMO = Symbol.for("react.memo");
  const FORWARD_REF = Symbol.for("react.forward_ref");

  it("reads a plain function component's name", () => {
    expect(resolve(function Kbd() {}, 0)).toBe("Kbd");
  });

  it("prefers displayName", () => {
    const fn = Object.assign(function inner() {}, { displayName: "Kbd" });
    expect(resolve(fn, 0)).toBe("Kbd");
  });

  it("unwraps React.memo around a named arrow", () => {
    const Kbd = (): null => null;
    expect(resolve({ $$typeof: MEMO, type: Kbd }, 0)).toBe("Kbd");
  });

  it("unwraps forwardRef", () => {
    const Slider = (): null => null;
    expect(resolve({ $$typeof: FORWARD_REF, render: Slider }, 0)).toBe("Slider");
  });

  it("unwraps forwardRef(memo(fn))", () => {
    const Inner = (): null => null;
    expect(resolve({ $$typeof: FORWARD_REF, render: { $$typeof: MEMO, type: Inner } }, 0)).toBe("Inner");
  });

  it("unwraps memo(forwardRef(fn))", () => {
    const Inner = (): null => null;
    expect(resolve({ $$typeof: MEMO, type: { $$typeof: FORWARD_REF, render: Inner } }, 0)).toBe("Inner");
  });

  it("prefers a displayName set on the wrapper itself", () => {
    const Inner = (): null => null;
    expect(resolve({ $$typeof: MEMO, type: Inner, displayName: "PublicName" }, 0)).toBe("PublicName");
  });

  it("returns the host tag string unchanged", () => {
    expect(resolve("div", 0)).toBe("div");
  });

  it("returns null for a truly anonymous inline arrow behind memo", () => {
    const anon: Record<string, unknown> = { $$typeof: MEMO, type: (): null => null };
    Object.defineProperty(anon.type as object, "name", { value: "" });
    expect(resolve(anon, 0)).toBe(null);
  });

  it("stops at a bounded depth instead of recursing forever", () => {
    const cyclic: Record<string, unknown> = { $$typeof: MEMO };
    cyclic.type = cyclic;
    expect(resolve(cyclic, 0)).toBe(null);
  });

  it("is embedded in the profiler hook script", () => {
    expect(PROFILER_HOOK_SCRIPT).toContain("resolveTypeName");
    expect(PROFILER_HOOK_SCRIPT).not.toContain('fiber.type.displayName || fiber.type.name');
  });
});

// ====================================================================
// 8 — CLI docs + --json announcement
// ====================================================================

describe("M64.8 CLI documentation", () => {
  it("documents the exit codes", () => {
    const help = helpText();
    expect(help).toContain("Exit codes");
    expect(help).toMatch(/0\s+.*pass/i);
    expect(help).toMatch(/1\s+.*fail/i);
    expect(help).toMatch(/2\s+.*(setup|usage)/i);
  });

  it("documents the multi-component --json template", () => {
    const help = helpText();
    expect(help).toMatch(/--json[\s\S]*template/i);
    expect(help).toContain(".<stem>.json");
  });

  it("documents that --max-combos does not bound matrix mode", () => {
    expect(helpText()).toMatch(/--max-combos[\s\S]*matrix/i);
  });
});

describe("M64.8 --json split announcement", () => {
  it("names the files written", () => {
    const notice = formatJsonSplitNotice([
      "sweep.badge.json", "sweep.kbd.json", "sweep.switch.json",
    ]);
    expect(notice).toContain("3");
    expect(notice).toContain("sweep.badge.json");
    expect(notice).toContain("sweep.kbd.json");
    expect(notice).toContain("sweep.switch.json");
  });

  it("caps a long list and says how many are left", () => {
    const paths = Array.from({ length: 12 }, (_, i) => `r.c${i}.json`);
    const notice = formatJsonSplitNotice(paths);
    expect(notice).toContain("r.c0.json");
    expect(notice).toContain("+4 more");
    expect(notice).not.toContain("r.c11.json");
  });

  it("is empty for a single report path", () => {
    expect(formatJsonSplitNotice(["one.json"])).toBe("");
  });
});
