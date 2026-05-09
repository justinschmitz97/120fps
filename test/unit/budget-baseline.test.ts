import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadBaseline,
  saveBaseline,
  compareBaseline,
  resolveTolerances,
  type Baseline,
  type BaselineEntry,
  type ResolvedTolerance,
} from "../../src/budget.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-baseline-"));
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

const DEFAULT_TOL: ResolvedTolerance = resolveTolerances(null);

describe("loadBaseline", () => {
  it("returns null when file does not exist", () => {
    expect(loadBaseline(path.join(tmpDir, "120fps-baseline.json"))).toBeNull();
  });

  it("parses valid baseline", () => {
    const baseline: Baseline = {
      version: 1,
      timestamp: "2026-01-01T00:00:00Z",
      entries: { "./Button.tsx": makeEntry() },
    };
    const filePath = path.join(tmpDir, "120fps-baseline.json");
    fs.writeFileSync(filePath, JSON.stringify(baseline));
    const loaded = loadBaseline(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries["./Button.tsx"].mount).toBe(1.0);
  });

  it("returns null for wrong version", () => {
    const bad = { version: 99, timestamp: "x", entries: {} };
    const filePath = path.join(tmpDir, "120fps-baseline.json");
    fs.writeFileSync(filePath, JSON.stringify(bad));
    expect(loadBaseline(filePath)).toBeNull();
  });
});

describe("saveBaseline", () => {
  it("creates new baseline file", () => {
    const filePath = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(filePath, makeEntry({ mount: 2.0 }), "./Button.tsx");
    const loaded = loadBaseline(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries["./Button.tsx"].mount).toBe(2.0);
    expect(loaded!.version).toBe(1);
  });

  it("merges with existing entries", () => {
    const filePath = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(filePath, makeEntry({ mount: 1.0 }), "./Button.tsx");
    saveBaseline(filePath, makeEntry({ mount: 3.0 }), "./Accordion.tsx");
    const loaded = loadBaseline(filePath);
    expect(loaded!.entries["./Button.tsx"].mount).toBe(1.0);
    expect(loaded!.entries["./Accordion.tsx"].mount).toBe(3.0);
  });

  it("overwrites existing entry for same component", () => {
    const filePath = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(filePath, makeEntry({ mount: 1.0 }), "./Button.tsx");
    saveBaseline(filePath, makeEntry({ mount: 5.0 }), "./Button.tsx");
    const loaded = loadBaseline(filePath);
    expect(loaded!.entries["./Button.tsx"].mount).toBe(5.0);
  });
});

describe("compareBaseline", () => {
  it("detects mount regression", () => {
    const entry = makeEntry({ mount: 1.0 });
    const current = { mount: 1.2, rerender: 0.5, unmount: 0.1, interactions: {} };
    const result = compareBaseline(entry, current, DEFAULT_TOL);
    expect(result.hasBaseline).toBe(true);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].metric).toBe("mount");
    expect(result.regressions[0].deltaPercent).toBeCloseTo(20);
  });

  it("no regression within tolerance", () => {
    const entry = makeEntry({ mount: 1.0 });
    const current = { mount: 1.09, rerender: 0.5, unmount: 0.1, interactions: {} };
    const result = compareBaseline(entry, current, DEFAULT_TOL);
    expect(result.regressions).toHaveLength(0);
  });

  it("detects improvement", () => {
    const entry = makeEntry({ mount: 1.0 });
    const current = { mount: 0.9, rerender: 0.5, unmount: 0.1, interactions: {} };
    const result = compareBaseline(entry, current, DEFAULT_TOL);
    expect(result.improvements).toHaveLength(1);
    expect(result.improvements[0].metric).toBe("mount");
    expect(result.improvements[0].deltaPercent).toBeCloseTo(-10);
  });

  it("does not flag small improvements (> -5%)", () => {
    const entry = makeEntry({ mount: 1.0 });
    const current = { mount: 0.96, rerender: 0.5, unmount: 0.1, interactions: {} };
    const result = compareBaseline(entry, current, DEFAULT_TOL);
    expect(result.improvements).toHaveLength(0);
  });

  it("skips unstable metrics", () => {
    const entry = makeEntry({ mount: 1.0 });
    const current = { mount: 2.0, rerender: 0.5, unmount: 0.1, interactions: {} };
    const unstable = new Set(["mount"]);
    const result = compareBaseline(entry, current, DEFAULT_TOL, unstable);
    expect(result.regressions).toHaveLength(0);
  });

  it("detects interaction regression", () => {
    const entry = makeEntry({ interactions: { "click button": 100 } });
    const current = { mount: 1.0, rerender: 0.5, unmount: 0.1, interactions: { "click button": 120 } };
    const result = compareBaseline(entry, current, DEFAULT_TOL);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].metric).toBe("interaction:click button");
  });

  it("handles new interaction not in baseline", () => {
    const entry = makeEntry({ interactions: {} });
    const current = { mount: 1.0, rerender: 0.5, unmount: 0.1, interactions: { "click button": 100 } };
    const result = compareBaseline(entry, current, DEFAULT_TOL);
    expect(result.regressions).toHaveLength(0);
  });

  it("checks all three core metrics independently", () => {
    const entry = makeEntry({ mount: 1.0, rerender: 1.0, unmount: 1.0 });
    const current = { mount: 1.5, rerender: 1.5, unmount: 1.5, interactions: {} };
    const result = compareBaseline(entry, current, DEFAULT_TOL);
    expect(result.regressions).toHaveLength(3);
    const metrics = result.regressions.map((r) => r.metric).sort();
    expect(metrics).toEqual(["mount", "rerender", "unmount"]);
  });
});
