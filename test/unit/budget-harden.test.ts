import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadBaseline,
  saveBaseline,
  resolveTolerances,
  compareBaseline,
  type Baseline,
  type BaselineEntry,
  selectBaselineEntry,
  baselineKey,
  computeEnvKey,
} from "../../src/budget.js";
// M45: entries are keyed by component x environment slot; selectBaselineEntry
// resolves the slot for us so these assertions stay about the entry, not the key.
function entryOf(baseline: any, componentPath: string) {
  return selectBaselineEntry(baseline, componentPath, "unused")!.entry;
}

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
  it("NOT an improvement at exactly -5%", () => {
    const entry = makeEntry({ mount: 10.0 });
    const current = { mount: 9.5, rerender: 0.5, unmount: 0.1, interactions: {} };
    const tol = resolveTolerances(null);
    const result = compareBaseline(entry, current, tol);
    expect(result.improvements).toHaveLength(0);
  });
});

describe("H12: --save-baseline writes valid JSON", () => {
  it("produces parseable JSON with correct structure", () => {
    const filePath = path.join(tmpDir, "120fps-baseline.json");
    saveBaseline(filePath, makeEntry({ mount: 1.5, tier: "T2" }), "./Comp.tsx");
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(2);
    expect(typeof parsed.timestamp).toBe("string");
    expect(parsed.entries[baselineKey("./Comp.tsx", computeEnvKey(undefined))].tier).toBe("T2");
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
    const savedEntry = entryOf(loaded, "./Button.tsx");
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
