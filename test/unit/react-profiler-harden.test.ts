import { describe, it, expect } from "vitest";
import {
  detectFramework,
  diffSnapshots,
  detectMemoBailouts,
  detectContextFanOut,
  computeRenderAttribution,
  computePortalOrphans,
  hasReactWarning,
  type ProfilerSnapshot,
  type ProfilerDiff,
  type ReactOptimizations,
  type FiberInfo,
} from "../../src/react-profiler.js";
import {
  formatTable,
  DEFAULT_THRESHOLDS,
  type ComboReport,
  type Report,
} from "../../src/report.js";
import { parseArgs } from "../../src/cli.js";

// --- helpers ---

function makeFiber(overrides: Partial<FiberInfo> = {}): FiberInfo {
  return {
    name: "Component",
    renderCount: 1,
    actualDurationMs: 1,
    selfDurationMs: 0.5,
    descendantCount: 5,
    ...overrides,
  };
}

function makeSnapshot(
  fibers: Array<[string, FiberInfo]> = [],
  commitCount = 1,
): ProfilerSnapshot {
  return { fibers: new Map(fibers), commitCount };
}

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

// ====================================================================
// Hardening tests
// ====================================================================

describe("H1: empty profiler snapshot diff", () => {
  it("produces empty diff with no re-renders", () => {
    const a = makeSnapshot([]);
    const b = makeSnapshot([]);
    const diff = diffSnapshots(a, b);
    expect(diff.rerenderFibers).toHaveLength(0);
    expect(detectMemoBailouts(diff)).toEqual([]);
    expect(detectContextFanOut(diff)).toEqual([]);
  });
});

describe("H2: duplicate fiber names handled by ID", () => {
  it("tracks fibers by ID, not by name", () => {
    const a = makeSnapshot([
      ["id1", makeFiber({ name: "Button", renderCount: 1 })],
      ["id2", makeFiber({ name: "Button", renderCount: 1 })],
    ]);
    const b = makeSnapshot([
      ["id1", makeFiber({ name: "Button", renderCount: 2 })],
      ["id2", makeFiber({ name: "Button", renderCount: 1 })],
    ]);
    const diff = diffSnapshots(a, b);
    expect(diff.rerenderFibers).toHaveLength(1);
    expect(diff.rerenderFibers[0].renderCountDelta).toBe(1);
  });
});

describe("H3: fiber with zero render count", () => {
  it("zero in both snapshots produces no bailout", () => {
    const a = makeSnapshot([["f1", makeFiber({ renderCount: 0 })]]);
    const b = makeSnapshot([["f1", makeFiber({ renderCount: 0 })]]);
    const diff = diffSnapshots(a, b);
    expect(diff.rerenderFibers).toHaveLength(0);
  });
});

describe("H4: very long component names in formatTable", () => {
  it("does not crash with 200-char component name", () => {
    const longName = "A".repeat(200);
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: {
          memoBailout: true,
          memoBailoutComponents: [longName],
          contextFanOut: false,
        },
      })],
    });
    const table = formatTable(r);
    expect(table).toContain(longName);
    expect(table.length).toBeGreaterThan(0);
  });
});

describe("H5: callback identity delta exactly at 0.5ms", () => {
  it("delta of exactly 0.5ms is NOT reported (> not >=)", () => {
    // The detection filters at > 0.5ms, so exactly 0.5 should not be in the list.
    // If somehow it's in the list, hasReactWarning checks > 2ms for warn.
    const opts: ReactOptimizations = {
      memoBailout: false,
      contextFanOut: false,
      callbackIdentityDeltas: [{ propName: "onClick", deltaMs: 0.5 }],
    };
    expect(hasReactWarning(opts)).toBe(false);
  });
});

describe("H6: callback identity delta exactly at 2.0ms", () => {
  it("delta of exactly 2.0ms does NOT produce warning (> not >=)", () => {
    const opts: ReactOptimizations = {
      memoBailout: false,
      contextFanOut: false,
      callbackIdentityDeltas: [{ propName: "onClick", deltaMs: 2.0 }],
    };
    expect(hasReactWarning(opts)).toBe(false);
  });
});

describe("H7: portal orphans = 0", () => {
  it("does not produce warning", () => {
    const opts: ReactOptimizations = {
      memoBailout: false,
      contextFanOut: false,
      portalOrphans: 0,
    };
    expect(hasReactWarning(opts)).toBe(false);
  });

  it("computePortalOrphans returns 0 for equal counts", () => {
    expect(computePortalOrphans(10, 10)).toBe(0);
  });
});

describe("H8: component with exactly 10 descendants", () => {
  it("descendantCount of exactly 10 is stored in fiber", () => {
    const fiber = makeFiber({ descendantCount: 10 });
    expect(fiber.descendantCount).toBe(10);
  });
});

describe("H9: formatTable with all react fields populated", () => {
  it("renders all sections without crash", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: {
          memoBailout: true,
          memoBailoutComponents: ["Button", "Icon"],
          contextFanOut: true,
          contextFanOutComponents: ["Sidebar"],
          callbackIdentityDeltas: [
            { propName: "onClick", deltaMs: 3.5 },
            { propName: "onChange", deltaMs: 1.2 },
          ],
          portalOrphans: 4,
          renderAttribution: [
            { component: "App", renderCount: 10, totalDurationMs: 20, selfDurationMs: 15 },
            { component: "Layout", renderCount: 8, totalDurationMs: 12, selfDurationMs: 8 },
            { component: "Header", renderCount: 5, totalDurationMs: 6, selfDurationMs: 3 },
          ],
        },
      })],
    });
    const table = formatTable(r);
    expect(table).toContain("Memo bailout: Button, Icon");
    expect(table).toContain("Context fan-out: Sidebar");
    expect(table).toContain("Callback identity: onClick +3.5ms, onChange +1.2ms");
    expect(table).toContain("Portal orphans: 4");
    expect(table).toContain("Render attribution:");
    expect(table).toContain("App: 15.0ms self (10 renders)");
  });
});

describe("H10: formatTable with only renderAttribution", () => {
  it("shows render attribution without memo/context/callback sections", () => {
    const r = makeReport({
      combos: [makeCombo({
        reactOptimizations: {
          memoBailout: false,
          contextFanOut: false,
          renderAttribution: [
            { component: "Widget", renderCount: 3, totalDurationMs: 5, selfDurationMs: 4 },
          ],
        },
      })],
    });
    const table = formatTable(r);
    expect(table).toContain("React Optimizations");
    expect(table).toContain("Render attribution:");
    expect(table).toContain("Widget");
    expect(table).not.toContain("Memo bailout");
    expect(table).not.toContain("Context fan-out");
    expect(table).not.toContain("Callback identity");
    expect(table).not.toContain("Portal orphans");
  });
});

describe("H11: diffSnapshots with 200 fibers", () => {
  it("handles large snapshot without issues", () => {
    const fibersA: Array<[string, FiberInfo]> = [];
    const fibersB: Array<[string, FiberInfo]> = [];
    for (let i = 0; i < 200; i++) {
      fibersA.push([`f${i}`, makeFiber({ name: `C${i}`, renderCount: 1 })]);
      fibersB.push([`f${i}`, makeFiber({ name: `C${i}`, renderCount: i % 2 === 0 ? 2 : 1 })]);
    }
    const diff = diffSnapshots(makeSnapshot(fibersA), makeSnapshot(fibersB));
    expect(diff.rerenderFibers).toHaveLength(100);
  });
});

describe("H12: render attribution selfDuration clamp", () => {
  it("reports negative selfDuration as-is (data faithfulness)", () => {
    const snap = makeSnapshot([
      ["f1", makeFiber({ name: "Broken", selfDurationMs: -0.5, actualDurationMs: 1 })],
    ]);
    const result = computeRenderAttribution(snap);
    expect(result[0].selfDurationMs).toBe(-0.5);
  });
});

describe("H13: detectFramework with minified react-dom", () => {
  it("detects react-dom in minified import", () => {
    expect(detectFramework(`import{createRoot}from"react-dom/client"`)).toBe("react");
  });

  it("detects react-dom in Vite pre-bundled path", () => {
    expect(detectFramework(`from ".vite/deps/react-dom_client.js"`)).toBe("react");
  });
});

describe("H14: --framework react --no-react-analysis", () => {
  it("both flags parse without error", () => {
    const result = parseArgs(["./Button.tsx", "--framework", "react", "--no-react-analysis"]);
    expect(result.error).toBeUndefined();
    expect(result.framework).toBe("react");
    expect(result.noReactAnalysis).toBe(true);
  });
});

describe("H15: --framework without component path", () => {
  it("still produces missing component error", () => {
    const result = parseArgs(["--framework", "react"]);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("Missing component path");
  });
});
