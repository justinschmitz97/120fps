import { describe, it, expect } from "vitest";
import { analyze } from "../../src/analyze.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// H13: fixture that throws on render still produces a report (React catches render errors)
describe("H13: fixture render error", () => {
  it("pipeline completes with a valid report", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-h13-${Date.now()}.json`);
    const report = await analyze("./fixtures/broken.fixture.tsx", {
      samples: 2,
      jsonPath,
    });
    expect(report.combos).toHaveLength(1);
    expect(report.fixturePath).toBe("./fixtures/broken.fixture.tsx");
    fs.unlinkSync(jsonPath);
  }, 60_000);
});

// H14: --fixture with non-existent fixture file
describe("H14: non-existent fixture", () => {
  it("throws when fixture file does not exist", async () => {
    await expect(
      analyze("./fixtures/button.tsx", {
        samples: 2,
        fixturePath: "./fixtures/nonexistent.fixture.tsx",
      }),
    ).rejects.toThrow("not found");
  });
});

// H15: fixture mode produces exactly 1 combo with empty props
describe("H15: single combo in fixture mode", () => {
  it("produces exactly 1 combo with props={}", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-h15-${Date.now()}.json`);
    const report = await analyze("./fixtures/standalone.fixture.tsx", {
      samples: 2,
      jsonPath,
    });
    expect(report.combos).toHaveLength(1);
    expect(report.combos[0].comboIndex).toBe(0);
    expect(report.combos[0].props).toEqual({});
    fs.unlinkSync(jsonPath);
  }, 120_000);
});

// H16: componentName comes from component path, not fixture, when --fixture used
describe("H16: component name source", () => {
  it("uses component file for name when --fixture is used", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-h16-${Date.now()}.json`);
    const report = await analyze("./fixtures/accordion-root.tsx", {
      samples: 2,
      jsonPath,
      fixturePath: "./fixtures/accordion-root.fixture.tsx",
    });
    expect(report.componentName).toBe("Accordion");
    fs.unlinkSync(jsonPath);
  }, 120_000);
});

// H17: direct .fixture.tsx input uses fixture filename for component name
describe("H17: direct fixture input name", () => {
  it("derives component name from fixture filename", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-h17-${Date.now()}.json`);
    const report = await analyze("./fixtures/standalone.fixture.tsx", {
      samples: 2,
      jsonPath,
    });
    expect(report.componentName).toBe("StandaloneScene");
    fs.unlinkSync(jsonPath);
  }, 120_000);
});

// H18: backward compat - regular component without fixture
describe("H18: backward compatibility", () => {
  it("no fixture fields in report when no fixture used", async () => {
    const jsonPath = path.join(os.tmpdir(), `120fps-h18-${Date.now()}.json`);
    const report = await analyze("./fixtures/no-props.tsx", {
      samples: 2,
      jsonPath,
    });
    expect(report.fixturePath).toBeUndefined();
    expect(report.fixtureAutoDetected).toBeUndefined();
    fs.unlinkSync(jsonPath);
  }, 120_000);
});
