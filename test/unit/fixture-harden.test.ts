import { describe, it, expect } from "vitest";
import { parseArgs } from "../../src/cli.js";
import { isFixturePath, detectFixture } from "../../src/analyze.js";
import { formatTable, type Report } from "../../src/report.js";
import path from "node:path";

// H1: .fixture.ts (not .tsx) extension detected
describe("H1: .fixture.ts extension", () => {
  it("isFixturePath recognizes .fixture.ts", () => {
    expect(isFixturePath("comp.fixture.ts")).toBe(true);
  });

  it("isFixturePath recognizes .fixture.jsx", () => {
    expect(isFixturePath("comp.fixture.jsx")).toBe(true);
  });
});

// H2: --fixture flag with spaces in path
describe("H2: spaces in fixture path", () => {
  it("parses fixture path with spaces", () => {
    const result = parseArgs(["./comp.tsx", "--fixture", "./spaced dir/comp.fixture.tsx"]);
    expect(result.fixturePath).toBe("./spaced dir/comp.fixture.tsx");
    expect(result.error).toBeUndefined();
  });
});

// H3: --fixture before component path
describe("H3: --fixture position", () => {
  it("handles --fixture before component path", () => {
    const result = parseArgs(["--fixture", "./comp.fixture.tsx", "./comp.tsx"]);
    expect(result.fixturePath).toBe("./comp.fixture.tsx");
    expect(result.componentPath).toBe("./comp.tsx");
  });
});

// H4: component path IS a .fixture.tsx (direct fixture input)
describe("H4: direct fixture input", () => {
  it("detects .fixture.tsx as direct fixture input", () => {
    expect(isFixturePath("./my-comp.fixture.tsx")).toBe(true);
  });

  it("does not detect .fixture in directory name", () => {
    expect(isFixturePath("./fixture-dir/comp.tsx")).toBe(false);
  });
});

// H5: detectFixture with no adjacent file
describe("H5: no adjacent fixture", () => {
  it("returns undefined for button.tsx (no button.fixture.tsx)", () => {
    const result = detectFixture(path.resolve("fixtures/button.tsx"));
    expect(result).toBeUndefined();
  });
});

// H6: isFixturePath with edge-case filenames
describe("H6: edge-case filenames", () => {
  it("rejects .fixture without extension", () => {
    expect(isFixturePath("comp.fixture")).toBe(false);
  });

  it("rejects file ending in fixture.tsx without dot separator", () => {
    expect(isFixturePath("compfixture.tsx")).toBe(false);
  });

  it("rejects .fixture.json", () => {
    expect(isFixturePath("comp.fixture.json")).toBe(false);
  });
});

// H7: --fixture combined with --json
describe("H7: --fixture with --json", () => {
  it("parses both flags correctly", () => {
    const result = parseArgs([
      "./comp.tsx", "--fixture", "./fix.fixture.tsx", "--json", "out.json",
    ]);
    expect(result.fixturePath).toBe("./fix.fixture.tsx");
    expect(result.jsonPath).toBe("out.json");
  });
});

// H8: formatTable hint for 0 interactions, no fixture
describe("H8: 0 interactions hint", () => {
  const baseReport: Report = {
    version: 1,
    timestamp: new Date().toISOString(),
    machine: { cpu: "T", cores: 1, ramMb: 1024, os: "T", nodeVersion: "v20", chromiumVersion: "120" },
    componentPath: "./accordion.tsx",
    componentName: "Accordion",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [{
      comboIndex: 0, props: {},
      mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
      unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
      rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
      domNodeCount: 3, heapDelta: 0, interactions: [],
      scalingCurve: null, relativeMount: 0.5, verdict: "pass",
    }],
    thresholds: { mountMs: 16, interactionMs: 100, relativeMount: 2.0, rerenderMs: 8 },
    pass: true,
  };

  it("shows hint when 0 interactions and no fixture", () => {
    const output = formatTable(baseReport);
    expect(output).toContain("0 interactions found");
    expect(output).toContain("accordion.fixture.tsx");
  });

  it("does not show hint when fixture is used", () => {
    const withFixture = { ...baseReport, fixturePath: "./accordion.fixture.tsx" };
    const output = formatTable(withFixture);
    expect(output).not.toContain("0 interactions found");
  });

  it("does not show hint when interactions exist", () => {
    const withInteractions: Report = {
      ...baseReport,
      combos: [{
        ...baseReport.combos[0],
        interactions: [{
          selector: "button", type: "click", label: "OK",
          timing: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
          relativeTiming: 0.5,
        }],
      }],
    };
    const output = formatTable(withInteractions);
    expect(output).not.toContain("0 interactions found");
  });
});

// H9: --fixture without component path (just --fixture alone)
describe("H9: fixture-only invocation", () => {
  it("errors when only --fixture is provided (no component path)", () => {
    const result = parseArgs(["--fixture", "./comp.fixture.tsx"]);
    expect(result.error).toBeTruthy();
  });
});

// H10: duplicate --fixture flags
describe("H10: duplicate --fixture", () => {
  it("last --fixture wins", () => {
    const result = parseArgs([
      "./comp.tsx",
      "--fixture", "./a.fixture.tsx",
      "--fixture", "./b.fixture.tsx",
    ]);
    expect(result.fixturePath).toBe("./b.fixture.tsx");
  });
});

// H11: isFixturePath with Windows backslashes
describe("H11: Windows paths", () => {
  it("detects fixture with backslash path", () => {
    expect(isFixturePath("src\\comp.fixture.tsx")).toBe(true);
  });
});

// H12: detectFixture returns absolute path
describe("H12: detectFixture returns absolute path", () => {
  it("returns absolute path for adjacent fixture", () => {
    const result = detectFixture(path.resolve("fixtures/accordion-root.tsx"));
    expect(result).toBeTruthy();
    expect(path.isAbsolute(result!)).toBe(true);
  });
});
