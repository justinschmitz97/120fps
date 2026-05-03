import { describe, it, expect } from "vitest";
import {
  formatTable,
  DEFAULT_THRESHOLDS,
  type ComboReport,
  type Report,
} from "../../src/report.js";
import type { ReactOptimizations } from "../../src/react-profiler.js";

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

function makeReactOptimizations(overrides: Partial<ReactOptimizations> = {}): ReactOptimizations {
  return {
    memoBailout: false,
    contextFanOut: false,
    ...overrides,
  };
}

// ====================================================================
// formatTable — React Optimizations section
// ====================================================================

describe("formatTable React Optimizations section", () => {
  it("shows 'React Optimizations' header when reactOptimizations present", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: makeReactOptimizations({ memoBailout: true, memoBailoutComponents: ["Button"] }),
      })],
    });
    expect(formatTable(r)).toContain("React Optimizations");
  });

  it("omits 'React Optimizations' section when reactOptimizations is undefined", () => {
    const r = makeReport();
    expect(formatTable(r)).not.toContain("React Optimizations");
  });

  it("shows memo bailout component names", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: makeReactOptimizations({
          memoBailout: true,
          memoBailoutComponents: ["Button", "Icon"],
        }),
      })],
    });
    const table = formatTable(r);
    expect(table).toContain("Memo bailout");
    expect(table).toContain("Button");
    expect(table).toContain("Icon");
  });

  it("omits memo bailout line when memoBailout is false", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: makeReactOptimizations({
          memoBailout: false,
          portalOrphans: 2,
        }),
      })],
    });
    expect(formatTable(r)).not.toContain("Memo bailout");
  });

  it("shows context fan-out component names", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: makeReactOptimizations({
          contextFanOut: true,
          contextFanOutComponents: ["Sidebar", "Nav"],
        }),
      })],
    });
    const table = formatTable(r);
    expect(table).toContain("Context fan-out");
    expect(table).toContain("Sidebar");
    expect(table).toContain("Nav");
  });

  it("omits context fan-out line when contextFanOut is false", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: makeReactOptimizations({
          contextFanOut: false,
          memoBailout: true,
          memoBailoutComponents: ["X"],
        }),
      })],
    });
    expect(formatTable(r)).not.toContain("Context fan-out");
  });

  it("shows callback identity deltas", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: makeReactOptimizations({
          callbackIdentityDeltas: [
            { propName: "onClick", deltaMs: 2.5 },
            { propName: "onChange", deltaMs: 1.2 },
          ],
        }),
      })],
    });
    const table = formatTable(r);
    expect(table).toContain("Callback identity");
    expect(table).toContain("onClick");
    expect(table).toContain("2.5");
  });

  it("omits callback identity when empty array", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: makeReactOptimizations({
          callbackIdentityDeltas: [],
          memoBailout: true,
          memoBailoutComponents: ["X"],
        }),
      })],
    });
    expect(formatTable(r)).not.toContain("Callback identity");
  });

  it("shows portal orphan count", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: makeReactOptimizations({ portalOrphans: 5 }),
      })],
    });
    const table = formatTable(r);
    expect(table).toContain("Portal orphans");
    expect(table).toContain("5");
  });

  it("omits portal orphans when 0", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: makeReactOptimizations({
          portalOrphans: 0,
          memoBailout: true,
          memoBailoutComponents: ["X"],
        }),
      })],
    });
    expect(formatTable(r)).not.toContain("Portal orphans");
  });

  it("shows render attribution top 3", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: makeReactOptimizations({
          renderAttribution: [
            { component: "Heavy", renderCount: 5, totalDurationMs: 10, selfDurationMs: 8 },
            { component: "Medium", renderCount: 3, totalDurationMs: 6, selfDurationMs: 4 },
            { component: "Light", renderCount: 2, totalDurationMs: 3, selfDurationMs: 2 },
            { component: "Tiny", renderCount: 1, totalDurationMs: 1, selfDurationMs: 0.5 },
          ],
        }),
      })],
    });
    const table = formatTable(r);
    expect(table).toContain("Render attribution");
    expect(table).toContain("Heavy");
    expect(table).toContain("Medium");
    expect(table).toContain("Light");
    expect(table).not.toContain("Tiny");
  });

  it("omits render attribution when empty", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: makeReactOptimizations({
          renderAttribution: [],
          memoBailout: true,
          memoBailoutComponents: ["X"],
        }),
      })],
    });
    expect(formatTable(r)).not.toContain("Render attribution");
  });

  it("shows combo number when multiple combos have react optimizations", () => {
    const r = makeReport({
      combos: [
        makeCombo({
          comboIndex: 0,
          reactOptimizations: makeReactOptimizations({ memoBailout: true, memoBailoutComponents: ["A"] }),
        }),
        makeCombo({
          comboIndex: 1,
          reactOptimizations: makeReactOptimizations({ memoBailout: true, memoBailoutComponents: ["B"] }),
        }),
      ],
    });
    const table = formatTable(r);
    expect(table).toContain("Combo #0");
    expect(table).toContain("Combo #1");
  });

  it("does not show combo number when single combo", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: makeReactOptimizations({ memoBailout: true, memoBailoutComponents: ["A"] }),
      })],
    });
    const table = formatTable(r);
    expect(table).not.toContain("Combo #");
  });

  it("handles reactOptimizations with all fields populated", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: {
          memoBailout: true,
          memoBailoutComponents: ["Button"],
          contextFanOut: true,
          contextFanOutComponents: ["Sidebar"],
          callbackIdentityDeltas: [{ propName: "onClick", deltaMs: 3.0 }],
          portalOrphans: 2,
          renderAttribution: [
            { component: "App", renderCount: 10, totalDurationMs: 20, selfDurationMs: 15 },
          ],
        },
      })],
    });
    const table = formatTable(r);
    expect(table).toContain("Memo bailout");
    expect(table).toContain("Context fan-out");
    expect(table).toContain("Callback identity");
    expect(table).toContain("Portal orphans");
    expect(table).toContain("Render attribution");
  });
});
