import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { analyze, type AnalyzeOptions } from "../../src/analyze.js";
import { parseBaselineKey, type Baseline, type BaselineEntry } from "../../src/budget.js";

const PROJECT_DIR = path.resolve(`.m39-cached-check-${process.pid}`);
const COMPONENT = path.join(PROJECT_DIR, "static-card.tsx");
const BASELINE = path.join(PROJECT_DIR, "120fps-baseline.json");
const ENTRY_KEY = "./static-card.tsx";

const FAST: AnalyzeOptions = {
  samples: 2,
  warmupRuns: 1,
  skipDeltas: true,
  skipAutoScale: true,
  skipAttribution: true,
  skipAutoCompose: true,
  skipReactAnalysis: true,
};

const SOURCE = (label: string) => `import React from "react";

export function StaticCard() {
  return <div className="card"><p>${label}</p></div>;
}
`;

function run(options: AnalyzeOptions) {
  return analyze(COMPONENT, {
    ...FAST,
    ...options,
    jsonPath: path.join(PROJECT_DIR, "report.json"),
  });
}

function readBaseline(): Baseline {
  return JSON.parse(fs.readFileSync(BASELINE, "utf-8")) as Baseline;
}

// M45: entries live in per-environment slots; this fixture only ever writes one.
function slotKey(baseline: Baseline): string {
  const key = Object.keys(baseline.entries).find(
    (k) => parseBaselineKey(k).componentPath === ENTRY_KEY,
  );
  if (!key) throw new Error(`no baseline slot for ${ENTRY_KEY}`);
  return key;
}

function storedEntry(): BaselineEntry {
  const baseline = readBaseline();
  return baseline.entries[slotKey(baseline)];
}

beforeAll(() => {
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PROJECT_DIR, "package.json"),
    JSON.stringify({ name: "m39-cached-check-fixture", version: "0.0.0", private: true }),
    "utf-8",
  );
  fs.writeFileSync(COMPONENT, SOURCE("original"), "utf-8");
});

afterAll(() => {
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
});

describe("M39: cached check", () => {
  it("save-baseline records fingerprint and verdict", async () => {
    const report = await run({ saveBaseline: true });
    const entry = storedEntry();
    expect(entry.sourceFingerprint).toMatch(/^[0-9a-f]{40}$/);
    expect(entry.pass).toBe(report.pass);
  }, 300000);

  it("an unchanged component reuses the baseline instead of measuring", async () => {
    const report = await run({ check: true });
    expect(report.cached).toBe(true);
    expect(report.combos).toEqual([]);
    expect(report.pass).toBe(storedEntry().pass);
    expect(report.baseline?.hasBaseline).toBe(true);
    expect(report.baseline?.regressions).toEqual([]);
  }, 300000);

  it("--no-cache measures even when unchanged", async () => {
    const report = await run({ check: true, noCache: true });
    expect(report.cached).toBeUndefined();
    expect(report.combos.length).toBeGreaterThan(0);
  }, 300000);

  it("a source change measures again", async () => {
    fs.writeFileSync(COMPONENT, SOURCE("edited"), "utf-8");
    const report = await run({ check: true });
    expect(report.cached).toBeUndefined();
    expect(report.combos.length).toBeGreaterThan(0);
  }, 300000);

  it("--baseline-env ignore measures: the user asked for a raw comparison", async () => {
    // Re-align the baseline so only the policy differs from a reusable state.
    await run({ saveBaseline: true });
    const report = await run({ check: true, baselineEnv: "ignore" });
    expect(report.cached).toBeUndefined();
    expect(report.combos.length).toBeGreaterThan(0);
  }, 300000);

  it("a hand-edited env feature breaks reuse through featuresDiffer", async () => {
    await run({ saveBaseline: true });
    const baseline = readBaseline();
    baseline.entries[slotKey(baseline)].env!.wrapper = "120fps.setup.tsx";
    fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2), "utf-8");
    const report = await run({ check: true });
    expect(report.cached).toBeUndefined();
    expect(report.combos.length).toBeGreaterThan(0);
  }, 300000);

  it("a machine-identity mismatch measures again", async () => {
    // Re-align the baseline with the edited source first.
    await run({ saveBaseline: true });
    const baseline = readBaseline();
    baseline.entries[slotKey(baseline)].env!.cpuThrottle = 8;
    fs.writeFileSync(BASELINE, JSON.stringify(baseline, null, 2), "utf-8");
    const report = await run({ check: true });
    expect(report.cached).toBeUndefined();
    expect(report.combos.length).toBeGreaterThan(0);
  }, 300000);
});
