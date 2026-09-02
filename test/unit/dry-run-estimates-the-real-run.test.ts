import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  explainProps,
  formatExplainProps,
  estimateRunCost,
  DEFAULT_PHASE_ESTIMATE,
  type PropsExplanation,
} from "../../src/analyze.js";
import {
  saveBaseline,
  loadBaseline,
  selectPhaseTimingEntry,
  type BaselineEntry,
} from "../../src/budget.js";
import type { PhaseTimings } from "../../src/report.js";

const FIXTURE = path.resolve(__dirname, "../../fixtures/phase-timings");

const RECORDED: PhaseTimings = {
  preflight: 4_000,
  build: 41_000,
  calibration: 30_000,
  mount: 58_000,
  rerender: 20_000,
  explore: 80_000,
  scale: 0,
  deltas: 0,
  attribution: 0,
  analysis: 12_000,
  total: 245_000,
};

const temps: string[] = [];

function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-phase-"));
  temps.push(dir);
  fs.copyFileSync(path.join(FIXTURE, "package.json"), path.join(dir, "package.json"));
  fs.copyFileSync(path.join(FIXTURE, "button.tsx"), path.join(dir, "button.tsx"));
  // The dry run's own react-dom gate is unrelated to what this file asserts;
  // a stub package is what the sibling dry-run tests install for it.
  const stub = path.join(dir, "node_modules", "react-dom");
  fs.mkdirSync(stub, { recursive: true });
  fs.writeFileSync(
    path.join(stub, "package.json"),
    JSON.stringify({ name: "react-dom", version: "18.2.0", main: "index.js" }),
  );
  fs.writeFileSync(path.join(stub, "index.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(stub, "client.js"), "module.exports = {};\n");
  return dir;
}

function localEnv() {
  const cpus = os.cpus();
  return {
    shape: 1 as const,
    metrics: 4,
    cpu: cpus.length > 0 ? cpus[0].model : "unknown",
    cores: cpus.length,
    os: `${os.type()} ${os.release()}`,
    nodeVersion: process.version,
    chromiumVersion: "120.0.0.0",
    cpuThrottle: 4,
    samples: 10,
    calibrationTotalDuration: 10,
    calibrationScriptDuration: 5,
    mode: "combo" as const,
  };
}

function entryWithTimings(): BaselineEntry {
  return {
    mount: 4.2,
    rerender: 1.1,
    unmount: 0.6,
    domNodeCount: 12,
    interactions: {},
    tier: "T1",
    env: localEnv(),
    pass: true,
    phaseTimings: RECORDED,
    phaseUnits: { combos: 4, samples: 5 },
  };
}

afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("phase timings on a baseline entry", () => {
  it("survives a save and load round trip", () => {
    const dir = tempProject();
    const baselinePath = path.join(dir, "120fps-baseline.json");
    saveBaseline(baselinePath, entryWithTimings(), "./button.tsx");

    const loaded = loadBaseline(baselinePath);
    const entry = selectPhaseTimingEntry(loaded, "./button.tsx", localEnv());
    expect(entry?.phaseTimings).toEqual(RECORDED);
    expect(entry?.phaseUnits).toEqual({ combos: 4, samples: 5 });
  });

  it("treats an entry written before this field as no phase timings recorded", () => {
    const dir = tempProject();
    const baselinePath = path.join(dir, "120fps-baseline.json");
    const legacy = entryWithTimings();
    delete legacy.phaseTimings;
    delete legacy.phaseUnits;
    saveBaseline(baselinePath, legacy, "./button.tsx");

    const loaded = loadBaseline(baselinePath);
    expect(loaded?.entries).toBeTruthy();
    expect(selectPhaseTimingEntry(loaded, "./button.tsx", localEnv())).toBeUndefined();
  });

  it("refuses an entry recorded on another machine", () => {
    const loaded = loadBaseline(path.join(FIXTURE, "baseline-other-machine.json"));
    expect(loaded?.entries).toBeTruthy();
    expect(selectPhaseTimingEntry(loaded, "./button.tsx", localEnv())).toBeUndefined();
  });
});

describe("estimated cost of a real run", () => {
  it("scales the recorded phases by the combos and samples the run would measure", () => {
    const estimate = estimateRunCost({
      combos: 8,
      samples: 5,
      recorded: { timings: RECORDED, units: { combos: 4, samples: 5 } },
    });
    // fixed 87s + mount 58s/20 samples x 40 + per-combo 25s/4 x 8
    expect(estimate.source).toBe("baseline");
    expect(estimate.combos).toBe(8);
    expect(estimate.samples).toBe(5);
    expect(estimate.estimatedMs).toBe(87_000 + 116_000 + 200_000);
  });

  it("falls back to the documented defaults with no recorded phases", () => {
    const estimate = estimateRunCost({ combos: 4, samples: 5 });
    expect(estimate.source).toBe("defaults");
    expect(estimate.estimatedMs).toBe(
      DEFAULT_PHASE_ESTIMATE.fixedMs +
      DEFAULT_PHASE_ESTIMATE.perMountSampleMs * 20 +
      DEFAULT_PHASE_ESTIMATE.perComboMs * 4,
    );
  });
});

describe("the dry run's estimate line", () => {
  function explanation(costEstimate: PropsExplanation["costEstimate"]): PropsExplanation {
    return {
      componentPath: "./button.tsx",
      componentName: "Button",
      exports: ["Button"],
      props: [],
      matrixWouldActivate: false,
      scaleProbeWillRun: false,
      predictedMode: "combo",
      warnings: [],
      ...(costEstimate ? { costEstimate } : {}),
    };
  }

  it("names the baseline file the phase numbers came from", () => {
    const text = formatExplainProps(explanation({
      estimatedMs: 130_000,
      combos: 8,
      samples: 5,
      source: "baseline",
    }));
    expect(text).toContain(
      "Estimated real run: ~2m 10s (8 combos x 5 samples; phase timings from 120fps-baseline.json)",
    );
  });

  it("says the numbers are defaults when nothing was recorded", () => {
    const text = formatExplainProps(explanation({
      estimatedMs: 44_000,
      combos: 4,
      samples: 5,
      source: "defaults",
    }));
    expect(text).toContain(
      "Estimated real run: ~44s (4 combos x 5 samples; defaults: no phase timings recorded for " +
      "this component yet)",
    );
  });

  it("prints no estimate line when no estimate was produced", () => {
    expect(formatExplainProps(explanation(undefined))).not.toContain("Estimated real run:");
  });
});

describe("a dry run over a component with a recorded baseline", () => {
  it("prints an estimate from the recorded phases", async () => {
    const dir = tempProject();
    saveBaseline(path.join(dir, "120fps-baseline.json"), entryWithTimings(), "./button.tsx");

    const explained = await explainProps(path.join(dir, "button.tsx"), { noPreflight: true });
    expect(explained.costEstimate?.source).toBe("baseline");
    expect(formatExplainProps(explained)).toMatch(
      /Estimated real run: ~[^(]+\(\d+ combos x \d+ samples; phase timings from 120fps-baseline\.json\)/,
    );
  });

  it("prints an estimate from defaults with no baseline at all", async () => {
    const dir = tempProject();
    const explained = await explainProps(path.join(dir, "button.tsx"), { noPreflight: true });
    expect(explained.costEstimate?.source).toBe("defaults");
    expect(formatExplainProps(explained)).toContain("defaults: no phase timings recorded for this component yet");
  });

  it("counts the combos and samples the flags would cap the real run to", async () => {
    const dir = tempProject();
    const explained = await explainProps(path.join(dir, "button.tsx"), {
      noPreflight: true,
      samples: 5,
      maxCombos: 4,
    });
    expect(explained.costEstimate?.combos).toBe(4);
    expect(explained.costEstimate?.samples).toBe(5);
  });
});
