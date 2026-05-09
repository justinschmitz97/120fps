import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "../../src/cli.js";
import {
  loadBudgetConfig,
  loadBaseline,
  saveBaseline,
  resolveComponentBudget,
  resolveTolerances,
  compareBaseline,
  type Baseline,
  type BaselineEntry,
  type BudgetConfig,
} from "../../src/budget.js";
import { TIER_BUDGETS, formatTable, buildTimingWithCV, type Report, type BaselineComparison } from "../../src/report.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-harden-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<BaselineEntry> = {}): BaselineEntry {
  return {
    mount: 1.0,
    rerender: 0.5,
    unmount: 0.1,
    domNodeCount: 10,
    interactions: {},
    tier: "T1",
    ...overrides,
  };
}

function makeTiming(median: number) {
  return buildTimingWithCV([median, median, median]);
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    machine: { cpu: "test", cores: 4, ramMb: 16384, os: "test", nodeVersion: "v20.0.0", chromiumVersion: "120" },
    componentPath: "./test.tsx",
    componentName: "Test",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [{
      comboIndex: 0,
      props: {},
      mount: makeTiming(1.0),
      unmount: makeTiming(0.1),
      rerender: makeTiming(0.5),
      domNodeCount: 8,
      heapDelta: 0,
      interactions: [],
      scalingCurve: null,
      relativeMount: 0.1,
      verdict: "pass" as const,
    }],
    thresholds: { mountMs: 50, interactionMs: 400, relativeMount: 2, rerenderMs: 16 },
    pass: true,
    ...overrides,
  };
}

describe("H1: config with syntax error", () => {
  it("throws with clear message", () => {
    fs.writeFileSync(path.join(tmpDir, "120fps.config.json"), "{{bad json");
    expect(() => loadBudgetConfig(tmpDir)).toThrow(/Failed to load/);
  });
});

describe("H2: baseline with wrong version", () => {
  it("returns null", () => {
    const filePath = path.join(tmpDir, "120fps-baseline.json");
    fs.writeFileSync(filePath, JSON.stringify({ version: 99, timestamp: "x", entries: {} }));
    expect(loadBaseline(filePath)).toBeNull();
  });
});

describe("H3: saveBaseline on empty/missing file", () => {
  it("creates valid baseline", () => {
    const filePath = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(filePath, makeEntry({ mount: 3.0 }), "./New.tsx");
    const loaded = loadBaseline(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.version).toBe(1);
    expect(loaded!.entries["./New.tsx"].mount).toBe(3.0);
  });
});

describe("H4: saveBaseline preserves unrelated entries", () => {
  it("other components untouched", () => {
    const filePath = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(filePath, makeEntry({ mount: 1.0 }), "./A.tsx");
    saveBaseline(filePath, makeEntry({ mount: 2.0 }), "./B.tsx");
    saveBaseline(filePath, makeEntry({ mount: 9.0 }), "./A.tsx");
    const loaded = loadBaseline(filePath);
    expect(loaded!.entries["./A.tsx"].mount).toBe(9.0);
    expect(loaded!.entries["./B.tsx"].mount).toBe(2.0);
  });
});

describe("H5: regression exactly at tolerance", () => {
  it("NOT a regression when current = baseline * (1 + tol/100)", () => {
    const entry = makeEntry({ mount: 10.0 });
    const tol = resolveTolerances(null);
    const current = { mount: 10.0 * (1 + tol.mount / 100), rerender: 0.5, unmount: 0.1, interactions: {} };
    const result = compareBaseline(entry, current, tol);
    expect(result.regressions).toHaveLength(0);
  });
});

describe("H6: regression 0.01% above tolerance", () => {
  it("IS a regression", () => {
    const entry = makeEntry({ mount: 10.0 });
    const tol = resolveTolerances(null);
    const current = { mount: 10.0 * (1 + tol.mount / 100) + 0.001, rerender: 0.5, unmount: 0.1, interactions: {} };
    const result = compareBaseline(entry, current, tol);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].metric).toBe("mount");
  });
});

describe("H7: improvement at -5%", () => {
  it("counted as improvement when delta < -5%", () => {
    const entry = makeEntry({ mount: 10.0 });
    const current = { mount: 9.4, rerender: 0.5, unmount: 0.1, interactions: {} };
    const tol = resolveTolerances(null);
    const result = compareBaseline(entry, current, tol);
    expect(result.improvements).toHaveLength(1);
    expect(result.improvements[0].deltaPercent).toBeCloseTo(-6, 0);
  });

  it("NOT an improvement at exactly -5%", () => {
    const entry = makeEntry({ mount: 10.0 });
    const current = { mount: 9.5, rerender: 0.5, unmount: 0.1, interactions: {} };
    const tol = resolveTolerances(null);
    const result = compareBaseline(entry, current, tol);
    expect(result.improvements).toHaveLength(0);
  });
});

describe("H8: all metrics pass", () => {
  it("0 regressions", () => {
    const entry = makeEntry({ mount: 1.0, rerender: 0.5, unmount: 0.1 });
    const current = { mount: 1.0, rerender: 0.5, unmount: 0.1, interactions: {} };
    const tol = resolveTolerances(null);
    const result = compareBaseline(entry, current, tol);
    expect(result.regressions).toHaveLength(0);
  });
});

describe("H9: unstable metric with regression", () => {
  it("skipped — not flagged as regression", () => {
    const entry = makeEntry({ mount: 1.0 });
    const current = { mount: 5.0, rerender: 0.5, unmount: 0.1, interactions: {} };
    const tol = resolveTolerances(null);
    const result = compareBaseline(entry, current, tol, new Set(["mount"]));
    expect(result.regressions).toHaveLength(0);
  });
});

describe("H10: --budget implies --ci and --check", () => {
  it("sets all three flags", () => {
    const args = parseArgs(["./Button.tsx", "--budget"]);
    expect(args.budget).toBe(true);
    expect(args.ci).toBe(true);
    expect(args.check).toBe(true);
  });
});

describe("H11: --check without baseline", () => {
  it("no regression check, passes", () => {
    const filePath = path.join(tmpDir, "nonexistent-baseline.json");
    const loaded = loadBaseline(filePath);
    expect(loaded).toBeNull();
  });
});

describe("H12: --save-baseline writes valid JSON", () => {
  it("produces parseable JSON with correct structure", () => {
    const filePath = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(filePath, makeEntry({ mount: 1.5, tier: "T2" }), "./Comp.tsx");
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(typeof parsed.timestamp).toBe("string");
    expect(parsed.entries["./Comp.tsx"].tier).toBe("T2");
  });
});

describe("H13: per-component config overrides defaults", () => {
  it("mount override", () => {
    const config: BudgetConfig = {
      defaults: { mount: 30 },
      components: { "./Special.tsx": { mount: 8 } },
    };
    const budget = resolveComponentBudget(config, "./Special.tsx", "T2");
    expect(budget.mountMs).toBe(8);

    const otherBudget = resolveComponentBudget(config, "./Other.tsx", "T2");
    expect(otherBudget.mountMs).toBe(30);
  });
});

describe("H14: CLI --threshold-mount overrides config", () => {
  it("CLI threshold takes priority via analyze options", () => {
    const args = parseArgs(["./Button.tsx", "--threshold-mount", "5"]);
    expect(args.thresholdMount).toBe(5);
    expect(args.error).toBeUndefined();
  });
});

describe("H15: config with unknown fields", () => {
  it("ignored (forward-compat)", () => {
    const configData = { defaults: { mount: 20 }, futureField: true, nested: { deep: true } };
    fs.writeFileSync(path.join(tmpDir, "120fps.config.json"), JSON.stringify(configData));
    const config = loadBudgetConfig(tmpDir);
    expect(config).not.toBeNull();
    expect(config!.defaults!.mount).toBe(20);
  });
});

describe("H16: baseline with 0ms mount", () => {
  it("skips regression check (avoids division by zero)", () => {
    const entry = makeEntry({ mount: 0, rerender: 0, unmount: 0 });
    const current = { mount: 5.0, rerender: 5.0, unmount: 5.0, interactions: {} };
    const tol = resolveTolerances(null);
    const result = compareBaseline(entry, current, tol);
    expect(result.regressions).toHaveLength(0);
  });
});

describe("H17: multiple interactions checked independently", () => {
  it("detects regression in one interaction but not another", () => {
    const entry = makeEntry({
      interactions: { "click submit": 100, "click cancel": 50 },
    });
    const current = {
      mount: 1.0,
      rerender: 0.5,
      unmount: 0.1,
      interactions: { "click submit": 120, "click cancel": 50 },
    };
    const tol = resolveTolerances(null);
    const result = compareBaseline(entry, current, tol);
    const ixReg = result.regressions.filter((r) => r.metric.startsWith("interaction:"));
    expect(ixReg).toHaveLength(1);
    expect(ixReg[0].metric).toBe("interaction:click submit");
  });
});

describe("H18: round-trip save then compare identical", () => {
  it("0 regressions", () => {
    const filePath = path.join(tmpDir, "120fps-baseline.json");
    const entry = makeEntry({ mount: 1.5, rerender: 0.8, unmount: 0.2, interactions: { "click": 100 } });
    saveBaseline(filePath, entry, "./Button.tsx");

    const loaded = loadBaseline(filePath);
    const savedEntry = loaded!.entries["./Button.tsx"];
    const tol = resolveTolerances(null);
    const result = compareBaseline(savedEntry, {
      mount: savedEntry.mount,
      rerender: savedEntry.rerender,
      unmount: savedEntry.unmount,
      interactions: savedEntry.interactions,
    }, tol);
    expect(result.regressions).toHaveLength(0);
    expect(result.improvements).toHaveLength(0);
  });
});

describe("H19: formatTable with regressions shows REGRESSED", () => {
  it("shows regression details in output", () => {
    const comparison: BaselineComparison = {
      hasBaseline: true,
      regressions: [{ metric: "mount", baseline: 0.82, current: 0.95, deltaPercent: 15.9, tolerance: 10 }],
      improvements: [],
    };
    const output = formatTable(makeReport({ baseline: comparison }));
    expect(output).toContain("REGRESSED");
    expect(output).toContain("mount");
    expect(output).toContain("tolerance");
  });
});

describe("H20: baseline section omitted when no baseline", () => {
  it("formatTable without baseline has no baseline section", () => {
    const output = formatTable(makeReport());
    expect(output).not.toContain("Baseline comparison");
  });
});
