import { describe, it, expect } from "vitest";
import { analyze } from "../../src/analyze.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("rerender e2e", () => {
  it("measures rerender for a regular component", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-rerender-${Date.now()}.json`);
    const report = await analyze("./fixtures/toggle-button.tsx", {
      samples: 3,
      jsonPath,
    });

    expect(report.combos.length).toBeGreaterThanOrEqual(1);
    for (const combo of report.combos) {
      expect(combo.rerender).toBeDefined();
      expect(combo.rerender.median).toBeGreaterThanOrEqual(0);
      expect(combo.rerender.samples.length).toBe(3);
    }

    fs.unlinkSync(jsonPath);
  }, 120_000);

  it("measures rerender for a fixture", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-rerender-${Date.now()}.json`);
    const report = await analyze("./fixtures/standalone.fixture.tsx", {
      samples: 3,
      jsonPath,
    });

    expect(report.combos).toHaveLength(1);
    expect(report.combos[0].rerender).toBeDefined();
    expect(report.combos[0].rerender.median).toBeGreaterThanOrEqual(0);

    fs.unlinkSync(jsonPath);
  }, 120_000);

  it("includes rerender in JSON output", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-rerender-${Date.now()}.json`);
    await analyze("./fixtures/toggle-button.tsx", {
      samples: 3,
      jsonPath,
    });

    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(parsed.combos[0].rerender).toBeDefined();
    expect(parsed.thresholds.rerenderMs).toBe(8);

    fs.unlinkSync(jsonPath);
  }, 120_000);

  it("includes rerenderChange for multi-combo components", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-rerender-${Date.now()}.json`);
    const report = await analyze("./fixtures/button.tsx", {
      samples: 3,
      jsonPath,
    });

    if (report.combos.length > 1) {
      const hasChange = report.combos.some((c) => c.rerenderChange !== undefined);
      expect(hasChange).toBe(true);
    }

    fs.unlinkSync(jsonPath);
  }, 300_000);

  it("respects --threshold-rerender", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-rerender-${Date.now()}.json`);
    const report = await analyze("./fixtures/toggle-button.tsx", {
      samples: 3,
      jsonPath,
      thresholds: { rerenderMs: 0.001 },
    });

    expect(report.combos.some((c) => c.verdict === "fail")).toBe(true);
    expect(report.pass).toBe(false);

    fs.unlinkSync(jsonPath);
  }, 120_000);
});

describe("scale fixture e2e", () => {
  it("produces combos at default scale points [1,5,20,50]", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-scale-${Date.now()}.json`);
    const report = await analyze("./fixtures/scale-accordion.fixture.tsx", {
      samples: 3,
      jsonPath,
    });

    expect(report.combos).toHaveLength(4);
    expect(report.combos[0].rerender).toBeDefined();
    expect(report.combos[3].rerender).toBeDefined();

    fs.unlinkSync(jsonPath);
  }, 180_000);

  it("respects --scale override", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-scale-${Date.now()}.json`);
    const report = await analyze("./fixtures/scale-accordion.fixture.tsx", {
      samples: 3,
      jsonPath,
      scalePoints: [1, 10, 100],
    });

    expect(report.combos).toHaveLength(3);

    fs.unlinkSync(jsonPath);
  }, 180_000);

  it("computes scaling curves for mount and rerender", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-scale-${Date.now()}.json`);
    const report = await analyze("./fixtures/scale-accordion.fixture.tsx", {
      samples: 3,
      jsonPath,
    });

    const hasMountCurve = report.combos.some((c) => c.scalingCurve !== null);
    expect(hasMountCurve).toBe(true);

    const hasRerenderCurve = report.combos.some((c) => c.rerenderScalingCurve !== null);
    expect(hasRerenderCurve).toBe(true);

    fs.unlinkSync(jsonPath);
  }, 180_000);

  it("fixture without scale export still produces 1 combo with rerender", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-scale-${Date.now()}.json`);
    const report = await analyze("./fixtures/standalone.fixture.tsx", {
      samples: 3,
      jsonPath,
    });

    expect(report.combos).toHaveLength(1);
    expect(report.combos[0].rerender).toBeDefined();

    fs.unlinkSync(jsonPath);
  }, 120_000);

  it("all existing tests pass — backward compat with no fixture", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-scale-${Date.now()}.json`);
    const report = await analyze("./fixtures/no-props.tsx", {
      samples: 3,
      jsonPath,
    });

    expect(report.version).toBe(1);
    expect(report.combos.length).toBeGreaterThanOrEqual(1);
    for (const combo of report.combos) {
      expect(combo.rerender).toBeDefined();
    }

    fs.unlinkSync(jsonPath);
  }, 120_000);
});
