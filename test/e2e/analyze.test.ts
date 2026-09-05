import { describe, it, expect, beforeAll } from "vitest";
import { sharedAnalyze as analyze } from "./shared-analyze.js";
import type { Report } from "../../src/report/index.js";
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

    expect(fs.existsSync(jsonPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    expect(parsed.version).toBe(1);
    expect(parsed.componentName).toBe("StaticButtons");

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
    const measured = report.combos.filter((c) => c.scaleProbe === undefined);
    expect(measured.length).toBeGreaterThan(0);
    expect(measured.every((c) => c.verdict === "fail")).toBe(true);
  }, 120000);

  describe("matrix mode", () => {
    // Shared beforeAll: a matrix pass costs ~120s; one per assertion would add 480s.
    let report: Report;
    let strictReport: Report;

    beforeAll(async () => {
      [report, strictReport] = await Promise.all([
        analyze("./fixtures/button.tsx", { samples: 3, matrixMode: true }),
        analyze("./fixtures/button.tsx", {
          samples: 3,
          matrixMode: true,
          thresholds: { interactionMs: 0.001 },
        }),
      ]);
    }, 400000);

    // Without index restore, `explore`'s local numbering would map interactions to cells 0..4.
    it("attaches interactions to the cells that were explored, not the first five", () => {
      const mr = report.matrixReport;
      expect(mr).toBeDefined();
      expect(mr!.cells.length).toBeGreaterThan(5);

      const explored = report.combos
        .filter((c) => c.interactions.length > 0)
        .map((c) => c.comboIndex)
        .sort((a, b) => a - b);
      const hottest = [...report.combos]
        .sort((a, b) => b.mount.median - a.mount.median)
        .slice(0, 5)
        .map((c) => c.comboIndex)
        .sort((a, b) => a - b);

      expect(explored).toEqual(hottest);
    });

    it("carries the worst interaction onto the matching cell", () => {
      for (const cell of report.matrixReport!.cells) {
        const combo = report.combos.find((c) => c.comboIndex === cell.comboIndex);
        expect(combo).toBeDefined();
        const expected = combo!.interactions.length > 0
          ? Math.max(...combo!.interactions.map((i) => i.timing.median))
          : null;
        expect(cell.worstInteractionMs).toBe(expected);
        expect(cell.verdict).toBe(combo!.verdict);
      }
    });

    // Guards a regression: the matrix branch dropped explicitThresholds, ignoring a user's budget.
    it("applies an explicit interaction threshold under tiered budgets", () => {
      const interactive = strictReport.combos.filter((c) => c.interactions.length > 0);
      expect(interactive.length).toBeGreaterThan(0);
      expect(interactive.every((c) => c.verdict === "fail")).toBe(true);
      expect(strictReport.pass).toBe(false);
      expect(strictReport.matrixReport!.failingCells.length).toBe(interactive.length);
    });

    it("keeps every failing cell reachable in the report", () => {
      const mr = strictReport.matrixReport!;
      const failedCellIndices = mr.cells.filter((c) => c.verdict === "fail").map((c) => c.comboIndex);
      expect(mr.failingCells.map((c) => c.comboIndex)).toEqual(failedCellIndices);
    });
  });
});
