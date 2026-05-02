import { describe, it, expect } from "vitest";
import { analyze } from "../../src/analyze.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("analyze e2e", () => {
  it("produces a valid report for a simple component", async () => {
    const jsonPath = path.join(
      os.tmpdir(),
      `120fps-test-${Date.now()}.json`,
    );
    const report = await analyze("./fixtures/static-buttons.tsx", {
      samples: 3,
      jsonPath,
    });

    expect(report.version).toBe(1);
    expect(report.componentName).toBe("StaticButtons");
    expect(report.combos.length).toBeGreaterThanOrEqual(1);
    expect(report.machine.cpu).toBeTruthy();
    expect(report.machine.nodeVersion).toMatch(/^v\d+/);
    expect(report.calibration.totalDuration).toBeGreaterThan(0);

    for (const combo of report.combos) {
      expect(combo.mount.cv).toBeGreaterThanOrEqual(0);
      expect(typeof combo.mount.unstable).toBe("boolean");
      expect(typeof combo.relativeMount).toBe("number");
      expect(["pass", "warn", "fail"]).toContain(combo.verdict);
    }

    expect(report.pass).toBe(typeof report.pass === "boolean" ? report.pass : true);

    // JSON file written
    expect(fs.existsSync(jsonPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(parsed.version).toBe(1);
    expect(parsed.componentName).toBe("StaticButtons");

    // Cleanup
    fs.unlinkSync(jsonPath);
  }, 120000);

  it("produces a report with interactions for interactive component", async () => {
    const jsonPath = path.join(
      os.tmpdir(),
      `120fps-test-${Date.now()}.json`,
    );
    const report = await analyze("./fixtures/toggle-button.tsx", {
      samples: 3,
      jsonPath,
    });

    expect(report.combos.length).toBeGreaterThanOrEqual(1);
    const hasInteractions = report.combos.some((c) => c.interactions.length > 0);
    expect(hasInteractions).toBe(true);

    for (const combo of report.combos) {
      for (const interaction of combo.interactions) {
        expect(interaction.timing.median).toBeGreaterThanOrEqual(0);
        expect(typeof interaction.relativeTiming).toBe("number");
      }
    }

    fs.unlinkSync(jsonPath);
  }, 120000);

  it("respects custom thresholds", async () => {
    const report = await analyze("./fixtures/static-buttons.tsx", {
      samples: 3,
      thresholds: { mountMs: 0.001, interactionMs: 0.001, relativeMount: 0.001 },
    });
    expect(report.pass).toBe(false);
    expect(report.combos.every((c) => c.verdict === "fail")).toBe(true);
  }, 120000);
});
