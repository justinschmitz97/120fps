import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { analyze, type AnalyzeOptions } from "../../src/analyze.js";
import type { Baseline } from "../../src/budget.js";
import type { Report } from "../../src/report.js";
import { DEGENERATE_COMBO_WARNING, MEMORY_SKIPPED_WARNING } from "../../src/isolation.js";

const OUT_DIR = path.resolve(`.m28-isolation-${process.pid}`);

// A package.json makes this directory its own project root, so --save-baseline
// lands here instead of at the repo root.
const PROJECT_DIR = path.resolve(`.m28-isolation-project-${process.pid}`);
const PROJECT_COMPONENT = path.join(PROJECT_DIR, "static-panel.tsx");
const PROJECT_BASELINE = path.join(PROJECT_DIR, "120fps-baseline.json");
const PROJECT_ENTRY_KEY = "./static-panel.tsx";

const FAST: AnalyzeOptions = {
  samples: 2,
  warmupRuns: 1,
  skipDeltas: true,
  skipAutoScale: true,
  skipAttribution: true,
  skipAutoCompose: true,
  skipReactAnalysis: true,
};

let reportSeq = 0;

function run(component: string, options: AnalyzeOptions): Promise<Report> {
  reportSeq += 1;
  return analyze(component, {
    ...FAST,
    ...options,
    jsonPath: path.join(OUT_DIR, `report-${reportSeq}.json`),
  });
}

beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(PROJECT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(PROJECT_DIR, "package.json"),
    JSON.stringify({ name: "m28-isolation-fixture", version: "0.0.0", private: true }),
    "utf-8",
  );
  fs.writeFileSync(
    PROJECT_COMPONENT,
    `import React from "react";

export function StaticPanel() {
  return (
    <div className="panel">
      <h2>Panel</h2>
      <p>Static content, no interactive elements.</p>
    </div>
  );
}
`,
    "utf-8",
  );
});

afterAll(() => {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.rmSync(PROJECT_DIR, { recursive: true, force: true });
});

describe("--isolate mount", () => {
  it("populates only the mount phase and runs no combo pipeline", async () => {
    const report = await run("./fixtures/button.tsx", {
      isolation: { phases: ["mount"] },
    });

    expect(report.isolation).toBeDefined();
    expect(report.isolation!.mount!.median).toBeGreaterThan(0);
    expect(report.isolation!.mount!.samples).toHaveLength(2);
    expect(report.isolation!.unmount).toBeUndefined();
    expect(report.isolation!.rerender).toBeUndefined();
    expect(report.isolation!.memory).toBeUndefined();
    expect(report.isolation!.strictMode).toBeUndefined();

    expect(report.combos).toEqual([]);
    expect(report.propDeltas).toBeUndefined();
    expect(report.scalingCurveReport).toBeUndefined();
    expect(report.matrixReport).toBeUndefined();
    expect(report.calibration.totalDuration).toBeGreaterThan(0);
  }, 300000);

  it("serves mount and unmount from the same pass", async () => {
    const report = await run("./fixtures/button.tsx", {
      isolation: { phases: ["mount", "unmount"] },
    });
    expect(report.isolation!.mount!.median).toBeGreaterThan(0);
    expect(report.isolation!.unmount!.samples).toHaveLength(2);
  }, 300000);
});

describe("--isolate all", () => {
  it("populates every phase", async () => {
    const report = await run("./fixtures/button.tsx", {
      isolation: {
        phases: ["mount", "rerender", "unmount", "memory", "strictmode"],
        memoryCycles: 4,
      },
    });

    const iso = report.isolation!;
    expect(iso.mount!.median).toBeGreaterThan(0);
    expect(iso.unmount).toBeDefined();
    expect(iso.rerender!.churn.samples).toHaveLength(20);
    expect(iso.strictMode!.normalMount.median).toBeGreaterThan(0);

    // A build without HeapProfiler skips the phase, but says so.
    if (iso.memory) {
      expect(iso.memory.cycles).toBe(4);
    } else {
      expect(report.warnings ?? []).toContain(MEMORY_SKIPPED_WARNING);
    }
  }, 600000);
});

describe("memory phase", () => {
  it("flags a component that retains every mount", async () => {
    const report = await run("./fixtures/leaky-mount.tsx", {
      isolation: { phases: ["memory"], memoryCycles: 8 },
    });

    expect(report.warnings ?? []).not.toContain(MEMORY_SKIPPED_WARNING);
    const memory = report.isolation!.memory!;
    expect(memory.cycles).toBe(8);
    expect(memory.heapGrowthPerCycle).toBeGreaterThan(1024);
    expect(memory.leakSuspected).toBe(true);
    expect(report.pass).toBe(false);
  }, 300000);

  it("does not flag a component that releases what it mounts", async () => {
    const report = await run("./fixtures/churn-stable.tsx", {
      isolation: { phases: ["memory"], memoryCycles: 8 },
    });
    expect(report.isolation!.memory!.leakSuspected).toBe(false);
    expect(report.pass).toBe(true);
  }, 300000);
});

describe("churn", () => {
  it("detects a rerender path that degrades under alternating props", async () => {
    const report = await run("./fixtures/churn-grow.tsx", {
      isolation: { phases: ["rerender"] },
    });

    const rerender = report.isolation!.rerender!;
    expect(rerender.churn.samples).toHaveLength(20);
    expect(rerender.churnDegradation).toBeGreaterThan(2.0);
    expect(report.pass).toBe(false);
  }, 300000);

  it("stays inside the churn limit for a constant-cost component", async () => {
    const report = await run("./fixtures/churn-stable.tsx", {
      isolation: { phases: ["rerender"] },
    });

    const rerender = report.isolation!.rerender!;
    expect(rerender.stable.median).toBeGreaterThan(0);
    expect(rerender.propChange.median).toBeGreaterThan(0);
    expect(rerender.churnDegradation).toBeLessThan(2.0);
    expect(report.pass).toBe(true);
  }, 300000);
});

describe("strictmode", () => {
  it("measures a higher strict mount and calls a clean component clean", async () => {
    const report = await run("./fixtures/strict-clean.tsx", {
      isolation: { phases: ["strictmode"] },
    });

    const strict = report.isolation!.strictMode!;
    expect(strict.normalMount.samples).toHaveLength(2);
    expect(strict.strictMount.samples).toHaveLength(2);
    expect(strict.strictMount.median).toBeGreaterThan(strict.normalMount.median);
    expect(strict.overhead).toBeGreaterThan(0);
    expect(strict.doubleInvokeClean).toBe(true);
  }, 300000);

  it("flags an effect that accumulates across invocations", async () => {
    const report = await run("./fixtures/strict-accumulate.tsx", {
      isolation: { phases: ["strictmode"] },
    });

    const strict = report.isolation!.strictMode!;
    expect(strict.overhead).toBeGreaterThan(110);
    expect(strict.doubleInvokeClean).toBe(false);
    // A dirty double invoke warns; it never fails the run.
    expect(report.pass).toBe(true);
  }, 300000);
});

describe("degenerate combo selection", () => {
  it("warns when only one prop combination exists", async () => {
    const report = await run("./fixtures/standalone.fixture.tsx", {
      isolation: { phases: ["rerender"] },
    });

    expect(report.warnings ?? []).toContain(DEGENERATE_COMBO_WARNING);
    const rerender = report.isolation!.rerender!;
    expect(rerender.propChange.samples).toEqual(rerender.stable.samples);
    expect(report.fixturePath).toBeDefined();
  }, 300000);
});

// ====================================================================
// Hardening
// ====================================================================

describe("H19: gcPressure discriminates", () => {
  it("counts unreclaimed checks for a leak and none for a clean component", async () => {
    const leaking = await run("./fixtures/leaky-mount.tsx", {
      isolation: { phases: ["memory"], memoryCycles: 20 },
    });
    const clean = await run("./fixtures/churn-stable.tsx", {
      isolation: { phases: ["memory"], memoryCycles: 20 },
    });

    // Four checks at cycles 5, 10, 15, 20.
    expect(leaking.isolation!.memory!.gcPressure).toBe(4);
    expect(clean.isolation!.memory!.gcPressure).toBe(0);
  }, 600000);
});

describe("H20: explicit thresholds and --flat-thresholds", () => {
  it("fails an explicit mount threshold no component can meet", async () => {
    const report = await run("./fixtures/heavy-mount.tsx", {
      isolation: { phases: ["mount"] },
      thresholds: { mountMs: 0.0001 },
    });
    expect(report.isolation!.mount!.median).toBeGreaterThan(0.0001);
    expect(report.pass).toBe(false);
  }, 300000);

  it("passes under a flat threshold no component can exceed", async () => {
    const report = await run("./fixtures/heavy-mount.tsx", {
      isolation: { phases: ["mount"] },
      flatThresholds: true,
      thresholds: { mountMs: 100000 },
    });
    expect(report.pass).toBe(true);
  }, 300000);
});

describe("H21: churn against a component that throws on the second prop set", () => {
  // React surfaces the render failure asynchronously, so the run completes with
  // the full sample count rather than aborting. It must not hang, and the
  // failing renders must not read as a degrading rerender path.
  it("completes without hanging and produces a full churn series", async () => {
    const report = await run("./fixtures/churn-throws.tsx", {
      isolation: { phases: ["rerender"] },
    });
    expect(report.isolation!.rerender!.churn.samples).toHaveLength(20);
    expect(Number.isFinite(report.isolation!.rerender!.churnDegradation)).toBe(true);
  }, 300000);
});

describe("H22: --no-isolate leaves the standard pipeline in place", () => {
  it("produces combos and no isolation report", async () => {
    const report = await run("./fixtures/churn-stable.tsx", { isolation: undefined });
    expect(report.isolation).toBeUndefined();
    expect(report.combos.length).toBeGreaterThan(0);
  }, 300000);
});

describe("H23: the written JSON carries the isolation report", () => {
  it("round-trips through the report file", async () => {
    const jsonPath = path.join(OUT_DIR, "isolation-json.json");
    await analyze("./fixtures/button.tsx", {
      ...FAST,
      isolation: { phases: ["mount", "unmount"] },
      jsonPath,
    });
    const written = JSON.parse(fs.readFileSync(jsonPath, "utf-8")) as Report;
    expect(written.isolation!.mount!.median).toBeGreaterThan(0);
    expect(written.isolation!.unmount).toBeDefined();
    expect(written.combos).toEqual([]);
  }, 300000);
});

describe("isolation baselines", () => {
  it("saves and re-checks an isolation baseline without regressions", async () => {
    const saved = await analyze(PROJECT_COMPONENT, {
      ...FAST,
      isolation: { phases: ["mount", "unmount"] },
      saveBaseline: true,
      jsonPath: path.join(OUT_DIR, "baseline-save.json"),
    });
    expect(saved.isolation!.mount!.median).toBeGreaterThan(0);

    const baseline = JSON.parse(fs.readFileSync(PROJECT_BASELINE, "utf-8")) as Baseline;
    const entry = baseline.entries[PROJECT_ENTRY_KEY];
    expect(entry).toBeDefined();
    expect(entry.env!.mode).toBe("isolation");
    expect(entry.mount).toBeGreaterThan(0);
    expect(entry.unmount).toBeGreaterThan(0);
    // The rerender phase did not run, so its metric is inert on comparison.
    expect(entry.rerender).toBe(0);
    expect(entry.interactions).toEqual({});

    const checked = await analyze(PROJECT_COMPONENT, {
      ...FAST,
      isolation: { phases: ["mount", "unmount"] },
      check: true,
      jsonPath: path.join(OUT_DIR, "baseline-check.json"),
    });
    expect(checked.baseline?.hasBaseline).toBe(true);
    expect(["identical", "normalizable"]).toContain(checked.baseline?.envMatch);
    expect(checked.baseline?.regressions.map((r) => r.metric)).not.toContain("rerender");
  }, 600000);

  it("classifies a combo baseline checked from isolation mode as incompatible", async () => {
    await analyze(PROJECT_COMPONENT, {
      ...FAST,
      saveBaseline: true,
      jsonPath: path.join(OUT_DIR, "combo-save.json"),
    });

    const checked = await analyze(PROJECT_COMPONENT, {
      ...FAST,
      isolation: { phases: ["mount"] },
      check: true,
      jsonPath: path.join(OUT_DIR, "combo-check.json"),
    });

    expect(checked.baseline?.envMatch).toBe("incompatible");
    expect(checked.baseline?.regressions).toEqual([]);
    expect(checked.baseline?.envMismatches.join(" ")).toContain("mode");
    expect(checked.pass).toBe(true);
  }, 600000);
});
