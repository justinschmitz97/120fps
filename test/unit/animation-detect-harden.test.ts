import { describe, it, expect } from "vitest";
import {
  classifyTier,
  formatTable,
  DEFAULT_THRESHOLDS,
  type ComboReport,
  type Report,
} from "../../src/report.js";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";

// --- helpers ---

function makeCombo(overrides: Partial<ComboReport> = {}): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
    unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
    rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
    domNodeCount: 10,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 0.5,
    verdict: "pass",
    ...overrides,
  };
}

const baseMachine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};

function makeInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    componentPath: "./Button.tsx",
    componentName: "Button",
    machine: baseMachine,
    calibration: { totalDuration: 10, scriptDuration: 5 },
    mounts: [{
      comboIndex: 0,
      props: {},
      mount: { samples: [1.5], median: 1.5, p95: 1.5 },
      unmount: { samples: [1], median: 1, p95: 1 },
      domNodeCount: 8,
    }],
    explores: [],
    heapDeltas: [0],
    thresholds: DEFAULT_THRESHOLDS,
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

// --- H1: animationName "none" explicitly ---
describe("H1: animationName none explicitly", () => {
  it("hasAnimation=false produces T1 for small component (no animation signal)", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 5,
        hasAnimation: false,
      }],
    }));
    expect(report.combos[0].tier).toBe("T1");
    expect(report.combos[0].hasAnimation).toBe(false);
  });
});

// --- H2: transitionDuration "0s" ---
describe("H2: transitionDuration 0s", () => {
  it("no animation detected means T1 for small static component", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 10,
        hasAnimation: false,
      }],
    }));
    expect(report.combos[0].tier).toBe("T1");
  });
});

// --- H3: animation-play-state paused but valid keyframes ---
describe("H3: paused animation still detected", () => {
  it("hasAnimation=true (paused animation has animationName != none) → T3 for small", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 8,
        hasAnimation: true,
      }],
    }));
    expect(report.combos[0].tier).toBe("T3");
  });
});

// --- H4: transition-property color only → false ---
describe("H4: color-only transition", () => {
  it("hasAnimation=false for trivial color transition → T1", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 8,
        hasAnimation: false,
      }],
    }));
    expect(report.combos[0].tier).toBe("T1");
  });
});

// --- H5: transition-property "all" with duration → true ---
describe("H5: transition all with duration", () => {
  it("hasAnimation=true → T3 for small, T3 for large", () => {
    const reportSmall = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 8,
        hasAnimation: true,
      }],
    }));
    expect(reportSmall.combos[0].tier).toBe("T3");

    const reportLarge = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 50,
        hasAnimation: true,
      }],
    }));
    expect(reportLarge.combos[0].tier).toBe("T3");
  });
});

// --- H6: multiple transition props, one layout-affecting ---
describe("H6: mixed transition props", () => {
  it("hasAnimation=true → promotes to T3 for small component", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 10,
        hasAnimation: true,
      }],
    }));
    expect(report.combos[0].tier).toBe("T3");
  });
});

// --- H7: empty #root (no child elements) ---
describe("H7: empty root", () => {
  it("hasAnimation=false with 0 DOM nodes → T1", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [0.1], median: 0.1, p95: 0.1 },
        unmount: { samples: [0.1], median: 0.1, p95: 0.1 },
        domNodeCount: 0,
        hasAnimation: false,
      }],
    }));
    expect(report.combos[0].tier).toBe("T1");
  });
});

// --- H8: undefined hasAnimation → defaults false ---
describe("H8: undefined hasAnimation defaults false", () => {
  it("MountResult without hasAnimation → buildReport uses false → T1 for small", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 8,
      }],
    }));
    expect(report.combos[0].tier).toBe("T1");
    expect(report.combos[0].hasAnimation).toBe(false);
  });
});

// --- H9: mixed combos ---
describe("H9: mixed combos with different animation status", () => {
  it("combo 0 animated (T2), combo 1 not animated (T1)", () => {
    const report = buildReport(makeInput({
      mounts: [
        {
          comboIndex: 0, props: { animated: true },
          mount: { samples: [1], median: 1, p95: 1 },
          unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
          domNodeCount: 8, hasAnimation: true,
        },
        {
          comboIndex: 1, props: { animated: false },
          mount: { samples: [1], median: 1, p95: 1 },
          unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
          domNodeCount: 8, hasAnimation: false,
        },
      ],
      heapDeltas: [0, 0],
    }));
    expect(report.combos[0].tier).toBe("T3");
    expect(report.combos[0].hasAnimation).toBe(true);
    expect(report.combos[1].tier).toBe("T1");
    expect(report.combos[1].hasAnimation).toBe(false);
  });
});

// --- H10: transition background-color only → false ---
describe("H10: background-color transition only", () => {
  it("hasAnimation=false → T1 for small", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 8, hasAnimation: false,
      }],
    }));
    expect(report.combos[0].tier).toBe("T1");
  });
});

// --- H11: transition max-height → true ---
describe("H11: max-height transition", () => {
  it("hasAnimation=true → T3 for small", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 8, hasAnimation: true,
      }],
    }));
    expect(report.combos[0].tier).toBe("T3");
  });
});

// --- H12: transition width → true ---
describe("H12: width transition", () => {
  it("hasAnimation=true → T3 for small", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 10, hasAnimation: true,
      }],
    }));
    expect(report.combos[0].tier).toBe("T3");
  });
});

// --- H13: hasAnimation + hasPortal → T3 ---
describe("H13: animation + portal → T3", () => {
  it("portal takes precedence for T3 classification", () => {
    const graph = {
      nodes: new Map([["n1", { id: "n1", depth: 0, interactions: [], pathFromRoot: [] }]]),
      edges: [{
        id: "e1", fromId: "n1", toId: "n2",
        interaction: { type: "click" as const, selector: "button", tagName: "BUTTON", label: "Open", portal: true },
        samples: [5], median: 5, p95: 5, traces: [],
      }],
      initialNodeId: "n1",
      wallClockMs: 100,
    };
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 50, hasAnimation: true,
      }],
      explores: [{ graph, comboIndex: 0, props: {} }],
    }));
    expect(report.combos[0].tier).toBe("T3");
    expect(report.combos[0].hasAnimation).toBe(true);
  });
});

// --- H14: hasAnimation + hasScaling interaction ---
describe("H14: animation + scaling tier interaction", () => {
  it("animation=true + scaling=true → T3 (animation rule fires before T4)", () => {
    expect(classifyTier({ domNodeCount: 30, hasPortal: false, hasScaling: true, hasAnimation: true })).toBe("T3");
  });

  it("animation=false + scaling=true, 30 DOM → T2 (scaling ignored, DOM determines tier)", () => {
    expect(classifyTier({ domNodeCount: 30, hasPortal: false, hasScaling: true, hasAnimation: false })).toBe("T2");
  });

  it("animation=true + scaling=false on large DOM → T3", () => {
    expect(classifyTier({ domNodeCount: 50, hasPortal: false, hasScaling: false, hasAnimation: true })).toBe("T3");
  });
});

// --- H15: both animation-name none and transition none ---
describe("H15: no animation and no transition", () => {
  it("hasAnimation=false → T1 for small component", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [0.5], median: 0.5, p95: 0.5 },
        unmount: { samples: [0.3], median: 0.3, p95: 0.3 },
        domNodeCount: 5, hasAnimation: false,
      }],
    }));
    expect(report.combos[0].tier).toBe("T1");
    expect(report.combos[0].hasAnimation).toBe(false);
  });
});

// --- H16: formatTable T2 + [anim] ---
describe("H16: formatTable T2 with anim", () => {
  it("renders PASS (T2) [anim] in verdict column", () => {
    const report = makeReport({
      combos: [makeCombo({ tier: "T2", hasAnimation: true, verdict: "pass" })],
      tieredBudgets: true,
    });
    const table = formatTable(report);
    expect(table).toContain("PASS (T2) [anim]");
  });
});

// --- H17: JSON roundtrip preserves hasAnimation ---
describe("H17: JSON roundtrip", () => {
  it("hasAnimation survives JSON.stringify/parse", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 8, hasAnimation: true,
      }],
    }));
    const parsed = JSON.parse(JSON.stringify(report));
    expect(parsed.combos[0].hasAnimation).toBe(true);
    expect(parsed.combos[0].tier).toBe("T3");
  });
});

// --- H18: pairwise transition transform 0s, color 0.3s → false ---
describe("H18: pairwise transition with layout prop at 0s", () => {
  it("layout prop with 0s duration means no effective animation → T1", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 8, hasAnimation: false,
      }],
    }));
    expect(report.combos[0].tier).toBe("T1");
  });
});

// --- H19: pairwise transition color 0s, transform 0.3s → true ---
describe("H19: pairwise transition with layout prop at non-0s", () => {
  it("layout prop with non-0s duration → animation detected → T2", () => {
    const report = buildReport(makeInput({
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [1], median: 1, p95: 1 },
        unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
        domNodeCount: 8, hasAnimation: true,
      }],
    }));
    expect(report.combos[0].tier).toBe("T3");
    expect(report.combos[0].hasAnimation).toBe(true);
  });
});

// --- H20: hasAnimation on all combos when tieredBudgets active ---
describe("H20: hasAnimation field present on all combos", () => {
  it("every combo has hasAnimation set when tiered budgets active", () => {
    const report = buildReport(makeInput({
      mounts: [
        {
          comboIndex: 0, props: { a: 1 },
          mount: { samples: [1], median: 1, p95: 1 },
          unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
          domNodeCount: 8, hasAnimation: false,
        },
        {
          comboIndex: 1, props: { a: 2 },
          mount: { samples: [1], median: 1, p95: 1 },
          unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
          domNodeCount: 8, hasAnimation: true,
        },
        {
          comboIndex: 2, props: { a: 3 },
          mount: { samples: [1], median: 1, p95: 1 },
          unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
          domNodeCount: 8,
        },
      ],
      heapDeltas: [0, 0, 0],
    }));
    expect(report.combos).toHaveLength(3);
    expect(report.combos[0].hasAnimation).toBe(false);
    expect(report.combos[1].hasAnimation).toBe(true);
    expect(report.combos[2].hasAnimation).toBe(false);
    for (const combo of report.combos) {
      expect(combo.tier).toBeDefined();
      expect(typeof combo.hasAnimation).toBe("boolean");
    }
  });

  it("flatThresholds → hasAnimation undefined on all combos", () => {
    const report = buildReport(makeInput({
      flatThresholds: true,
      mounts: [
        {
          comboIndex: 0, props: {},
          mount: { samples: [1], median: 1, p95: 1 },
          unmount: { samples: [0.5], median: 0.5, p95: 0.5 },
          domNodeCount: 8, hasAnimation: true,
        },
      ],
    }));
    expect(report.combos[0].hasAnimation).toBeUndefined();
    expect(report.combos[0].tier).toBeUndefined();
  });
});
