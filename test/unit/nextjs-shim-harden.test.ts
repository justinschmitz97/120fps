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

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "120fps-shim-h-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePkg(content: string) {
  fs.writeFileSync(path.join(tmpDir, "package.json"), content);
}

const baseMachine = {
  cpu: "Test", cores: 4, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};

function makeInput(overrides: Partial<BuildReportInput> = {}): BuildReportInput {
  return {
    componentPath: "./Button.tsx",
    componentName: "Button",
    machine: baseMachine,
    calibration: { totalDuration: 10, scriptDuration: 5 },
    mounts: [{
      comboIndex: 0, props: {},
      mount: { samples: [5], median: 5, p95: 5 },
      unmount: { samples: [1], median: 1, p95: 1 },
      domNodeCount: 8,
    }],
    explores: [],
    heapDeltas: [0],
    thresholds: DEFAULT_THRESHOLDS,
    ...overrides,
  };
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine: baseMachine,
    componentPath: "./X.tsx",
    componentName: "X",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [{
      comboIndex: 0, props: {},
      mount: { samples: [5], median: 5, p95: 5, cv: 0, unstable: false },
      unmount: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
      rerender: { samples: [3], median: 3, p95: 3, cv: 0, unstable: false },
      domNodeCount: 10, heapDelta: 0, interactions: [],
      scalingCurve: null, relativeMount: 0.5, verdict: "pass",
    }],
    thresholds: DEFAULT_THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

// H1: malformed package.json
describe("H1: malformed package.json", () => {
  it("detectNextJs returns false for invalid JSON", () => {
    writePkg("{ not valid json }}}");
    expect(detectNextJs(tmpDir)).toBe(false);
  });

  it("detectNextJs returns false for empty file", () => {
    writePkg("");
    expect(detectNextJs(tmpDir)).toBe(false);
  });
});

// H2: next in nested dependencies (not direct)
describe("H2: next only in transitive deps", () => {
  it("returns false when next is not a direct dep", () => {
    writePkg(JSON.stringify({
      dependencies: { sonner: "^2.0.0" },
    }));
    expect(detectNextJs(tmpDir)).toBe(false);
  });
});

// H3: alias regex doesn't match subpaths
describe("H3: alias regex boundary matching", () => {
  it("next/image alias does not match next/image/loader", () => {
    const aliases = buildShimAliases(true);
    const imageAlias = aliases.find((a) => a.replacement.includes("next-image"));
    expect(imageAlias!.find.test("next/image/loader")).toBe(false);
  });

  it("next/link alias does not match next/link/types", () => {
    const aliases = buildShimAliases(true);
    const linkAlias = aliases.find((a) => a.replacement.includes("next-link"));
    expect(linkAlias!.find.test("next/link/types")).toBe(false);
  });

  it("next-video/player alias does not match next-video/player/controls", () => {
    const aliases = buildShimAliases(true);
    const videoAlias = aliases.find((a) => a.replacement.includes("next-video-player"));
    expect(videoAlias!.find.test("next-video/player/controls")).toBe(false);
  });
});

// H4: --no-shims with --ci
describe("H4: --no-shims flag combinations", () => {
  it("--no-shims with --ci and --flat-thresholds", () => {
    const result = parseArgs(["./X.tsx", "--no-shims", "--ci", "--flat-thresholds"]);
    expect(result.noShims).toBe(true);
    expect(result.ci).toBe(true);
    expect(result.flatThresholds).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it("--no-shims at end of args", () => {
    const result = parseArgs(["./X.tsx", "--ci", "--no-shims"]);
    expect(result.noShims).toBe(true);
  });
});

// H5: buildReport with empty nextJsShims array
describe("H5: edge cases for nextJsShims in report", () => {
  it("empty array is not propagated to report", () => {
    const report = buildReport(makeInput({ nextJsShims: [] }));
    expect(report.nextJsShims).toBeUndefined();
  });

  it("single shim is propagated", () => {
    const report = buildReport(makeInput({ nextJsShims: ["next/link"] }));
    expect(report.nextJsShims).toEqual(["next/link"]);
  });

  it("multiple shims are propagated in order", () => {
    const shims = ["next/image", "next/dynamic", "next/navigation"];
    const report = buildReport(makeInput({ nextJsShims: shims }));
    expect(report.nextJsShims).toEqual(shims);
  });
});

// H6: formatTable with single shim
describe("H6: formatTable with single shim", () => {
  it("single shim shows correctly", () => {
    const r = makeReport({ nextJsShims: ["next/image"] });
    const output = formatTable(r);
    const shimLine = output.split("\n").find((l) => l.includes("Next.js shims"))!;
    expect(shimLine).toBe("Next.js shims: next/image");
  });

  it("shim line appears after chromium version", () => {
    const r = makeReport({ nextJsShims: ["next/image"] });
    const output = formatTable(r);
    const lines = output.split("\n");
    const chromiumLine = lines.findIndex((l) => l.includes("Chromium"));
    const shimLine = lines.findIndex((l) => l.includes("Next.js shims"));
    expect(shimLine).toBe(chromiumLine + 1);
  });
});

// H7: shim file contents are valid JS modules
describe("H7: shim files are parseable", () => {
  it("all compiled shim files contain export", () => {
    const shimDir = path.resolve(__dirname, "../../dist/shims");
    for (const entry of SHIM_MODULES) {
      const content = fs.readFileSync(path.join(shimDir, entry.shimFile), "utf-8");
      expect(content, `${entry.shimFile} should have exports`).toMatch(/export/);
    }
  });

  it("next-image shim exports default", () => {
    const shimDir = path.resolve(__dirname, "../../dist/shims");
    const content = fs.readFileSync(path.join(shimDir, "next-image.js"), "utf-8");
    expect(content).toContain("export default");
  });

  it("next-navigation shim exports named functions", () => {
    const shimDir = path.resolve(__dirname, "../../dist/shims");
    const content = fs.readFileSync(path.join(shimDir, "next-navigation.js"), "utf-8");
    expect(content).toContain("useRouter");
    expect(content).toContain("usePathname");
    expect(content).toContain("useSearchParams");
  });
});

// H8: detectNextJs is idempotent
describe("H8: detectNextJs idempotency", () => {
  it("same result on repeated calls", () => {
    writePkg(JSON.stringify({ dependencies: { next: "^16.0.0" } }));
    const a = detectNextJs(tmpDir);
    const b = detectNextJs(tmpDir);
    expect(a).toBe(b);
    expect(a).toBe(true);
  });
});

// H9: package.json with no dependencies key at all
describe("H9: minimal package.json", () => {
  it("returns false for package.json with only name", () => {
    writePkg(JSON.stringify({ name: "my-app" }));
    expect(detectNextJs(tmpDir)).toBe(false);
  });

  it("returns false for package.json with null dependencies", () => {
    writePkg(JSON.stringify({ dependencies: null }));
    expect(detectNextJs(tmpDir)).toBe(false);
  });
});

// H10: buildShimAliases replacement paths resolve to existing directory
describe("H10: shim alias paths resolve", () => {
  it("all replacement paths point to files in the shim directory", () => {
    const aliases = buildShimAliases(true);
    for (const alias of aliases) {
      expect(alias.replacement).toMatch(/shims[/\\]/);
      expect(alias.replacement).toMatch(/\.js$/);
    }
  });
});

// H11: nextJsShims survives JSON round-trip (report serialization)
describe("H11: report JSON round-trip", () => {
  it("nextJsShims preserved through JSON.parse(JSON.stringify())", () => {
    const report = buildReport(makeInput({ nextJsShims: ["next/image", "next/dynamic"] }));
    const roundTripped = JSON.parse(JSON.stringify(report));
    expect(roundTripped.nextJsShims).toEqual(["next/image", "next/dynamic"]);
  });

  it("report without shims has no nextJsShims key after round-trip", () => {
    const report = buildReport(makeInput());
    const roundTripped = JSON.parse(JSON.stringify(report));
    expect(roundTripped.nextJsShims).toBeUndefined();
  });
});
