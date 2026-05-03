import { describe, it, expect } from "vitest";
import { analyze } from "../../src/analyze.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// H1: scale function that throws at N>100
describe("H1: scale function that throws for large N", () => {
  it("completes pipeline at small scale points without error", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-harden-${Date.now()}.json`);
    const report = await analyze("./fixtures/scale-throws.fixture.tsx", {
      samples: 3,
      jsonPath,
      scalePoints: [1, 5, 10],
    });

    expect(report.combos).toHaveLength(3);
    for (const combo of report.combos) {
      expect(combo.rerender).toBeDefined();
    }

    fs.unlinkSync(jsonPath);
  }, 180_000);
});

// H2: scale(0) — zero items
describe("H2: scale with zero in scale points", () => {
  it("handles scale(0) gracefully (empty render)", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-harden-${Date.now()}.json`);
    // scale(0) produces <div data-accordion></div> with no items — valid JSX
    const report = await analyze("./fixtures/scale-accordion.fixture.tsx", {
      samples: 3,
      jsonPath,
      scalePoints: [0, 1, 5],
    });

    expect(report.combos).toHaveLength(3);
    expect(report.combos[0].domNodeCount).toBeLessThanOrEqual(report.combos[2].domNodeCount);

    fs.unlinkSync(jsonPath);
  }, 180_000);
});

// H8: rerender of component that renders null
describe("H8: rerender of renders-null component", () => {
  it("produces valid report with rerender timing", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-harden-${Date.now()}.json`);
    const report = await analyze("./fixtures/renders-null.tsx", {
      samples: 3,
      jsonPath,
    });

    expect(report.combos.length).toBeGreaterThanOrEqual(1);
    expect(report.combos[0].rerender).toBeDefined();
    expect(report.combos[0].rerender.median).toBeGreaterThanOrEqual(0);

    fs.unlinkSync(jsonPath);
  }, 120_000);
});

// H9: identity rerender (same single combo fixture)
describe("H9: identity rerender in fixture mode", () => {
  it("stable rerender with empty props produces valid timing", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-harden-${Date.now()}.json`);
    const report = await analyze("./fixtures/standalone.fixture.tsx", {
      samples: 3,
      jsonPath,
    });

    expect(report.combos).toHaveLength(1);
    expect(report.combos[0].rerender.samples).toHaveLength(3);
    expect(report.combos[0].rerenderChange).toBeUndefined();

    fs.unlinkSync(jsonPath);
  }, 120_000);
});
