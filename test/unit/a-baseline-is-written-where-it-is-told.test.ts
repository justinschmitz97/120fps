import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { KNOWN_FLAGS, parseArgs } from "../../src/cli/index.js";
import { helpText } from "../../src/cli/help.js";
import {
  BASELINE_FILE_NAME,
  DEFAULT_THRESHOLDS,
  buildEnvFingerprint,
  loadBaseline,
  parseBaselineKey,
  resolveBaselinePath,
  saveBaseline,
  type BaselineEntry,
  type ComboReport,
  type EnvFingerprint,
  type Report,
} from "../../src/report/index.js";
import { applyBaselineWorkflow } from "../../src/pipeline/build-report.js";
import type { AnalyzeOptions } from "../../src/pipeline/analyze.js";

const ROOT = path.join(os.tmpdir(), `120fps-baseline-file-${process.pid}`);
const NAMED = path.join(ROOT, "artifacts", "named-baseline.json");
const DEFAULT_PATH = path.join(ROOT, BASELINE_FILE_NAME);

const machine = {
  cpu: "Test CPU", cores: 8, ramMb: 16384,
  os: "Linux 6.0", nodeVersion: "v20.0.0", chromiumVersion: "120.0.0.0",
};

const env: EnvFingerprint = buildEnvFingerprint({
  machine,
  calibration: { totalDuration: 10, scriptDuration: 5 },
  cpuThrottle: 4,
  samples: 3,
  mode: "combo",
  framework: "react",
});

function combo(overrides: Partial<ComboReport> = {}): ComboReport {
  return {
    comboIndex: 0,
    props: {},
    mount: { samples: [4], median: 4, p95: 4, cv: 0, unstable: false },
    unmount: { samples: [1], median: 1, p95: 1, cv: 0, unstable: false },
    rerender: { samples: [2], median: 2, p95: 2, cv: 0, unstable: false },
    domNodeCount: 6,
    heapDelta: 0,
    interactions: [],
    scalingCurve: null,
    relativeMount: 0.4,
    verdict: "pass",
    tier: "T1",
    ...overrides,
  };
}

function report(overrides: Partial<Report> = {}): Report {
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00.000Z",
    machine,
    componentPath: path.join(ROOT, "card.tsx"),
    componentName: "Card",
    calibration: { totalDuration: 10, scriptDuration: 5 },
    combos: [combo()],
    thresholds: DEFAULT_THRESHOLDS,
    pass: true,
    ...overrides,
  };
}

const metrics = {
  mount: 4,
  rerender: 2,
  unmount: 1,
  domNodeCount: 6,
  interactions: {},
  unstable: new Set<string>(),
  tier: "T1" as BaselineEntry["tier"],
};

function workflow(subject: Report, options: Partial<AnalyzeOptions>): void {
  applyBaselineWorkflow(subject, metrics, {
    options: options as AnalyzeOptions,
    projectRoot: ROOT,
    relativeComponent: "./card.tsx",
    componentDir: ROOT,
    currentEnv: env,
    envPolicy: "normalize",
    sourceFingerprint: "source-fingerprint",
  });
}

function slotFor(baselinePath: string, componentPath: string): BaselineEntry {
  const baseline = loadBaseline(baselinePath);
  if (!baseline) throw new Error(`no baseline at ${baselinePath}`);
  const key = Object.keys(baseline.entries).find(
    (candidate) => parseBaselineKey(candidate).componentPath === componentPath,
  );
  if (!key) throw new Error(`no slot for ${componentPath}`);
  return baseline.entries[key];
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});

afterAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe("--baseline-file names the file the run reads and writes", () => {
  it("is a known flag that takes a path", () => {
    expect(KNOWN_FLAGS.has("--baseline-file")).toBe(true);
    const args = parseArgs(["./card.tsx", "--baseline-file", "out/base.json"]);
    expect(args.error).toBeUndefined();
    expect(args.baselineFile).toBe("out/base.json");
  });

  it("errors when no path follows it", () => {
    expect(parseArgs(["./card.tsx", "--baseline-file"]).error).toContain("--baseline-file");
  });

  it("is documented beside --save-baseline and --check", () => {
    const text = helpText();
    expect(text).toContain("--baseline-file <path>");
    expect(text).toContain("--save-baseline");
    expect(text).toContain("--check");
  });

  it("resolves to the project root file when absent", () => {
    expect(resolveBaselinePath(ROOT, undefined)).toBe(DEFAULT_PATH);
  });

  it("resolves a relative path against the process cwd", () => {
    expect(resolveBaselinePath(ROOT, "out/base.json")).toBe(
      path.resolve(process.cwd(), "out/base.json"),
    );
  });

  it("keeps an absolute path as given", () => {
    expect(resolveBaselinePath(ROOT, NAMED)).toBe(path.resolve(NAMED));
  });
});

describe("--save-baseline writes where it is told", () => {
  it("writes the named file and leaves the project root alone", () => {
    workflow(report(), { saveBaseline: true, baselineFile: NAMED });
    expect(fs.existsSync(NAMED)).toBe(true);
    expect(fs.existsSync(DEFAULT_PATH)).toBe(false);
  });

  it("writes the project root file when no path is named", () => {
    workflow(report(), { saveBaseline: true });
    expect(fs.existsSync(DEFAULT_PATH)).toBe(true);
  });

  it("stores the run's warnings with the entry", () => {
    workflow(report({ warnings: ["the stylesheet did not compile"] }), {
      saveBaseline: true,
      baselineFile: NAMED,
    });
    expect(slotFor(NAMED, "./card.tsx").warnings).toEqual(["the stylesheet did not compile"]);
  });

  it("fails with a message naming the destination it could not write", () => {
    const blocker = path.join(ROOT, "blocker");
    fs.writeFileSync(blocker, "not a directory", "utf-8");
    const target = path.join(blocker, "baseline.json");
    expect(() => saveBaseline(target, slotless(), "./card.tsx")).toThrow(target);
  });
});

describe("--check reads where it is told", () => {
  it("compares against the named file, not the project root", () => {
    workflow(report(), { saveBaseline: true, baselineFile: NAMED });
    const checked = report();
    workflow(checked, { check: true, baselineFile: NAMED });
    expect(checked.baseline?.hasBaseline).toBe(true);
  });

  it("finds no baseline when the named file holds none", () => {
    workflow(report(), { saveBaseline: true });
    const checked = report();
    workflow(checked, { check: true, baselineFile: NAMED });
    expect(checked.baseline).toBeUndefined();
  });
});

describe("a caller-named destination is handled like any other path", () => {
  it("creates the directories the named path needs", () => {
    const deep = path.join(ROOT, "a", "b", "c", "base.json");
    workflow(report(), { saveBaseline: true, baselineFile: deep });
    expect(fs.existsSync(deep)).toBe(true);
  });

  it("treats an empty flag value as no flag at all", () => {
    expect(resolveBaselinePath(ROOT, "")).toBe(DEFAULT_PATH);
  });

  it("fails with a message naming a destination that is a directory", () => {
    fs.mkdirSync(NAMED, { recursive: true });
    expect(() => saveBaseline(NAMED, slotless(), "./card.tsx")).toThrow(NAMED);
  });

  it("merges into the named file instead of replacing what it holds", () => {
    saveBaseline(NAMED, slotless(), "./other.tsx");
    workflow(report(), { saveBaseline: true, baselineFile: NAMED });
    expect(() => slotFor(NAMED, "./other.tsx")).not.toThrow();
    expect(() => slotFor(NAMED, "./card.tsx")).not.toThrow();
  });
});

function slotless(): BaselineEntry {
  return {
    mount: 4, rerender: 2, unmount: 1, domNodeCount: 6,
    interactions: {}, tier: "T1", env, pass: true,
  };
}
