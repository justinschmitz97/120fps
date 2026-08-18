import { describe, it, expect } from "vitest";
import { formatMarkdown, formatJUnit } from "../../src/ci-report.js";
import {
  DEFAULT_THRESHOLDS,
  type Report,
  type ComboReport,
  type ScalingCurveReport,
  type ScalingPoint,
  type TimingWithCV,
} from "../../src/report.js";
import type { ScalingCurve } from "../../src/metrics.js";
import {
  type IsolationReport,
  LEAK_BYTES_PER_CYCLE,
  CHURN_DEGRADATION_LIMIT,
} from "../../src/isolation.js";

// M55: curve, isolation, and cached reports ship `combos: []`; formatMarkdown
// and formatJUnit must render their real data instead of "—ms" placeholders
// and a bare "failed" JUnit body. Fixtures below mirror how src/analyze.ts
// populates each shape (read-only reference, not modified by this suite).

const machine = {
  cpu: "Test CPU", cores: 8, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};

function timing(median: number, overrides: Partial<TimingWithCV> = {}): TimingWithCV {
  return { samples: [median], median, p95: median, cv: 0, unstable: false, ...overrides };
}

function curve(growthClass: ScalingCurve["growthClass"], overrides: Partial<ScalingCurve> = {}): ScalingCurve {
  return { slope: 1, intercept: 0, r2: 0.95, growthClass, ...overrides };
}

function scalePoint(n: number, mountMs: number, rerenderMs: number, overrides: Partial<ScalingPoint> = {}): ScalingPoint {
  return {
    n,
    mount: timing(mountMs),
    rerender: timing(rerenderMs),
    unmount: timing(1),
    domNodeCount: n * 5,
    heapDelta: 0,
    interactions: [],
    ...overrides,
  };
}

function curveReportShape(overrides: Partial<ScalingCurveReport> = {}): ScalingCurveReport {
  const points = overrides.points ?? [scalePoint(1, 4, 2), scalePoint(10, 6, 3), scalePoint(50, 9, 4)];
  return {
    propName: "items",
    propKind: "array",
    reason: "array prop scaling",
    points,
    mountCurve: curve("linear"),
    rerenderCurve: curve("linear"),
    unmountCurve: curve("constant"),
    interactionCurves: {},
    domGrowth: curve("linear"),
    heapGrowth: curve("linear"),
    ...overrides,
  };
}

function combo(overrides: Partial<ComboReport> = {}): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: timing(4),
    unmount: timing(1),
    rerender: timing(2),
    domNodeCount: 6,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 0.4,
    verdict: "pass",
    tier: "T1",
    ...overrides,
  };
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine,
    componentPath: "./src/Button.tsx",
    componentName: "Button",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [combo()],
    thresholds: DEFAULT_THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

// --- curve fixtures ---

const CURVE_PASS = report({
  componentPath: "./src/List.tsx",
  combos: [],
  pass: true,
  scalingCurveReport: curveReportShape(),
});

const CURVE_GROWTH_FAIL = report({
  componentPath: "./src/QuadraticList.tsx",
  combos: [],
  pass: false,
  scalingCurveReport: curveReportShape({
    mountCurve: curve("quadratic"),
    points: [scalePoint(1, 4, 2), scalePoint(10, 40, 6), scalePoint(50, 900, 10)],
  }),
});

const CURVE_SINGLE_POINT = report({
  componentPath: "./src/OnePoint.tsx",
  combos: [],
  pass: true,
  scalingCurveReport: curveReportShape({
    points: [scalePoint(5, 6, 3)],
    mountCurve: curve("inconclusive"),
  }),
});

// --- isolation fixtures ---

const ISO_MOUNT_ONLY: IsolationReport = { mount: timing(6) };

const ISO_LEAK: IsolationReport = {
  mount: timing(10),
  memory: {
    cycles: 20,
    heapBefore: 1_000_000,
    heapAfter: 1_500_000,
    heapGrowth: 500_000,
    heapGrowthPerCycle: 25_000,
    leakSuspected: true,
    gcPressure: 3,
  },
};

const ISO_CHURN: IsolationReport = {
  mount: timing(8),
  rerender: {
    stable: timing(3),
    propChange: timing(4),
    churn: timing(9),
    churnDegradation: 2.5,
  },
};

const ISO_STRICT_WARN: IsolationReport = {
  mount: timing(9),
  strictMode: {
    normalMount: timing(9),
    strictMount: timing(20),
    overhead: 122,
    doubleInvokeClean: false,
  },
};

const ISOLATION_PASS = report({
  componentPath: "./src/Isolated.tsx",
  combos: [],
  pass: true,
  isolation: ISO_MOUNT_ONLY,
});

const ISOLATION_LEAK_FAIL = report({
  componentPath: "./src/LeakyIsolated.tsx",
  combos: [],
  pass: false,
  isolation: ISO_LEAK,
});

const ISOLATION_CHURN_FAIL = report({
  componentPath: "./src/ChurnyIsolated.tsx",
  combos: [],
  pass: false,
  isolation: ISO_CHURN,
});

const ISOLATION_STRICT_WARN = report({
  componentPath: "./src/StrictIsolated.tsx",
  combos: [],
  pass: true,
  isolation: ISO_STRICT_WARN,
});

// --- cached fixtures ---

const CACHED_PASS = report({
  componentPath: "./src/CachedGood.tsx",
  combos: [],
  pass: true,
  cached: true,
});

const CACHED_FAIL = report({
  componentPath: "./src/CachedBad.tsx",
  combos: [],
  pass: false,
  cached: true,
});

// --- unrecognized empty-combos fixture ---

const EMPTY_FAIL = report({
  componentPath: "./src/Unknown.tsx",
  combos: [],
  pass: false,
});

const EMPTY_PASS = report({
  componentPath: "./src/UnknownOk.tsx",
  combos: [],
  pass: true,
});

describe("formatMarkdown/formatJUnit: curve mode", () => {
  it("markdown shows real mount/rerender numbers, not a dash", () => {
    const text = formatMarkdown([CURVE_PASS]);
    expect(text).not.toContain("| — | — |");
    expect(text).toContain("4.00ms");
    expect(text).toContain("9.00ms");
  });

  it("markdown shows the growth class", () => {
    expect(formatMarkdown([CURVE_PASS])).toContain("linear");
  });

  it("markdown mode-detail lists every scale point's mount median", () => {
    const text = formatMarkdown([CURVE_PASS]);
    expect(text).toContain("N=1: mount 4.00ms");
    expect(text).toContain("N=10: mount 6.00ms");
    expect(text).toContain("N=50: mount 9.00ms");
  });

  it("worstVerdict surfaces FAIL for a quadratic growth class", () => {
    const text = formatMarkdown([CURVE_GROWTH_FAIL]);
    expect(text).toContain("**FAIL**");
  });

  it("JUnit failure body names the growth classification, never bare 'failed'", () => {
    const xml = formatJUnit([CURVE_GROWTH_FAIL]);
    expect(xml).toContain("quadratic");
    expect(xml).not.toMatch(/<failure[^>]*>failed<\/failure>/);
  });
});

describe("formatMarkdown/formatJUnit: isolation mode", () => {
  it("markdown shows the isolated mount median, not a dash", () => {
    const text = formatMarkdown([ISOLATION_PASS]);
    expect(text).toContain("6.00ms");
  });

  it("worstVerdict surfaces warn for a StrictMode double-invoke violation that still passes", () => {
    const text = formatMarkdown([ISOLATION_STRICT_WARN]);
    expect(text).toContain("warn");
    expect(text).not.toContain("**FAIL**");
  });

  it("JUnit failure body carries the leak bytes/cycle number for a leak-suspected fail", () => {
    const xml = formatJUnit([ISOLATION_LEAK_FAIL]);
    expect(xml).toContain("25000 bytes/cycle");
    expect(xml).toContain(String(LEAK_BYTES_PER_CYCLE));
    expect(xml).not.toMatch(/<failure[^>]*>failed<\/failure>/);
  });

  it("JUnit failure body carries the churn degradation ratio for a churn breach", () => {
    const xml = formatJUnit([ISOLATION_CHURN_FAIL]);
    expect(xml).toContain("2.50x");
    expect(xml).toContain(`${CHURN_DEGRADATION_LIMIT.toFixed(1)}x`);
    expect(xml).not.toMatch(/<failure[^>]*>failed<\/failure>/);
  });
});

describe("formatMarkdown/formatJUnit: cached mode", () => {
  it("markdown keeps the reused label and does not fabricate timings", () => {
    const text = formatMarkdown([CACHED_PASS]);
    expect(text).toContain("_(cached)_");
  });

  it("JUnit failure body explains a cached fail instead of the bare placeholder", () => {
    const xml = formatJUnit([CACHED_FAIL]);
    expect(xml).toContain("Reused failing verdict from baseline");
    expect(xml).not.toMatch(/<failure[^>]*>failed<\/failure>/);
  });
});

describe("formatMarkdown/formatJUnit: unrecognized empty-combos shape", () => {
  it("markdown renders an explicit 'no measurable data' row instead of dashes", () => {
    const text = formatMarkdown([EMPTY_FAIL]);
    expect(text).toContain("no measurable data");
  });

  it("JUnit failure body is explicit, never the bare placeholder", () => {
    const xml = formatJUnit([EMPTY_FAIL]);
    expect(xml).toContain("No measurable data");
    expect(xml).not.toMatch(/<failure[^>]*>failed<\/failure>/);
  });
});

// --- Harden: numbered hypotheses ---

describe("formatMarkdown/formatJUnit: mode-dispatch edge cases", () => {
  // H1
  it("H1: a curve report with a single scale point renders without crashing and without a redundant range", () => {
    const text = formatMarkdown([CURVE_SINGLE_POINT]);
    expect(text).toContain("6.00ms");
    expect(text).not.toContain("6.00ms → 6.00ms");
  });

  // H2
  it("H2: isolation with only one phase run shows just that phase, no crash on missing phases", () => {
    const text = formatMarkdown([ISOLATION_PASS]);
    expect(text).toContain("Mount: 6.00ms");
    expect(text).not.toContain("Rerender:");
    expect(text).not.toContain("Memory:");
    expect(text).not.toContain("StrictMode:");
  });

  // H3
  it("H3: a cached report that failed still marks _(cached)_ and shows dashes, not fabricated numbers", () => {
    const text = formatMarkdown([CACHED_FAIL]);
    expect(text).toContain("_(cached)_");
    expect(text).toContain("**FAIL**");
    expect(text).toMatch(/\| — \| — \|/);
  });

  // H4
  it("H4: combined signals (StrictMode warn + a run warning) both surface without one swallowing the other", () => {
    const combined = report({
      componentPath: "./src/Combined.tsx",
      combos: [],
      pass: true,
      isolation: ISO_STRICT_WARN,
      warnings: ["Only one prop combination available; prop-change and churn measure stable rerenders."],
    });
    const text = formatMarkdown([combined]);
    expect(text).toContain("warn");
    expect(text).toContain("StrictMode: +122.0%");
  });

  // H5
  it("H5: a component path containing a pipe does not break the markdown table", () => {
    const piped = report({ componentPath: "./src/A|B.tsx" });
    const text = formatMarkdown([piped]);
    expect(text).toContain("A\\|B.tsx");
  });

  // H6
  it("H6: XML-unsafe characters in a curve prop name are escaped in the JUnit failure body", () => {
    const unsafe = report({
      componentPath: "./src/Unsafe.tsx",
      combos: [],
      pass: false,
      scalingCurveReport: curveReportShape({
        propName: `items<script>&"'`,
        mountCurve: curve("exponential"),
      }),
    });
    const xml = formatJUnit([unsafe]);
    expect(xml).toContain("&lt;script&gt;");
    expect(xml).toContain("&amp;");
    expect(xml).not.toContain("<script>");
  });

  // H7
  it("H7: a multi-component sweep mixing every mode renders all rows and correct totals", () => {
    const sweep = [
      report(), // combo, pass
      CURVE_GROWTH_FAIL, // curve, fail
      ISOLATION_LEAK_FAIL, // isolation, fail
      CACHED_PASS, // cached, pass
    ];
    const md = formatMarkdown(sweep);
    for (const r of sweep) expect(md).toContain(r.componentPath.replace(/\|/g, "\\|"));

    const xml = formatJUnit(sweep);
    expect(xml).toContain('tests="4" failures="2"');
  });

  // H8
  it("H8: an empty report list produces well-formed, non-crashing output in both formats", () => {
    expect(formatMarkdown([])).toContain("0 components");
    expect(formatJUnit([])).toContain('tests="0" failures="0"');
  });

  // H9
  it("H9: worstVerdict precedence is fail over warn: a failing isolation report with a StrictMode warn signal still shows FAIL", () => {
    const failAndWarn = report({
      componentPath: "./src/FailAndWarn.tsx",
      combos: [],
      pass: false,
      isolation: { ...ISO_LEAK, strictMode: ISO_STRICT_WARN.strictMode },
    });
    const text = formatMarkdown([failAndWarn]);
    expect(text).toContain("**FAIL**");
    expect(text).not.toMatch(/\| warn \|/);
  });

  // H10
  it("H10: a report with combos AND a scalingCurveReport populated renders as standard (combo wins dispatch)", () => {
    const both = report({
      componentPath: "./src/Both.tsx",
      combos: [combo({ mount: timing(4) })],
      scalingCurveReport: curveReportShape(),
    });
    const text = formatMarkdown([both]);
    expect(text).toContain("4.00ms");
    // Mode detail is curve/isolation-only; a combo-dispatched report must not
    // pull in the curve's per-point breakdown.
    expect(text).not.toContain("N=1: mount");
  });

  // H11
  it("H11: a passing cached report never fabricates timings even though the row is otherwise unremarkable", () => {
    const text = formatMarkdown([CACHED_PASS]);
    expect(text).toMatch(/\| — \| — \|/);
  });

  // H12
  it("H12: JUnit leaves a passing isolation/curve/cached report without a failure body", () => {
    const xml = formatJUnit([CURVE_PASS, ISOLATION_PASS, CACHED_PASS]);
    expect(xml).not.toContain("<failure");
  });
});

describe("formatMarkdown/formatJUnit: standard mode unaffected by mode dispatch", () => {
  it("standard combo markdown row is unaffected beyond warn surfacing", () => {
    const text = formatMarkdown([report()]);
    expect(text).toContain("4.00ms");
    expect(text).toContain("2.00ms");
  });

  it("a warn-verdict combo now surfaces as warn instead of collapsing to pass", () => {
    const warnReport = report({ combos: [combo({ verdict: "warn" })] });
    const text = formatMarkdown([warnReport]);
    expect(text).toContain("| warn |");
  });

  it("standard-mode JUnit failure body is untouched by mode dispatch", () => {
    const failing = report({
      pass: false,
      combos: [combo({ verdict: "fail", mount: timing(90) })],
    });
    const xml = formatJUnit([failing]);
    expect(xml).toContain("over budget for tier");
  });
});
