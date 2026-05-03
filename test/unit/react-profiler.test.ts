import { describe, it, expect } from "vitest";
import {
  detectFramework,
  diffSnapshots,
  detectMemoBailouts,
  detectContextFanOut,
  computeRenderAttribution,
  computePortalOrphans,
  hasReactWarning,
  PROFILER_HOOK_SCRIPT,
  generateProbeEntry,
  generateProbeHtml,
  type ProfilerSnapshot,
  type ProfilerDiff,
  type ReactOptimizations,
  type FiberInfo,
  type RenderAttribution,
  type CallbackIdentityDelta,
} from "../../src/react-profiler.js";
import { parseArgs } from "../../src/cli.js";
import type { AnalyzeOptions } from "../../src/analyze.js";

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
  return {
    fibers: new Map(fibers),
    commitCount,
  };
}

// ====================================================================
// detectFramework
// ====================================================================

describe("detectFramework", () => {
  it("returns 'react' when entry contains react-dom/client import", () => {
    const entry = `import { createRoot } from "react-dom/client";`;
    expect(detectFramework(entry)).toBe("react");
  });

  it("returns 'react' when entry contains react-dom import", () => {
    const entry = `import ReactDOM from "react-dom";`;
    expect(detectFramework(entry)).toBe("react");
  });

  it("returns 'vanilla' when entry has no react-dom", () => {
    const entry = `const app = document.getElementById("root");`;
    expect(detectFramework(entry)).toBe("vanilla");
  });

  it("returns 'vanilla' for empty string", () => {
    expect(detectFramework("")).toBe("vanilla");
  });

  it("detects react-dom in require() calls", () => {
    const entry = `const ReactDOM = require("react-dom");`;
    expect(detectFramework(entry)).toBe("react");
  });

  it("detects react-dom in dynamic import", () => {
    const entry = `const mod = await import("react-dom/client");`;
    expect(detectFramework(entry)).toBe("react");
  });
});

// ====================================================================
// diffSnapshots
// ====================================================================

describe("diffSnapshots", () => {
  it("returns empty diff for identical snapshots", () => {
    const snap = makeSnapshot([["f1", makeFiber({ renderCount: 2 })]]);
    const diff = diffSnapshots(snap, snap);
    expect(diff.rerenderFibers).toHaveLength(0);
  });

  it("detects fiber with increased render count", () => {
    const a = makeSnapshot([["f1", makeFiber({ name: "Button", renderCount: 1 })]]);
    const b = makeSnapshot([["f1", makeFiber({ name: "Button", renderCount: 3 })]]);
    const diff = diffSnapshots(a, b);
    expect(diff.rerenderFibers).toHaveLength(1);
    expect(diff.rerenderFibers[0].name).toBe("Button");
    expect(diff.rerenderFibers[0].renderCountDelta).toBe(2);
  });

  it("ignores fibers with unchanged render count", () => {
    const a = makeSnapshot([["f1", makeFiber({ renderCount: 5 })]]);
    const b = makeSnapshot([["f1", makeFiber({ renderCount: 5 })]]);
    const diff = diffSnapshots(a, b);
    expect(diff.rerenderFibers).toHaveLength(0);
  });

  it("ignores fibers only in snapshot B (new mounts)", () => {
    const a = makeSnapshot([]);
    const b = makeSnapshot([["f1", makeFiber({ renderCount: 1 })]]);
    const diff = diffSnapshots(a, b);
    expect(diff.rerenderFibers).toHaveLength(0);
  });

  it("ignores fibers only in snapshot A (unmounted)", () => {
    const a = makeSnapshot([["f1", makeFiber({ renderCount: 2 })]]);
    const b = makeSnapshot([]);
    const diff = diffSnapshots(a, b);
    expect(diff.rerenderFibers).toHaveLength(0);
  });

  it("handles multiple fibers with mixed changes", () => {
    const a = makeSnapshot([
      ["f1", makeFiber({ name: "A", renderCount: 1 })],
      ["f2", makeFiber({ name: "B", renderCount: 3 })],
      ["f3", makeFiber({ name: "C", renderCount: 2 })],
    ]);
    const b = makeSnapshot([
      ["f1", makeFiber({ name: "A", renderCount: 4 })],
      ["f2", makeFiber({ name: "B", renderCount: 3 })],
      ["f3", makeFiber({ name: "C", renderCount: 5 })],
    ]);
    const diff = diffSnapshots(a, b);
    expect(diff.rerenderFibers).toHaveLength(2);
    expect(diff.rerenderFibers[0].name).toBe("A");
    expect(diff.rerenderFibers[0].renderCountDelta).toBe(3);
    expect(diff.rerenderFibers[1].name).toBe("C");
    expect(diff.rerenderFibers[1].renderCountDelta).toBe(3);
  });

  it("sorts by renderCountDelta descending", () => {
    const a = makeSnapshot([
      ["f1", makeFiber({ name: "Small", renderCount: 1 })],
      ["f2", makeFiber({ name: "Big", renderCount: 1 })],
    ]);
    const b = makeSnapshot([
      ["f1", makeFiber({ name: "Small", renderCount: 2 })],
      ["f2", makeFiber({ name: "Big", renderCount: 10 })],
    ]);
    const diff = diffSnapshots(a, b);
    expect(diff.rerenderFibers[0].name).toBe("Big");
    expect(diff.rerenderFibers[1].name).toBe("Small");
  });
});

// ====================================================================
// detectMemoBailouts
// ====================================================================

describe("detectMemoBailouts", () => {
  it("returns component names that re-rendered", () => {
    const diff: ProfilerDiff = {
      rerenderFibers: [
        { name: "Button", renderCountDelta: 1 },
        { name: "Icon", renderCountDelta: 2 },
      ],
    };
    expect(detectMemoBailouts(diff)).toEqual(["Button", "Icon"]);
  });

  it("returns empty array when no fibers re-rendered", () => {
    const diff: ProfilerDiff = { rerenderFibers: [] };
    expect(detectMemoBailouts(diff)).toEqual([]);
  });

  it("excludes Root component", () => {
    const diff: ProfilerDiff = {
      rerenderFibers: [
        { name: "Root", renderCountDelta: 1 },
        { name: "Button", renderCountDelta: 1 },
      ],
    };
    expect(detectMemoBailouts(diff)).toEqual(["Button"]);
  });

  it("excludes AppRoot component", () => {
    const diff: ProfilerDiff = {
      rerenderFibers: [
        { name: "AppRoot", renderCountDelta: 1 },
        { name: "Card", renderCountDelta: 1 },
      ],
    };
    expect(detectMemoBailouts(diff)).toEqual(["Card"]);
  });
});

// ====================================================================
// detectContextFanOut
// ====================================================================

describe("detectContextFanOut", () => {
  it("returns component names that re-rendered from context change", () => {
    const diff: ProfilerDiff = {
      rerenderFibers: [{ name: "Sidebar", renderCountDelta: 1 }],
    };
    expect(detectContextFanOut(diff)).toEqual(["Sidebar"]);
  });

  it("excludes __120fpsContextProbe provider", () => {
    const diff: ProfilerDiff = {
      rerenderFibers: [
        { name: "__120fpsContextProbe", renderCountDelta: 1 },
        { name: "List", renderCountDelta: 1 },
      ],
    };
    expect(detectContextFanOut(diff)).toEqual(["List"]);
  });

  it("excludes Root and AppRoot", () => {
    const diff: ProfilerDiff = {
      rerenderFibers: [
        { name: "Root", renderCountDelta: 1 },
        { name: "AppRoot", renderCountDelta: 1 },
        { name: "Input", renderCountDelta: 1 },
      ],
    };
    expect(detectContextFanOut(diff)).toEqual(["Input"]);
  });

  it("returns empty when no fibers re-rendered", () => {
    const diff: ProfilerDiff = { rerenderFibers: [] };
    expect(detectContextFanOut(diff)).toEqual([]);
  });
});

// ====================================================================
// computeRenderAttribution
// ====================================================================

describe("computeRenderAttribution", () => {
  it("returns top 5 fibers sorted by selfDuration descending", () => {
    const fibers: Array<[string, FiberInfo]> = [];
    for (let i = 0; i < 8; i++) {
      fibers.push([
        `f${i}`,
        makeFiber({ name: `Comp${i}`, selfDurationMs: i, actualDurationMs: i * 2 }),
      ]);
    }
    const snap = makeSnapshot(fibers);
    const result = computeRenderAttribution(snap);
    expect(result).toHaveLength(5);
    expect(result[0].component).toBe("Comp7");
    expect(result[4].component).toBe("Comp3");
  });

  it("returns fewer than 5 when fewer fibers exist", () => {
    const snap = makeSnapshot([
      ["f1", makeFiber({ name: "A", selfDurationMs: 3 })],
      ["f2", makeFiber({ name: "B", selfDurationMs: 1 })],
    ]);
    const result = computeRenderAttribution(snap);
    expect(result).toHaveLength(2);
    expect(result[0].component).toBe("A");
  });

  it("returns empty array for empty snapshot", () => {
    const snap = makeSnapshot([]);
    expect(computeRenderAttribution(snap)).toEqual([]);
  });

  it("maps fields correctly", () => {
    const snap = makeSnapshot([
      ["f1", makeFiber({
        name: "Widget",
        renderCount: 3,
        actualDurationMs: 10,
        selfDurationMs: 4,
      })],
    ]);
    const result = computeRenderAttribution(snap);
    expect(result[0]).toEqual({
      component: "Widget",
      renderCount: 3,
      totalDurationMs: 10,
      selfDurationMs: 4,
    });
  });

  it("respects custom top parameter", () => {
    const fibers: Array<[string, FiberInfo]> = [];
    for (let i = 0; i < 10; i++) {
      fibers.push([`f${i}`, makeFiber({ name: `C${i}`, selfDurationMs: i })]);
    }
    const snap = makeSnapshot(fibers);
    const result = computeRenderAttribution(snap, 3);
    expect(result).toHaveLength(3);
  });
});

// ====================================================================
// computePortalOrphans
// ====================================================================

describe("computePortalOrphans", () => {
  it("returns positive delta when post > pre", () => {
    expect(computePortalOrphans(5, 8)).toBe(3);
  });

  it("returns 0 when post equals pre", () => {
    expect(computePortalOrphans(5, 5)).toBe(0);
  });

  it("returns 0 when post < pre (never negative)", () => {
    expect(computePortalOrphans(8, 3)).toBe(0);
  });
});

// ====================================================================
// hasReactWarning
// ====================================================================

describe("hasReactWarning", () => {
  it("returns true when memoBailout is true", () => {
    const opts: ReactOptimizations = {
      memoBailout: true,
      memoBailoutComponents: ["Button"],
      contextFanOut: false,
    };
    expect(hasReactWarning(opts)).toBe(true);
  });

  it("returns true when contextFanOut is true", () => {
    const opts: ReactOptimizations = {
      memoBailout: false,
      contextFanOut: true,
      contextFanOutComponents: ["Sidebar"],
    };
    expect(hasReactWarning(opts)).toBe(true);
  });

  it("returns true when portalOrphans > 0", () => {
    const opts: ReactOptimizations = {
      memoBailout: false,
      contextFanOut: false,
      portalOrphans: 3,
    };
    expect(hasReactWarning(opts)).toBe(true);
  });

  it("returns true when callback delta > 2ms", () => {
    const opts: ReactOptimizations = {
      memoBailout: false,
      contextFanOut: false,
      callbackIdentityDeltas: [{ propName: "onClick", deltaMs: 2.5 }],
    };
    expect(hasReactWarning(opts)).toBe(true);
  });

  it("returns false when callback delta <= 2ms", () => {
    const opts: ReactOptimizations = {
      memoBailout: false,
      contextFanOut: false,
      callbackIdentityDeltas: [{ propName: "onClick", deltaMs: 1.5 }],
    };
    expect(hasReactWarning(opts)).toBe(false);
  });

  it("returns false when all findings are clean", () => {
    const opts: ReactOptimizations = {
      memoBailout: false,
      contextFanOut: false,
    };
    expect(hasReactWarning(opts)).toBe(false);
  });

  it("returns false when portalOrphans is 0", () => {
    const opts: ReactOptimizations = {
      memoBailout: false,
      contextFanOut: false,
      portalOrphans: 0,
    };
    expect(hasReactWarning(opts)).toBe(false);
  });
});

// ====================================================================
// CLI flags
// ====================================================================

describe("CLI --no-react-analysis flag", () => {
  it("parseArgs recognizes --no-react-analysis", () => {
    const result = parseArgs(["./Button.tsx", "--no-react-analysis"]);
    expect(result.noReactAnalysis).toBe(true);
  });

  it("defaults noReactAnalysis to undefined", () => {
    const result = parseArgs(["./Button.tsx"]);
    expect(result.noReactAnalysis).toBeUndefined();
  });

  it("--no-react-analysis does not produce an error", () => {
    const result = parseArgs(["./Button.tsx", "--no-react-analysis"]);
    expect(result.error).toBeUndefined();
  });

  it("works alongside --ci", () => {
    const result = parseArgs(["./Button.tsx", "--ci", "--no-react-analysis"]);
    expect(result.ci).toBe(true);
    expect(result.noReactAnalysis).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

describe("CLI --framework flag", () => {
  it("parseArgs recognizes --framework react", () => {
    const result = parseArgs(["./Button.tsx", "--framework", "react"]);
    expect(result.framework).toBe("react");
  });

  it("parseArgs recognizes --framework vanilla", () => {
    const result = parseArgs(["./Button.tsx", "--framework", "vanilla"]);
    expect(result.framework).toBe("vanilla");
  });

  it("parseArgs recognizes --framework auto", () => {
    const result = parseArgs(["./Button.tsx", "--framework", "auto"]);
    expect(result.framework).toBe("auto");
  });

  it("defaults framework to undefined", () => {
    const result = parseArgs(["./Button.tsx"]);
    expect(result.framework).toBeUndefined();
  });

  it("--framework without value returns error", () => {
    const result = parseArgs(["./Button.tsx", "--framework"]);
    expect(result.error).toBeTruthy();
  });

  it("--framework with invalid value returns error", () => {
    const result = parseArgs(["./Button.tsx", "--framework", "vue"]);
    expect(result.error).toBeTruthy();
  });

  it("--framework does not produce error with valid value", () => {
    const result = parseArgs(["./Button.tsx", "--framework", "react"]);
    expect(result.error).toBeUndefined();
  });
});

// ====================================================================
// PROFILER_HOOK_SCRIPT
// ====================================================================

describe("PROFILER_HOOK_SCRIPT", () => {
  it("assigns __REACT_DEVTOOLS_GLOBAL_HOOK__", () => {
    expect(PROFILER_HOOK_SCRIPT).toContain("__REACT_DEVTOOLS_GLOBAL_HOOK__");
  });

  it("sets supportsFiber to true", () => {
    expect(PROFILER_HOOK_SCRIPT).toContain("supportsFiber: true");
  });

  it("defines inject method", () => {
    expect(PROFILER_HOOK_SCRIPT).toContain("inject:");
  });

  it("defines onCommitFiberRoot method", () => {
    expect(PROFILER_HOOK_SCRIPT).toContain("onCommitFiberRoot:");
  });

  it("stores data on window.__120fps_profiler", () => {
    expect(PROFILER_HOOK_SCRIPT).toContain("__120fps_profiler");
  });

  it("provides reset function", () => {
    expect(PROFILER_HOOK_SCRIPT).toContain("reset:");
  });
});

// ====================================================================
// generateProbeEntry
// ====================================================================

describe("generateProbeEntry", () => {
  it("includes synthetic context provider", () => {
    const entry = generateProbeEntry({
      componentRelative: "src/Button.tsx",
      componentName: "Button",
      isDefaultExport: true,
    });
    expect(entry).toContain("__120fpsContext");
    expect(entry).toContain("__120fpsContextProbe");
    expect(entry).toContain("createContext");
  });

  it("exposes forceContextUpdate on __120fps", () => {
    const entry = generateProbeEntry({
      componentRelative: "src/Button.tsx",
      componentName: "Button",
      isDefaultExport: true,
    });
    expect(entry).toContain("forceContextUpdate");
    expect(entry).toContain("__120fps_forceContext");
  });

  it("exposes rerenderWithStableCallbacks", () => {
    const entry = generateProbeEntry({
      componentRelative: "src/Button.tsx",
      componentName: "Button",
      isDefaultExport: true,
    });
    expect(entry).toContain("rerenderWithStableCallbacks");
    expect(entry).toContain("stableCallbackCache");
  });

  it("exposes rerenderWithFreshCallbacks", () => {
    const entry = generateProbeEntry({
      componentRelative: "src/Button.tsx",
      componentName: "Button",
      isDefaultExport: true,
    });
    expect(entry).toContain("rerenderWithFreshCallbacks");
  });

  it("uses default import for default export components", () => {
    const entry = generateProbeEntry({
      componentRelative: "src/Button.tsx",
      componentName: "Button",
      isDefaultExport: true,
    });
    expect(entry).toContain('import Button from "/src/Button.tsx"');
  });

  it("uses named import for named export components", () => {
    const entry = generateProbeEntry({
      componentRelative: "src/Button.tsx",
      componentName: "Button",
      isDefaultExport: false,
    });
    expect(entry).toContain('import { Button as Component }');
  });

  it("preserves component relative path", () => {
    const entry = generateProbeEntry({
      componentRelative: "packages/ui/Input.tsx",
      componentName: "Input",
      isDefaultExport: true,
    });
    expect(entry).toContain("/packages/ui/Input.tsx");
  });

  it("wraps component in context provider on mount", () => {
    const entry = generateProbeEntry({
      componentRelative: "src/Button.tsx",
      componentName: "Button",
      isDefaultExport: true,
    });
    expect(entry).toContain("__120fpsContextProbe");
    expect(entry).toContain("createElement(");
  });
});

// ====================================================================
// generateProbeHtml
// ====================================================================

describe("generateProbeHtml", () => {
  it("includes root div", () => {
    expect(generateProbeHtml()).toContain('id="root"');
  });

  it("points to probe-entry.tsx", () => {
    expect(generateProbeHtml()).toContain("probe-entry.tsx");
  });
});

// ====================================================================
// AnalyzeOptions integration
// ====================================================================

describe("AnalyzeOptions react fields", () => {
  it("accepts skipReactAnalysis option", () => {
    const opts: AnalyzeOptions = { skipReactAnalysis: true };
    expect(opts.skipReactAnalysis).toBe(true);
  });

  it("accepts framework option", () => {
    const opts: AnalyzeOptions = { framework: "vanilla" };
    expect(opts.framework).toBe("vanilla");
  });

  it("defaults are undefined when not provided", () => {
    const opts: AnalyzeOptions = {};
    expect(opts.skipReactAnalysis).toBeUndefined();
    expect(opts.framework).toBeUndefined();
  });

  it("framework accepts all valid values", () => {
    const r: AnalyzeOptions = { framework: "react" };
    const v: AnalyzeOptions = { framework: "vanilla" };
    const a: AnalyzeOptions = { framework: "auto" };
    expect(r.framework).toBe("react");
    expect(v.framework).toBe("vanilla");
    expect(a.framework).toBe("auto");
  });
});
