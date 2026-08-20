import { describe, it, expect } from "vitest";
import {
  classifyTier,
  deriveReportMode,
  detectRenderHealthInconsistency,
  formatTable,
  RENDER_HEALTH_INCONSISTENT_WARNING,
  DEFAULT_THRESHOLDS,
  TIER_BUDGETS,
  type ComboReport,
  type MatrixCell,
  type MatrixReport,
  type Report,
  type ScalingCurveReport,
} from "../../src/report.js";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";
import {
  formatNoiseWarning,
  HOSTILE_RUN_WARNING,
  HOSTILE_BASELINE_NOTE,
  NOISY_RUN_WARNING,
  type NoiseReport,
} from "../../src/noise.js";
import { OBSERVED_ANIMATION_EXPRESSION } from "../../src/measure.js";
import { FIBER_TYPE_NAME_SOURCE } from "../../src/react-profiler.js";
import { formatJsonSplitNotice, helpText, KNOWN_FLAGS } from "../../src/cli.js";
import { formatMarkdown } from "../../src/ci-report.js";

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

function makeCell(overrides: Partial<MatrixCell> = {}): MatrixCell {
  return {
    comboIndex: 0,
    props: { open: true },
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

function makeMatrix(cells: MatrixCell[]): MatrixReport {
  return {
    axes: [{ propName: "open", values: [false, true] }],
    cells,
    hotCells: cells,
    coldCells: cells,
    failingCells: cells.filter((c) => c.verdict === "fail"),
    compoundEffects: [],
  };
}

function noise(level: NoiseReport["level"], overrides: Partial<NoiseReport["signals"]> = {}): NoiseReport {
  return {
    level,
    signals: { probeCv: 34.8, probeMedianMs: 12, unstableFraction: 0.5, contextRetries: 0, ...overrides },
  };
}

function makeInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    componentPath: "./Table.tsx",
    componentName: "Table",
    machine: baseMachine,
    calibration: { totalDuration: 10, scriptDuration: 5 },
    mounts: [{
      comboIndex: 0,
      props: {},
      mount: { samples: [1], median: 1, p95: 1 },
      unmount: { samples: [1], median: 1, p95: 1 },
      domNodeCount: 8,
    }],
    explores: [],
    heapDeltas: [0],
    thresholds: DEFAULT_THRESHOLDS,
    ...overrides,
  };
}

type TypeNameFn = (type: unknown, depth: number) => string | null;
const resolveTypeName = new Function(
  `${FIBER_TYPE_NAME_SOURCE}; return resolveTypeName;`,
)() as TypeNameFn;

function runAnimationRule(animations: unknown[]): boolean {
  const root = { contains: (node: any) => node?.inRoot === true };
  const doc = {
    getElementById: (id: string) => (id === "root" ? root : null),
    getAnimations: () => animations,
  };
  return new Function("document", `return ${OBSERVED_ANIMATION_EXPRESSION};`)(doc) as boolean;
}

const inRoot = { nodeType: 1, inRoot: true };

// H1: three-deep wrapper nesting still finds the innermost name.
describe("H1: memo(forwardRef(memo(fn)))", () => {
  it("resolves through every layer", () => {
    const Inner = (): null => null;
    const nested = {
      $$typeof: Symbol.for("react.memo"),
      type: {
        $$typeof: Symbol.for("react.forward_ref"),
        render: { $$typeof: Symbol.for("react.memo"), type: Inner },
      },
    };
    expect(resolveTypeName(nested, 0)).toBe("Inner");
  });
});

// H2: a cycle through `.render` must terminate, not just one through `.type`.
describe("H2: cyclic forwardRef chain", () => {
  it("stops at the depth bound", () => {
    const cyclic: Record<string, unknown> = { $$typeof: Symbol.for("react.forward_ref") };
    cyclic.render = cyclic;
    expect(resolveTypeName(cyclic, 0)).toBe(null);
  });
});

// H3: React.lazy and context objects carry neither a name nor an unwrappable
// inner type; the resolver must fall through rather than throw.
describe("H3: exotic types without a name", () => {
  it("returns null for a context object", () => {
    expect(resolveTypeName({ $$typeof: Symbol.for("react.context"), _currentValue: 1 }, 0)).toBe(null);
  });

  it("returns null for null and undefined", () => {
    expect(resolveTypeName(null, 0)).toBe(null);
    expect(resolveTypeName(undefined, 0)).toBe(null);
  });
});

// H4: detection is a single read. An animation that starts after it is not
// retroactively seen: the rule must be a pure function of what is live now.
describe("H4: animation starting after detection", () => {
  it("is false before it starts and true after", () => {
    const animations: unknown[] = [];
    expect(runAnimationRule(animations)).toBe(false);
    animations.push({ playState: "running", effect: { target: inRoot } });
    expect(runAnimationRule(animations)).toBe(true);
  });
});

// H5: the rule must not walk the DOM: that was the source of both the false
// positive and the per-element computed-style cost.
describe("H5: the animation rule reads no DOM", () => {
  it("never queries elements", () => {
    expect(OBSERVED_ANIMATION_EXPRESSION).not.toContain("querySelectorAll");
    expect(OBSERVED_ANIMATION_EXPRESSION).not.toContain("transitionDuration");
  });

  it("survives an animation object with no effect property at all", () => {
    expect(runAnimationRule([{ playState: "running" }])).toBe(false);
  });
});

// H6: the tier floor changes budgets, not just labels.
describe("H6: a large animated component gets T4's budget", () => {
  it("passes at 70ms mount where the T3 override would have failed it", () => {
    const report = buildReport(makeInput({
      // A calibration slow enough that the relative-mount warn does not mask
      // the budget check this hypothesis is about.
      calibration: { totalDuration: 100, scriptDuration: 50 },
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [70], median: 70, p95: 70 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 2000,
        hasAnimation: true,
      }],
    }));
    expect(report.combos[0].tier).toBe("T4");
    expect(TIER_BUDGETS.T4.mountMs).toBeGreaterThan(70);
    expect(TIER_BUDGETS.T3.mountMs).toBeLessThan(70);
    expect(report.combos[0].verdict).toBe("pass");
  });

  it("keeps a small animated component on T3's budget", () => {
    const report = buildReport(makeInput({
      calibration: { totalDuration: 100, scriptDuration: 50 },
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [70], median: 70, p95: 70 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 6,
        hasAnimation: true,
      }],
    }));
    expect(report.combos[0].tier).toBe("T3");
    expect(report.combos[0].verdict).toBe("fail");
  });
});

// H7: report.mode uses the fingerprint's vocabulary, so a mode value can never
// mean one thing on the report and another in the baseline slot it compares to.
describe("H7: report.mode and baseline fingerprint compatibility", () => {
  it("does not change what a report without the field derives to", () => {
    const curve = makeReport({ combos: [], scalingCurveReport: makeCurve() });
    expect(curve.mode).toBeUndefined();
    expect(deriveReportMode(curve)).toBe("curve");
  });

  it("prefers an explicit field over the populated shape", () => {
    const report = makeReport({ mode: "isolation", combos: [], scalingCurveReport: makeCurve() });
    expect(deriveReportMode(report)).toBe("isolation");
  });

  it("resolves a cached report with no populated mode field to combo", () => {
    expect(deriveReportMode(makeReport({ combos: [], cached: true }))).toBe("combo");
  });
});

// H8: --ci suppresses the terminal table, so the WARN rollup must not be the
// only place a CI reader learns a run warned.
describe("H8: the WARN signal survives JSON-only mode", () => {
  it("markdown reports the warn verdict for a passing run with a warned combo", () => {
    const report = makeReport({
      combos: [makeCombo({ verdict: "pass" }), makeCombo({ comboIndex: 1, verdict: "warn" })],
    });
    expect(formatMarkdown([report])).toContain("| warn |");
  });

  it("the rollup line itself is terminal-only", () => {
    const report = makeReport({ combos: [makeCombo({ verdict: "warn" })] });
    expect(formatMarkdown([report])).not.toContain("warnings do not fail the run");
    expect(formatTable(report)).toContain("warnings do not fail the run");
  });
});

// H9: modes with no per-row verdicts must not print a rollup at all.
describe("H9: rollup only where rows carry verdicts", () => {
  it("says nothing in curve mode", () => {
    const report = makeReport({ combos: [], scalingCurveReport: makeCurve() });
    expect(formatTable(report)).not.toContain("warned;");
  });

  it("says nothing in isolation mode", () => {
    const report = makeReport({
      combos: [],
      isolation: { mount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false } } as Report["isolation"],
    });
    expect(formatTable(report)).not.toContain("warned;");
  });

  it("says nothing for an empty matrix", () => {
    const report = makeReport({ combos: [], matrixReport: makeMatrix([]) });
    expect(formatTable(report)).not.toContain("warned;");
  });

  it("counts every cell, not only the shown ones", () => {
    const cells = [
      makeCell({ comboIndex: 0, verdict: "warn" }),
      makeCell({ comboIndex: 1, verdict: "pass" }),
      makeCell({ comboIndex: 2, verdict: "warn" }),
    ];
    const matrix = makeMatrix(cells);
    matrix.hotCells = [cells[0]];
    const report = makeReport({ combos: [], matrixReport: matrix });
    expect(formatTable(report)).toContain("2 of 3 cells warned");
  });
});

// H10: the noise warning must reach every output mode, not just the combo table.
describe("H10: enriched noise warning in every mode", () => {
  it("appears in curve output", () => {
    const report = makeReport({
      combos: [], scalingCurveReport: makeCurve(),
      warnings: [HOSTILE_RUN_WARNING], noise: noise("hostile"),
    });
    expect(formatTable(report)).toContain("machine: hostile");
  });

  it("appears in matrix output", () => {
    const report = makeReport({
      combos: [], matrixReport: makeMatrix([makeCell()]),
      warnings: [NOISY_RUN_WARNING], noise: noise("noisy"),
    });
    expect(formatTable(report)).toContain("machine: noisy");
  });

  it("appears in isolation output", () => {
    const report = makeReport({
      combos: [],
      isolation: { mount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false } } as Report["isolation"],
      warnings: [HOSTILE_RUN_WARNING], noise: noise("hostile"),
    });
    expect(formatTable(report)).toContain("machine: hostile");
  });
});

// H11: a warning with no `noise` object behind it must degrade, not crash.
describe("H11: noise warning without signals", () => {
  it("falls back to the fixed sentence", () => {
    const report = makeReport({ warnings: [HOSTILE_RUN_WARNING] });
    const table = formatTable(report);
    expect(table).toContain(HOSTILE_RUN_WARNING);
    expect(table).not.toContain("machine: hostile");
  });

  it("falls back when the noise object says quiet but a warning was recorded", () => {
    const report = makeReport({ warnings: [HOSTILE_RUN_WARNING], noise: noise("quiet") });
    expect(formatTable(report)).toContain(HOSTILE_RUN_WARNING);
  });
});

// H12: the baseline clause tracks whether a comparison happened, not whether
// one was asked for and found nothing.
describe("H12: baseline clause conditions", () => {
  it("turns on for a baseline field that reports no entry", () => {
    const report = makeReport({
      warnings: [HOSTILE_RUN_WARNING], noise: noise("hostile"),
      baseline: { hasBaseline: false, regressions: [], improvements: [] },
    });
    expect(formatTable(report)).toContain(HOSTILE_BASELINE_NOTE);
  });
});

// H13: signal rounding must not invent precision or drop a zero.
describe("H13: signal formatting", () => {
  it("rounds the probe CV and the unstable share", () => {
    const text = formatNoiseWarning(noise("noisy", { probeCv: 15.4, unstableFraction: 0 }), false);
    expect(text).toContain("probe CV 15%");
    expect(text).toContain("0% of metrics unstable");
  });

  it("says retry, not retries, for exactly one", () => {
    expect(formatNoiseWarning(noise("noisy", { contextRetries: 1 }), false)).toContain("1 context retry");
  });

  it("reports a 100% unstable fraction", () => {
    expect(formatNoiseWarning(noise("hostile", { unstableFraction: 1 }), false))
      .toContain("100% of metrics unstable");
  });
});

// H14: the React section's emptiness rule must match its printing rule exactly.
describe("H14: React findings that print nothing", () => {
  it("suppresses contextFanOut with no component names", () => {
    const report = makeReport({
      combos: [makeCombo({ reactOptimizations: { memoBailout: false, contextFanOut: true } })],
    });
    expect(formatTable(report)).not.toContain("React Optimizations");
  });

  it("suppresses portalOrphans of zero", () => {
    const report = makeReport({
      combos: [makeCombo({ reactOptimizations: { memoBailout: false, contextFanOut: false, portalOrphans: 0 } })],
    });
    expect(formatTable(report)).not.toContain("React Optimizations");
  });

  it("suppresses an empty callbackIdentityDeltas array", () => {
    const report = makeReport({
      combos: [makeCombo({
        reactOptimizations: { memoBailout: false, contextFanOut: false, callbackIdentityDeltas: [] },
      })],
    });
    expect(formatTable(report)).not.toContain("React Optimizations");
  });

  it("shows a portal-orphan finding on its own", () => {
    const report = makeReport({
      combos: [makeCombo({ reactOptimizations: { memoBailout: false, contextFanOut: false, portalOrphans: 2 } })],
    });
    expect(formatTable(report)).toContain("Portal orphans: 2");
  });
});

// H15: a delta that rounds to zero from below still reads "below".
describe("H15: compound delta near zero", () => {
  it("keeps the sign and the direction consistent", () => {
    const report = makeReport({
      combos: [],
      matrixReport: {
        ...makeMatrix([makeCell()]),
        compoundEffects: [{
          props: { open: true },
          expectedMount: 100,
          actualMount: 99.96,
          compoundDelta: -0.04,
          significance: "low",
        }],
      },
    });
    const table = formatTable(report);
    expect(table).toContain("below additive expectation");
    expect(table).not.toContain("above additive expectation");
  });
});

// H16: the split notice must cap without lying about the count.
describe("H16: --json split notice bounds", () => {
  it("lists all eight without a remainder", () => {
    const paths = Array.from({ length: 8 }, (_, i) => `r.c${i}.json`);
    const notice = formatJsonSplitNotice(paths);
    expect(notice).toContain("r.c7.json");
    expect(notice).not.toContain("more");
  });

  it("adds a remainder at nine", () => {
    const paths = Array.from({ length: 9 }, (_, i) => `r.c${i}.json`);
    expect(formatJsonSplitNotice(paths)).toContain("+1 more");
  });

  it("says nothing for an empty list", () => {
    expect(formatJsonSplitNotice([])).toBe("");
  });
});

// H17: the new help sections must not break the flag-parity guard.
describe("H17: help parity after the new sections", () => {
  it("every two-space-indented flag in the help text is a known flag", () => {
    const documented = new Set(
      (helpText().match(/(?<=^ {2})--[a-z-]+/gm) ?? []).map((f) => f.trim()),
    );
    for (const flag of documented) {
      expect(KNOWN_FLAGS.has(flag), `KNOWN_FLAGS missing ${flag}`).toBe(true);
    }
  });
});

// H18: the tier floor must not move the size boundaries it sits on top of.
describe("H18: size boundaries unchanged", () => {
  it("keeps 10/11 and 40/41 where they were", () => {
    expect(classifyTier({ domNodeCount: 10, hasPortal: false, hasAnimation: false })).toBe("T1");
    expect(classifyTier({ domNodeCount: 11, hasPortal: false, hasAnimation: false })).toBe("T2");
    expect(classifyTier({ domNodeCount: 40, hasPortal: false, hasAnimation: false })).toBe("T2");
    expect(classifyTier({ domNodeCount: 41, hasPortal: false, hasAnimation: false })).toBe("T4");
  });

  it("treats a negative node count as T1 and still honours the floor", () => {
    expect(classifyTier({ domNodeCount: -1, hasPortal: false, hasAnimation: false })).toBe("T1");
    expect(classifyTier({ domNodeCount: -1, hasPortal: true, hasAnimation: false })).toBe("T3");
  });
});

// M83 #1 (element-plus-F2): a same-run disagreement between an empty combo
// and a nonzero sibling (including a scale-probe row) must be reported, not
// asserted away as "the component renders nothing for these props".
describe("M83 #1: detectRenderHealthInconsistency", () => {
  it("returns undefined when nothing is empty", () => {
    const combos = [makeCombo({ comboIndex: 0, domNodeCount: 5 })];
    expect(detectRenderHealthInconsistency(combos)).toBeUndefined();
  });

  it("returns undefined when every combo is empty (no disagreement)", () => {
    const combos = [
      makeCombo({ comboIndex: 0, domNodeCount: 0, renderHealth: "empty" }),
      makeCombo({ comboIndex: 1, domNodeCount: 0, renderHealth: "empty" }),
    ];
    expect(detectRenderHealthInconsistency(combos)).toBeUndefined();
  });

  it("names the empty and nonzero combo indices when both exist in the same run", () => {
    const combos = [
      makeCombo({ comboIndex: 0, domNodeCount: 0, renderHealth: "empty" }),
      makeCombo({ comboIndex: 1, domNodeCount: 12, scaleProbe: 5 }),
    ];
    const message = detectRenderHealthInconsistency(combos);
    expect(message).toBe(RENDER_HEALTH_INCONSISTENT_WARNING([0], [1]));
    expect(message).toContain("#0");
    expect(message).toContain("#1");
    expect(message).toContain("not resolved");
  });

  it("does not fire on a renderHealth: error combo alone (that is a real failure, not a disagreement)", () => {
    const combos = [makeCombo({ comboIndex: 0, domNodeCount: 0, renderHealth: "error" })];
    expect(detectRenderHealthInconsistency(combos)).toBeUndefined();
  });
});

describe("M83 #1: appendEmptyRenderNote states the disagreement instead of asserting it away", () => {
  it("prints the inconsistency message instead of 'renders nothing' when a sibling combo is nonzero", () => {
    const report = makeReport({
      combos: [
        makeCombo({ comboIndex: 0, domNodeCount: 0, renderHealth: "empty" }),
        makeCombo({ comboIndex: 1, domNodeCount: 8, scaleProbe: 20 }),
      ],
    });
    const table = formatTable(report);
    expect(table).toContain("this disagreement was not resolved");
    expect(table).not.toContain("the component renders nothing for these props");
  });

  it("keeps the original phrasing when every combo agrees", () => {
    const report = makeReport({
      combos: [makeCombo({ comboIndex: 0, domNodeCount: 0, renderHealth: "empty" })],
    });
    const table = formatTable(report);
    expect(table).toContain("the component renders nothing for these props");
  });
});

// M83 #8 (primevue-Minor1): detectFixture never accepts `.fixture.tsx` for a
// Vue target — it looks only for `${stem}.fixture.vue`. The fixture-creation
// hint must name a file the loader will actually find.
describe("M83 #8: fixture suggestion matches the loader's own extension", () => {
  it("suggests .fixture.vue for a Vue component", () => {
    const report = makeReport({ componentPath: "./Button.vue", combos: [makeCombo({ interactions: [] })] });
    expect(formatTable(report)).toContain("Button.fixture.vue");
    expect(formatTable(report)).not.toContain("Button.fixture.tsx");
  });

  it("still suggests .fixture.tsx for a React component (unchanged)", () => {
    const report = makeReport({ componentPath: "./Button.tsx", combos: [makeCombo({ interactions: [] })] });
    expect(formatTable(report)).toContain("Button.fixture.tsx");
  });
});

// Integration: buildReport itself must push the warning onto report.warnings,
// not only formatTable's terminal phrasing — so the JSON report carries it too.
describe("M83 #1: buildReport pushes RENDER_HEALTH_INCONSISTENT_WARNING", () => {
  it("warns when a discrete combo is empty and a scale-probe sibling is nonzero", () => {
    const mounts = [
      { comboIndex: 0, props: {}, mount: { samples: [1], median: 1, p95: 1 }, unmount: { samples: [1], median: 1, p95: 1 }, domNodeCount: 0 },
      { comboIndex: 1, props: { __120fps_scaleN: 5 }, mount: { samples: [1], median: 1, p95: 1 }, unmount: { samples: [1], median: 1, p95: 1 }, domNodeCount: 10 },
      { comboIndex: 2, props: { __120fps_scaleN: 20 }, mount: { samples: [2], median: 2, p95: 2 }, unmount: { samples: [1], median: 1, p95: 1 }, domNodeCount: 40 },
    ];
    const report = buildReport({
      componentPath: "./Avatar.vue",
      componentName: "Avatar",
      machine: baseMachine,
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: mounts as any,
      explores: [],
      heapDeltas: mounts.map(() => 0),
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(report.warnings).toBeDefined();
    expect(report.warnings!.some((w) => w.includes("this disagreement was not resolved"))).toBe(true);
  });

  it("does not warn when every combo agrees (all nonzero)", () => {
    const mounts = [
      { comboIndex: 0, props: {}, mount: { samples: [1], median: 1, p95: 1 }, unmount: { samples: [1], median: 1, p95: 1 }, domNodeCount: 5 },
    ];
    const report = buildReport({
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: mounts as any,
      explores: [],
      heapDeltas: mounts.map(() => 0),
      thresholds: DEFAULT_THRESHOLDS,
    });
    expect(
      (report.warnings ?? []).some((w) => w.includes("this disagreement was not resolved")),
    ).toBe(false);
  });
});
