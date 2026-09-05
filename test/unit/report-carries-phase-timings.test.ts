import { describe, it, expect } from "vitest";
import { buildReport, type BuildReportInput } from "../../src/pipeline/index.js";
import { formatMarkdown } from "../../src/report/index.js";
import { buildCurveReport } from "../../src/report/index.js";
import type { MountResult, TraceEvent } from "../../src/browser/index.js";
import {
  createPhaseClock,
  formatPhaseBreakdown,
  describePhaseBreakdown,
  PHASE_NAMES,
  type PhaseTimings,
  type Report,
  type Thresholds,
} from "../../src/report/index.js";

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 500_000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

const THRESHOLDS: Thresholds = { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 };

function sumOfPhases(timings: PhaseTimings): number {
  return PHASE_NAMES.reduce((sum, name) => sum + timings[name], 0);
}

function makeBuildInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    componentPath: "button.tsx",
    componentName: "Button",
    machine: {
      cpu: "test", cores: 4, ramMb: 8192, os: "test",
      nodeVersion: "20.0.0", chromiumVersion: "120.0",
    },
    calibration: { totalDuration: 10, scriptDuration: 5 },
    mounts: [
      {
        comboIndex: 0,
        props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 10,
        heapDelta: 0,
      },
    ],
    explores: [],
    heapDeltas: [0],
    thresholds: THRESHOLDS,
    flatThresholds: true,
    ...overrides,
  };
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: {
      cpu: "test", cores: 4, ramMb: 8192, os: "test",
      nodeVersion: "20.0.0", chromiumVersion: "120.0",
    },
    componentPath: "./button.tsx",
    componentName: "Button",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [{
      comboIndex: 0,
      props: {},
      mount: { samples: [1], median: 1, p95: 1, cv: 0 },
      unmount: { samples: [1], median: 1, p95: 1, cv: 0 },
      rerender: { samples: [1], median: 1, p95: 1, cv: 0 },
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

describe("phase timings over a run's label sequence", () => {
  it("carries every phase key and sums the ten phases to the total", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    time.advance(4_000);
    clock.boundary("preflight: walking the import graph");
    time.advance(6_000);
    clock.boundary("harness: building");
    time.advance(30_000);
    clock.boundary("calibration");
    time.advance(2_000);
    clock.boundary("mode: prop combos");
    time.advance(1_000);
    clock.boundary("mount: 4 combos x 5 samples");
    time.advance(40_000);
    clock.boundary("rerender: 4 combos");
    time.advance(20_000);
    clock.boundary("explore: 4 combos, budget 15s each");
    time.advance(80_000);
    clock.boundary("react analysis");
    time.advance(12_000);
    clock.boundary("report");

    const timings = clock.timings();
    expect(Object.keys(timings).sort()).toEqual(
      ["analysis", "attribution", "build", "calibration", "deltas", "explore",
       "mount", "preflight", "rerender", "scale", "total"],
    );
    expect(timings.total).toBe(195_000);
    expect(sumOfPhases(timings)).toBe(timings.total);
  });

  it("charges an unrecognised label to the phase it interrupts", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    time.advance(3_000);
    clock.boundary("calibration");
    time.advance(5_000);
    clock.boundary("mode: prop combos");
    time.advance(7_000);
    clock.boundary("mount: 4 combos x 5 samples");
    time.advance(9_000);
    clock.boundary("report");

    const timings = clock.timings();
    expect(timings.preflight).toBe(3_000);
    expect(timings.calibration).toBe(12_000);
    expect(timings.mount).toBe(9_000);
    expect(sumOfPhases(timings)).toBe(timings.total);
  });

  it("reports zero for a phase the run never entered", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    time.advance(1_000);
    clock.boundary("preflight: walking the import graph");
    time.advance(1_000);
    clock.boundary("report");

    const timings = clock.timings();
    expect(timings.deltas).toBe(0);
    expect(timings.scale).toBe(0);
    expect(timings.explore).toBe(0);
    expect(timings.attribution).toBe(0);
  });

  it("keeps the sum identity for a curve run's scale-point labels", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    clock.boundary("mode: curve on items");
    time.advance(11_000);
    clock.boundary("mount: 4 scale points");
    time.advance(13_000);
    clock.boundary("rerender: 4 scale points");
    time.advance(17_000);
    clock.boundary("explore: 4 scale points");
    time.advance(19_000);
    clock.boundary("scaling curves");
    time.advance(23_000);
    clock.boundary("report");

    const timings = clock.timings();
    expect(timings.scale).toBe(23_000);
    expect(sumOfPhases(timings)).toBe(timings.total);
  });

  it("keeps the sum identity for a matrix run's cell labels", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    clock.boundary("mode: prop matrix");
    time.advance(8_000);
    clock.boundary("mount: 9 matrix cells");
    time.advance(15_000);
    clock.boundary("rerender: 9 matrix cells");
    time.advance(6_000);
    clock.boundary("explore: 3 hottest cells");
    time.advance(21_000);
    clock.boundary("report");

    const timings = clock.timings();
    expect(timings.mount).toBe(15_000);
    expect(sumOfPhases(timings)).toBe(timings.total);
  });

  it("charges an isolation run's label to the phase already open", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    time.advance(2_000);
    clock.boundary("harness: building");
    time.advance(4_000);
    clock.boundary("isolation: mount,unmount");
    time.advance(30_000);

    const timings = clock.timings();
    expect(timings.build).toBe(34_000);
    expect(sumOfPhases(timings)).toBe(timings.total);
  });

  it("carves the attribution window out of the phase that was open", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    time.advance(1_000);
    clock.boundary("mount: 4 combos x 5 samples");
    time.advance(20_000);
    clock.addAttribution(5_000);
    clock.boundary("report");

    const timings = clock.timings();
    expect(timings.attribution).toBe(5_000);
    expect(timings.mount).toBe(15_000);
    expect(sumOfPhases(timings)).toBe(timings.total);
  });

  it("charges a curve run's attribution work to the attribution phase", () => {
    const trace: TraceEvent[] = [
      {
        cat: "devtools.timeline",
        name: "FunctionCall",
        dur: 3_000,
        ph: "X",
        ts: 1_000,
        args: { data: { url: "http://localhost:5173/src/List.tsx" } },
      },
    ];
    const scalePoints = [1, 5];
    const mounts: MountResult[] = scalePoints.map((n, i) => ({
      comboIndex: i,
      props: { __120fps_scaleN: n },
      mount: { samples: [5], median: 5, p95: 5 },
      unmount: { samples: [2], median: 2, p95: 2 },
      domNodeCount: 10,
      heapDelta: 0,
      mountTraces: [trace],
    }));
    const charged: number[] = [];

    const curve = buildCurveReport({
      propName: "items",
      propKind: "array",
      reason: "array prop",
      scalePoints,
      mounts,
      rerenders: [],
      explores: [],
      heapDeltas: scalePoints.map(() => 0),
      calibration: { totalDuration: 10, scriptDuration: 5 },
      thresholds: THRESHOLDS,
      phaseClock: { addAttribution: (ms) => charged.push(ms) },
    });

    expect(curve.points.every((point) => point.costAttribution !== undefined)).toBe(true);
    expect(charged).toHaveLength(scalePoints.length);
  });

  it("closes the total at the report boundary, not at the read", () => {
    const time = fakeClock();
    const clock = createPhaseClock(time.now);

    time.advance(10_000);
    clock.boundary("report");
    time.advance(90_000);

    expect(clock.timings().total).toBe(10_000);
  });
});

describe("explore wall clock per combo", () => {
  it("carries the state graph's own number onto the combo", () => {
    const report = buildReport(makeBuildInput({
      explores: [{
        comboIndex: 0,
        props: {},
        graph: { nodes: new Map(), edges: [], initialNodeId: "root", wallClockMs: 80_000 },
      }],
    }));
    expect(report.combos[0].exploreWallClockMs).toBe(80_000);
  });

  it("leaves the field off a combo whose explore was skipped", () => {
    const report = buildReport(makeBuildInput());
    expect(report.combos[0].exploreWallClockMs).toBeUndefined();
  });
});

describe("phase breakdown rendering", () => {
  const timings: PhaseTimings = {
    preflight: 0, build: 41_000, calibration: 0, mount: 58_000, rerender: 0,
    explore: 80_000, scale: 0, deltas: 0, attribution: 0, analysis: 0,
    total: 179_000,
  };

  it("omits a phase at zero from the parenthesis", () => {
    expect(formatPhaseBreakdown(timings)).toBe("  (build 41s, mount 58s, explore 1m 20s)");
  });

  it("renders nothing without timings", () => {
    expect(formatPhaseBreakdown(undefined)).toBe("");
    expect(describePhaseBreakdown(undefined)).toBe("");
  });
});

describe("markdown report phases", () => {
  it("carries the same numbers per component", () => {
    const md = formatMarkdown([
      makeReport({
        componentPath: "./with.tsx",
        phaseTimings: {
          preflight: 4_000, build: 41_000, calibration: 30_000, mount: 58_000,
          rerender: 20_000, explore: 80_000, scale: 0, deltas: 0,
          attribution: 0, analysis: 12_000, total: 245_000,
        },
      }),
      makeReport({ componentPath: "./without.tsx" }),
    ]);

    expect(md).toContain("| phases |");
    expect(md).toContain(
      "preflight 4s, build 41s, calibration 30s, mount 58s, rerender 20s, explore 1m 20s, analysis 12s",
    );
  });

  it("renders a report without phase timings as a dash, never as 0s", () => {
    const md = formatMarkdown([makeReport({ componentPath: "./without.tsx" })]);
    const row = md.split("\n").find((line) => line.includes("./without.tsx"))!;
    expect(row.endsWith("| - |")).toBe(true);
    expect(row).not.toContain("0s");
  });
});
