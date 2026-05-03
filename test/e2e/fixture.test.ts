import { describe, it, expect } from "vitest";
import { analyze } from "../../src/analyze.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("fixture e2e", () => {
  it("runs pipeline on a standalone .fixture.tsx input", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-fixture-${Date.now()}.json`);
    const report = await analyze("./fixtures/standalone.fixture.tsx", {
      samples: 3,
      jsonPath,
    });

    expect(report.version).toBe(1);
    expect(report.componentName).toBe("StandaloneScene");
    expect(report.combos).toHaveLength(1);
    expect(report.combos[0].props).toEqual({});
    expect(report.fixturePath).toBe("./fixtures/standalone.fixture.tsx");

    const hasInteractions = report.combos.some((c) => c.interactions.length > 0);
    expect(hasInteractions).toBe(true);

    fs.unlinkSync(jsonPath);
  }, 120_000);

  it("runs pipeline with --fixture flag (component + fixture)", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-fixture-${Date.now()}.json`);
    const report = await analyze("./fixtures/accordion-root.tsx", {
      samples: 3,
      jsonPath,
      fixturePath: "./fixtures/accordion-root.fixture.tsx",
    });

    expect(report.componentName).toBe("Accordion");
    expect(report.combos).toHaveLength(1);
    expect(report.combos[0].props).toEqual({});
    expect(report.fixturePath).toBe("./fixtures/accordion-root.fixture.tsx");
    expect(report.fixtureAutoDetected).toBe(false);

    const hasInteractions = report.combos.some((c) => c.interactions.length > 0);
    expect(hasInteractions).toBe(true);

    fs.unlinkSync(jsonPath);
  }, 120_000);

  it("auto-detects adjacent fixture", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-fixture-${Date.now()}.json`);
    const report = await analyze("./fixtures/accordion-root.tsx", {
      samples: 3,
      jsonPath,
    });

    expect(report.componentName).toBe("Accordion");
    expect(report.fixturePath).toBeTruthy();
    expect(report.fixtureAutoDetected).toBe(true);
    expect(report.combos).toHaveLength(1);
    expect(report.combos[0].props).toEqual({});

    fs.unlinkSync(jsonPath);
  }, 120_000);

  it("reports fixture path in JSON output", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-fixture-${Date.now()}.json`);
    await analyze("./fixtures/standalone.fixture.tsx", {
      samples: 3,
      jsonPath,
    });

    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(parsed.fixturePath).toBe("./fixtures/standalone.fixture.tsx");

    fs.unlinkSync(jsonPath);
  }, 120_000);

  it("runs normally when no fixture exists (backward compat)", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-fixture-${Date.now()}.json`);
    const report = await analyze("./fixtures/toggle-button.tsx", {
      samples: 3,
      jsonPath,
    });

    expect(report.fixturePath).toBeUndefined();
    expect(report.fixtureAutoDetected).toBeUndefined();
    expect(report.combos.length).toBeGreaterThanOrEqual(1);

    fs.unlinkSync(jsonPath);
  }, 120_000);
});
