import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  detectNextJs,
  SHIM_MODULES,
  buildShimAliases,
} from "../../src/harness.js";
import { parseArgs } from "../../src/cli.js";
import { buildReport, type BuildReportInput } from "../../src/analyze.js";
import {
  formatTable,
  DEFAULT_THRESHOLDS,
  type ComboReport,
  type Report,
} from "../../src/report.js";

// --- helpers ---

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-shim-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePkg(deps: Record<string, string> = {}, devDeps: Record<string, string> = {}) {
  fs.writeFileSync(
    path.join(tmpDir, "package.json"),
    JSON.stringify({ dependencies: deps, devDependencies: devDeps }),
  );
}

function makeCombo(overrides: Partial<ComboReport> = {}): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
    unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
    rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
    domNodeCount: 10,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 0.5,
    verdict: "pass",
    ...overrides,
  };
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: {
      cpu: "Test CPU",
      cores: 4,
      ramMb: 16384,
      os: "Linux 6.0",
      nodeVersion: "v20.0.0",
      chromiumVersion: "120.0.0.0",
    },
    componentPath: "./Carousel.tsx",
    componentName: "Carousel",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [makeCombo()],
    thresholds: DEFAULT_THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

const baseMachine = {
  cpu: "Test",
  cores: 4,
  ramMb: 16384,
  os: "Linux 6.0",
  nodeVersion: "v20.0.0",
  chromiumVersion: "120.0.0.0",
};

// --- detectNextJs ---

describe("detectNextJs", () => {
  it("returns true when next is in dependencies", () => {
    writePkg({ next: "^14.0.0", react: "^19.0.0" });
    expect(detectNextJs(tmpDir)).toBe(true);
  });

  it("returns true when next is in devDependencies", () => {
    writePkg({}, { next: "^14.0.0" });
    expect(detectNextJs(tmpDir)).toBe(true);
  });

  it("returns false when next is not present", () => {
    writePkg({ react: "^19.0.0" });
    expect(detectNextJs(tmpDir)).toBe(false);
  });

  it("returns false when no package.json exists", () => {
    expect(detectNextJs(tmpDir)).toBe(false);
  });

  it("returns false for empty dependencies", () => {
    writePkg();
    expect(detectNextJs(tmpDir)).toBe(false);
  });
});

// --- SHIM_MODULES ---

describe("SHIM_MODULES", () => {
  it("covers all six specified modules", () => {
    const names = SHIM_MODULES.map((s) => s.module);
    expect(names).toContain("next/image");
    expect(names).toContain("next/dynamic");
    expect(names).toContain("next/link");
    expect(names).toContain("next/navigation");
    expect(names).toContain("next/headers");
    expect(names).toContain("next-video/player");
    expect(names).toHaveLength(6);
  });

  it("each entry has a module and a shimFile", () => {
    for (const entry of SHIM_MODULES) {
      expect(typeof entry.module).toBe("string");
      expect(typeof entry.shimFile).toBe("string");
      expect(entry.shimFile).toMatch(/\.js$/);
    }
  });
});

// --- buildShimAliases ---

describe("buildShimAliases", () => {
  it("returns aliases for all modules when hasNextJs is true", () => {
    const aliases = buildShimAliases(true);
    expect(aliases).toHaveLength(6);
    for (const alias of aliases) {
      expect(alias.find).toBeInstanceOf(RegExp);
      expect(typeof alias.replacement).toBe("string");
    }
  });

  it("returns empty array when hasNextJs is false", () => {
    expect(buildShimAliases(false)).toEqual([]);
  });

  it("alias regex matches exact module specifier", () => {
    const aliases = buildShimAliases(true);
    const imageAlias = aliases.find((a) => a.replacement.includes("next-image"));
    expect(imageAlias).toBeDefined();
    expect(imageAlias!.find.test("next/image")).toBe(true);
    expect(imageAlias!.find.test("next/image/foo")).toBe(false);
    expect(imageAlias!.find.test("@next/image")).toBe(false);
  });

  it("shim files point to dist/shims/ directory", () => {
    const aliases = buildShimAliases(true);
    for (const alias of aliases) {
      expect(alias.replacement).toContain("shims");
    }
  });
});

// --- parseArgs --no-shims ---

describe("parseArgs --no-shims", () => {
  it("parses --no-shims flag", () => {
    const result = parseArgs(["./Carousel.tsx", "--no-shims"]);
    expect(result.noShims).toBe(true);
  });

  it("defaults noShims to undefined when not specified", () => {
    const result = parseArgs(["./Carousel.tsx"]);
    expect(result.noShims).toBeUndefined();
  });

  it("--no-shims coexists with other flags", () => {
    const result = parseArgs(["./Carousel.tsx", "--no-shims", "--ci"]);
    expect(result.noShims).toBe(true);
    expect(result.ci).toBe(true);
  });
});

// --- Report.nextJsShims ---

describe("Report.nextJsShims", () => {
  it("buildReport passes through nextJsShims from input", () => {
    const input: BuildReportInput = {
      componentPath: "./Carousel.tsx",
      componentName: "Carousel",
      machine: baseMachine,
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [{
        comboIndex: 0,
        props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
      }],
      explores: [],
      heapDeltas: [0],
      thresholds: DEFAULT_THRESHOLDS,
      nextJsShims: ["next/image"],
    };
    const report = buildReport(input);
    expect(report.nextJsShims).toEqual(["next/image"]);
  });

  it("omits nextJsShims when not provided", () => {
    const input: BuildReportInput = {
      componentPath: "./Button.tsx",
      componentName: "Button",
      machine: baseMachine,
      calibration: { totalDuration: 10, scriptDuration: 5 },
      mounts: [{
        comboIndex: 0,
        props: {},
        mount: { samples: [5], median: 5, p95: 5 },
        unmount: { samples: [1], median: 1, p95: 1 },
        domNodeCount: 8,
      }],
      explores: [],
      heapDeltas: [0],
      thresholds: DEFAULT_THRESHOLDS,
    };
    const report = buildReport(input);
    expect(report.nextJsShims).toBeUndefined();
  });
});

// --- formatTable with nextJsShims ---

describe("formatTable with nextJsShims", () => {
  it("shows shim line when nextJsShims is present", () => {
    const r = makeReport({ nextJsShims: ["next/image", "next/dynamic"] });
    const output = formatTable(r);
    expect(output).toContain("Next.js shims: next/image, next/dynamic");
  });

  it("does not show shim line when nextJsShims is absent", () => {
    const r = makeReport();
    const output = formatTable(r);
    expect(output).not.toContain("Next.js shims");
  });

  it("does not show shim line for empty array", () => {
    const r = makeReport({ nextJsShims: [] });
    const output = formatTable(r);
    expect(output).not.toContain("Next.js shims");
  });
});

// --- Shim file existence ---

describe("shim files exist on disk", () => {
  it("all shim .js files exist in dist/shims/", () => {
    const shimDir = path.resolve(__dirname, "../../dist/shims");
    for (const entry of SHIM_MODULES) {
      const shimPath = path.join(shimDir, entry.shimFile);
      expect(fs.existsSync(shimPath), `Missing shim: ${entry.shimFile}`).toBe(true);
    }
  });
});
