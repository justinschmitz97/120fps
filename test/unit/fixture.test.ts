import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";
import { isFixturePath, detectFixture } from "../../src/analyze.js";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";
import type { Thresholds, CalibrationResult } from "../../src/report.js";
import type { MountResult } from "../../src/measure.js";
import type { ExploreResult, StateGraph } from "../../src/explorer.js";
import path from "node:path";

// --- CLI tests ---

describe("parseArgs --fixture", () => {
  it("parses --fixture flag with path", () => {
    const result = parseArgs(["./comp.tsx", "--fixture", "./comp.fixture.tsx"]);
    expect(result.fixturePath).toBe("./comp.fixture.tsx");
    expect(result.componentPath).toBe("./comp.tsx");
  });

  it("returns error when --fixture has no path", () => {
    const result = parseArgs(["./comp.tsx", "--fixture"]);
    expect(result.error).toBeTruthy();
  });

  it("returns error when --fixture is used without component path", () => {
    const result = parseArgs(["--fixture", "./comp.fixture.tsx"]);
    expect(result.error).toBeTruthy();
  });

  it("allows --fixture with other flags", () => {
    const result = parseArgs([
      "./comp.tsx",
      "--fixture", "./comp.fixture.tsx",
      "--samples", "5",
      "--ci",
    ]);
    expect(result.fixturePath).toBe("./comp.fixture.tsx");
    expect(result.samples).toBe(5);
    expect(result.ci).toBe(true);
  });
});

// --- Fixture detection ---

describe("isFixturePath", () => {
  it("returns true for .fixture.tsx", () => {
    expect(isFixturePath("accordion.fixture.tsx")).toBe(true);
  });

  it("returns true for .fixture.ts", () => {
    expect(isFixturePath("accordion.fixture.ts")).toBe(true);
  });

  it("returns false for regular .tsx", () => {
    expect(isFixturePath("accordion.tsx")).toBe(false);
  });

  it("returns false for .tsx containing fixture in name", () => {
    expect(isFixturePath("my-fixture-helper.tsx")).toBe(false);
  });
});

describe("detectFixture", () => {
  it("finds adjacent .fixture.tsx for a component", () => {
    const compPath = path.resolve("fixtures/accordion-root.tsx");
    const result = detectFixture(compPath);
    expect(result).toBe(path.resolve("fixtures/accordion-root.fixture.tsx"));
  });

  it("returns undefined when no adjacent fixture exists", () => {
    const compPath = path.resolve("fixtures/button.tsx");
    const result = detectFixture(compPath);
    expect(result).toBeUndefined();
  });
});

// --- Report fields ---

function makeEmptyGraph(): StateGraph {
  const nodes = new Map();
  nodes.set("abc", { id: "abc", depth: 0, interactions: [], pathFromRoot: [] });
  return { nodes, edges: [], initialNodeId: "abc", wallClockMs: 100 };
}

const baseMachine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};
const baseThresholds: Thresholds = { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 };
const baseCal: CalibrationResult = { totalDuration: 10, scriptDuration: 5 };

describe("buildReport fixture fields", () => {
  it("includes fixturePath when provided", () => {
    const report = buildReport({
      componentPath: "./accordion.tsx",
      componentName: "Accordion",
      machine: baseMachine,
      calibration: baseCal,
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 10,
      }],
      explores: [{ graph: makeEmptyGraph(), comboIndex: 0, props: {} }],
      heapDeltas: [0],
      thresholds: baseThresholds,
      fixturePath: "./accordion.fixture.tsx",
      fixtureAutoDetected: false,
    });

    expect(report.fixturePath).toBe("./accordion.fixture.tsx");
    expect(report.fixtureAutoDetected).toBe(false);
  });

  it("includes fixtureAutoDetected=true when auto-detected", () => {
    const report = buildReport({
      componentPath: "./accordion.tsx",
      componentName: "Accordion",
      machine: baseMachine,
      calibration: baseCal,
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 10,
      }],
      explores: [{ graph: makeEmptyGraph(), comboIndex: 0, props: {} }],
      heapDeltas: [0],
      thresholds: baseThresholds,
      fixturePath: "./accordion.fixture.tsx",
      fixtureAutoDetected: true,
    });

    expect(report.fixtureAutoDetected).toBe(true);
  });

  it("omits fixture fields when no fixture used", () => {
    const report = buildReport({
      componentPath: "./button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: baseCal,
      mounts: [{
        comboIndex: 0, props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [2], median: 2, p95: 2 },
        domNodeCount: 10,
      }],
      explores: [{ graph: makeEmptyGraph(), comboIndex: 0, props: {} }],
      heapDeltas: [0],
      thresholds: baseThresholds,
    });

    expect(report.fixturePath).toBeUndefined();
    expect(report.fixtureAutoDetected).toBeUndefined();
  });
});
